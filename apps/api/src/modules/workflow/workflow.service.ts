import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, IsNull, LessThan } from 'typeorm';
import { REQUEST_TYPES, type InboxItem, type UpsertWorkflowDefinition, type WorkflowDefinition as DefinitionDto, type WorkflowInstance as InstanceDto } from '@sil/hr-shared';
import { AccessProfile } from '../../common/access';
import { iso } from '../../common/base.entity';
import { assertVersion } from '../../common/etag';
import { conflict, forbidden, notFound, ProblemException, unprocessable } from '../../common/problem';
import { writeAudit } from '../audit/audit.subscriber';
import { NotificationsService } from '../notifications/notifications.module';
import { SettingsService } from '../settings/settings.module';
import { WorkflowDefinition, WorkflowDelegation, WorkflowInstance, WorkflowStep, WorkflowTask } from './workflow.entities';

/** What a domain module tells the engine when it submits. */
export interface SubmitRequest {
  requestType: keyof typeof REQUEST_TYPES;
  subjectId: string;
  subjectEmployeeId: string | null;
  requesterUserId: string | null;
  /** Sub-kind used by definition conditions (e.g. the leave type code). */
  kind?: string;
  /** Number used by thresholds (days of leave, an amount…). */
  value?: number | null;
  summary: string;
  context?: Record<string, unknown>;
}

/** Domain callbacks; they run inside the decision's transaction, so they can still veto it. */
export interface WorkflowHandler {
  onApproved(m: EntityManager, instance: WorkflowInstance, actorUserId: string): Promise<void>;
  onRejected(m: EntityManager, instance: WorkflowInstance, comment: string | null): Promise<void>;
  onReturned(m: EntityManager, instance: WorkflowInstance, comment: string | null): Promise<void>;
}

/** Tells the engine whether a person is away (approved leave today); provided by the leave module. */
export type AvailabilityResolver = (m: EntityManager, employeeId: string, date: string) => Promise<boolean>;

interface Resolved {
  userId: string | null;
  roleId: string | null;
  onBehalfOf: string | null;
  note?: string;
}

const MAX_HOPS = 10;

/**
 * The approval engine. A definition (matched on request type, conditions and priority)
 * lists ordered steps; each resolves its approver by rule when it becomes current.
 * Requesters never approve their own request; an approver who delegated, or is on
 * leave, is replaced by their delegate or their own manager; a step nobody can take
 * goes to the workflow administrators' pool rather than being silently skipped.
 */
