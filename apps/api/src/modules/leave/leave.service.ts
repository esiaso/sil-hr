import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, In } from 'typeorm';
import { z } from 'zod';
import {
  leaveAdjustment, leaveRequestQuery, upsertLeavePolicy, upsertLeaveType, upsertPublicHoliday,
  type ApplyLeave, type LeaveBalance, type LeaveRequest as LeaveRequestDto, type LeaveType as LeaveTypeDto, type Page,
} from '@sil/hr-shared';
import { AccessProfile, applyScope, scopeAllows } from '../../common/access';
import { iso } from '../../common/base.entity';
import { assertVersion } from '../../common/etag';
import { mapPage, paginate } from '../../common/pagination';
import { conflict, forbidden, notFound, ProblemException, unprocessable } from '../../common/problem';
import { Employee } from '../employees/employee.entities';
import { OutboxService } from '../events/events.module';
import { NumberingService } from '../numbering/numbering.module';
import { ScopeService } from '../organisation/scope.service';
import { SettingsService } from '../settings/settings.module';
import { WorkflowInstance } from '../workflow/workflow.entities';
import { WorkflowService } from '../workflow/workflow.service';
import { LeaveLedger, LeavePolicy, LeaveRequest, LeaveType, PublicHoliday } from './leave.entities';
import { addDays, carryForward, countLeaveDays, dueAccrualMonths, leaveYearBounds, leaveYearOf, proratedAnnual } from './leave.rules';

type Entry = LeaveLedger['entryType'];

export const toLeaveTypeDto = (t: LeaveType): LeaveTypeDto => ({
  id: t.id, code: t.code, name: t.name, description: t.description, is_paid: t.isPaid, pay_rate: t.payRate, counting: t.counting, accrual: t.accrual,
  default_entitlement_days: t.defaultEntitlementDays, allow_half_day: t.allowHalfDay, allow_negative_balance: t.allowNegativeBalance, gender: t.gender,
  min_service_months: t.minServiceMonths, min_notice_days: t.minNoticeDays, max_consecutive_days: t.maxConsecutiveDays, requires_document_over_days: t.requiresDocumentOverDays,
  carry_forward_max_days: t.carryForwardMaxDays, carry_forward_expiry_months: t.carryForwardExpiryMonths, encashable: t.encashable, colour: t.colour, status: t.status,
  created_at: t.createdAt.toISOString(), updated_at: t.updatedAt.toISOString(), version: t.version,
});

const LIVE = ['pending', 'approved'] as const;

/** Per-employee planned working days from rosters (provided by time and attendance). */
export type ScheduleProvider = (m: EntityManager, employeeId: string, from: string, to: string) => Promise<((date: string) => boolean | undefined) | undefined>;

@Injectable()
export class LeaveService implements OnModuleInit {
  private schedule: ScheduleProvider = async () => undefined;

