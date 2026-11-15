import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import Decimal from 'decimal.js';
import { DataSource, EntityManager } from 'typeorm';
import { z } from 'zod';
import { createClaim, createTravel, expenseItemFields } from '@sil/hr-shared';
import { AccessProfile, applyScope, scopeAllows } from '../../common/access';
import { conflict, forbidden, notFound, unprocessable } from '../../common/problem';
import { DocumentsService } from '../documents/documents.module';
import { OutboxService } from '../events/events.module';
import { NumberingService } from '../numbering/numbering.module';
import { ScopeService } from '../organisation/scope.service';
import { SettingsService } from '../settings/settings.module';
import { WorkflowInstance } from '../workflow/workflow.entities';
import { WorkflowService } from '../workflow/workflow.service';
import { ExpenseClaim, ExpenseItem, TravelRequest } from './expenses.entities';

type Dto<T extends z.ZodType> = z.infer<T>;
const m2 = (x: Decimal.Value) => new Decimal(x).toFixed(2);
const nextPeriod = (p: string) => {
  const [y, mo] = p.split('-').map(Number);
  return mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`;
};

/** Payroll components the module pays through (seeded; codes are fixed). */
export const EXPENSE_COMPONENTS = { reimbursement: 'EXPENSE_REIMB', advance: 'TRAVEL_ADV', recovery: 'ADV_RECOVERY' } as const;

interface Emp { id: string; name: string; staff_number: string; department_name: string | null; branch_id: string | null; department_id: string | null; cost_centre_id: string | null }

@Injectable()
export class ExpensesService implements OnModuleInit {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly settings: SettingsService,
    private readonly workflow: WorkflowService,
    private readonly outbox: OutboxService,
    private readonly numbering: NumberingService,
    private readonly scope: ScopeService,
    private readonly docs: DocumentsService,
  ) {}

  onModuleInit(): void {
    this.workflow.registerHandler('travel_request', {
      onApproved: (m, i) => this.travelDecided(m, i, 'approved', null),
      onRejected: (m, i, c) => this.travelDecided(m, i, 'rejected', c),
      onReturned: (m, i, c) => this.travelDecided(m, i, 'returned', c),
    });
    this.workflow.registerHandler('expense_claim', {
      onApproved: (m, i) => this.claimApproved(m, i),
      onRejected: (m, i, c) => this.claimDecided(m, i, 'rejected', c),
      onReturned: (m, i, c) => this.claimDecided(m, i, 'returned', c),
    });
  }

  private async emp(m: EntityManager, id: string): Promise<Emp> {
    const [e] = await m.query(
      `SELECT e.id, e.first_name || ' ' || e.last_name AS name, e.staff_number, d.name AS department_name, e.branch_id, e.department_id, e.cost_centre_id
         FROM employee e LEFT JOIN department d ON d.id = e.department_id WHERE e.id = $1`,
      [id],
    );
    if (!e) throw notFound('Employee');
    return e;
  }

  private async canSee(access: AccessProfile, e: Emp) {
    if (access.employeeId === e.id) return true;
    return access.has('expense:read') && scopeAllows(await this.scope.filterFor(access, 'expense:read'), { branchId: e.branch_id, departmentId: e.department_id, employeeId: e.id });
  }

  /** The first payroll month that is still open: this month unless its payroll is already approved. */
  async payablePeriod(m: EntityManager): Promise<string> {
    let p = (await this.settings.today(m)).slice(0, 7);
    for (let i = 0; i < 24; i++) {
      const [r] = await m.query(`SELECT status FROM payroll_run WHERE period = $1`, [p]);
      if (!r || ['draft', 'calculated', 'under_review'].includes(r.status)) return p;
      p = nextPeriod(p);
    }
    return p;
  }

  private async payOneOff(m: EntityManager, employeeId: string, code: string, period: string, amount: Decimal, note: string) {
    if (amount.lte(0)) return;
    const [c] = await m.query(`SELECT id FROM pay_component WHERE code = $1`, [code]);
    if (!c) throw conflict('component_missing', `Pay component ${code} is missing; run the seed`);
    await m.query(`INSERT INTO payroll_one_off (employee_id, component_id, period, amount, note) VALUES ($1, $2, $3, $4, $5)`, [employeeId, c.id, period, amount.toFixed(2), note.slice(0, 300)]);
  }

  // ================================================================== travel
  private async travelDto(m: EntityManager, t: TravelRequest) {
    const e = await this.emp(m, t.employeeId);
    const [c] = await m.query(`SELECT id FROM expense_claim WHERE travel_request_id = $1 AND status NOT IN ('rejected', 'cancelled') LIMIT 1`, [t.id]);
    return {
      id: t.id, number: t.number, employee_id: e.id, employee_name: e.name, staff_number: e.staff_number, department_name: e.department_name, purpose: t.purpose, destination: t.destination, depart_on: t.departOn, return_on: t.returnOn,
      estimated_cost: m2(t.estimatedCost), advance: m2(t.advance), advance_period: t.advancePeriod, status: t.status, decision_comment: t.decisionComment, workflow_instance_id: t.workflowInstanceId, claim_id: c?.id ?? null,
      created_at: t.createdAt.toISOString(), updated_at: t.updatedAt.toISOString(), version: t.version,
    };
  }

  async requestTravel(access: AccessProfile, dto: Dto<typeof createTravel>) {
    if (!access.employeeId) throw forbidden('Your account is not linked to an employee record');
    const id = await this.dataSource.transaction(async (m) => {
      const e = await this.emp(m, access.employeeId!);
      const t = await m.getRepository(TravelRequest).save(m.getRepository(TravelRequest).create({
        number: await this.numbering.next('travel_request', { manager: m }), employeeId: e.id, purpose: dto.purpose, destination: dto.destination, departOn: dto.depart_on, returnOn: dto.return_on, estimatedCost: dto.estimated_cost, advance: dto.advance, status: 'pending',
      }));
      const adv = new Decimal(dto.advance).gt(0);
      const i = await this.workflow.submit(m, { requestType: 'travel_request', kind: adv ? 'advance' : 'no_advance', subjectId: t.id, subjectEmployeeId: e.id, requesterUserId: access.actorId, value: Number(dto.estimated_cost), summary: `${e.name}: trip to ${dto.destination} (${dto.depart_on} to ${dto.return_on})${adv ? `, advance KES ${m2(dto.advance)}` : ''}` });
      t.workflowInstanceId = i.id;
      await m.getRepository(TravelRequest).save(t);
      return t.id;
    });
    return this.travelDto(this.dataSource.manager, (await this.dataSource.getRepository(TravelRequest).findOneBy({ id }))!);
  }

  private async travelDecided(m: EntityManager, i: WorkflowInstance, status: 'approved' | 'rejected' | 'returned', comment: string | null) {
    const t = await m.getRepository(TravelRequest).findOneByOrFail({ id: i.subjectId });
    Object.assign(t, { status, decisionComment: comment });
    if (status === 'approved' && new Decimal(t.advance).gt(0)) {
      t.advancePeriod = await this.payablePeriod(m);
      await this.payOneOff(m, t.employeeId, EXPENSE_COMPONENTS.advance, t.advancePeriod, new Decimal(t.advance), `Travel advance ${t.number}`);
    }
    await m.getRepository(TravelRequest).save(t);
  }

  async cancelTravel(access: AccessProfile, id: string) {
    await this.dataSource.transaction(async (m) => {
      const t = await m.getRepository(TravelRequest).findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
      if (!t || t.employeeId !== access.employeeId) throw notFound('Travel request');
      if (!['pending', 'returned'].includes(t.status)) throw conflict('locked', `The request is ${t.status}`);
      await this.workflow.cancel(m, 'travel_request', t.id);
      t.status = 'cancelled';
      await m.getRepository(TravelRequest).save(t);
    });
    return this.travelDto(this.dataSource.manager, (await this.dataSource.getRepository(TravelRequest).findOneBy({ id }))!);
  }

  async travelRequests(access: AccessProfile, q: { status?: string; employee_id?: string }, mine: boolean) {
    const m = this.dataSource.manager;
    const qb = m.getRepository(TravelRequest).createQueryBuilder('t').innerJoin('employee', 'e', 'e.id = t.employee_id').orderBy('t.createdAt', 'DESC').limit(500);
    if (mine) qb.andWhere('t.employee_id = :me', { me: access.employeeId ?? '00000000-0000-0000-0000-000000000000' });
    else applyScope(qb, await this.scope.filterFor(access, 'expense:read'), { branch: 'e.branch_id', department: 'e.department_id', employee: 'e.id' });
    if (q.status) qb.andWhere('t.status = :s', { s: q.status });
    if (q.employee_id) qb.andWhere('t.employee_id = :e', { e: q.employee_id });
    return Promise.all((await qb.getMany()).map((t) => this.travelDto(m, t)));
  }

  // ================================================================== claims
  private async claimDto(m: EntityManager, c: ExpenseClaim) {
    const e = await this.emp(m, c.employeeId);
    const items = await m.getRepository(ExpenseItem).find({ where: { claimId: c.id }, order: { spentOn: 'ASC' } });
    const [t] = c.travelRequestId ? await m.query(`SELECT number FROM travel_request WHERE id = $1`, [c.travelRequestId]) : [];
    return {
      id: c.id, number: c.number, employee_id: e.id, employee_name: e.name, staff_number: e.staff_number, department_name: e.department_name, travel_request_id: c.travelRequestId, travel_number: t?.number ?? null, title: c.title,
      total: m2(c.total), advance_offset: m2(c.advanceOffset), net: m2(new Decimal(c.total).minus(c.advanceOffset)), status: c.status, paid_period: c.paidPeriod, decision_comment: c.decisionComment, workflow_instance_id: c.workflowInstanceId,
      items: items.map((x) => ({ id: x.id, spent_on: x.spentOn, category: x.category as 'other', description: x.description, amount: m2(x.amount), receipt_document_id: x.receiptDocumentId })),
      created_at: c.createdAt.toISOString(), updated_at: c.updatedAt.toISOString(), version: c.version,
    };
  }

  async claim(access: AccessProfile, id: string) {
    const m = this.dataSource.manager;
    const c = await m.getRepository(ExpenseClaim).findOneBy({ id });
    if (!c || !(await this.canSee(access, await this.emp(m, c.employeeId)))) throw notFound('Expense claim');
    return this.claimDto(m, c);
  }

  async claims(access: AccessProfile, q: { status?: string; employee_id?: string }, mine: boolean) {
    const m = this.dataSource.manager;
    const qb = m.getRepository(ExpenseClaim).createQueryBuilder('c').innerJoin('employee', 'e', 'e.id = c.employee_id').orderBy('c.createdAt', 'DESC').limit(500);
    if (mine) qb.andWhere('c.employee_id = :me', { me: access.employeeId ?? '00000000-0000-0000-0000-000000000000' });
    else applyScope(qb, await this.scope.filterFor(access, 'expense:read'), { branch: 'e.branch_id', department: 'e.department_id', employee: 'e.id' });
    if (q.status) qb.andWhere('c.status = :s', { s: q.status });
    if (q.employee_id) qb.andWhere('c.employee_id = :e', { e: q.employee_id });
    return Promise.all((await qb.getMany()).map((c) => this.claimDto(m, c)));
  }

  async createClaim(access: AccessProfile, dto: Dto<typeof createClaim>) {
    if (!access.employeeId) throw forbidden('Your account is not linked to an employee record');
    const id = await this.dataSource.transaction(async (m) => {
      if (dto.travel_request_id) {
        const t = await m.getRepository(TravelRequest).findOneBy({ id: dto.travel_request_id });
        if (!t || t.employeeId !== access.employeeId) throw unprocessable('travel_not_found', 'Unknown travel request', [{ path: 'travel_request_id', message: 'Not found' }]);
        if (t.status !== 'approved') throw unprocessable('travel_not_approved', 'Claim against an approved trip', [{ path: 'travel_request_id', message: `Trip is ${t.status}` }]);
        if ((await m.query(`SELECT 1 FROM expense_claim WHERE travel_request_id = $1 AND status NOT IN ('rejected', 'cancelled')`, [t.id])).length) throw conflict('claim_exists', 'That trip already has a claim');
      }
      const c = await m.getRepository(ExpenseClaim).save(m.getRepository(ExpenseClaim).create({ number: await this.numbering.next('expense_claim', { manager: m }), employeeId: access.employeeId!, travelRequestId: dto.travel_request_id ?? null, title: dto.title, status: 'draft' }));
      return c.id;
    });
    return this.claim(access, id);
  }

  private async editable(m: EntityManager, access: AccessProfile, id: string) {
    const c = await m.getRepository(ExpenseClaim).findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
    if (!c || c.employeeId !== access.employeeId) throw notFound('Expense claim');
    if (!['draft', 'returned'].includes(c.status)) throw conflict('locked', `The claim is ${c.status}`);
    return c;
  }

  private async retotal(m: EntityManager, c: ExpenseClaim) {
    const [{ t }] = await m.query(`SELECT coalesce(sum(amount), 0)::text AS t FROM expense_item WHERE claim_id = $1`, [c.id]);
    c.total = t;
    await m.getRepository(ExpenseClaim).save(c);
  }

  async addItem(access: AccessProfile, id: string, f: Dto<typeof expenseItemFields>, receipt: Express.Multer.File | undefined) {
    await this.dataSource.transaction(async (m) => {
      const c = await this.editable(m, access, id);
      if (f.spent_on > (await this.settings.today(m))) throw unprocessable('future', 'The date is in the future', [{ path: 'spent_on', message: 'In the future' }]);
      const [{ n }] = await m.query(`SELECT count(*)::int AS n FROM expense_item WHERE claim_id = $1`, [id]);
      if (n >= 50) throw unprocessable('too_many', 'At most 50 items on one claim');
      const doc = receipt ? await this.docs.create({ owner_type: 'expense_claim', owner_id: c.id, title: `Receipt: ${f.description}`.slice(0, 200), category: 'receipt', is_sensitive: 'false' }, receipt, access.actorId) : null;
      await m.getRepository(ExpenseItem).insert({ claimId: c.id, spentOn: f.spent_on, category: f.category, description: f.description, amount: f.amount, receiptDocumentId: doc?.id ?? null });
      await this.retotal(m, c);
    });
    return this.claim(access, id);
  }

  async removeItem(access: AccessProfile, id: string, itemId: string) {
    await this.dataSource.transaction(async (m) => {
      const c = await this.editable(m, access, id);
      const r = await m.getRepository(ExpenseItem).delete({ id: itemId, claimId: c.id });
      if (!r.affected) throw notFound('Item');
      await this.retotal(m, c);
    });
    return this.claim(access, id);
  }

  async submit(access: AccessProfile, id: string) {
    await this.dataSource.transaction(async (m) => {
      const c = await this.editable(m, access, id);
      const items = await m.getRepository(ExpenseItem).findBy({ claimId: c.id });
      if (!items.length) throw unprocessable('no_items', 'Add at least one item');
      const limit = await this.settings.get('expenses.receipt_required_above', m);
      const missing = items.filter((x) => !x.receiptDocumentId && new Decimal(x.amount).gt(limit));
      if (missing.length) throw unprocessable('receipt_required', `Attach receipts for items over KES ${limit}`, missing.map((x) => ({ path: 'items', message: x.description })));
      const trip = c.travelRequestId ? await m.getRepository(TravelRequest).findOneByOrFail({ id: c.travelRequestId }) : null;
      c.advanceOffset = trip?.advance ?? '0';
      c.status = 'pending';
      c.decisionComment = null;
      const e = await this.emp(m, c.employeeId);
      const i = await this.workflow.submit(m, { requestType: 'expense_claim', kind: new Decimal(c.advanceOffset).gt(0) ? 'with_advance' : 'standard', subjectId: c.id, subjectEmployeeId: e.id, requesterUserId: access.actorId, value: Number(c.total), summary: `${e.name}: expense claim ${c.number}, KES ${m2(c.total)}` });
      c.workflowInstanceId = i.id;
      await m.getRepository(ExpenseClaim).save(c);
    });
    return this.claim(access, id);
  }

  async cancelClaim(access: AccessProfile, id: string) {
    await this.dataSource.transaction(async (m) => {
      const c = await m.getRepository(ExpenseClaim).findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
      if (!c || c.employeeId !== access.employeeId) throw notFound('Expense claim');
      if (!['draft', 'returned', 'pending'].includes(c.status)) throw conflict('locked', `The claim is ${c.status}`);
      await this.workflow.cancel(m, 'expense_claim', c.id);
      c.status = 'cancelled';
      await m.getRepository(ExpenseClaim).save(c);
    });
    return this.claim(access, id);
  }

  /** Approval: payroll pays the net (total less the trip's advance), or recovers an over-advance. */
  private async claimApproved(m: EntityManager, i: WorkflowInstance) {
    const c = await m.getRepository(ExpenseClaim).findOneByOrFail({ id: i.subjectId });
    const e = await this.emp(m, c.employeeId);
    const net = new Decimal(c.total).minus(c.advanceOffset);
    c.status = 'approved';
    c.paidPeriod = await this.payablePeriod(m);
    if (net.gt(0)) await this.payOneOff(m, e.id, EXPENSE_COMPONENTS.reimbursement, c.paidPeriod, net, `Expense claim ${c.number}`);
    if (net.lt(0)) await this.payOneOff(m, e.id, EXPENSE_COMPONENTS.recovery, c.paidPeriod, net.neg(), `Unspent advance, claim ${c.number}`);
    await m.getRepository(ExpenseClaim).save(c);
    await this.outbox.record(m, 'hr.expense_claim.approved.v1', e.id, { id: c.id, number: c.number, employee_id: e.id, staff_number: e.staff_number, total: m2(c.total), advance_offset: m2(c.advanceOffset), net: m2(net), paid_period: c.paidPeriod, cost_centre_id: e.cost_centre_id });
  }

  private async claimDecided(m: EntityManager, i: WorkflowInstance, status: 'rejected' | 'returned', comment: string | null) {
    const c = await m.getRepository(ExpenseClaim).findOneByOrFail({ id: i.subjectId });
    Object.assign(c, { status, decisionComment: comment });
    await m.getRepository(ExpenseClaim).save(c);
  }

  async receipt(access: AccessProfile, itemId: string) {
    const m = this.dataSource.manager;
    const x = await m.getRepository(ExpenseItem).findOneBy({ id: itemId });
    if (!x?.receiptDocumentId) throw notFound('Receipt');
    const c = await m.getRepository(ExpenseClaim).findOneByOrFail({ id: x.claimId });
    // Approvers of the claim see receipts too.
    const approver = c.workflowInstanceId && (await m.query(`SELECT 1 FROM workflow_task WHERE instance_id = $1 AND (assignee_user_id = $2 OR acted_by = $2 OR candidate_role_id IN (SELECT role_id FROM role_assignment WHERE user_id = $2))`, [c.workflowInstanceId, access.actorId])).length;
    if (!approver && !(await this.canSee(access, await this.emp(m, c.employeeId)))) throw notFound('Receipt');
    return this.docs.read(x.receiptDocumentId);
  }
}
