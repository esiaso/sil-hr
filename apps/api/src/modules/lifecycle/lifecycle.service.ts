import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import Decimal from 'decimal.js';
import { DataSource, EntityManager } from 'typeorm';
import { z } from 'zod';
import {
  completeExit, createContract, createLifecycleRequest, updateContract, PERMISSION_CODES, updateChecklistTask, upsertChecklistTemplate, type AssigneeGroup,
} from '@sil/hr-shared';
import { AccessProfile, applyScope, scopeAllows, systemAccess } from '../../common/access';
import { assertVersion } from '../../common/etag';
import { conflict, forbidden, notFound, unprocessable } from '../../common/problem';
import { writeAudit } from '../audit/audit.subscriber';
import { DocumentsService } from '../documents/documents.module';
import { Employee } from '../employees/employee.entities';
import { EmployeesService } from '../employees/employees.service';
import { OutboxService } from '../events/events.module';
import { LeaveService } from '../leave/leave.service';
import { NotificationsService } from '../notifications/notifications.module';
import { NumberingService } from '../numbering/numbering.module';
import { ScopeService } from '../organisation/scope.service';
import { PayComponent, PayrollOneOff, PayrollRun } from '../payroll/payroll.entities';
import { PayrollService } from '../payroll/payroll.service';
import { SettingsService } from '../settings/settings.module';
import { WorkflowInstance } from '../workflow/workflow.entities';
import { WorkflowService } from '../workflow/workflow.service';
import {
  Checklist, ChecklistTask, ChecklistTemplate, ChecklistTemplateTask, EmployeeContract, ExitClearance, LifecycleRequest, type Assignee, type ExitKind,
} from './lifecycle.entities';
import { ProcurementClient, type ProcurementClearance } from './procurement.client';

type Dto<T extends z.ZodType> = z.infer<T>;
const m2 = (x: Decimal.Value) => new Decimal(x).toFixed(2);
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
const iso = (d: Date | null) => (d ? d.toISOString() : null);

/** Which role holders work each checklist group (besides HR, who can work all of them). */
const GROUP_ROLES: Record<Exclude<AssigneeGroup, 'line_manager' | 'employee'>, string[]> = {
  hr: ['hr_officer', 'hr_manager'],
  it: ['it_support'],
  facilities: ['facilities'],
  finance: ['finance_approver', 'payroll_officer'],
};