  registerScheduleProvider(fn: ScheduleProvider): void {
    this.schedule = fn;
  }

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly workflow: WorkflowService,
    private readonly scope: ScopeService,
    private readonly outbox: OutboxService,
    private readonly numbering: NumberingService,
    private readonly settings: SettingsService,
  ) {}

  /** Leave plugs into the engine: approval outcomes, and approvers who are away. */
  onModuleInit(): void {
    this.workflow.registerHandler('leave_request', {
      onApproved: (m, i) => this.onApproved(m, i),
      onRejected: (m, i, c) => this.onClosed(m, i, 'rejected', c),
      onReturned: (m, i, c) => this.onClosed(m, i, 'returned', c),
    });
    this.workflow.registerAvailability(async (m, employeeId, date) => {
      const [row] = await m.query(`SELECT 1 FROM leave_request WHERE employee_id = $1 AND status = 'approved' AND start_date <= $2 AND end_date >= $2 LIMIT 1`, [employeeId, date]);
      return !!row;
    });
  }

  // ------------------------------------------------------------------ setup
  async types(all = false) {
    return (await this.dataSource.getRepository(LeaveType).find({ where: all ? {} : { status: 'active' }, order: { name: 'ASC' } })).map(toLeaveTypeDto);
  }

  async saveType(dto: z.infer<typeof upsertLeaveType>, id?: string, version?: number) {
    const repo = this.dataSource.getRepository(LeaveType);
    const t = id ? await repo.findOneBy({ id }) : repo.create();
    if (!t) throw notFound('Leave type');
    if (id && version !== undefined) assertVersion(t.version, version);
    Object.assign(t, {
      code: dto.code, name: dto.name, description: dto.description ?? null, isPaid: dto.is_paid, payRate: dto.pay_rate, counting: dto.counting, accrual: dto.accrual,
      defaultEntitlementDays: dto.default_entitlement_days, allowHalfDay: dto.allow_half_day, allowNegativeBalance: dto.allow_negative_balance, gender: dto.gender ?? null,
      minServiceMonths: dto.min_service_months, minNoticeDays: dto.min_notice_days, maxConsecutiveDays: dto.max_consecutive_days ?? null, requiresDocumentOverDays: dto.requires_document_over_days ?? null,
      carryForwardMaxDays: dto.carry_forward_max_days, carryForwardExpiryMonths: dto.carry_forward_expiry_months ?? null, encashable: dto.encashable, colour: dto.colour ?? null,
      ...(dto.status ? { status: dto.status } : {}),
    });
    return toLeaveTypeDto(await repo.save(t));
  }

  async policies() {
    return (await this.dataSource.getRepository(LeavePolicy).find({ order: { effectiveFrom: 'DESC' } })).map((p) => ({ id: p.id, leave_type_id: p.leaveTypeId, job_grade_id: p.jobGradeId, employment_type: p.employmentType, entitlement_days: p.entitlementDays, effective_from: p.effectiveFrom, effective_to: p.effectiveTo }));
  }

  async savePolicy(dto: z.infer<typeof upsertLeavePolicy>, id?: string) {
    const repo = this.dataSource.getRepository(LeavePolicy);
    const p = id ? await repo.findOneBy({ id }) : repo.create();
    if (!p) throw notFound('Policy');
    Object.assign(p, { leaveTypeId: dto.leave_type_id, jobGradeId: dto.job_grade_id ?? null, employmentType: dto.employment_type ?? null, entitlementDays: dto.entitlement_days, effectiveFrom: dto.effective_from, effectiveTo: dto.effective_to ?? null });
    const s = await repo.save(p);
    return { id: s.id, leave_type_id: s.leaveTypeId, job_grade_id: s.jobGradeId, employment_type: s.employmentType, entitlement_days: s.entitlementDays, effective_from: s.effectiveFrom, effective_to: s.effectiveTo };
  }

  async holidays(year?: number) {
    const qb = this.dataSource.getRepository(PublicHoliday).createQueryBuilder('h').orderBy('h.date');
    if (year) qb.where(`extract(year from h.date) = :y`, { y: year });
    return (await qb.getMany()).map((h) => ({ id: h.id, date: h.date, name: h.name, branch_id: h.branchId }));
  }

  async saveHoliday(dto: z.infer<typeof upsertPublicHoliday>) {
    const repo = this.dataSource.getRepository(PublicHoliday);
    const h = await repo.save(repo.create({ date: dto.date, name: dto.name, branchId: dto.branch_id ?? null }));
    return { id: h.id, date: h.date, name: h.name, branch_id: h.branchId };
  }

  async removeHoliday(id: string) {
    const repo = this.dataSource.getRepository(PublicHoliday);
    const h = await repo.findOneBy({ id });
    if (!h) throw notFound('Holiday');
    await repo.remove(h);
  }

  // ------------------------------------------------------------------ entitlement and ledger
  /** Most specific effective policy (grade + type > grade > type), else the type's default. */
  private async entitlement(m: EntityManager, type: LeaveType, e: Employee, onDate: string): Promise<number> {
    const [gradeRow] = e.positionId ? await m.query(`SELECT job_grade_id FROM position WHERE id = $1`, [e.positionId]) : [];
    const grade = gradeRow?.job_grade_id ?? null;
    const rows = await m.getRepository(LeavePolicy).createQueryBuilder('p')
      .where('p.leave_type_id = :t AND p.effective_from <= :d AND (p.effective_to IS NULL OR p.effective_to >= :d)', { t: type.id, d: onDate })
      .andWhere('(p.job_grade_id IS NULL OR p.job_grade_id = :g)', { g: grade })
      .andWhere('(p.employment_type IS NULL OR p.employment_type = :et)', { et: e.employmentType })
      .getMany();
    const score = (p: LeavePolicy) => (p.jobGradeId ? 2 : 0) + (p.employmentType ? 1 : 0);
    const best = rows.sort((a, b) => score(b) - score(a))[0];
    return best ? best.entitlementDays : type.defaultEntitlementDays;
  }

  private async post(m: EntityManager, e: { employeeId: string; leaveTypeId: string; leaveYear: number }, entryType: Entry, days: number, effectiveDate: string, extra: { requestId?: string; periodKey?: string; note?: string; actor?: string | null } = {}): Promise<boolean> {
    if (days === 0) return false;
    const res = await m.query(
      `INSERT INTO leave_ledger (employee_id, leave_type_id, leave_year, entry_type, days, effective_date, leave_request_id, period_key, note, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT DO NOTHING RETURNING id`,
      [e.employeeId, e.leaveTypeId, e.leaveYear, entryType, days, effectiveDate, extra.requestId ?? null, extra.periodKey ?? null, extra.note ?? null, extra.actor ?? null],
    );
    return res.length > 0;
  }

  /**
   * Makes sure every grant due by `asOf` is in the ledger for this year (idempotent via
   * period keys): the annual or one-off grant, or each month's accrual.
   */
  async ensureGranted(m: EntityManager, type: LeaveType, e: Employee, year: number, asOf: string): Promise<void> {
    const startMonth = await this.settings.get('leave.year_start_month', m);
    const { start, end } = leaveYearBounds(year, startMonth);
    if (e.hireDate > end || (e.exitDate && e.exitDate < start)) return;
    if (type.gender && e.gender && type.gender !== e.gender) return;
    const ent = await this.entitlement(m, type, e, e.hireDate > start ? e.hireDate : start);
    const key = { employeeId: e.id, leaveTypeId: type.id, leaveYear: year };
    if (type.accrual === 'monthly') {
      for (const month of dueAccrualMonths(year, startMonth, e.hireDate, e.exitDate, asOf)) {
        await this.post(m, key, 'accrual', Math.round((ent / 12) * 100) / 100, `${month}-15`, { periodKey: `accrual:${month}`, note: 'Monthly accrual' });
      }
    } else if (type.accrual === 'annual') {
      await this.post(m, key, 'accrual', proratedAnnual(ent, year, startMonth, e.hireDate), e.hireDate > start ? e.hireDate : start, { periodKey: 'grant', note: e.hireDate > start ? 'Annual grant, prorated from hire' : 'Annual grant' });
    } else {
      await this.post(m, key, 'accrual', ent, start, { periodKey: 'grant', note: 'Yearly allowance' });
    }
  }

  private async sums(m: EntityManager, employeeId: string, year: number, typeIds?: string[]) {
    const rows: { leave_type_id: string; entry_type: Entry; total: string }[] = await m.query(
      `SELECT leave_type_id, entry_type, sum(days)::text AS total FROM leave_ledger WHERE employee_id = $1 AND leave_year = $2 ${typeIds ? 'AND leave_type_id = ANY($3::uuid[])' : ''} GROUP BY 1, 2`,
      typeIds ? [employeeId, year, typeIds] : [employeeId, year],
    );
    const map = new Map<string, Partial<Record<Entry, number>>>();
    for (const r of rows) map.set(r.leave_type_id, { ...(map.get(r.leave_type_id) ?? {}), [r.entry_type]: Number(r.total) });
    return map;
  }

  async balances(access: AccessProfile, employeeId: string, year?: number): Promise<LeaveBalance[]> {
    const e = await this.loadEmployee(access, employeeId);
    const today = await this.settings.today();
    const y = year ?? leaveYearOf(today, await this.settings.get('leave.year_start_month'));
    const types = await this.dataSource.getRepository(LeaveType).find({ where: { status: 'active' }, order: { name: 'ASC' } });
    await this.dataSource.transaction(async (m) => {
      for (const t of types) await this.ensureGranted(m, t, e, y, today);
    });
    const sums = await this.sums(this.dataSource.manager, e.id, y);
    return types
      .filter((t) => !t.gender || !e.gender || t.gender === e.gender)
      .map((t) => {
        const s = sums.get(t.id) ?? {};
        const get = (k: Entry) => s[k] ?? 0;
        const available = Object.values(s).reduce((a, b) => a + (b ?? 0), 0);
        return {
          leave_type_id: t.id, leave_type_code: t.code, leave_type_name: t.name, leave_year: y, entitled: get('accrual'), carried_forward: get('carry_forward'), adjustments: get('adjustment'),
          taken: -get('taken'), reserved: -(get('reserved') + get('release')), expired: -get('expiry'), encashed: -get('encashment'), available: Math.round(available * 100) / 100,
        };
      });
  }

  async ledger(access: AccessProfile, employeeId: string, year: number) {
    await this.loadEmployee(access, employeeId);
    const rows = await this.dataSource.getRepository(LeaveLedger).find({ where: { employeeId, leaveYear: year }, order: { createdAt: 'ASC' } });
    return rows.map((r) => ({ id: r.id, leave_type_id: r.leaveTypeId, leave_year: r.leaveYear, entry_type: r.entryType, days: r.days, effective_date: r.effectiveDate, leave_request_id: r.leaveRequestId, note: r.note, created_at: r.createdAt.toISOString() }));
  }

  async adjust(access: AccessProfile, employeeId: string, dto: z.infer<typeof leaveAdjustment>) {
    await this.loadEmployee(access, employeeId, 'leave:adjust');
    const type = await this.dataSource.getRepository(LeaveType).findOneBy({ id: dto.leave_type_id });
    if (!type) throw unprocessable('leave_type_not_found', 'Unknown leave type');
    if (dto.entry_type === 'encashment' && (!type.encashable || dto.days > 0)) throw unprocessable('not_encashable', 'Encashment removes days, and only from encashable leave types');
    await this.dataSource.transaction((m) => this.post(m, { employeeId, leaveTypeId: type.id, leaveYear: dto.leave_year }, dto.entry_type, dto.days, (dto.leave_year + '-01-01'), { note: dto.note, actor: access.actorId }));
    return this.balances(access, employeeId, dto.leave_year);
  }

  // ------------------------------------------------------------------ requests
  private async loadEmployee(access: AccessProfile, employeeId: string, permission = 'leave:read', m: EntityManager = this.dataSource.manager): Promise<Employee> {
    const e = await m.getRepository(Employee).findOneBy({ id: employeeId });
    if (!e) throw notFound('Employee');
    if (employeeId === access.employeeId && permission === 'leave:read') return e;
    const f = await this.scope.filterFor(access, permission);
    if (!scopeAllows(f, { branchId: e.branchId, departmentId: e.departmentId, employeeId: e.id })) throw notFound('Employee');
    return e;
  }

  /**
   * For payroll: days of approved unpaid (or part-paid) leave between two dates, each
   * weighted by the share that is not paid (unpaid = 1, half pay = 0.5). Requests that
   * cross the range are counted only inside it, with the same day-counting rules.
   */
  async unpaidLeaveDays(m: EntityManager, employeeId: string, branchId: string | null, from: string, to: string): Promise<{ days: number; detail: { type: string; days: number }[] }> {
    const rows: { start_date: string; end_date: string; start_half_day: boolean; end_half_day: boolean; days: string; name: string; is_paid: boolean; pay_rate: string; counting: 'working_days' | 'calendar_days' }[] = await m.query(
      `SELECT to_char(r.start_date, 'YYYY-MM-DD') AS start_date, to_char(r.end_date, 'YYYY-MM-DD') AS end_date, r.start_half_day, r.end_half_day, r.days, t.name, t.is_paid, t.pay_rate, t.counting
         FROM leave_request r JOIN leave_type t ON t.id = r.leave_type_id
        WHERE r.employee_id = $1 AND r.status = 'approved' AND r.start_date <= $3 AND r.end_date >= $2 AND (NOT t.is_paid OR t.pay_rate < 1)`,
      [employeeId, from, to],
    );
    if (!rows.length) return { days: 0, detail: [] };
    const workingDays = await this.settings.get('calendar.working_days', m);
    const detail: { type: string; days: number }[] = [];
    for (const r of rows) {
      const start = r.start_date < from ? from : r.start_date;
      const end = r.end_date > to ? to : r.end_date;
      const days = start === r.start_date && end === r.end_date
        ? Number(r.days)
        : countLeaveDays({ start, end, startHalfDay: start === r.start_date && r.start_half_day, endHalfDay: end === r.end_date && r.end_half_day, counting: r.counting, workingDays, holidays: await this.holidaysFor(m, branchId, start, end), rostered: await this.schedule(m, employeeId, start, end) }).days;
      const weight = r.is_paid ? 1 - Number(r.pay_rate) : 1;
      if (days * weight > 0) detail.push({ type: r.name, days: Math.round(days * weight * 100) / 100 });
    }
    return { days: Math.round(detail.reduce((a, d) => a + d.days, 0) * 100) / 100, detail };
  }