@Injectable()
export class WorkflowService {
  private readonly logger = new Logger('Workflow');
  private readonly handlers = new Map<string, WorkflowHandler>();
  private isAway: AvailabilityResolver = async () => false;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly notifications: NotificationsService,
    private readonly settings: SettingsService,
  ) {}

  registerHandler(requestType: string, handler: WorkflowHandler): void {
    this.handlers.set(requestType, handler);
  }

  registerAvailability(fn: AvailabilityResolver): void {
    this.isAway = fn;
  }

  // ------------------------------------------------------------------ definitions
  private defDto(d: WorkflowDefinition): DefinitionDto {
    return {
      id: d.id, code: d.code, name: d.name, request_type: d.requestType, description: d.description, conditions: d.conditions, priority: d.priority, is_active: d.isActive,
      steps: (d.steps ?? []).sort((a, b) => a.stepNo - b.stepNo).map((s) => ({ id: s.id, step_no: s.stepNo, name: s.name, approver_rule: s.approverRule, level: s.level, role_id: s.roleId, user_id: s.userId, min_value: s.minValue, escalate_after_hours: s.escalateAfterHours, escalate_to: s.escalateTo, escalate_role_id: s.escalateRoleId })),
      created_at: d.createdAt.toISOString(), updated_at: d.updatedAt.toISOString(), version: d.version,
    };
  }

  async definitions(): Promise<DefinitionDto[]> {
    return (await this.dataSource.getRepository(WorkflowDefinition).find({ relations: { steps: true }, order: { requestType: 'ASC', priority: 'DESC' } })).map((d) => this.defDto(d));
  }

  async saveDefinition(dto: UpsertWorkflowDefinition, id?: string, version?: number): Promise<DefinitionDto> {
    return this.dataSource.transaction(async (m) => {
      const repo = m.getRepository(WorkflowDefinition);
      let d: WorkflowDefinition;
      if (id) {
        const found = await repo.findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
        if (!found) throw notFound('Workflow');
        if (version !== undefined) assertVersion(found.version, version);
        d = found;
      } else {
        d = repo.create();
      }
      Object.assign(d, { code: dto.code, name: dto.name, requestType: dto.request_type, description: dto.description ?? null, conditions: dto.conditions, priority: dto.priority, isActive: dto.is_active });
      d = await repo.save(d);
      // Steps are replaced as a whole; running instances keep the tasks they already have.
      const before = await m.getRepository(WorkflowStep).findBy({ definitionId: d.id });
      await m.getRepository(WorkflowStep).delete({ definitionId: d.id });
      await m.getRepository(WorkflowStep).insert(
        dto.steps.map((s, i) => ({
          definitionId: d.id, stepNo: i + 1, name: s.name, approverRule: s.approver_rule, level: s.level ?? null, roleId: s.role_id ?? null, userId: s.user_id ?? null,
          minValue: s.min_value ?? null, escalateAfterHours: s.escalate_after_hours ?? null, escalateTo: s.escalate_to ?? null, escalateRoleId: s.escalate_role_id ?? null,
        })),
      );
      await writeAudit(m, { action: 'update', entityType: 'WorkflowDefinition', entityId: d.id, before: { steps: before.length }, after: { steps: dto.steps } });
      return this.defDto((await repo.findOne({ where: { id: d.id }, relations: { steps: true } }))!);
    });
  }

  /** The active definition for a request: conditions must match; highest priority wins. */
  private async match(m: EntityManager, req: SubmitRequest): Promise<WorkflowDefinition> {
    const defs = await m.getRepository(WorkflowDefinition).find({ where: { requestType: req.requestType, isActive: true }, relations: { steps: true }, order: { priority: 'DESC', createdAt: 'ASC' } });
    let deptPath: string[] = [];
    let employmentType: string | null = null;
    if (req.subjectEmployeeId) {
      const [e] = await m.query(`SELECT e.employment_type, d.id AS dept, d.path FROM employee e LEFT JOIN department d ON d.id = e.department_id WHERE e.id = $1`, [req.subjectEmployeeId]);
      if (e) {
        deptPath = e.dept ? [...e.path, e.dept] : [];
        employmentType = e.employment_type;
      }
    }
    const ok = (d: WorkflowDefinition) => {
      const c = d.conditions ?? {};
      if (c.kinds?.length && !(req.kind && c.kinds.includes(req.kind))) return false;
      if (c.employment_types?.length && !(employmentType && c.employment_types.includes(employmentType))) return false;
      if (c.department_ids?.length && !c.department_ids.some((id) => deptPath.includes(id))) return false;
      if (c.min_value !== undefined && (req.value ?? 0) < c.min_value) return false;
      if (c.max_value !== undefined && (req.value ?? 0) > c.max_value) return false;
      return true;
    };
    const found = defs.find(ok);
    if (!found || !found.steps?.length) throw new ProblemException(422, 'no_workflow', `No active approval workflow matches this ${REQUEST_TYPES[req.requestType] ?? req.requestType}; ask an administrator to set one up`);
    return found;
  }

  // ------------------------------------------------------------------ running
  async submit(m: EntityManager, req: SubmitRequest): Promise<WorkflowInstance> {
    if (!m.queryRunner?.isTransactionActive) throw new Error('Submit inside the domain transaction');
    const def = await this.match(m, req);
    if (await m.getRepository(WorkflowInstance).existsBy({ requestType: req.requestType, subjectId: req.subjectId, status: 'pending' })) {
      throw conflict('already_pending', 'This request is already waiting for approval');
    }
    const instance = await m.getRepository(WorkflowInstance).save(
      m.getRepository(WorkflowInstance).create({
        definitionId: def.id, definitionCode: def.code, requestType: req.requestType, subjectId: req.subjectId, subjectEmployeeId: req.subjectEmployeeId,
        requesterUserId: req.requesterUserId, summary: req.summary.slice(0, 300), value: req.value ?? null, context: { ...(req.context ?? {}), kind: req.kind ?? null }, currentStepNo: null,
      }),
    );
    await this.advance(m, instance, def, 0, req.requesterUserId ?? 'system');
    return instance;
  }

  /** Opens the next applicable step after `afterStep`, or approves the instance if none is left. */
  private async advance(m: EntityManager, instance: WorkflowInstance, def: WorkflowDefinition, afterStep: number, actorUserId: string): Promise<void> {
    const steps = (def.steps ?? (await m.getRepository(WorkflowStep).findBy({ definitionId: def.id }))).sort((a, b) => a.stepNo - b.stepNo);
    for (const step of steps.filter((s) => s.stepNo > afterStep)) {
      if (step.minValue !== null && (instance.value ?? 0) < step.minValue) {
        await this.recordTask(m, instance, step, { userId: null, roleId: null, onBehalfOf: null }, 'skipped', `Below the step threshold of ${step.minValue}`);
        continue;
      }
      // Each step needs a different person: earlier approvers are passed over (the chain climbs).
      const approvedBy = await this.approvers(m, instance.id);
      const who = await this.resolve(m, instance, step, approvedBy);
      instance.currentStepNo = step.stepNo;
      await m.getRepository(WorkflowInstance).save(instance);
      await this.recordTask(m, instance, step, who, 'open', who.note ?? null);
      return;
    }
    instance.status = 'approved';
    instance.currentStepNo = null;
    instance.completedAt = new Date();
    await m.getRepository(WorkflowInstance).save(instance);
    await this.handlers.get(instance.requestType)?.onApproved(m, instance, actorUserId);
    await this.notifyRequester(m, instance, 'approved', null);
  }

  private async approvers(m: EntityManager, instanceId: string): Promise<Set<string>> {
    const rows = await m.getRepository(WorkflowTask).find({ where: { instanceId, status: 'approved' }, select: { actedBy: true } });
    return new Set(rows.map((r) => r.actedBy).filter((x): x is string => !!x));
  }

  private async recordTask(m: EntityManager, instance: WorkflowInstance, step: WorkflowStep, who: Resolved, status: 'open' | 'skipped', comment: string | null): Promise<WorkflowTask> {
    const due = status === 'open' && step.escalateAfterHours ? new Date(Date.now() + step.escalateAfterHours * 3_600_000) : null;
    const task = await m.getRepository(WorkflowTask).save(
      m.getRepository(WorkflowTask).create({ instanceId: instance.id, stepNo: step.stepNo, stepName: step.name, assigneeUserId: who.userId, candidateRoleId: who.roleId, onBehalfOfUserId: who.onBehalfOf, status, dueAt: due, comment, actedAt: status === 'skipped' ? new Date() : null }),
    );
    if (status === 'open') await this.notifyAssignees(m, instance, task);
    return task;
  }

  // ------------------------------------------------------------------ approver resolution
  private async userOf(m: EntityManager, employeeId: string | null): Promise<string | null> {
    if (!employeeId) return null;
    const [u] = await m.query(`SELECT id FROM user_account WHERE employee_id = $1 AND status = 'active' AND deleted_at IS NULL`, [employeeId]);
    return u?.id ?? null;
  }

  private async managerOf(m: EntityManager, employeeId: string): Promise<string | null> {
    const [e] = await m.query(`SELECT manager_id FROM employee WHERE id = $1`, [employeeId]);
    return e?.manager_id ?? null;
  }

  private async departmentHeadFor(m: EntityManager, employeeId: string): Promise<string | null> {
    const [d] = await m.query(`SELECT d.id, d.path FROM employee e JOIN department d ON d.id = e.department_id WHERE e.id = $1`, [employeeId]);
    if (!d) return null;
    for (const depId of [d.id, ...[...d.path].reverse()]) {
      const [row] = await m.query(
        `SELECT e.id FROM employee e JOIN position p ON p.id = e.position_id LEFT JOIN position up ON up.id = p.reports_to_position_id
          WHERE p.department_id = $1 AND e.status NOT IN ('exited', 'suspended') AND e.deleted_at IS NULL AND e.id <> $2
            AND (up.id IS NULL OR up.department_id <> $1)
          ORDER BY e.hire_date LIMIT 1`,
        [depId, employeeId],
      );
      if (row) return row.id;
    }
    return null;
  }

  /**
   * Turns a step into a person (or a role pool). Walks up the management chain when the
   * natural approver is the requester, has no login, or is away without a delegate.
   */
  private async resolve(m: EntityManager, instance: WorkflowInstance, step: WorkflowStep, approvedBy: Set<string> = new Set()): Promise<Resolved> {
    const subject = instance.subjectEmployeeId;
    const requester = instance.requesterUserId;
    const subjectUser = await this.userOf(m, subject);
    const today = await this.settings.today(m);
    const excluded = (u: string | null) => !u || u === requester || u === subjectUser || approvedBy.has(u);

    const viaDelegation = async (userId: string): Promise<Resolved | null> => {
      const del = await m
        .getRepository(WorkflowDelegation)
        .createQueryBuilder('d')
        .where('d.from_user_id = :u AND d.starts_on <= :t AND d.ends_on >= :t', { u: userId, t: today })
        .andWhere(`(cardinality(d.request_types) = 0 OR :rt = ANY(d.request_types))`, { rt: instance.requestType })
        .orderBy('d.created_at', 'DESC')
        .getOne();
      if (del && !excluded(del.toUserId)) return { userId: del.toUserId, roleId: null, onBehalfOf: userId, note: 'Delegated' };
      return null;
    };

    // Employee-based rules: start from an employee and climb while unusable.
    const fromEmployee = async (start: string | null, climb: boolean): Promise<Resolved> => {
      let emp = start;
      for (let hop = 0; emp && hop < MAX_HOPS; hop++) {
        const userId = await this.userOf(m, emp);
        if (userId && !excluded(userId)) {
          const delegated = await viaDelegation(userId);
          if (delegated) return delegated;
          const [away] = [await this.isAway(m, emp, today)];
          if (!away) return { userId, roleId: null, onBehalfOf: null };
        }
        if (!climb) break;
        emp = await this.managerOf(m, emp);
      }
      return { userId: null, roleId: null, onBehalfOf: null, note: 'No available approver: sent to the workflow administrators' };
    };

    switch (step.approverRule) {
      case 'line_manager':
        return fromEmployee(subject ? await this.managerOf(m, subject) : null, true);
      case 'manager_level': {
        let emp = subject;
        for (let i = 0; i < (step.level ?? 1) && emp; i++) emp = await this.managerOf(m, emp);
        return fromEmployee(emp, true);
      }
      case 'department_head':
        return fromEmployee(subject ? await this.departmentHeadFor(m, subject) : null, true);
      case 'user': {
        if (excluded(step.userId)) return { userId: null, roleId: null, onBehalfOf: null, note: 'The named approver is the requester: sent to the workflow administrators' };
        return (await viaDelegation(step.userId!)) ?? { userId: step.userId, roleId: null, onBehalfOf: null };
      }
      case 'role':
        // A pool: anyone holding the role may act, except the requester (checked at decision time).
        return { userId: null, roleId: step.roleId, onBehalfOf: null };
    }
  }

  // ------------------------------------------------------------------ deciding
  private async canAct(m: EntityManager, access: AccessProfile, task: WorkflowTask, instance: WorkflowInstance): Promise<boolean> {
    const me = access.actorId;
    if (me === instance.requesterUserId) return false;
    // One person, one signature per request.
    if ((await this.approvers(m, instance.id)).has(me)) return false;
    if (access.employeeId && access.employeeId === instance.subjectEmployeeId) return false;
    if (task.assigneeUserId) return task.assigneeUserId === me;
    if (task.candidateRoleId) {
      const [row] = await m.query(`SELECT 1 FROM role_assignment WHERE user_id = $1 AND role_id = $2`, [me, task.candidateRoleId]);
      // Workflow administrators may take any pool task (e.g. when the whole team is away).
      return !!row || access.has('workflow:manage');
    }
    return access.has('workflow:manage');
  }

  async decide(access: AccessProfile, taskId: string, decision: 'approve' | 'reject' | 'return', comment: string | null): Promise<InstanceDto> {
    const instanceId = await this.dataSource.transaction(async (m) => {
      const task = await m.getRepository(WorkflowTask).findOne({ where: { id: taskId }, lock: { mode: 'pessimistic_write' } });
      if (!task) throw notFound('Approval task');
      const instance = await m.getRepository(WorkflowInstance).findOne({ where: { id: task.instanceId }, lock: { mode: 'pessimistic_write' } });
      if (!instance) throw notFound('Approval request');
      if (task.status !== 'open' || instance.status !== 'pending') throw conflict('already_decided', 'This has already been dealt with');
      if (!(await this.canAct(m, access, task, instance))) throw forbidden('This approval is not yours to decide', 'not_assignee');

      Object.assign(task, { status: decision === 'approve' ? 'approved' : decision === 'reject' ? 'rejected' : 'returned', actedAt: new Date(), actedBy: access.actorId, comment: comment ?? task.comment });
      await m.getRepository(WorkflowTask).save(task);
      await writeAudit(m, { action: decision === 'approve' ? 'approve' : decision === 'reject' ? 'reject' : 'return', entityType: `Workflow:${instance.requestType}`, entityId: instance.subjectId, after: { step: task.stepNo, comment, onBehalfOf: task.onBehalfOfUserId } });

      if (decision === 'approve') {
        const def = await m.getRepository(WorkflowDefinition).findOneOrFail({ where: { id: instance.definitionId }, relations: { steps: true } });
        await this.advance(m, instance, def, task.stepNo, access.actorId);
      } else {
        instance.status = decision === 'reject' ? 'rejected' : 'returned';
        instance.currentStepNo = null;
        instance.completedAt = new Date();
        await m.getRepository(WorkflowInstance).save(instance);
        await m.getRepository(WorkflowTask).update({ instanceId: instance.id, status: 'open' }, { status: 'cancelled' });
        const h = this.handlers.get(instance.requestType);
        if (decision === 'reject') await h?.onRejected(m, instance, comment);
        else await h?.onReturned(m, instance, comment);
        await this.notifyRequester(m, instance, decision === 'reject' ? 'rejected' : 'returned for correction', comment);
      }
      return instance.id;
    });
    return this.instance(instanceId);
  }

  /** The requester withdrew (or the subject changed): open tasks are cancelled. */
  async cancel(m: EntityManager, requestType: string, subjectId: string): Promise<void> {
    const inst = await m.getRepository(WorkflowInstance).findOneBy({ requestType, subjectId, status: 'pending' });
    if (!inst) return;
    inst.status = 'cancelled';
    inst.completedAt = new Date();
    await m.getRepository(WorkflowInstance).save(inst);
    await m.getRepository(WorkflowTask).update({ instanceId: inst.id, status: 'open' }, { status: 'cancelled' });
  }

  /** Worker: open tasks past their due time move to the escalation target. */
  async escalateDue(): Promise<number> {
    let n = 0;
    const due = await this.dataSource.getRepository(WorkflowTask).find({ where: { status: 'open', dueAt: LessThan(new Date()) }, take: 100 });
    for (const t of due) {
      await this.dataSource.transaction(async (m) => {
        const task = await m.getRepository(WorkflowTask).findOne({ where: { id: t.id, status: 'open' }, lock: { mode: 'pessimistic_write' } });
        if (!task) return;
        const instance = await m.getRepository(WorkflowInstance).findOneByOrFail({ id: task.instanceId });
        const step = await m.getRepository(WorkflowStep).findOneBy({ definitionId: instance.definitionId, stepNo: task.stepNo });
        let who: Resolved = { userId: null, roleId: null, onBehalfOf: null, note: 'Escalated to the workflow administrators' };
        if (step?.escalateTo === 'role' && step.escalateRoleId) who = { userId: null, roleId: step.escalateRoleId, onBehalfOf: null, note: 'Escalated' };
        if (step?.escalateTo === 'next_manager' && task.assigneeUserId) {
          const [u] = await m.query(`SELECT employee_id FROM user_account WHERE id = $1`, [task.assigneeUserId]);
          const mgr = u?.employee_id ? await this.managerOf(m, u.employee_id) : null;
          const mgrUser = await this.userOf(m, mgr);
          if (mgrUser && mgrUser !== instance.requesterUserId) who = { userId: mgrUser, roleId: null, onBehalfOf: task.assigneeUserId, note: 'Escalated' };
        }
        task.status = 'escalated';
        task.actedAt = new Date();
        await m.getRepository(WorkflowTask).save(task);
        const next = await m.getRepository(WorkflowTask).save(
          m.getRepository(WorkflowTask).create({ instanceId: instance.id, stepNo: task.stepNo, stepName: task.stepName, assigneeUserId: who.userId, candidateRoleId: who.roleId, onBehalfOfUserId: who.onBehalfOf, status: 'open', dueAt: null, comment: who.note ?? null }),
        );
        await this.notifyAssignees(m, instance, next);
        n++;
      });
    }
    return n;
  }

  // ------------------------------------------------------------------ reading
  private async names(ids: (string | null)[]): Promise<Map<string, string>> {
    const list = [...new Set(ids.filter((x): x is string => !!x))];
    if (!list.length) return new Map();
    const rows: { id: string; display_name: string }[] = await this.dataSource.query(`SELECT id, display_name FROM user_account WHERE id = ANY($1::uuid[])`, [list]);
    return new Map(rows.map((r) => [r.id, r.display_name]));
  }

  async instance(id: string, access?: AccessProfile): Promise<InstanceDto> {
    const i = await this.dataSource.getRepository(WorkflowInstance).findOne({ where: { id }, relations: { tasks: true } });
    if (!i) throw notFound('Approval request');
    if (access && !access.has('workflow:read') && i.requesterUserId !== access.actorId && !(i.tasks ?? []).some((t) => t.assigneeUserId === access.actorId || t.actedBy === access.actorId)) {
      throw notFound('Approval request');
    }
    const names = await this.names((i.tasks ?? []).flatMap((t) => [t.assigneeUserId, t.actedBy]));
    const [emp] = i.subjectEmployeeId ? await this.dataSource.query(`SELECT first_name || ' ' || last_name AS name FROM employee WHERE id = $1`, [i.subjectEmployeeId]) : [];
    return {
      id: i.id, request_type: i.requestType, subject_id: i.subjectId, subject_employee_id: i.subjectEmployeeId, subject_employee_name: emp?.name ?? null, requester_user_id: i.requesterUserId,
      definition_code: i.definitionCode, status: i.status, current_step_no: i.currentStepNo, summary: i.summary, value: i.value, submitted_at: i.createdAt.toISOString(), completed_at: iso(i.completedAt),
      tasks: (i.tasks ?? []).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()).map((t) => ({
        id: t.id, instance_id: t.instanceId, step_no: t.stepNo, step_name: t.stepName, assignee_user_id: t.assigneeUserId, assignee_name: (t.assigneeUserId && names.get(t.assigneeUserId)) || (t.actedBy && names.get(t.actedBy)) || null,
        on_behalf_of_user_id: t.onBehalfOfUserId, status: t.status, due_at: iso(t.dueAt), acted_at: iso(t.actedAt), comment: t.comment, created_at: t.createdAt.toISOString(),
      })),
    };
  }

  async instanceFor(requestType: string, subjectId: string): Promise<InstanceDto | null> {
    const i = await this.dataSource.getRepository(WorkflowInstance).findOne({ where: { requestType, subjectId }, order: { createdAt: 'DESC' } });
    return i ? this.instance(i.id) : null;
  }

  /** Open tasks I can act on: mine, my roles' pools, and (for administrators) unassigned ones. */
  async inbox(access: AccessProfile, requestType?: string): Promise<InboxItem[]> {
    const params: unknown[] = [access.actorId];
    let pools = `t.assignee_user_id = $1 OR (t.assignee_user_id IS NULL AND t.candidate_role_id IN (SELECT role_id FROM role_assignment WHERE user_id = $1))`;
    if (access.has('workflow:manage')) pools += ` OR (t.assignee_user_id IS NULL AND t.candidate_role_id IS NULL)`;
    let filter = '';
    if (requestType) {
      params.push(requestType);
      filter = ` AND i.request_type = $2`;
    }
    const rows: Record<string, unknown>[] = await this.dataSource.query(
      `SELECT t.id, t.instance_id, t.step_no, t.step_name, t.assignee_user_id, t.on_behalf_of_user_id, t.status, t.due_at, t.acted_at, t.comment, t.created_at,
              i.request_type, i.subject_id, i.subject_employee_id, i.summary, i.value, i.created_at AS submitted_at, i.requester_user_id,
              e.first_name || ' ' || e.last_name AS subject_employee_name, u.display_name AS assignee_name
         FROM workflow_task t JOIN workflow_instance i ON i.id = t.instance_id
         LEFT JOIN employee e ON e.id = i.subject_employee_id
         LEFT JOIN user_account u ON u.id = t.assignee_user_id
        WHERE t.status = 'open' AND i.status = 'pending' AND (${pools})${filter}
          AND i.requester_user_id IS DISTINCT FROM $1
        ORDER BY t.created_at`,
      params,
    );
    const iso2 = (d: unknown) => (d ? new Date(d as string).toISOString() : null);
    return rows
      .filter((r) => !(access.employeeId && r.subject_employee_id === access.employeeId))
      .map((r) => ({
        id: r.id as string, instance_id: r.instance_id as string, step_no: r.step_no as number, step_name: r.step_name as string, assignee_user_id: (r.assignee_user_id as string) ?? null,
        assignee_name: (r.assignee_name as string) ?? null, on_behalf_of_user_id: (r.on_behalf_of_user_id as string) ?? null, status: 'open' as const, due_at: iso2(r.due_at), acted_at: null,
        comment: (r.comment as string) ?? null, created_at: iso2(r.created_at)!, request_type: r.request_type as string, subject_id: r.subject_id as string,
        subject_employee_id: (r.subject_employee_id as string) ?? null, subject_employee_name: (r.subject_employee_name as string) ?? null, summary: r.summary as string,
        value: r.value === null ? null : Number(r.value), submitted_at: iso2(r.submitted_at)!,
      }));
  }

  // ------------------------------------------------------------------ delegations
  async delegations(access: AccessProfile) {
    const where = access.has('workflow:manage') ? {} : [{ fromUserId: access.actorId }, { toUserId: access.actorId }];
    const rows = await this.dataSource.getRepository(WorkflowDelegation).find({ where: where as never, order: { startsOn: 'DESC' } });
    const names = await this.names(rows.flatMap((d) => [d.fromUserId, d.toUserId]));
    return rows.map((d) => ({ id: d.id, from_user_id: d.fromUserId, from_name: names.get(d.fromUserId) ?? null, to_user_id: d.toUserId, to_name: names.get(d.toUserId) ?? null, starts_on: d.startsOn, ends_on: d.endsOn, request_types: d.requestTypes, reason: d.reason, created_at: d.createdAt.toISOString() }));
  }

  async createDelegation(access: AccessProfile, input: { from_user_id?: string; to_user_id?: string; to_employee_id?: string; starts_on: string; ends_on: string; request_types: string[]; reason?: string | null }) {
    let toUser = input.to_user_id;
    if (!toUser && input.to_employee_id) {
      const [u] = await this.dataSource.query(`SELECT id FROM user_account WHERE employee_id = $1 AND status = 'active' AND deleted_at IS NULL`, [input.to_employee_id]);
      if (!u) throw unprocessable('no_login', 'That person has no active SIL HR login', [{ path: 'to_employee_id', message: 'No login' }]);
      toUser = u.id;
    }
    const dto = { ...input, to_user_id: toUser! };
    const from = dto.from_user_id ?? access.actorId;
    if (from !== access.actorId && !access.has('workflow:manage')) throw forbidden('You can only delegate your own approvals');
    if (from === dto.to_user_id) throw unprocessable('self_delegation', 'Choose someone else', [{ path: 'to_user_id', message: 'Same person' }]);
    const [to] = await this.dataSource.query(`SELECT id FROM user_account WHERE id = $1 AND status = 'active' AND deleted_at IS NULL`, [dto.to_user_id]);
    if (!to) throw unprocessable('user_not_found', 'That person has no active account', [{ path: 'to_user_id', message: 'Not found' }]);
    const repo = this.dataSource.getRepository(WorkflowDelegation);
    const d = await repo.save(repo.create({ fromUserId: from, toUserId: dto.to_user_id, startsOn: dto.starts_on, endsOn: dto.ends_on, requestTypes: dto.request_types, reason: dto.reason ?? null }));
    return (await this.delegations(access)).find((x) => x.id === d.id)!;
  }

  async removeDelegation(access: AccessProfile, id: string): Promise<void> {
    const repo = this.dataSource.getRepository(WorkflowDelegation);
    const d = await repo.findOneBy({ id });
    if (!d || (d.fromUserId !== access.actorId && !access.has('workflow:manage'))) throw notFound('Delegation');
    await repo.remove(d);
  }

  // ------------------------------------------------------------------ notifications
  private async notifyAssignees(m: EntityManager, instance: WorkflowInstance, task: WorkflowTask): Promise<void> {
    const link = `/approvals?task=${task.id}`;
    const vars = { summary: instance.summary, step: task.stepName };
    if (task.assigneeUserId) await this.notifications.notifyUsers([task.assigneeUserId], 'approval_task_assigned', vars, link, m);
    else if (task.candidateRoleId) {
      const users: { user_id: string }[] = await m.query(`SELECT DISTINCT user_id FROM role_assignment WHERE role_id = $1`, [task.candidateRoleId]);
      await this.notifications.notifyUsers(users.map((u) => u.user_id).filter((u) => u !== instance.requesterUserId), 'approval_task_assigned', vars, link, m);
    } else await this.notifications.notifyPermissionHolders('workflow:manage', 'approval_task_assigned', vars, link, m);
  }

  private async notifyRequester(m: EntityManager, instance: WorkflowInstance, outcome: string, comment: string | null): Promise<void> {
    if (!instance.requesterUserId) return;
    await this.notifications.notifyUsers([instance.requesterUserId], 'approval_decided', { summary: instance.summary, outcome, comment: comment ?? '' }, null, m);
  }

  /** For tests and the admin view. */
  openTasks(instanceId: string) {
    return this.dataSource.getRepository(WorkflowTask).find({ where: { instanceId, status: 'open' } });
  }

  async tasksAssignedTo(userId: string) {
    return this.dataSource.getRepository(WorkflowTask).find({ where: { assigneeUserId: userId, status: 'open', actedAt: IsNull() } });
  }

  async instancesFor(subjectIds: string[]) {
    return subjectIds.length ? this.dataSource.getRepository(WorkflowInstance).find({ where: { subjectId: In(subjectIds) } }) : [];
  }
}