@Injectable()
export class LifecycleService implements OnModuleInit {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly settings: SettingsService,
    private readonly workflow: WorkflowService,
    private readonly outbox: OutboxService,
    private readonly notifications: NotificationsService,
    private readonly numbering: NumberingService,
    private readonly scope: ScopeService,
    private readonly employees: EmployeesService,
    private readonly payroll: PayrollService,
    private readonly leave: LeaveService,
    private readonly procurement: ProcurementClient,
    private readonly docs: DocumentsService,
  ) {}

  onModuleInit(): void {
    this.workflow.registerHandler('lifecycle_change', {
      onApproved: (m, i, actor) => this.approve(m, i, actor),
      onRejected: (m, i, c) => this.close(m, i, 'rejected', c),
      onReturned: (m, i, c) => this.close(m, i, 'returned', c),
    });
  }

  private sys(actor: string) {
    return systemAccess(actor, 'approval', PERMISSION_CODES);
  }

  private async employee(m: EntityManager, id: string) {
    const [r] = await m.query(
      `SELECT e.id, e.staff_number, e.first_name || ' ' || e.last_name AS name, e.status, e.employment_type, e.branch_id, e.department_id, e.position_id, e.manager_id, to_char(e.hire_date, 'YYYY-MM-DD') AS hire_date,
              to_char(e.exit_date, 'YYYY-MM-DD') AS exit_date, p.title AS position_title, p.job_grade_id
         FROM employee e LEFT JOIN position p ON p.id = e.position_id WHERE e.id = $1`,
      [id],
    );
    if (!r) throw notFound('Employee');
    return r as { id: string; staff_number: string; name: string; status: string; employment_type: string; branch_id: string | null; department_id: string | null; position_id: string | null; manager_id: string | null; hire_date: string; exit_date: string | null; position_title: string | null; job_grade_id: string | null };
  }

  private async assertScope(access: AccessProfile, permission: string, e: { id: string; branch_id: string | null; department_id: string | null }) {
    if (!scopeAllows(await this.scope.filterFor(access, permission), { branchId: e.branch_id, departmentId: e.department_id, employeeId: e.id })) throw forbidden(`Outside your ${permission} scope`, 'out_of_scope');
  }

  // ================================================================== contracts
  private async contractDto(m: EntityManager, c: EmployeeContract) {
    const today = await this.settings.today(m);
    const [x] = await m.query(`SELECT e.first_name || ' ' || e.last_name AS name, e.staff_number, p.title FROM employee e LEFT JOIN position p ON p.id = $2 WHERE e.id = $1`, [c.employeeId, c.positionId]);
    return {
      id: c.id, number: c.number, employee_id: c.employeeId, employee_name: x?.name, staff_number: x?.staff_number, contract_type: c.contractType, position_id: c.positionId, position_title: x?.title ?? null,
      start_date: c.startDate, end_date: c.endDate, probation_months: c.probationMonths, notice_days: c.noticeDays, basic: c.basic === null ? null : m2(c.basic), terms: c.terms, document_id: c.documentId,
      status: c.status, renewed_from_id: c.renewedFromId, days_left: c.endDate && c.status === 'active' ? daysBetween(today, c.endDate) : null,
      created_at: c.createdAt.toISOString(), updated_at: c.updatedAt.toISOString(), version: c.version,
    };
  }

  async contracts(access: AccessProfile, q: { employee_id?: string; expiring_within_days?: number; status?: string }) {
    const m = this.dataSource.manager;
    const qb = m.getRepository(EmployeeContract).createQueryBuilder('c').innerJoin(Employee, 'e', 'e.id = c.employee_id').orderBy('c.startDate', 'DESC').take(1000);
    if (q.employee_id) qb.andWhere('c.employee_id = :e', { e: q.employee_id });
    if (q.status) qb.andWhere('c.status = :s', { s: q.status });
    if (q.expiring_within_days !== undefined) qb.andWhere(`c.status = 'active' AND c.end_date IS NOT NULL AND c.end_date <= (current_date + make_interval(days => :d))`, { d: q.expiring_within_days });
    const filter = await this.scope.filterFor(access, 'contract:read');
    if (q.employee_id && q.employee_id === access.employeeId) { /* own contracts */ } else applyScope(qb, filter, { branch: 'e.branch_id', department: 'e.department_id', employee: 'e.id' });
    const rows = await qb.getMany();
    return Promise.all(rows.map((c) => this.contractDto(m, c)));
  }

  async createContract(access: AccessProfile, dto: Dto<typeof createContract>, outer?: EntityManager, renewedFromId: string | null = null) {
    const work = async (m: EntityManager) => {
      const e = await this.employee(m, dto.employee_id);
      await this.assertScope(access, 'contract:manage', e);
      // The contract in force ends the day before a new one starts.
      await m.query(`UPDATE employee_contract SET status = CASE WHEN $3::uuid IS NOT NULL THEN 'renewed' ELSE 'ended' END, end_date = CASE WHEN end_date IS NULL OR end_date >= $2 THEN $2::date - 1 ELSE end_date END, updated_at = now(), version = version + 1
                      WHERE employee_id = $1 AND status = 'active' AND start_date < $2`, [e.id, dto.start_date, renewedFromId]);
      const c = await m.getRepository(EmployeeContract).save(m.getRepository(EmployeeContract).create({
        number: await this.numbering.next('contract', { manager: m, date: dto.start_date }), employeeId: e.id, contractType: dto.contract_type, positionId: dto.position_id ?? e.position_id, startDate: dto.start_date,
        endDate: dto.end_date ?? null, probationMonths: dto.probation_months ?? null, noticeDays: dto.notice_days, basic: dto.basic ?? null, terms: dto.terms ?? null, documentId: dto.document_id ?? null, status: 'active', renewedFromId,
      }));
      return this.contractDto(m, c);
    };
    return outer ? work(outer) : this.dataSource.transaction(work);
  }

  /** Corrects the terms of a contract in force; every change is audited. */
  async updateContract(access: AccessProfile, id: string, dto: Dto<typeof updateContract>, version: number) {
    return this.dataSource.transaction(async (m) => {
      const c = await m.getRepository(EmployeeContract).findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
      if (!c) throw notFound('Contract');
      await this.assertScope(access, 'contract:manage', await this.employee(m, c.employeeId));
      assertVersion(c.version, version);
      if (c.status !== 'active' && c.status !== 'draft') throw conflict('contract_closed', `A ${c.status} contract cannot be changed`);
      if (dto.end_date && dto.end_date < c.startDate) throw unprocessable('end_before_start', 'The end date is before the start', [{ path: 'end_date', message: 'Before start' }]);
      const before = { endDate: c.endDate, probationMonths: c.probationMonths, noticeDays: c.noticeDays, basic: c.basic, terms: c.terms };
      Object.assign(c, { endDate: dto.end_date ?? null, probationMonths: dto.probation_months ?? null, noticeDays: dto.notice_days, basic: dto.basic ?? null, terms: dto.terms ?? null, remindedAt: dto.end_date !== before.endDate ? null : c.remindedAt });
      await m.getRepository(EmployeeContract).save(c);
      await writeAudit(m, { action: 'update', entityType: 'EmployeeContract', entityId: c.id, before, after: { endDate: c.endDate, probationMonths: c.probationMonths, noticeDays: c.noticeDays, basic: c.basic, terms: c.terms } });
      return this.contractDto(m, c);
    });
  }

  /** Records the signed copy of a contract (PDF or scan). */
  async attachContractDocument(access: AccessProfile, id: string, file: Express.Multer.File | undefined) {
    if (!file) throw unprocessable('file_required', 'Attach the signed contract', [{ path: 'file', message: 'Required' }]);
    const m = this.dataSource.manager;
    const c = await m.getRepository(EmployeeContract).findOneBy({ id });
    if (!c) throw notFound('Contract');
    await this.assertScope(access, 'contract:manage', await this.employee(m, c.employeeId));
    const doc = await this.docs.create({ owner_type: 'employee', owner_id: c.employeeId, title: `Signed contract ${c.number}`, category: 'signed_contract', is_sensitive: 'true' }, file, access.actorId);
    c.documentId = doc.id;
    await m.getRepository(EmployeeContract).save(c);
    return this.contractDto(m, c);
  }

  async contractDocument(access: AccessProfile, id: string) {
    const m = this.dataSource.manager;
    const c = await m.getRepository(EmployeeContract).findOneBy({ id });
    if (!c?.documentId) throw notFound('Signed contract');
    if (c.employeeId !== access.employeeId) await this.assertScope(access, 'contract:read', await this.employee(m, c.employeeId));
    return this.docs.read(c.documentId);
  }

  // ================================================================== requests
  async requestDto(m: EntityManager, r: LifecycleRequest) {
    const e = await this.employee(m, r.employeeId);
    return {
      id: r.id, number: r.number, kind: r.kind, employee_id: r.employeeId, employee_name: e.name, staff_number: e.staff_number, effective_date: r.effectiveDate, details: r.details, reason: r.reason, status: r.status,
      decision_comment: r.decisionComment, workflow_instance_id: r.workflowInstanceId, result: r.result, created_at: r.createdAt.toISOString(),
    };
  }

  /** Withdraws a request that is still waiting (or was returned): the requester, or anyone who may raise such requests for that person. */
  async cancelRequest(access: AccessProfile, id: string) {
    await this.dataSource.transaction(async (m) => {
      const r = await m.getRepository(LifecycleRequest).findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
      if (!r) throw notFound('Request');
      if (r.createdBy !== access.actorId) await this.assertScope(access, 'lifecycle:request', await this.employee(m, r.employeeId));
      if (!['pending', 'returned'].includes(r.status)) throw conflict('decided', `The request is ${r.status}`);
      await this.workflow.cancel(m, 'lifecycle_change', r.id);
      r.status = 'cancelled';
      await m.getRepository(LifecycleRequest).save(r);
      await writeAudit(m, { action: 'update', entityType: 'LifecycleRequest', entityId: r.id, after: { status: 'cancelled' } });
    });
    const m = this.dataSource.manager;
    return this.requestDto(m, (await m.getRepository(LifecycleRequest).findOneBy({ id }))!);
  }

  async requests(access: AccessProfile, q: { employee_id?: string; status?: string; kind?: string }) {
    const m = this.dataSource.manager;
    const qb = m.getRepository(LifecycleRequest).createQueryBuilder('r').innerJoin(Employee, 'e', 'e.id = r.employee_id').orderBy('r.createdAt', 'DESC').take(500);
    if (q.employee_id) qb.andWhere('r.employee_id = :e', { e: q.employee_id });
    if (q.status) qb.andWhere('r.status = :s', { s: q.status });
    if (q.kind) qb.andWhere('r.kind = :k', { k: q.kind });
    applyScope(qb, await this.scope.filterFor(access, 'lifecycle:request'), { branch: 'e.branch_id', department: 'e.department_id', employee: 'e.id' });
    return Promise.all((await qb.getMany()).map((r) => this.requestDto(m, r)));
  }

  private async nextNumber(m: EntityManager, table: string, prefix: string) {
    const [{ n }] = await m.query(`SELECT count(*)::int + 1 AS n FROM ${table} WHERE created_at >= date_trunc('year', now())`);
    return `${prefix}/${new Date().getUTCFullYear()}/${String(n).padStart(5, '0')}`;
  }

  async createRequest(access: AccessProfile, dto: Dto<typeof createLifecycleRequest>) {
    return this.dataSource.transaction(async (m) => {
      const e = await this.employee(m, dto.employee_id);
      await this.assertScope(access, 'lifecycle:request', e);
      if (e.status === 'exited') throw conflict('employee_exited', 'This person has left');
      if (await m.getRepository(LifecycleRequest).existsBy({ employeeId: e.id, kind: dto.kind, status: 'pending' })) throw conflict('pending', `There is already a pending ${dto.kind.replace('_', ' ')} for ${e.name}`);
      const details: Record<string, unknown> = {};
      let summary = '';
      switch (dto.kind) {
        case 'promotion':
        case 'transfer': {
          const [p] = await m.query(`SELECT p.title, g.name AS grade FROM position p LEFT JOIN job_grade g ON g.id = p.job_grade_id WHERE p.id = $1 AND p.status = 'active'`, [dto.position_id]);
          if (!p) throw unprocessable('position_not_found', 'Unknown or inactive position', [{ path: 'position_id', message: 'Not found' }]);
          if (dto.position_id === e.position_id) throw unprocessable('same_position', `${e.name} already holds this position`, [{ path: 'position_id', message: 'Same position' }]);
          Object.assign(details, { position_id: dto.position_id, position_title: p.title, grade: p.grade, from_position_id: e.position_id, from_position_title: e.position_title, manager_id: dto.manager_id ?? undefined });
          if (dto.kind === 'promotion' && dto.new_basic) details.new_basic = dto.new_basic;
          summary = `${dto.kind === 'promotion' ? 'Promote' : 'Transfer'} ${e.name} to ${p.title} from ${dto.effective_date}`;
          break;
        }
        case 'confirmation':
          if (e.status !== 'probation') throw unprocessable('not_on_probation', `${e.name} is not on probation`);
          summary = `Confirm ${e.name} in post from ${dto.effective_date}`;
          break;
        case 'contract_renewal': {
          const current = await m.getRepository(EmployeeContract).findOneBy({ employeeId: e.id, status: 'active' });
          if (!current) throw unprocessable('no_contract', `${e.name} has no active contract to renew`);
          if (dto.effective_date <= current.startDate) throw unprocessable('too_early', 'The renewal must start after the current contract started', [{ path: 'effective_date', message: 'Too early' }]);
          Object.assign(details, { contract_id: current.id, contract_type: dto.contract_type, end_date: dto.end_date ?? null, new_basic: dto.new_basic ?? null, notice_days: dto.notice_days ?? current.noticeDays });
          summary = `Renew ${e.name}'s contract from ${dto.effective_date}${dto.end_date ? ` to ${dto.end_date}` : ''}`;
          break;
        }
        case 'resignation':
        case 'termination': {
          if (await m.getRepository(ExitClearance).existsBy({ employeeId: e.id })) throw conflict('exit_in_progress', `An exit is already in progress for ${e.name}`);
          const exitKind: ExitKind = dto.kind === 'resignation' ? 'resignation' : dto.exit_kind;
          Object.assign(details, { exit_kind: exitKind, ...(dto.kind === 'resignation' ? { notice_given_on: dto.notice_given_on, document_id: dto.document_id ?? null } : { pay_notice_in_lieu: dto.pay_notice_in_lieu }) });
          summary = `${dto.kind === 'resignation' ? 'Resignation' : 'Termination'} of ${e.name}: last day ${dto.effective_date}`;
          break;
        }
      }
      const r = await m.getRepository(LifecycleRequest).save(m.getRepository(LifecycleRequest).create({ number: await this.nextNumber(m, 'lifecycle_request', 'LC'), kind: dto.kind, employeeId: e.id, effectiveDate: dto.effective_date, details, reason: dto.reason, status: 'pending' }));
      const u: { id: string } | undefined = (await m.query(`SELECT id FROM user_account WHERE id = $1`, [access.actorId]))[0];
      const instance = await this.workflow.submit(m, { requestType: 'lifecycle_change', kind: dto.kind, subjectId: r.id, subjectEmployeeId: e.id, requesterUserId: u?.id ?? null, summary, value: null });
      r.workflowInstanceId = instance.id;
      await m.getRepository(LifecycleRequest).save(r);
      return this.requestDto(m, r);
    });
  }

  private async close(m: EntityManager, i: WorkflowInstance, status: 'rejected' | 'returned', comment: string | null) {
    const r = await m.getRepository(LifecycleRequest).findOneByOrFail({ id: i.subjectId });
    Object.assign(r, { status, decisionComment: comment });
    await m.getRepository(LifecycleRequest).save(r);
    if (r.kind === 'final_dues') await m.getRepository(ExitClearance).update({ employeeId: r.employeeId }, { finalDuesStatus: 'draft', finalDuesRequestId: null });
  }

  /** Workflow: what an approved lifecycle request does. */
  private async approve(m: EntityManager, i: WorkflowInstance, actor: string) {
    const r = await m.getRepository(LifecycleRequest).findOneByOrFail({ id: i.subjectId });
    const sys = this.sys(actor);
    const d = r.details;
    const result: Record<string, unknown> = {};
    const e = await this.employee(m, r.employeeId);
    switch (r.kind) {
      case 'promotion':
      case 'transfer': {
        await this.employees.transfer(sys, r.employeeId, { position_id: d.position_id as string, manager_id: (d.manager_id as string | undefined) ?? undefined, effective_from: r.effectiveDate, reason: `${r.kind === 'promotion' ? 'Promotion' : 'Transfer'} ${r.number}: ${r.reason ?? ''}`.slice(0, 500) }, m);
        if (d.new_basic) await this.payroll.setSalary(sys, r.employeeId, { basic: d.new_basic as string, effective_from: r.effectiveDate, reason: `Promotion ${r.number}` }, m);
        if (r.kind === 'promotion') {
          const [p] = await m.query(`SELECT job_grade_id FROM position WHERE id = $1`, [d.position_id]);
          await this.outbox.record(m, 'hr.employee.promoted.v1', r.employeeId, { id: r.employeeId, staff_number: e.staff_number, position_id: d.position_id as string, previous_position_id: (d.from_position_id as string | null) ?? null, job_grade_id: p?.job_grade_id ?? null, effective_from: r.effectiveDate });
        }
        break;
      }
      case 'confirmation':
        await this.employees.changeStatus(sys, r.employeeId, { status: 'active', effective_date: r.effectiveDate, reason: `Confirmed in post (${r.number})` }, m);
        break;
      case 'contract_renewal': {
        const c = await this.createContract(sys, { employee_id: r.employeeId, contract_type: d.contract_type as never, start_date: r.effectiveDate, end_date: (d.end_date as string | null) ?? null, notice_days: (d.notice_days as number) ?? 30, basic: (d.new_basic as string | null) ?? null, position_id: e.position_id }, m, d.contract_id as string);
        if (d.new_basic) await this.payroll.setSalary(sys, r.employeeId, { basic: d.new_basic as string, effective_from: r.effectiveDate, reason: `Contract renewal ${r.number}` }, m);
        result.contract_id = c.id;
        break;
      }
      case 'resignation':
      case 'termination': {
        if (['active', 'probation', 'suspended'].includes(e.status)) await this.employees.changeStatus(sys, r.employeeId, { status: 'on_notice', effective_date: (await this.settings.today(m)) < e.hire_date ? e.hire_date : await this.settings.today(m), reason: `${r.kind === 'resignation' ? 'Resigned' : 'Termination'} (${r.number})` }, m);
        const contract = await m.getRepository(EmployeeContract).findOneBy({ employeeId: r.employeeId, status: 'active' });
        const noticeDays = contract?.noticeDays ?? 30;
        const served = d.notice_given_on ? Math.max(0, daysBetween(d.notice_given_on as string, r.effectiveDate)) : 0;
        const ec = await m.getRepository(ExitClearance).save(m.getRepository(ExitClearance).create({
          employeeId: r.employeeId, exitDate: r.effectiveDate, exitKind: d.exit_kind as ExitKind, noticeDays, noticeServedDays: r.kind === 'resignation' ? served : (d.pay_notice_in_lieu ? 0 : noticeDays),
        }));
        const cl = await this.startChecklist(m, r.employeeId, 'offboarding', r.effectiveDate, r.id);
        await this.outbox.record(m, 'hr.employee.offboarding_started.v1', r.employeeId, { id: r.employeeId, staff_number: e.staff_number, exit_date: r.effectiveDate, exit_kind: d.exit_kind as string });
        result.exit_clearance_id = ec.id;
        result.checklist_id = cl?.id ?? null;
        break;
      }
      case 'final_dues': {
        result.one_off_ids = await this.postFinalDues(m, r, actor);
        break;
      }
    }
    Object.assign(r, { status: 'approved', result });
    await m.getRepository(LifecycleRequest).save(r);
  }

  // ================================================================== checklists
  private async templateDto(m: EntityManager, t: ChecklistTemplate) {
    const tasks = await m.getRepository(ChecklistTemplateTask).find({ where: { templateId: t.id }, order: { seq: 'ASC' } });
    return { id: t.id, code: t.code, name: t.name, kind: t.kind, employment_types: t.employmentTypes, is_default: t.isDefault, status: t.status, version: t.version, tasks: tasks.map((x) => ({ id: x.id, title: x.title, description: x.description, assignee: x.assignee, due_offset_days: x.dueOffsetDays, blocks_exit: x.blocksExit })) };
  }

  async templates() {
    const m = this.dataSource.manager;
    return Promise.all((await m.getRepository(ChecklistTemplate).find({ order: { kind: 'ASC', name: 'ASC' } })).map((t) => this.templateDto(m, t)));
  }

  async saveTemplate(dto: Dto<typeof upsertChecklistTemplate>, id?: string, version?: number) {
    return this.dataSource.transaction(async (m) => {
      const repo = m.getRepository(ChecklistTemplate);
      const t = id ? await repo.findOneBy({ id }) : repo.create();
      if (!t) throw notFound('Checklist template');
      if (id && version !== undefined) assertVersion(t.version, version);
      if (dto.is_default) await m.query(`UPDATE checklist_template SET is_default = false WHERE kind = $1 AND id IS DISTINCT FROM $2`, [dto.kind, id ?? null]);
      Object.assign(t, { code: dto.code, name: dto.name, kind: dto.kind, employmentTypes: dto.employment_types, isDefault: dto.is_default, status: dto.status });
      const saved = await repo.save(t);
      await m.getRepository(ChecklistTemplateTask).delete({ templateId: saved.id });
      await m.getRepository(ChecklistTemplateTask).insert(dto.tasks.map((x, n) => ({ templateId: saved.id, seq: n + 1, title: x.title, description: x.description ?? null, assignee: x.assignee, dueOffsetDays: x.due_offset_days, blocksExit: x.blocks_exit })));
      return this.templateDto(m, saved);
    });
  }

  /** Creates a checklist from the best template: one for the employment type, else the default. */
  async startChecklist(m: EntityManager, employeeId: string, kind: 'onboarding' | 'offboarding', anchor: string, requestId: string | null = null) {
    if (await m.getRepository(Checklist).existsBy({ employeeId, kind, status: 'open' })) return null;
    const e = await this.employee(m, employeeId);
    const templates = await m.getRepository(ChecklistTemplate).findBy({ kind, status: 'active' });
    const t = templates.find((x) => x.employmentTypes.includes(e.employment_type)) ?? templates.find((x) => x.isDefault) ?? templates[0];
    const cl = await m.getRepository(Checklist).save(m.getRepository(Checklist).create({ employeeId, kind, templateId: t?.id ?? null, anchorDate: anchor, status: 'open', lifecycleRequestId: requestId }));
    if (t) {
      const tasks = await m.getRepository(ChecklistTemplateTask).find({ where: { templateId: t.id }, order: { seq: 'ASC' } });
      await m.getRepository(ChecklistTask).insert(tasks.map((x) => ({ checklistId: cl.id, seq: x.seq, title: x.title, description: x.description, assignee: x.assignee, dueDate: addDays(anchor, x.dueOffsetDays), blocksExit: x.blocksExit, status: 'open' as const })));
      // Tell the people who will do the work.
      for (const group of [...new Set(tasks.map((x) => x.assignee))]) await this.notifyGroup(m, group, e, kind);
    }
    return cl;
  }

  private async notifyGroup(m: EntityManager, group: Assignee, e: { id: string; name: string; manager_id: string | null }, kind: string) {
    let users: { id: string }[] = [];
    if (group === 'line_manager') users = e.manager_id ? await m.query(`SELECT id FROM user_account WHERE employee_id = $1 AND status = 'active'`, [e.manager_id]) : [];
    else if (group === 'employee') users = await m.query(`SELECT id FROM user_account WHERE employee_id = $1 AND status = 'active'`, [e.id]);
    else users = await m.query(`SELECT DISTINCT u.id FROM user_account u JOIN role_assignment ra ON ra.user_id = u.id JOIN role r ON r.id = ra.role_id WHERE r.code = ANY($1) AND u.status = 'active'`, [GROUP_ROLES[group]]);
    await this.notifications.notifyUsers(users.map((u) => u.id), 'checklist_tasks_assigned', { name: e.name, kind }, '/lifecycle/tasks', m);
  }

  private async taskRows(where: string, params: unknown[]) {
    const rows: Record<string, unknown>[] = await this.dataSource.query(
      `SELECT t.*, c.employee_id, c.kind, e.first_name || ' ' || e.last_name AS employee_name, u.display_name AS done_by_name
         FROM checklist_task t JOIN checklist c ON c.id = t.checklist_id JOIN employee e ON e.id = c.employee_id LEFT JOIN user_account u ON u.id = t.done_by
        WHERE ${where} ORDER BY t.due_date, t.seq`,
      params,
    );
    return rows.map((t) => ({
      id: t.id as string, checklist_id: t.checklist_id as string, seq: t.seq as number, title: t.title as string, description: t.description as string | null, assignee: t.assignee as Assignee,
      due_date: (t.due_date instanceof Date ? t.due_date.toISOString().slice(0, 10) : t.due_date) as string, blocks_exit: t.blocks_exit as boolean, status: t.status as 'open', done_by_name: (t.done_by_name as string) ?? null,
      done_at: t.done_at ? new Date(t.done_at as string).toISOString() : null, note: t.note as string | null, employee_id: t.employee_id as string, employee_name: t.employee_name as string, kind: t.kind as 'onboarding',
    }));
  }

  async checklists(access: AccessProfile, q: { status?: string; kind?: string; employee_id?: string }) {
    const qb = this.dataSource.getRepository(Checklist).createQueryBuilder('c').innerJoin(Employee, 'e', 'e.id = c.employee_id').orderBy('c.createdAt', 'DESC').take(300);
    if (q.status) qb.andWhere('c.status = :s', { s: q.status });
    if (q.kind) qb.andWhere('c.kind = :k', { k: q.kind });
    if (q.employee_id) qb.andWhere('c.employee_id = :e', { e: q.employee_id });
    applyScope(qb, await this.scope.filterFor(access, 'checklist:manage'), { branch: 'e.branch_id', department: 'e.department_id', employee: 'e.id' });
    const lists = await qb.getMany();
    if (!lists.length) return [];
    const tasks = await this.taskRows('t.checklist_id = ANY($1::uuid[])', [lists.map((l) => l.id)]);
    const today = await this.settings.today();
    return lists.map((c) => {
      const ts = tasks.filter((t) => t.checklist_id === c.id);
      return {
        id: c.id, employee_id: c.employeeId, employee_name: ts[0]?.employee_name ?? '', staff_number: '', kind: c.kind, anchor_date: c.anchorDate, status: c.status,
        done: ts.filter((t) => t.status !== 'open').length, total: ts.length, overdue: ts.filter((t) => t.status === 'open' && t.due_date < today).length, tasks: ts, created_at: c.createdAt.toISOString(),
      };
    });
  }

  /** The groups a user works for: their roles, their reports (line manager) and themselves. */
  private async groupsOf(access: AccessProfile): Promise<Assignee[]> {
    const roles: { code: string }[] = await this.dataSource.query(`SELECT r.code FROM role_assignment ra JOIN role r ON r.id = ra.role_id WHERE ra.user_id = $1`, [access.actorId]);
    const codes = new Set(roles.map((r) => r.code));
    const out: Assignee[] = [];
    for (const [g, rs] of Object.entries(GROUP_ROLES)) if (rs.some((r) => codes.has(r)) || codes.has('system_admin')) out.push(g as Assignee);
    return out;
  }

  async myTasks(access: AccessProfile) {
    const groups = await this.groupsOf(access);
    return this.taskRows(
      `c.status = 'open' AND t.status = 'open' AND (t.assignee = ANY($1::text[]) OR (t.assignee = 'line_manager' AND e.manager_id = $2) OR (t.assignee = 'employee' AND c.employee_id = $2))`,
      [groups, access.employeeId ?? '00000000-0000-0000-0000-000000000000'],
    );
  }

  async updateTask(access: AccessProfile, taskId: string, dto: Dto<typeof updateChecklistTask>) {
    return this.dataSource.transaction(async (m) => {
      const t = await m.getRepository(ChecklistTask).findOneBy({ id: taskId });
      if (!t) throw notFound('Task');
      const c = await m.getRepository(Checklist).findOneByOrFail({ id: t.checklistId });
      if (c.status !== 'open') throw conflict('checklist_closed', 'This checklist is closed');
      const e = await this.employee(m, c.employeeId);
      const groups = await this.groupsOf(access);
      const allowed = access.has('checklist:manage') || groups.includes(t.assignee) || (t.assignee === 'line_manager' && e.manager_id === access.employeeId) || (t.assignee === 'employee' && e.id === access.employeeId);
      if (!allowed) throw forbidden('This task belongs to another team');
      Object.assign(t, { status: dto.status, note: dto.note ?? t.note, doneBy: dto.status === 'open' ? null : access.actorId, doneAt: dto.status === 'open' ? null : new Date() });
      await m.getRepository(ChecklistTask).save(t);
      // Onboarding closes itself when everything is done; offboarding closes when the exit is completed.
      const open = await m.getRepository(ChecklistTask).countBy({ checklistId: c.id, status: 'open' });
      if (!open && c.kind === 'onboarding') Object.assign(c, { status: 'completed', completedAt: new Date() }), await m.getRepository(Checklist).save(c);
      return (await this.taskRows('t.id = $1', [t.id]))[0];
    });
  }

  async startChecklistManually(access: AccessProfile, employeeId: string, kind: 'onboarding' | 'offboarding') {
    return this.dataSource.transaction(async (m) => {
      const e = await this.employee(m, employeeId);
      await this.assertScope(access, 'checklist:manage', e);
      const cl = await this.startChecklist(m, employeeId, kind, kind === 'onboarding' ? e.hire_date : (e.exit_date ?? (await this.settings.today(m))));
      if (!cl) throw conflict('checklist_open', `${e.name} already has an open ${kind} checklist`);
      return cl.id;
    });
  }

  // ================================================================== exit clearance and final dues
  private async figures(m: EntityManager, ec: ExitClearance, extra: { payNoticeInLieu?: boolean } = {}) {
    const loans = (await this.payroll.loans({ employee_id: ec.employeeId, status: 'active' })).reduce((a, l) => a.plus(l.balance), new Decimal(0));
    const leave = await this.leave.annualAvailableAt(m, ec.employeeId, ec.exitDate);
    const [s] = await m.query(`SELECT basic FROM employee_salary WHERE employee_id = $1 AND effective_from <= $2 AND (effective_to IS NULL OR effective_to >= $2) ORDER BY effective_from DESC LIMIT 1`, [ec.employeeId, ec.exitDate]);
    const basic = new Decimal(s?.basic ?? 0);
    const divisor = await this.settings.get('lifecycle.leave_pay_days_divisor', m);
    const leavePay = basic.div(divisor).mul(leave.days);
    const shortfall = Math.max(0, ec.noticeDays - ec.noticeServedDays);
    // Notice paid in lieu (termination without working the notice): basic ÷ 30 per day not worked.
    const noticePay = ec.exitKind !== 'resignation' && shortfall > 0 && extra.payNoticeInLieu !== false ? basic.div(30).mul(shortfall) : new Decimal(0);
    return { loans: m2(loans), leaveDays: leave.days, leaveTypeId: leave.leaveTypeId, leaveYear: leave.year, leavePay: m2(leavePay), noticePay: m2(noticePay) };
  }

  async clearanceDto(m: EntityManager, ec: ExitClearance) {
    const e = await this.employee(m, ec.employeeId);
    const f = await this.figures(m, ec);
    const [{ n }] = await m.query(`SELECT count(*)::int AS n FROM checklist_task t JOIN checklist c ON c.id = t.checklist_id WHERE c.employee_id = $1 AND c.kind = 'offboarding' AND c.status = 'open' AND t.blocks_exit AND t.status = 'open'`, [ec.employeeId]);
    const proc = (ec.procurement as unknown as ProcurementClearance | null) ?? { reachable: false, error: this.procurement.configured ? 'Not checked yet' : 'Procurement is not connected. Check assets by hand.', cleared: null, blockers: [], assets: [], outstanding_advances: [], petty_cash_floats: [], checked_at: null };
    const editable = ec.finalDuesStatus === 'draft';
    return {
      id: ec.id, employee_id: ec.employeeId, employee_name: e.name, staff_number: e.staff_number, exit_date: ec.exitDate, exit_kind: ec.exitKind, notice_days: ec.noticeDays, notice_served_days: ec.noticeServedDays,
      procurement: proc, loans_outstanding: editable ? f.loans : m2(ec.loansOutstanding), leave_days: editable ? f.leaveDays : ec.leaveDays, leave_pay: editable ? f.leavePay : m2(ec.leavePay), notice_pay: editable ? f.noticePay : m2(ec.noticePay),
      checklist_open_blocking: n, ready: n === 0 && proc.cleared === true, final_dues_status: ec.finalDuesStatus, final_dues_request_id: ec.finalDuesRequestId, completed_at: iso(ec.completedAt), version: ec.version,
    };
  }

  async clearances(access: AccessProfile, q: { open?: boolean }) {
    const m = this.dataSource.manager;
    const qb = m.getRepository(ExitClearance).createQueryBuilder('x').innerJoin(Employee, 'e', 'e.id = x.employee_id').orderBy('x.exitDate', 'ASC').take(300);
    if (q.open) qb.andWhere('x.completed_at IS NULL');
    applyScope(qb, await this.scope.filterFor(access, 'exit:manage'), { branch: 'e.branch_id', department: 'e.department_id', employee: 'e.id' });
    return Promise.all((await qb.getMany()).map((x) => this.clearanceDto(m, x)));
  }

  private async loadClearance(access: AccessProfile, employeeId: string, m: EntityManager = this.dataSource.manager) {
    const ec = await m.getRepository(ExitClearance).findOneBy({ employeeId });
    if (!ec) throw notFound('Exit clearance');
    await this.assertScope(access, 'exit:manage', await this.employee(m, employeeId));
    return ec;
  }

  async clearance(access: AccessProfile, employeeId: string) {
    return this.clearanceDto(this.dataSource.manager, await this.loadClearance(access, employeeId));
  }

  /** Asks procurement what the person still holds (assets, advances, petty cash floats). */
  async checkProcurement(access: AccessProfile, employeeId: string) {
    const ec = await this.loadClearance(access, employeeId);
    const e = await this.employee(this.dataSource.manager, employeeId);
    const r = await this.procurement.exitClearance(e.staff_number);
    await this.dataSource.getRepository(ExitClearance).update({ id: ec.id }, { procurement: r as never, procurementCheckedAt: new Date(), procurementCleared: r.cleared });
    return this.clearanceDto(this.dataSource.manager, (await this.dataSource.getRepository(ExitClearance).findOneByOrFail({ id: ec.id })));
  }

  /** Freezes the figures and sends final dues for approval (HR officer, HR manager…). */
  async submitFinalDues(access: AccessProfile, employeeId: string) {
    return this.dataSource.transaction(async (m) => {
      const ec = await this.loadClearance(access, employeeId, m);
      if (ec.finalDuesStatus !== 'draft') throw conflict('final_dues_submitted', `Final dues are already ${ec.finalDuesStatus}`);
      const f = await this.figures(m, ec);
      const e = await this.employee(m, employeeId);
      Object.assign(ec, { loansOutstanding: f.loans, leaveDays: f.leaveDays, leavePay: f.leavePay, noticePay: f.noticePay, finalDuesStatus: 'submitted' });
      const r = await m.getRepository(LifecycleRequest).save(m.getRepository(LifecycleRequest).create({
        number: await this.nextNumber(m, 'lifecycle_request', 'LC'), kind: 'final_dues', employeeId, effectiveDate: ec.exitDate, status: 'pending', reason: 'Final dues at exit',
        details: { leave_days: f.leaveDays, leave_type_id: f.leaveTypeId, leave_year: f.leaveYear, leave_pay: f.leavePay, notice_pay: f.noticePay, loans_outstanding: f.loans },
      }));
      ec.finalDuesRequestId = r.id;
      await m.getRepository(ExitClearance).save(ec);
      const u: { id: string } | undefined = (await m.query(`SELECT id FROM user_account WHERE id = $1`, [access.actorId]))[0];
      const instance = await this.workflow.submit(m, { requestType: 'lifecycle_change', kind: 'final_dues', subjectId: r.id, subjectEmployeeId: employeeId, requesterUserId: u?.id ?? null, value: Number(f.leavePay) + Number(f.noticePay), summary: `Final dues for ${e.name}: leave pay KES ${f.leavePay} (${f.leaveDays} days), notice pay KES ${f.noticePay}, loans to recover KES ${f.loans}` });
      r.workflowInstanceId = instance.id;
      await m.getRepository(LifecycleRequest).save(r);
      return this.clearanceDto(m, ec);
    });
  }

  /**
   * Approved final dues go to the payroll of the exit month: leave pay and notice pay as
   * one-off earnings, unused annual leave is encashed, and each loan's instalment becomes
   * its balance so the last payslip recovers it.
   */
  private async postFinalDues(m: EntityManager, r: LifecycleRequest, actor: string): Promise<string[]> {
    const d = r.details as { leave_days: number; leave_type_id: string | null; leave_year: number; leave_pay: string; notice_pay: string };
    const period = r.effectiveDate.slice(0, 7);
    const run = await m.getRepository(PayrollRun).findOneBy({ period });
    if (run && ['under_review', 'approved', 'paid', 'closed'].includes(run.status)) throw conflict('period_locked', `The ${period} payroll is ${run.status.replace('_', ' ')}: final dues cannot be added to it`);
    const ids: string[] = [];
    const add = async (code: string, amount: string, note: string) => {
      if (new Decimal(amount).lte(0)) return;
      const c = await m.getRepository(PayComponent).findOneByOrFail({ code });
      const o = await m.getRepository(PayrollOneOff).save(m.getRepository(PayrollOneOff).create({ employeeId: r.employeeId, componentId: c.id, period, amount, note }));
      ids.push(o.id);
    };
    await add('LEAVE_PAY', d.leave_pay, `Unused annual leave: ${d.leave_days} day(s) (${r.number})`);
    await add('NOTICE_PAY', d.notice_pay, `Notice paid in lieu (${r.number})`);
    if (d.leave_type_id && d.leave_days > 0) await this.leave.encashAtExit(m, r.employeeId, d.leave_type_id, d.leave_year, d.leave_days, r.effectiveDate, actor);
    await m.query(
      `UPDATE employee_loan l SET installment = greatest(0.01, l.principal - COALESCE((SELECT sum(pl.amount) FROM payslip_line pl JOIN payslip p ON p.id = pl.payslip_id JOIN payroll_run pr ON pr.id = p.run_id WHERE pl.loan_id = l.id AND pr.status IN ('approved', 'paid', 'closed')), 0)),
              note = coalesce(l.note || ' · ', '') || 'Balance recovered from final pay', updated_at = now(), version = version + 1
        WHERE l.employee_id = $1 AND l.status = 'active'`,
      [r.employeeId],
    );
    await m.getRepository(ExitClearance).update({ employeeId: r.employeeId }, { finalDuesStatus: 'posted' });
    return ids;
  }

  /** Ends employment: the status becomes exited (access ends, SCIM and events follow). */
  async completeExit(access: AccessProfile, employeeId: string, dto: Dto<typeof completeExit>) {
    return this.dataSource.transaction(async (m) => {
      const ec = await this.loadClearance(access, employeeId, m);
      if (ec.completedAt) throw conflict('already_exited', 'This exit is already complete');
      const view = await this.clearanceDto(m, ec);
      const today = await this.settings.today(m);
      if (ec.exitDate > today) throw conflict('not_yet', `The last working day is ${ec.exitDate}`);
      if (!view.ready && !dto.override_reason) throw unprocessable('not_cleared', view.checklist_open_blocking ? `${view.checklist_open_blocking} blocking checklist task(s) are still open` : 'Procurement has not cleared this person (assets, advances or petty cash). Give a reason to complete anyway.', [{ path: 'override_reason', message: 'Required to complete without clearance' }]);
      if (ec.finalDuesStatus !== 'posted' && !dto.override_reason) throw unprocessable('final_dues_pending', 'Approve the final dues first, or give a reason to complete without them', [{ path: 'override_reason', message: 'Required' }]);
      await this.employees.changeStatus(this.sys(access.actorId), employeeId, { status: 'exited', effective_date: ec.exitDate, reason: `${ec.exitKind.replace('_', ' ')}${dto.override_reason ? `; completed without full clearance: ${dto.override_reason}` : ''}`.slice(0, 500) }, m);
      Object.assign(ec, { completedAt: new Date() });
      await m.getRepository(ExitClearance).save(ec);
      await m.query(`UPDATE checklist SET status = 'completed', completed_at = now(), updated_at = now(), version = version + 1 WHERE employee_id = $1 AND kind = 'offboarding' AND status = 'open'`, [employeeId]);
      return this.clearanceDto(m, ec);
    });
  }

  // ================================================================== background
  /** Hourly: contract expiry reminders, ended contracts, onboarding checklists for new hires. */
  async sweep(): Promise<number> {
    let n = 0;
    const today = await this.settings.today();
    const days = await this.settings.get('contracts.reminder_days');
    await this.dataSource.transaction(async (m) => {
      const due: { id: string; employee_id: string; staff_number: string; name: string; end_date: string }[] = await m.query(
        `SELECT c.id, c.employee_id, e.staff_number, e.first_name || ' ' || e.last_name AS name, to_char(c.end_date, 'YYYY-MM-DD') AS end_date FROM employee_contract c JOIN employee e ON e.id = c.employee_id
          WHERE c.status = 'active' AND c.end_date IS NOT NULL AND c.reminded_at IS NULL AND c.end_date <= $1::date + $2::int AND c.end_date >= $1::date AND e.status <> 'exited'`,
        [today, days],
      );
      for (const c of due) {
        const left = daysBetween(today, c.end_date);
        await this.outbox.record(m, 'hr.contract.expiring.v1', c.employee_id, { contract_id: c.id, employee_id: c.employee_id, staff_number: c.staff_number, end_date: c.end_date, days_left: left });
        await this.notifications.notifyPermissionHolders('contract:manage', 'contract_expiring', { name: c.name, end_date: c.end_date, days_left: left }, '/lifecycle/contracts', m);
        await m.query(`UPDATE employee_contract SET reminded_at = now() WHERE id = $1`, [c.id]);
        n++;
      }
      const ended = await m.query(`UPDATE employee_contract SET status = 'ended', updated_at = now(), version = version + 1 WHERE status = 'active' AND end_date < $1 RETURNING id`, [today]);
      n += (ended[0] as unknown[] | undefined)?.length ?? 0;
      const hires: { id: string; hire: string }[] = await m.query(
        `SELECT e.id, to_char(e.hire_date, 'YYYY-MM-DD') AS hire FROM employee e WHERE e.status IN ('onboarding', 'probation', 'active') AND e.hire_date >= $1::date - 30 AND NOT EXISTS (SELECT 1 FROM checklist c WHERE c.employee_id = e.id AND c.kind = 'onboarding')`,
        [today],
      );
      for (const h of hires) if (await this.startChecklist(m, h.id, 'onboarding', h.hire)) n++;
    });
    return n;
  }

}