/** At exit: the annual leave still available this leave year (days). */
  async annualAvailableAt(m: EntityManager, employeeId: string, date: string): Promise<{ leaveTypeId: string | null; year: number; days: number }> {
    const type = await m.getRepository(LeaveType).findOneBy({ code: 'annual' });
    const year = leaveYearOf(date, await this.settings.get('leave.year_start_month', m));
    if (!type) return { leaveTypeId: null, year, days: 0 };
    const [{ total }] = await m.query(`SELECT coalesce(sum(days), 0)::float AS total FROM leave_ledger WHERE employee_id = $1 AND leave_type_id = $2 AND leave_year = $3`, [employeeId, type.id, year]);
    return { leaveTypeId: type.id, year, days: Math.max(0, Math.round(Number(total) * 100) / 100) };
  }

  /** At exit: pays out unused annual leave by removing it from the balance (encashment). */
  async encashAtExit(m: EntityManager, employeeId: string, leaveTypeId: string, year: number, days: number, date: string, actor: string | null): Promise<void> {
    if (days <= 0) return;
    await this.post(m, { employeeId, leaveTypeId, leaveYear: year }, 'encashment', -days, date, { note: 'Paid out at exit', actor });
  }

    /** For payroll proration: working days between two dates on the organisation's week, less public holidays. */
  async workingDaysBetween(m: EntityManager, branchId: string | null, from: string, to: string): Promise<number> {
    if (to < from) return 0;
    const workingDays = await this.settings.get('calendar.working_days', m);
    return countLeaveDays({ start: from, end: to, startHalfDay: false, endHalfDay: false, counting: 'working_days', workingDays, holidays: await this.holidaysFor(m, branchId, from, to) }).days;
  }

  private async holidaysFor(m: EntityManager, branchId: string | null, from: string, to: string): Promise<Map<string, string>> {
    const rows = await m.query(`SELECT to_char(date, 'YYYY-MM-DD') AS d, name FROM public_holiday WHERE date BETWEEN $1 AND $2 AND (branch_id IS NULL OR branch_id = $3)`, [from, to, branchId]);
    return new Map(rows.map((r: { d: string; name: string }) => [r.d, r.name]));
  }

  /** Works out days and the leave year, and checks every rule except the balance. */
  private async evaluate(m: EntityManager, e: Employee, type: LeaveType, dto: Pick<ApplyLeave, 'start_date' | 'end_date' | 'start_half_day' | 'end_half_day' | 'document_id'>) {
    if (type.status !== 'active') throw unprocessable('leave_type_inactive', 'That leave type is not in use');
    if (type.gender && e.gender && type.gender !== e.gender) throw unprocessable('not_eligible', `${type.name} is not available to this employee`);
    if ((dto.start_half_day || dto.end_half_day) && !type.allowHalfDay) throw unprocessable('no_half_days', `${type.name} is taken in whole days`, [{ path: 'start_half_day', message: 'Not allowed' }]);
    if (e.status === 'exited') throw unprocessable('employee_exited', 'This person has left');
    const startMonth = await this.settings.get('leave.year_start_month', m);
    const year = leaveYearOf(dto.start_date, startMonth);
    // Allowance-type leave (maternity, paternity…) may run into the next leave year and is charged to the year it starts;
    // accruing leave must be split at the year boundary so each year's balance pays for its own days.
    if (type.accrual !== 'none' && leaveYearOf(dto.end_date, startMonth) !== year) throw unprocessable('spans_leave_years', `Split this into two requests at the start of the leave year (${leaveYearBounds(year + 1, startMonth).start})`, [{ path: 'end_date', message: 'Crosses the leave year' }]);
    const serviceStart = addDays(e.hireDate, 0);
    if (type.minServiceMonths > 0) {
      const eligible = new Date(`${serviceStart}T00:00:00Z`);
      eligible.setUTCMonth(eligible.getUTCMonth() + type.minServiceMonths);
      if (dto.start_date < eligible.toISOString().slice(0, 10)) throw unprocessable('min_service', `${type.name} is available after ${type.minServiceMonths} months of service`);
    }
    const workingDays = await this.settings.get('calendar.working_days', m);
    const rostered = await this.schedule(m, e.id, dto.start_date, dto.end_date);
    const { days, excluded } = countLeaveDays({ start: dto.start_date, end: dto.end_date, startHalfDay: dto.start_half_day, endHalfDay: dto.end_half_day, counting: type.counting, workingDays, holidays: await this.holidaysFor(m, e.branchId, dto.start_date, dto.end_date), rostered });
    if (days <= 0) throw unprocessable('no_days', 'Those dates contain no working days', [{ path: 'start_date', message: 'Nothing to take' }]);
    if (type.maxConsecutiveDays !== null && days > type.maxConsecutiveDays) throw unprocessable('too_long', `${type.name} is at most ${type.maxConsecutiveDays} days at a time`);
    if (type.requiresDocumentOverDays !== null && days > type.requiresDocumentOverDays && !dto.document_id) {
      throw unprocessable('document_required', `Attach a supporting document for more than ${type.requiresDocumentOverDays} days of ${type.name}`, [{ path: 'document_id', message: 'Required' }]);
    }
    return { days, year, excluded };
  }

  private async available(m: EntityManager, e: Employee, type: LeaveType, year: number): Promise<number> {
    const today = await this.settings.today(m);
    const { end } = leaveYearBounds(year, await this.settings.get('leave.year_start_month', m));
    // Only what has accrued by today counts (or by the leave year's end, if it is over):
    // monthly-accrual leave cannot be borrowed ahead unless the type allows a negative balance.
    await this.ensureGranted(m, type, e, year, today < end ? today : end);
    const [row] = await m.query(`SELECT coalesce(sum(days), 0)::text AS s FROM leave_ledger WHERE employee_id = $1 AND leave_type_id = $2 AND leave_year = $3`, [e.id, type.id, year]);
    return Number(row.s);
  }

  async quote(access: AccessProfile, dto: ApplyLeave) {
    const employeeId = dto.employee_id ?? access.employeeId;
    if (!employeeId) throw new ProblemException(404, 'no_employee_record', 'Your account is not linked to an employee record');
    return this.dataSource.transaction(async (m) => {
      const e = await this.loadEmployee(access, employeeId, employeeId === access.employeeId ? 'leave:read' : 'leave:apply_for_others', m);
      const type = await m.getRepository(LeaveType).findOneByOrFail({ id: dto.leave_type_id });
      const r = await this.evaluate(m, e, type, dto);
      return { days: r.days, leave_year: r.year, available: await this.available(m, e, type, r.year), excluded: r.excluded };
    });
  }

  private dto(r: LeaveRequest): LeaveRequestDto {
    return {
      id: r.id, number: r.number, employee_id: r.employeeId, employee_name: r.employee ? `${r.employee.firstName} ${r.employee.lastName}` : '', leave_type_id: r.leaveTypeId,
      leave_type_name: r.leaveType?.name ?? '', start_date: r.startDate, end_date: r.endDate, start_half_day: r.startHalfDay, end_half_day: r.endHalfDay, days: r.days, leave_year: r.leaveYear,
      reason: r.reason, status: r.status, document_id: r.documentId, workflow_instance_id: r.workflowInstanceId, submitted_at: iso(r.submittedAt), decided_at: iso(r.decidedAt),
      decision_comment: r.decisionComment, created_at: r.createdAt.toISOString(), updated_at: r.updatedAt.toISOString(), version: r.version,
    };
  }

  private async reload(m: EntityManager, id: string): Promise<LeaveRequestDto> {
    return this.dto((await m.getRepository(LeaveRequest).findOne({ where: { id }, relations: { employee: true, leaveType: true } }))!);
  }

  async apply(access: AccessProfile, dto: ApplyLeave): Promise<LeaveRequestDto> {
    const employeeId = dto.employee_id ?? access.employeeId;
    if (!employeeId) throw new ProblemException(404, 'no_employee_record', 'Your account is not linked to an employee record');
    return this.dataSource.transaction(async (m) => {
      const forSelf = employeeId === access.employeeId;
      const e = await this.loadEmployee(access, employeeId, forSelf ? 'leave:read' : 'leave:apply_for_others', m);
      const type = await m.getRepository(LeaveType).findOneBy({ id: dto.leave_type_id });
      if (!type) throw unprocessable('leave_type_not_found', 'Unknown leave type', [{ path: 'leave_type_id', message: 'Not found' }]);
      const { days, year } = await this.evaluate(m, e, type, dto);
      const repo = m.getRepository(LeaveRequest);
      const r = await repo.save(
        repo.create({
          number: await this.numbering.next('leave_request', { manager: m, date: dto.start_date }), employeeId: e.id, leaveTypeId: type.id, startDate: dto.start_date, endDate: dto.end_date,
          startHalfDay: dto.start_half_day, endHalfDay: dto.end_half_day, days, leaveYear: year, reason: dto.reason ?? null, documentId: dto.document_id ?? null, status: 'draft',
        }),
      );
      if (dto.submit) await this.submitInTx(m, access, r, e, type);
      return this.reload(m, r.id);
    });
  }

  private async submitInTx(m: EntityManager, access: AccessProfile, r: LeaveRequest, e: Employee, type: LeaveType): Promise<void> {
    const today = await this.settings.today(m);
    if (type.minNoticeDays > 0 && r.startDate < addDays(today, type.minNoticeDays) && !access.has('leave:apply_for_others')) {
      throw unprocessable('short_notice', `${type.name} needs ${type.minNoticeDays} days' notice`, [{ path: 'start_date', message: 'Too soon' }]);
    }
    const available = await this.available(m, e, type, r.leaveYear);
    if (!type.allowNegativeBalance && r.days > available) {
      throw unprocessable('insufficient_balance', `Only ${available} day(s) of ${type.name} available in ${r.leaveYear}; this needs ${r.days}`, [{ path: 'end_date', message: 'Not enough balance' }]);
    }
    r.status = 'pending';
    r.submittedAt = new Date();
    try {
      await m.getRepository(LeaveRequest).save(r);
    } catch (err) {
      if ((err as { driverError?: { constraint?: string } }).driverError?.constraint === 'ex_leave_overlap') throw conflict('overlapping_leave', 'You already have leave pending or approved on some of these days');
      throw err;
    }
    // Reserve now, so two pending requests cannot both spend the same days.
    await this.post(m, { employeeId: e.id, leaveTypeId: type.id, leaveYear: r.leaveYear }, 'reserved', -r.days, r.startDate, { requestId: r.id, actor: access.actorId, note: r.number });
    const [userRow] = await m.query(`SELECT id FROM user_account WHERE employee_id = $1`, [e.id]);
    const instance = await this.workflow.submit(m, {
      requestType: 'leave_request', subjectId: r.id, subjectEmployeeId: e.id, requesterUserId: userRow?.id ?? access.actorId, kind: type.code, value: r.days,
      summary: `${type.name}: ${e.firstName} ${e.lastName}, ${r.days} day(s) from ${r.startDate}`, context: { number: r.number },
    });
    r.workflowInstanceId = instance.id;
    await m.getRepository(LeaveRequest).save(r);
  }

  private async loadRequest(access: AccessProfile, id: string, m: EntityManager, lock = false): Promise<LeaveRequest> {
    const r = await m.getRepository(LeaveRequest).findOne({ where: { id }, ...(lock ? { lock: { mode: 'pessimistic_write' as const } } : {}) });
    if (!r) throw notFound('Leave request');
    await this.loadEmployee(access, r.employeeId, 'leave:read', m);
    return r;
  }

  async get(access: AccessProfile, id: string) {
    await this.loadRequest(access, id, this.dataSource.manager);
    return this.reload(this.dataSource.manager, id);
  }

  /** Submits a draft, or resubmits one that was returned for correction (edits allowed). */
  async submit(access: AccessProfile, id: string, edits?: Partial<Pick<ApplyLeave, 'start_date' | 'end_date' | 'start_half_day' | 'end_half_day' | 'reason' | 'document_id'>>) {
    return this.dataSource.transaction(async (m) => {
      const r = await this.loadRequest(access, id, m, true);
      if (!['draft', 'returned'].includes(r.status)) throw conflict('not_editable', `This request is ${r.status}`);
      const e = await m.getRepository(Employee).findOneByOrFail({ id: r.employeeId });
      if (e.id !== access.employeeId && !access.has('leave:apply_for_others')) throw forbidden('Only the employee or HR can submit this');
      const type = await m.getRepository(LeaveType).findOneByOrFail({ id: r.leaveTypeId });
      if (edits) Object.assign(r, {
        ...(edits.start_date && { startDate: edits.start_date }), ...(edits.end_date && { endDate: edits.end_date }),
        ...(edits.start_half_day !== undefined && { startHalfDay: edits.start_half_day }), ...(edits.end_half_day !== undefined && { endHalfDay: edits.end_half_day }),
        ...(edits.reason !== undefined && { reason: edits.reason ?? null }), ...(edits.document_id !== undefined && { documentId: edits.document_id ?? null }),
      });
      const { days, year } = await this.evaluate(m, e, type, { start_date: r.startDate, end_date: r.endDate, start_half_day: r.startHalfDay, end_half_day: r.endHalfDay, document_id: r.documentId });
      Object.assign(r, { days, leaveYear: year, decisionComment: null, decidedAt: null });
      await this.submitInTx(m, access, r, e, type);
      return this.reload(m, r.id);
    });
  }

  /**
   * Withdraws a request. Pending: the reservation is released and approvers' tasks are
   * cancelled. Approved: only before it starts (HR any time), and the days come back.
   */
  async cancel(access: AccessProfile, id: string, reason: string | null) {
    return this.dataSource.transaction(async (m) => {
      const r = await this.loadRequest(access, id, m, true);
      const own = r.employeeId === access.employeeId;
      const hr = access.has('leave:apply_for_others');
      if (!own && !hr) throw forbidden('Only the employee or HR can cancel this');
      const key = { employeeId: r.employeeId, leaveTypeId: r.leaveTypeId, leaveYear: r.leaveYear };
      if (r.status === 'pending') {
        await this.workflow.cancel(m, 'leave_request', r.id);
        await this.post(m, key, 'release', r.days, r.startDate, { requestId: r.id, actor: access.actorId, note: `${r.number} withdrawn` });
      } else if (r.status === 'approved') {
        const today = await this.settings.today(m);
        if (r.startDate <= today && !hr) throw conflict('already_started', 'Leave that has started can only be cancelled by HR');
        await this.post(m, key, 'taken', r.days, r.startDate, { requestId: r.id, actor: access.actorId, note: `${r.number} cancelled` });
        const type = await m.getRepository(LeaveType).findOneByOrFail({ id: r.leaveTypeId });
        await this.outbox.record(m, 'hr.leave.cancelled.v1', r.id, await this.eventData(m, r, type));
      } else if (!['draft', 'returned'].includes(r.status)) {
        throw conflict('not_cancellable', `This request is ${r.status}`);
      }
      r.status = 'cancelled';
      r.decisionComment = reason ?? r.decisionComment;
      await m.getRepository(LeaveRequest).save(r);
      return this.reload(m, r.id);
    });
  }

  private async eventData(m: EntityManager, r: LeaveRequest, type: LeaveType) {
    const [e] = await m.query(`SELECT staff_number FROM employee WHERE id = $1`, [r.employeeId]);
    return { id: r.id, number: r.number, employee_id: r.employeeId, staff_number: e.staff_number, leave_type_code: type.code, start_date: r.startDate, end_date: r.endDate, start_half_day: r.startHalfDay, end_half_day: r.endHalfDay, days: r.days, is_paid: type.isPaid };
  }

  private async onApproved(m: EntityManager, instance: WorkflowInstance): Promise<void> {
    const r = await m.getRepository(LeaveRequest).findOneOrFail({ where: { id: instance.subjectId }, lock: { mode: 'pessimistic_write' } });
    const type = await m.getRepository(LeaveType).findOneByOrFail({ id: r.leaveTypeId });
    const key = { employeeId: r.employeeId, leaveTypeId: r.leaveTypeId, leaveYear: r.leaveYear };
    // Reservation becomes taken leave.
    await this.post(m, key, 'release', r.days, r.startDate, { requestId: r.id, note: `${r.number} approved` });
    await this.post(m, key, 'taken', -r.days, r.startDate, { requestId: r.id, note: r.number });
    Object.assign(r, { status: 'approved', decidedAt: new Date() });
    await m.getRepository(LeaveRequest).save(r);
    await this.outbox.record(m, 'hr.leave.approved.v1', r.id, await this.eventData(m, r, type));
  }

  private async onClosed(m: EntityManager, instance: WorkflowInstance, status: 'rejected' | 'returned', comment: string | null): Promise<void> {
    const r = await m.getRepository(LeaveRequest).findOneOrFail({ where: { id: instance.subjectId }, lock: { mode: 'pessimistic_write' } });
    await this.post(m, { employeeId: r.employeeId, leaveTypeId: r.leaveTypeId, leaveYear: r.leaveYear }, 'release', r.days, r.startDate, { requestId: r.id, note: `${r.number} ${status}` });
    Object.assign(r, { status, decidedAt: new Date(), decisionComment: comment });
    await m.getRepository(LeaveRequest).save(r);
  }

  async list(access: AccessProfile, q: z.infer<typeof leaveRequestQuery>, mineOnly = false): Promise<Page<LeaveRequestDto>> {
    const qb = this.dataSource.getRepository(LeaveRequest).createQueryBuilder('r').innerJoinAndSelect('r.employee', 'e').innerJoinAndSelect('r.leaveType', 't');
    if (mineOnly) qb.andWhere('r.employee_id = :me', { me: access.employeeId ?? '00000000-0000-0000-0000-000000000000' });
    else applyScope(qb, await this.scope.filterFor(access, 'leave:read'), { branch: 'e.branch_id', department: 'e.department_id', employee: 'e.id' });
    if (q.status) qb.andWhere('r.status = :s', { s: q.status });
    if (q.employee_id) qb.andWhere('r.employee_id = :emp', { emp: q.employee_id });
    if (q.leave_type_id) qb.andWhere('r.leave_type_id = :lt', { lt: q.leave_type_id });
    if (q.department_id) qb.andWhere('e.department_id IN (SELECT id FROM department WHERE id = :dep OR :dep = ANY(path))', { dep: q.department_id });
    if (q.from) qb.andWhere('r.end_date >= :from', { from: q.from });
    if (q.to) qb.andWhere('r.start_date <= :to', { to: q.to });
    const page = await paginate(qb, q, { alias: 'r', defaultSort: '-created_at', sortable: { start_date: { prop: 'startDate', column: 'start_date', cast: 'date' } } });
    return mapPage(page, (r) => this.dto(r));
  }

  /** Team leave calendar: pending and approved leave overlapping the window, within scope. */
  async calendar(access: AccessProfile, from: string, to: string, departmentId?: string, sub = true) {
    if (to < from || Date.parse(to) - Date.parse(from) > 120 * 86_400_000) throw unprocessable('bad_window', 'Choose a window of at most 120 days');
    const qb = this.dataSource.getRepository(LeaveRequest).createQueryBuilder('r').innerJoinAndSelect('r.employee', 'e').innerJoinAndSelect('r.leaveType', 't')
      .where('r.status IN (:...st)', { st: LIVE }).andWhere('r.start_date <= :to AND r.end_date >= :from', { from, to });
    const filter = await this.scope.filterFor(access, 'leave:read');
    if (access.employeeId && !filter.all) filter.employeeIds.push(access.employeeId);
    applyScope(qb, filter, { branch: 'e.branch_id', department: 'e.department_id', employee: 'e.id' });
    if (departmentId) {
      if (sub) qb.andWhere('e.department_id IN (SELECT id FROM department WHERE id = :dep OR :dep = ANY(path))', { dep: departmentId });
      else qb.andWhere('e.department_id = :dep', { dep: departmentId });
    }
    const rows = await qb.orderBy('r.start_date').getMany();
    return rows.map((r) => ({ request_id: r.id, employee_id: r.employeeId, employee_name: `${r.employee!.firstName} ${r.employee!.lastName}`, department_id: r.employee!.departmentId, leave_type_code: r.leaveType!.code, leave_type_name: r.leaveType!.name, colour: r.leaveType!.colour, start_date: r.startDate, end_date: r.endDate, status: r.status as 'pending' | 'approved' }));
  }

  // ------------------------------------------------------------------ scheduled
  /** Hourly (idempotent): grants and monthly accruals for the current leave year. */
  async accrueAll(): Promise<number> {
    const today = await this.settings.today();
    const year = leaveYearOf(today, await this.settings.get('leave.year_start_month'));
    const types = await this.dataSource.getRepository(LeaveType).findBy({ status: 'active' });
    const employees = await this.dataSource.getRepository(Employee).find({ where: { status: In(['onboarding', 'probation', 'active', 'on_notice', 'suspended']) } });
    let n = 0;
    for (const e of employees) {
      await this.dataSource.transaction(async (m) => {
        for (const t of types) await this.ensureGranted(m, t, e, year, today);
      });
      n++;
    }
    return n;
  }

  /**
   * At the start of a leave year: carry last year's unused days (up to each type's cap)
   * into the new year; when a carry-over's expiry date passes, expire what is unused.
   */
  async carryForwardAll(): Promise<number> {
    const today = await this.settings.today();
    const startMonth = await this.settings.get('leave.year_start_month');
    const year = leaveYearOf(today, startMonth);
    const prev = year - 1;
    const types = (await this.dataSource.getRepository(LeaveType).findBy({ status: 'active' })).filter((t) => t.carryForwardMaxDays > 0);
    let n = 0;
    for (const t of types) {
      const rows: { employee_id: string; balance: string }[] = await this.dataSource.query(
        `SELECT employee_id, sum(days)::text AS balance FROM leave_ledger WHERE leave_type_id = $1 AND leave_year = $2 GROUP BY employee_id`,
        [t.id, prev],
      );
      for (const r of rows) {
        const carry = carryForward(Number(r.balance), t.carryForwardMaxDays);
        const yearStart = leaveYearBounds(year, startMonth).start;
        await this.dataSource.transaction(async (m) => {
          if (await this.post(m, { employeeId: r.employee_id, leaveTypeId: t.id, leaveYear: year }, 'carry_forward', carry, yearStart, { periodKey: `carry:${prev}`, note: `Carried from ${prev}` })) n++;
        });
        if (t.carryForwardExpiryMonths && carry > 0) {
          const expiry = new Date(`${yearStart}T00:00:00Z`);
          expiry.setUTCMonth(expiry.getUTCMonth() + t.carryForwardExpiryMonths);
          const expiresOn = expiry.toISOString().slice(0, 10);
          if (today >= expiresOn) {
            // Days used since the year began are taken from the carried-over days first.
            const [used] = await this.dataSource.query(
              `SELECT coalesce(-sum(days), 0)::text AS used FROM leave_ledger WHERE employee_id = $1 AND leave_type_id = $2 AND leave_year = $3 AND entry_type = 'taken' AND effective_date < $4`,
              [r.employee_id, t.id, year, expiresOn],
            );
            const unused = Math.max(0, carry - Number(used.used));
            await this.dataSource.transaction((m) => this.post(m, { employeeId: r.employee_id, leaveTypeId: t.id, leaveYear: year }, 'expiry', -unused, expiresOn, { periodKey: `carry-expiry:${prev}`, note: 'Carried-over days expired' }));
          }
        }
      }
    }
    return n;
  }
}
