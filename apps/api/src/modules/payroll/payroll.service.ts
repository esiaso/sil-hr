import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import Decimal from 'decimal.js';
import { DataSource, EntityManager, In } from 'typeorm';
import { z } from 'zod';
import {
  createOneOff, createRun, setSalary, upsertGlAccountMap, upsertLoan, upsertPayComponent, upsertPayItem, upsertPaymentFileFormat, upsertStatutoryRate,
} from '@sil/hr-shared';
import { AccessProfile, applyScope, scopeAllows } from '../../common/access';
import { iso } from '../../common/base.entity';
import { assertVersion } from '../../common/etag';
import { conflict, forbidden, notFound, unprocessable } from '../../common/problem';
import { Employee, EmployeeBankAccount } from '../employees/employee.entities';
import { OutboxService } from '../events/events.module';
import { LeaveService } from '../leave/leave.service';
import { NotificationsService } from '../notifications/notifications.module';
import { NumberingService } from '../numbering/numbering.module';
import { ScopeService } from '../organisation/scope.service';
import { SettingsService } from '../settings/settings.module';
import { WorkflowInstance } from '../workflow/workflow.entities';
import { WorkflowService } from '../workflow/workflow.service';
import { calculatePayslip, compileFormula, type CalcInput, type CalcItem, type CalcLoan, type CalcOneOff, type CalcOvertime } from './payroll.calc';
import {
  EmployeeLoan, EmployeePayItem, EmployeeSalary, GlAccountMap, PayComponent, PaymentFileFormat, PayrollOneOff, PayrollRun, Payslip, PayslipLine, StatutoryRate,
} from './payroll.entities';
import { STATUTORY_CODES, validateTable, type StatutoryCode, type StatutoryTables } from './payroll.statutory';

type Dto<T extends z.ZodType> = z.infer<T>;
const LOCKED = ['approved', 'paid', 'closed'] as const;
const isLocked = (s: string) => (LOCKED as readonly string[]).includes(s);
const m2 = (x: Decimal.Value) => new Decimal(x).toFixed(2);

export function periodBounds(period: string): { start: string; end: string } {
  const [y, mo] = period.split('-').map(Number);
  const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  return { start: `${period}-01`, end: `${period}-${String(last).padStart(2, '0')}` };
}
const dayBefore = (d: string) => new Date(Date.parse(`${d}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000) + 1;
export const prevPeriod = (p: string) => { const [y, m] = p.split('-').map(Number); return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`; };

/**
 * Other modules add pay items for a person and month (e.g. medical scheme contributions).
 * Items come back as one-off lines: the provider decides amounts from its own dated data.
 */
export type PayItemsProvider = (m: EntityManager, e: Employee, period: { period: string; start: string; end: string; from: string; to: string }, basicMonthly: number) => Promise<CalcOneOff[]>;

@Injectable()
export class PayrollService implements OnModuleInit {
  private readonly logger = new Logger('Payroll');
  private readonly providers: PayItemsProvider[] = [];

  /** The rows of payroll the caller may see. */
  scopeFilter(access: AccessProfile) {
    return this.scope.filterFor(access, 'payroll:read');
  }

  registerItemsProvider(fn: PayItemsProvider): void {
    this.providers.push(fn);
  }

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly settings: SettingsService,
    private readonly leave: LeaveService,
    private readonly workflow: WorkflowService,
    private readonly outbox: OutboxService,
    private readonly numbering: NumberingService,
    private readonly notifications: NotificationsService,
    private readonly scope: ScopeService,
  ) {}

  onModuleInit(): void {
    this.workflow.registerHandler('payroll_run', {
      onApproved: (m, i) => this.approve(m, i),
      onRejected: (m, i, c) => this.sendBack(m, i, c),
      onReturned: (m, i, c) => this.sendBack(m, i, c),
    });
  }

  // ================================================================== components
  componentDto(c: PayComponent) {
    return {
      id: c.id, code: c.code, name: c.name, kind: c.kind, method: c.method, default_value: c.defaultValue, formula: c.formula, taxable: c.taxable, pensionable: c.pensionable,
      prorate: c.prorate, tax_treatment: c.taxTreatment, is_system: c.isSystem, sort_order: c.sortOrder, status: c.status,
      created_at: c.createdAt.toISOString(), updated_at: c.updatedAt.toISOString(), version: c.version,
    };
  }

  async components() {
    return (await this.dataSource.getRepository(PayComponent).find({ order: { sortOrder: 'ASC', code: 'ASC' } })).map((c) => this.componentDto(c));
  }

  checkFormula(formula: string, vars: Record<string, number>) {
    try {
      return { ok: true, value: compileFormula(formula)(vars), message: null as string | null };
    } catch (e) {
      return { ok: false, value: null, message: (e as Error).message };
    }
  }

  async saveComponent(dto: Dto<typeof upsertPayComponent>, id?: string, version?: number) {
    const repo = this.dataSource.getRepository(PayComponent);
    const c = id ? await repo.findOneBy({ id }) : repo.create();
    if (!c) throw notFound('Pay component');
    if (id && version !== undefined) assertVersion(c.version, version);
    if (c.isSystem && (dto.code !== c.code || dto.kind !== c.kind)) throw unprocessable('system_component', 'The code and kind of a built-in component cannot change', [{ path: 'code', message: 'Built in' }]);
    if (dto.method === 'formula') {
      const r = this.checkFormula(dto.formula ?? '', {});
      if (!r.ok) throw unprocessable('bad_formula', r.message!, [{ path: 'formula', message: r.message! }]);
    }
    if (dto.kind !== 'deduction' && dto.tax_treatment !== 'none') throw unprocessable('bad_treatment', 'Only deductions can have a tax treatment', [{ path: 'tax_treatment', message: 'Deductions only' }]);
    Object.assign(c, {
      code: dto.code, name: dto.name, kind: dto.kind, method: dto.method, defaultValue: dto.default_value ?? null, formula: dto.method === 'formula' ? dto.formula : null,
      taxable: dto.kind === 'deduction' || dto.kind === 'employer_contribution' ? false : dto.taxable, pensionable: dto.kind === 'earning' ? dto.pensionable : false,
      prorate: dto.prorate, taxTreatment: dto.tax_treatment, sortOrder: dto.sort_order, status: dto.status,
    });
    return this.componentDto(await repo.save(c));
  }

  // ================================================================== statutory tables
  rateDto(r: StatutoryRate) {
    return { id: r.id, code: r.code, effective_from: r.effectiveFrom, effective_to: r.effectiveTo, params: r.params, source: r.source, created_at: r.createdAt.toISOString(), updated_at: r.updatedAt.toISOString(), version: r.version };
  }

  async rates() {
    return (await this.dataSource.getRepository(StatutoryRate).find({ order: { code: 'ASC', effectiveFrom: 'DESC' } })).map((r) => this.rateDto(r));
  }

  /** A table already used by an approved payroll is history: it cannot change under that payroll. */
  private async assertRateUnused(m: EntityManager, r: { effectiveFrom: string; effectiveTo: string | null }) {
    const [{ n }] = await m.query(
      `SELECT count(*)::int AS n FROM payroll_run WHERE status IN ('approved', 'paid', 'closed') AND period_end >= $1 AND ($2::date IS NULL OR period_end <= $2)`,
      [r.effectiveFrom, r.effectiveTo],
    );
    if (n > 0) throw conflict('rate_in_use', 'An approved payroll used this table. Add a new table from a later date instead of changing this one.');
  }

  async saveRate(dto: Dto<typeof upsertStatutoryRate>, id?: string, version?: number) {
    const problems = validateTable(dto.code, dto.params);
    if (problems.length) throw unprocessable('invalid_table', problems.join('; '), problems.map((p) => ({ path: `params.${p.split(':')[0]}`, message: p })));
    if (dto.effective_to && dto.effective_to < dto.effective_from) throw unprocessable('bad_dates', 'The end is before the start', [{ path: 'effective_to', message: 'Before the start' }]);
    return this.dataSource.transaction(async (m) => {
      const repo = m.getRepository(StatutoryRate);
      const r = id ? await repo.findOneBy({ id }) : repo.create();
      if (!r) throw notFound('Rate table');
      if (id) {
        if (version !== undefined) assertVersion(r.version, version);
        await this.assertRateUnused(m, r);
      }
      // A new open-ended table closes the one in force the day before it starts.
      if (!id) {
        const open = await repo.findOne({ where: { code: dto.code, effectiveTo: null as never }, order: { effectiveFrom: 'DESC' } });
        if (open && open.effectiveFrom < dto.effective_from) {
          open.effectiveTo = dayBefore(dto.effective_from);
          await repo.save(open);
        }
      }
      Object.assign(r, { code: dto.code, effectiveFrom: dto.effective_from, effectiveTo: dto.effective_to ?? null, params: dto.params, source: dto.source ?? null });
      return this.rateDto(await repo.save(r));
    });
  }

  async deleteRate(id: string) {
    await this.dataSource.transaction(async (m) => {
      const r = await m.getRepository(StatutoryRate).findOneBy({ id });
      if (!r) throw notFound('Rate table');
      await this.assertRateUnused(m, r);
      await m.getRepository(StatutoryRate).delete({ id });
      // The table it had closed is in force again.
      if (r.effectiveTo === null) await m.query(`UPDATE statutory_rate SET effective_to = NULL, updated_at = now(), version = version + 1 WHERE code = $1 AND effective_to = $2`, [r.code, dayBefore(r.effectiveFrom)]);
    });
  }

  /** The tables in force on a date; a missing table stops the payroll. */
  async tablesOn(m: EntityManager, date: string): Promise<{ tables: StatutoryTables; ids: Record<string, string> }> {
    const rows = await m.getRepository(StatutoryRate).createQueryBuilder('r').where('r.effective_from <= :d AND (r.effective_to IS NULL OR r.effective_to >= :d)', { d: date }).getMany();
    const tables: Partial<Record<StatutoryCode, unknown>> = {};
    const ids: Record<string, string> = {};
    for (const r of rows) { tables[r.code] = r.params; ids[r.code] = r.id; }
    const missing = STATUTORY_CODES.filter((c) => !tables[c]);
    if (missing.length) throw unprocessable('missing_rate_table', `No ${missing.join(', ')} table is in force on ${date}. Add it under Payroll → Setup.`);
    return { tables: tables as unknown as StatutoryTables, ids };
  }

  // ================================================================== formats and accounts
  formatDto(f: PaymentFileFormat) {
    return { id: f.id, code: f.code, name: f.name, channel: f.channel, file_type: f.fileType, columns: f.columns, is_default: f.isDefault, note: f.note, created_at: f.createdAt.toISOString(), updated_at: f.updatedAt.toISOString(), version: f.version };
  }
  async formats() {
    return (await this.dataSource.getRepository(PaymentFileFormat).find({ order: { channel: 'ASC', name: 'ASC' } })).map((f) => this.formatDto(f));
  }
  async saveFormat(dto: Dto<typeof upsertPaymentFileFormat>, id?: string, version?: number) {
    return this.dataSource.transaction(async (m) => {
      const repo = m.getRepository(PaymentFileFormat);
      const f = id ? await repo.findOneBy({ id }) : repo.create();
      if (!f) throw notFound('Payment file format');
      if (id && version !== undefined) assertVersion(f.version, version);
      if (dto.is_default) await m.query(`UPDATE payment_file_format SET is_default = false WHERE channel = $1 AND id IS DISTINCT FROM $2`, [dto.channel, id ?? null]);
      Object.assign(f, { code: dto.code, name: dto.name, channel: dto.channel, fileType: dto.file_type, columns: dto.columns, isDefault: dto.is_default, note: dto.note ?? null });
      return this.formatDto(await repo.save(f));
    });
  }

  async accountMap() {
    return (await this.dataSource.getRepository(GlAccountMap).find({ order: { key: 'ASC' } })).map((g) => ({ id: g.id, key: g.key, description: g.description, debit_account: g.debitAccount, credit_account: g.creditAccount, version: g.version }));
  }
  async saveAccountMap(rows: Dto<typeof upsertGlAccountMap>[]) {
    await this.dataSource.transaction(async (m) => {
      const repo = m.getRepository(GlAccountMap);
      for (const r of rows) {
        const g = (await repo.findOneBy({ key: r.key })) ?? repo.create({ key: r.key });
        Object.assign(g, { description: r.description ?? g.description ?? null, debitAccount: r.debit_account || null, creditAccount: r.credit_account || null });
        await repo.save(g);
      }
    });
    return this.accountMap();
  }

  // ================================================================== per employee
  private async employeeOr404(id: string, m: EntityManager = this.dataSource.manager) {
    const e = await m.getRepository(Employee).findOneBy({ id });
    if (!e) throw notFound('Employee');
    return e;
  }

  private async assertScope(access: AccessProfile, permission: string, e: Employee) {
    const filter = await this.scope.filterFor(access, permission);
    if (!scopeAllows(filter, { branchId: e.branchId, departmentId: e.departmentId, employeeId: e.id })) throw forbidden(`Outside your ${permission} scope`, 'out_of_scope');
  }

  /** The end of the last approved payroll; pay changes before it would rewrite history. */
  private async lockedUntil(m: EntityManager): Promise<string | null> {
    const [r] = await m.query(`SELECT to_char(max(period_end), 'YYYY-MM-DD') AS d FROM payroll_run WHERE status IN ('approved', 'paid', 'closed')`);
    return r?.d ?? null;
  }
  private async assertOpen(m: EntityManager, date: string, what: string) {
    const until = await this.lockedUntil(m);
    if (until && date <= until) throw conflict('period_locked', `${what} from ${date} would change an approved payroll (approved up to ${until}). Start it after that date, and pay any difference as arrears (a one-off item).`);
  }

  async employeePay(access: AccessProfile, employeeId: string) {
    const e = await this.employeeOr404(employeeId);
    await this.assertScope(access, 'salary:read', e);
    const salaries = await this.dataSource.getRepository(EmployeeSalary).find({ where: { employeeId }, order: { effectiveFrom: 'DESC' } });
    const items: { id: string; employee_id: string; component_id: string; code: string; name: string; kind: string; method: string; value: string | null; formula: string | null; effective_from: string; effective_to: string | null; note: string | null }[] = await this.dataSource.query(
      `SELECT i.id, i.employee_id, i.component_id, c.code, c.name, c.kind, c.method, i.value, i.formula, to_char(i.effective_from, 'YYYY-MM-DD') AS effective_from, to_char(i.effective_to, 'YYYY-MM-DD') AS effective_to, i.note
         FROM employee_pay_item i JOIN pay_component c ON c.id = i.component_id WHERE i.employee_id = $1 ORDER BY c.sort_order, i.effective_from DESC`,
      [employeeId],
    );
    return {
      employee_id: employeeId,
      salaries: salaries.map((s) => ({ id: s.id, employee_id: s.employeeId, basic: m2(s.basic), effective_from: s.effectiveFrom, effective_to: s.effectiveTo, reason: s.reason, created_at: s.createdAt.toISOString() })),
      items: items.map((i) => ({ id: i.id, employee_id: i.employee_id, component_id: i.component_id, component_code: i.code, component_name: i.name, kind: i.kind, method: i.method, value: i.value === null ? null : Number(i.value), formula: i.formula, effective_from: i.effective_from, effective_to: i.effective_to, note: i.note })),
      loans: await this.loans({ employee_id: employeeId }),
      one_offs: await this.oneOffs({ employee_id: employeeId }),
    };
  }

  async setSalary(access: AccessProfile, employeeId: string, dto: Dto<typeof setSalary>, outer?: EntityManager) {
    const e = await this.employeeOr404(employeeId, outer);
    await this.assertScope(access, 'salary:manage', e);
    const work = async (m: EntityManager) => {
      await this.assertOpen(m, dto.effective_from, 'A salary');
      const repo = m.getRepository(EmployeeSalary);
      // Later rows are replaced; the row in force is closed the day before.
      await repo.createQueryBuilder().delete().where('employee_id = :id AND effective_from >= :d', { id: employeeId, d: dto.effective_from }).execute();
      await m.query(`UPDATE employee_salary SET effective_to = $3, updated_at = now(), version = version + 1 WHERE employee_id = $1 AND effective_from < $2 AND (effective_to IS NULL OR effective_to >= $2)`, [employeeId, dto.effective_from, dayBefore(dto.effective_from)]);
      await repo.save(repo.create({ employeeId, basic: dto.basic, effectiveFrom: dto.effective_from, effectiveTo: null, reason: dto.reason ?? null }));
    };
    if (outer) { await work(outer); return null; }
    await this.dataSource.transaction(work);
    return this.employeePay(access, employeeId);
  }

  async savePayItem(access: AccessProfile, employeeId: string, dto: Dto<typeof upsertPayItem>, id?: string) {
    const e = await this.employeeOr404(employeeId);
    await this.assertScope(access, 'salary:manage', e);
    const c = await this.dataSource.getRepository(PayComponent).findOneBy({ id: dto.component_id });
    if (!c || c.status !== 'active') throw unprocessable('component_not_found', 'Unknown or inactive pay component', [{ path: 'component_id', message: 'Not found' }]);
    if (c.isSystem) throw unprocessable('system_component', `${c.name} is calculated by the payroll; it cannot be set per person`, [{ path: 'component_id', message: 'Built in' }]);
    if (dto.formula) {
      const r = this.checkFormula(dto.formula, {});
      if (!r.ok) throw unprocessable('bad_formula', r.message!, [{ path: 'formula', message: r.message! }]);
    }
    await this.dataSource.transaction(async (m) => {
      const repo = m.getRepository(EmployeePayItem);
      const it = id ? await repo.findOneBy({ id, employeeId }) : repo.create({ employeeId });
      if (!it) throw notFound('Pay item');
      await this.assertOpen(m, id ? (it.effectiveFrom < dto.effective_from ? it.effectiveFrom : dto.effective_from) : dto.effective_from, 'A pay item');
      Object.assign(it, { componentId: dto.component_id, value: dto.value ?? null, formula: dto.formula ?? null, effectiveFrom: dto.effective_from, effectiveTo: dto.effective_to ?? null, note: dto.note ?? null });
      await repo.save(it);
    });
    return this.employeePay(access, employeeId);
  }

  async deletePayItem(access: AccessProfile, employeeId: string, id: string) {
    const e = await this.employeeOr404(employeeId);
    await this.assertScope(access, 'salary:manage', e);
    await this.dataSource.transaction(async (m) => {
      const it = await m.getRepository(EmployeePayItem).findOneBy({ id, employeeId });
      if (!it) throw notFound('Pay item');
      await this.assertOpen(m, it.effectiveFrom, 'Removing a pay item');
      await m.getRepository(EmployeePayItem).delete({ id });
    });
    return this.employeePay(access, employeeId);
  }

  // ================================================================== loans and one-off items
  async loans(q: { employee_id?: string; status?: string }) {
    const rows: { id: string; employee_id: string; employee_name: string; component_id: string; component_name: string; reference: string | null; principal: string; installment: string; start_period: string; status: 'active' | 'settled' | 'cancelled'; note: string | null; created_at: Date; version: number; repaid: string }[] = await this.dataSource.query(
      `SELECT l.id, l.employee_id, e.first_name || ' ' || e.last_name AS employee_name, l.component_id, c.name AS component_name, l.reference, l.principal, l.installment, l.start_period, l.status, l.note, l.created_at, l.version,
              COALESCE((SELECT sum(pl.amount) FROM payslip_line pl JOIN payslip p ON p.id = pl.payslip_id JOIN payroll_run r ON r.id = p.run_id WHERE pl.loan_id = l.id AND r.status IN ('approved', 'paid', 'closed')), 0) AS repaid
         FROM employee_loan l JOIN employee e ON e.id = l.employee_id JOIN pay_component c ON c.id = l.component_id
        WHERE ($1::uuid IS NULL OR l.employee_id = $1) AND ($2::text IS NULL OR l.status = $2)
        ORDER BY l.created_at DESC LIMIT 1000`,
      [q.employee_id ?? null, q.status ?? null],
    );
    return rows.map((r) => ({
      id: r.id, employee_id: r.employee_id, employee_name: r.employee_name, component_id: r.component_id, component_name: r.component_name, reference: r.reference, principal: m2(r.principal), installment: m2(r.installment),
      start_period: r.start_period, repaid: m2(r.repaid), balance: m2(Decimal.max(0, new Decimal(r.principal).minus(r.repaid))), status: r.status, note: r.note, created_at: new Date(r.created_at).toISOString(), version: r.version,
    }));
  }

  async saveLoan(access: AccessProfile, dto: Dto<typeof upsertLoan>, id?: string, version?: number) {
    const e = await this.employeeOr404(dto.employee_id);
    await this.assertScope(access, 'salary:manage', e);
    const c = await this.dataSource.getRepository(PayComponent).findOneBy({ id: dto.component_id });
    if (!c || c.kind !== 'deduction' || c.isSystem) throw unprocessable('bad_component', 'Choose a deduction such as Staff loan, Salary advance or HELB', [{ path: 'component_id', message: 'Not a loan deduction' }]);
    if (new Decimal(dto.installment).gt(dto.principal)) throw unprocessable('bad_installment', 'The instalment is more than the amount', [{ path: 'installment', message: 'Too large' }]);
    const repo = this.dataSource.getRepository(EmployeeLoan);
    const l = id ? await repo.findOneBy({ id }) : repo.create();
    if (!l) throw notFound('Loan');
    if (id && version !== undefined) assertVersion(l.version, version);
    if (id && l.employeeId !== dto.employee_id) throw unprocessable('employee_changed', 'A loan cannot move to another person');
    Object.assign(l, { employeeId: dto.employee_id, componentId: dto.component_id, reference: dto.reference ?? null, principal: dto.principal, installment: dto.installment, startPeriod: dto.start_period, status: dto.status, note: dto.note ?? null });
    const saved = await repo.save(l);
    return (await this.loans({ employee_id: dto.employee_id })).find((x) => x.id === saved.id)!;
  }

  async oneOffs(q: { employee_id?: string; period?: string }) {
    const rows: { id: string; employee_id: string; employee_name: string; component_id: string; component_name: string; kind: string; period: string; amount: string; note: string | null; created_at: Date }[] = await this.dataSource.query(
      `SELECT o.id, o.employee_id, e.first_name || ' ' || e.last_name AS employee_name, o.component_id, c.name AS component_name, c.kind, o.period, o.amount, o.note, o.created_at
         FROM payroll_one_off o JOIN employee e ON e.id = o.employee_id JOIN pay_component c ON c.id = o.component_id
        WHERE ($1::uuid IS NULL OR o.employee_id = $1) AND ($2::text IS NULL OR o.period = $2) ORDER BY o.period DESC, o.created_at DESC LIMIT 2000`,
      [q.employee_id ?? null, q.period ?? null],
    );
    return rows.map((r) => ({ ...r, amount: m2(r.amount), created_at: new Date(r.created_at).toISOString() }));
  }

  private async assertPeriodOpen(m: EntityManager, period: string) {
    const run = await m.getRepository(PayrollRun).findOneBy({ period });
    if (run && (isLocked(run.status) || run.status === 'under_review')) throw conflict('period_locked', `The ${period} payroll is ${run.status.replace('_', ' ')}; items for it can no longer change`);
  }

  async createOneOff(access: AccessProfile, dto: Dto<typeof createOneOff>) {
    const e = await this.employeeOr404(dto.employee_id);
    await this.assertScope(access, 'salary:manage', e);
    const c = await this.dataSource.getRepository(PayComponent).findOneBy({ id: dto.component_id });
    if (!c || c.isSystem || c.status !== 'active' || c.kind === 'employer_contribution') throw unprocessable('bad_component', 'Choose an earning, benefit or deduction', [{ path: 'component_id', message: 'Not allowed' }]);
    return this.dataSource.transaction(async (m) => {
      await this.assertPeriodOpen(m, dto.period);
      const o = await m.getRepository(PayrollOneOff).save(m.getRepository(PayrollOneOff).create({ employeeId: dto.employee_id, componentId: dto.component_id, period: dto.period, amount: dto.amount, note: dto.note ?? null }));
      return { id: o.id, employee_id: o.employeeId, component_id: c.id, component_name: c.name, kind: c.kind, period: o.period, amount: m2(o.amount), note: o.note, created_at: o.createdAt.toISOString() };
    });
  }

  async deleteOneOff(id: string) {
    await this.dataSource.transaction(async (m) => {
      const o = await m.getRepository(PayrollOneOff).findOneBy({ id });
      if (!o) throw notFound('One-off item');
      await this.assertPeriodOpen(m, o.period);
      await m.getRepository(PayrollOneOff).delete({ id });
    });
  }

  // ================================================================== runs
  runDto(r: PayrollRun) {
    return {
      id: r.id, number: r.number, period: r.period, period_start: r.periodStart, period_end: r.periodEnd, pay_date: r.payDate, status: r.status, employees: r.employees,
      gross: m2(r.gross), total_deductions: m2(r.totalDeductions), net: m2(r.net), paye: m2(r.paye), employer_cost: m2(r.employerCost), warnings: r.warnings,
      calculated_at: iso(r.calculatedAt), submitted_at: iso(r.submittedAt), approved_at: iso(r.approvedAt), paid_at: iso(r.paidAt), closed_at: iso(r.closedAt), decision_comment: r.decisionComment,
      workflow_instance_id: r.workflowInstanceId, created_at: r.createdAt.toISOString(), updated_at: r.updatedAt.toISOString(), version: r.version,
    };
  }

  async runs() {
    return (await this.dataSource.getRepository(PayrollRun).find({ order: { period: 'DESC' }, take: 120 })).map((r) => this.runDto(r));
  }

  async run(id: string, m: EntityManager = this.dataSource.manager) {
    const r = await m.getRepository(PayrollRun).findOneBy({ id });
    if (!r) throw notFound('Payroll run');
    return r;
  }

  /** The last working day of the month, or the configured pay day moved back off a rest day or holiday. */
  async defaultPayDate(m: EntityManager, period: string): Promise<string> {
    const { start, end } = periodBounds(period);
    const day = await this.settings.get('payroll.pay_day', m);
    let d = day > 0 ? `${period}-${String(Math.min(day, Number(end.slice(8)))).padStart(2, '0')}` : end;
    for (let i = 0; i < 10 && d >= start; i++, d = dayBefore(d)) {
      if ((await this.leave.workingDaysBetween(m, null, d, d)) > 0) return d;
    }
    return end;
  }

  async createRun(dto: Dto<typeof createRun>) {
    return this.dataSource.transaction(async (m) => {
      if (await m.getRepository(PayrollRun).existsBy({ period: dto.period })) throw conflict('run_exists', `There is already a payroll for ${dto.period}`);
      const later = await m.query(`SELECT period FROM payroll_run WHERE period > $1 AND status IN ('approved', 'paid', 'closed') LIMIT 1`, [dto.period]);
      if (later.length) throw conflict('later_run_approved', `The ${later[0].period} payroll is already approved; earlier months cannot be run now`);
      const { start, end } = periodBounds(dto.period);
      const payDate = dto.pay_date ?? (await this.defaultPayDate(m, dto.period));
      const r = await m.getRepository(PayrollRun).save(m.getRepository(PayrollRun).create({ number: `PR/${dto.period.replace('-', '/')}`, period: dto.period, periodStart: start, periodEnd: end, payDate, status: 'draft', warnings: [] }));
      return this.runDto(r);
    });
  }

  async deleteRun(id: string) {
    await this.dataSource.transaction(async (m) => {
      const r = await this.run(id, m);
      if (!['draft', 'calculated'].includes(r.status)) throw conflict('run_locked', `A ${r.status.replace('_', ' ')} payroll cannot be deleted`);
      await m.getRepository(PayrollRun).delete({ id });
    });
  }

  /**
   * Works out every payslip for the period. Deterministic and re-runnable until the run is
   * submitted: it replaces the previous calculation with one from the current inputs.
   */
  async calculate(access: AccessProfile, id: string) {
    return this.dataSource.transaction(async (m) => {
      const run = await this.run(id, m);
      await m.query(`SELECT pg_advisory_xact_lock(hashtext('payroll_run'), hashtext($1))`, [id]);
      if (!['draft', 'calculated'].includes(run.status)) throw conflict('run_locked', `A ${run.status.replace('_', ' ')} payroll cannot be recalculated`);
      const { tables, ids } = await this.tablesOn(m, run.periodEnd);
      const basis = await this.settings.get('payroll.proration_basis', m);
      const monthlyHours = await this.settings.get('payroll.monthly_hours', m);
      const components = await m.getRepository(PayComponent).find();
      const byId = new Map(components.map((c) => [c.id, c]));
      await m.getRepository(Payslip).delete({ runId: id });

      const people = await m.getRepository(Employee).createQueryBuilder('e')
        .leftJoinAndSelect('e.department', 'd').leftJoinAndSelect('e.costCentre', 'cc').leftJoinAndSelect('e.position', 'p')
        .addSelect('e.kraPinEnc')
        .where(`e.status <> 'onboarding' AND e.hire_date <= :end AND (e.exit_date IS NULL OR e.exit_date >= :start)`, { start: run.periodStart, end: run.periodEnd })
        .orderBy('e.staff_number').getMany();
      const runWarnings: PayrollRun['warnings'] = [];
      const totals = { n: 0, gross: new Decimal(0), ded: new Decimal(0), net: new Decimal(0), paye: new Decimal(0), employer: new Decimal(0) };

      // Overtime multipliers in force at the period end.
      const otRules: { day_type: string; multiplier: string | null; requires_approval: boolean }[] = await m.query(
        `SELECT day_type, multiplier, requires_approval FROM overtime_rule WHERE effective_from <= $1 AND (effective_to IS NULL OR effective_to >= $1)`, [run.periodEnd],
      );

      for (const e of people) {
        const name = e.displayName;
        const from = e.hireDate > run.periodStart ? e.hireDate : run.periodStart;
        const to = e.exitDate && e.exitDate < run.periodEnd ? e.exitDate : run.periodEnd;
        const salaries = await m.getRepository(EmployeeSalary).createQueryBuilder('s').where('s.employee_id = :id AND s.effective_from <= :to AND (s.effective_to IS NULL OR s.effective_to >= :from)', { id: e.id, from, to }).orderBy('s.effective_from', 'DESC').getMany();
        if (!salaries.length) {
          runWarnings.push({ employee_id: e.id, name, message: 'No salary set; left out of this payroll' });
          continue;
        }
        const warnings: string[] = [];
        if (salaries.length > 1) warnings.push(`Salary changed on ${salaries[0].effectiveFrom}; this month uses the new salary. Pay any difference for the earlier days as arrears.`);
        if (e.status === 'suspended') warnings.push('Suspended: check whether this suspension is with pay');
        if (!e.kraPinEnc) warnings.push('No KRA PIN on record');
        if (!e.nssfNumber) warnings.push('No NSSF number on record');
        if (!e.shaNumber) warnings.push('No SHA number on record');

        const totalUnits = basis === 'calendar_days' ? daysBetween(run.periodStart, run.periodEnd) : await this.leave.workingDaysBetween(m, e.branchId, run.periodStart, run.periodEnd);
        const paidUnits = basis === 'calendar_days' ? daysBetween(from, to) : await this.leave.workingDaysBetween(m, e.branchId, from, to);
        const unpaid = await this.leave.unpaidLeaveDays(m, e.id, e.branchId, from, to);

        const itemRows = await m.getRepository(EmployeePayItem).createQueryBuilder('i').where('i.employee_id = :id AND i.effective_from <= :to AND (i.effective_to IS NULL OR i.effective_to >= :to)', { id: e.id, to }).getMany();
        const items: CalcItem[] = [];
        for (const it of itemRows) {
          const c = byId.get(it.componentId);
          if (!c || c.status !== 'active') continue;
          items.push({ code: c.code, name: c.name, kind: c.kind, method: c.method, value: it.value ?? c.defaultValue, formula: it.formula ?? c.formula, taxable: c.taxable, pensionable: c.pensionable, prorate: c.prorate, treatment: c.taxTreatment });
        }
        const loanRows = (await this.loansFor(m, e.id, run.period, id)).filter((l) => new Decimal(l.balance).gt(0));
        const loans: CalcLoan[] = loanRows.map((l) => ({ loanId: l.id, code: byId.get(l.component_id)?.code ?? 'LOAN', name: `${l.component_name}${l.reference ? ` (${l.reference})` : ''}`, installment: Number(l.installment), balance: Number(l.balance) }));
        const oneOffRows = await m.getRepository(PayrollOneOff).findBy({ employeeId: e.id, period: run.period });
        const oneOffs: CalcOneOff[] = oneOffRows.map((o) => {
          const c = byId.get(o.componentId)!;
          return { code: c.code, name: c.name, kind: c.kind, amount: Number(o.amount), taxable: c.taxable, pensionable: c.pensionable, treatment: c.taxTreatment, note: o.note };
        });

        for (const p of this.providers) oneOffs.push(...(await p(m, e, { period: run.period, start: run.periodStart, end: run.periodEnd, from, to }, Number(salaries[0].basic))));

        const otRows: { day_type: string; minutes: number }[] = await m.query(
          `SELECT day_type, sum(overtime_minutes)::int AS minutes FROM attendance_day WHERE employee_id = $1 AND work_date BETWEEN $2 AND $3 AND overtime_minutes > 0 GROUP BY 1`, [e.id, from, to],
        );
        const overtime: CalcOvertime[] = [];
        for (const o of otRows) {
          const rule = otRules.find((r) => r.day_type === o.day_type);
          if (!rule?.multiplier) continue;
          if (rule.requires_approval) { warnings.push(`${Math.round(o.minutes / 6) / 10} h of ${o.day_type.replace('_', ' ')} overtime need approval and were not paid`); continue; }
          overtime.push({ dayType: o.day_type, minutes: o.minutes, multiplier: Number(rule.multiplier) });
        }

        const salary = salaries[0];
        const input: CalcInput = { basicMonthly: Number(salary.basic), paidUnits, totalUnits, unpaidLeaveDays: unpaid.days, monthlyHours, items, overtime, loans, oneOffs, tables };
        const r = calculatePayslip(input);
        warnings.push(...r.warnings);

        const account = await m.getRepository(EmployeeBankAccount).findOne({ where: { employeeId: e.id }, order: { isPrimary: 'DESC', createdAt: 'ASC' } });
        if (!account && r.net > 0) warnings.push('No bank or M-Pesa account; pay by other means');

        const slip = await m.getRepository(Payslip).save(m.getRepository(Payslip).create({
          runId: id, employeeId: e.id, number: null, employeeName: name, staffNumber: e.staffNumber, departmentId: e.departmentId, departmentName: e.department?.name ?? null,
          costCentreId: e.costCentreId, costCentreCode: e.costCentre?.code ?? null, basic: m2(r.basic), gross: m2(r.gross), taxablePay: m2(r.taxable_pay), paye: m2(r.paye), nssf: m2(r.nssf),
          shif: m2(r.shif), housingLevy: m2(r.housing_levy), totalDeductions: m2(r.total_deductions), net: m2(r.net), employerCost: m2(r.employer_cost),
          tax: { allowable: r.allowable, tax_before_relief: r.tax_before_relief, personal_relief: r.personal_relief, insurance_relief: r.insurance_relief },
          inputs: { ...input, tables: undefined, table_ids: ids, salary_id: salary.id, unpaid_leave: unpaid.detail, period: { from, to, basis }, position: e.position?.title ?? null },
          warnings, paymentMethod: account ? account.kind : 'cash', paymentAccountId: account?.id ?? null,
        }));
        await m.getRepository(PayslipLine).insert(r.lines.map((l, i) => ({ payslipId: slip.id, seq: i, code: l.code, name: l.name, kind: l.kind, amount: m2(l.amount), taxable: l.taxable ?? null, detail: l.detail ?? null, loanId: l.loanId ?? null })));
        for (const w of warnings) runWarnings.push({ employee_id: e.id, name, message: w });
        totals.n++;
        totals.gross = totals.gross.plus(r.gross);
        totals.ded = totals.ded.plus(r.total_deductions);
        totals.net = totals.net.plus(r.net);
        totals.paye = totals.paye.plus(r.paye);
        totals.employer = totals.employer.plus(r.employer_cost);
      }

      Object.assign(run, {
        status: 'calculated', employees: totals.n, gross: m2(totals.gross), totalDeductions: m2(totals.ded), net: m2(totals.net), paye: m2(totals.paye), employerCost: m2(totals.employer),
        warnings: runWarnings, calculatedAt: new Date(), calculatedBy: access.actorId, decisionComment: null,
      });
      return this.runDto(await m.getRepository(PayrollRun).save(run));
    });
  }

  /** Loans being repaid in a period, with what is left after approved payrolls (this run excluded). */
  private async loansFor(m: EntityManager, employeeId: string, period: string, runId: string) {
    const rows: { id: string; component_id: string; component_name: string; reference: string | null; installment: string; balance: string }[] = await m.query(
      `SELECT l.id, l.component_id, c.name AS component_name, l.reference, l.installment,
              l.principal - COALESCE((SELECT sum(pl.amount) FROM payslip_line pl JOIN payslip p ON p.id = pl.payslip_id JOIN payroll_run r ON r.id = p.run_id
                                       WHERE pl.loan_id = l.id AND r.status IN ('approved', 'paid', 'closed') AND r.id <> $3), 0) AS balance
         FROM employee_loan l JOIN pay_component c ON c.id = l.component_id
        WHERE l.employee_id = $1 AND l.status = 'active' AND l.start_period <= $2 ORDER BY l.created_at`,
      [employeeId, period, runId],
    );
    return rows;
  }

  async submit(access: AccessProfile, id: string, comment?: string | null) {
    return this.dataSource.transaction(async (m) => {
      const run = await this.run(id, m);
      if (run.status !== 'calculated') throw conflict('not_calculated', 'Calculate the payroll before submitting it');
      if (run.employees === 0) throw unprocessable('empty_run', 'This payroll has no payslips');
      const u: { id: string } | undefined = (await m.query(`SELECT id FROM user_account WHERE id = $1`, [access.actorId]))[0];
      const instance = await this.workflow.submit(m, {
        requestType: 'payroll_run', subjectId: run.id, subjectEmployeeId: null, requesterUserId: u?.id ?? null, value: Number(run.net),
        summary: `Payroll ${run.period}: ${run.employees} staff, net KES ${Number(run.net).toLocaleString('en-KE', { minimumFractionDigits: 2 })}${comment ? `. ${comment}` : ''}`,
        context: { period: run.period, employees: run.employees, gross: m2(run.gross), net: m2(run.net), warnings: run.warnings.length },
      });
      Object.assign(run, { status: 'under_review', submittedAt: new Date(), workflowInstanceId: instance.id, decisionComment: null });
      return this.runDto(await m.getRepository(PayrollRun).save(run));
    });
  }

  /** Workflow: final approval locks the payslips, numbers them, publishes them and tells staff. */
  private async approve(m: EntityManager, i: WorkflowInstance) {
    const run = await this.run(i.subjectId, m);
    if (run.status !== 'under_review') throw conflict('run_state', `The payroll is ${run.status}`);
    const slips = await m.getRepository(Payslip).find({ where: { runId: run.id }, order: { staffNumber: 'ASC' } });
    for (const s of slips) {
      s.number = await this.numbering.next('payslip', { manager: m, date: run.payDate });
      await m.getRepository(Payslip).save(s);
    }
    Object.assign(run, { status: 'approved', approvedAt: new Date() });
    await m.getRepository(PayrollRun).save(run);
    // Settled loans close themselves.
    await m.query(
      `UPDATE employee_loan l SET status = 'settled', updated_at = now(), version = version + 1
        WHERE l.status = 'active' AND l.id IN (SELECT pl.loan_id FROM payslip_line pl JOIN payslip p ON p.id = pl.payslip_id WHERE p.run_id = $1 AND pl.loan_id IS NOT NULL)
          AND l.principal <= (SELECT COALESCE(sum(pl.amount), 0) FROM payslip_line pl JOIN payslip p ON p.id = pl.payslip_id JOIN payroll_run r ON r.id = p.run_id WHERE pl.loan_id = l.id AND r.status IN ('approved', 'paid', 'closed'))`,
      [run.id],
    );
    await this.outbox.record(m, 'hr.payroll.run.approved.v1', run.id, { id: run.id, number: run.number, period: run.period, pay_date: run.payDate, employees: run.employees, gross: m2(run.gross), net: m2(run.net), employer_cost: m2(run.employerCost) });
    if (await this.settings.get('payroll.notify_payslips', m)) {
      const users: { id: string }[] = await m.query(`SELECT u.id FROM user_account u JOIN payslip p ON p.employee_id = u.employee_id WHERE p.run_id = $1 AND u.status = 'active'`, [run.id]);
      await this.notifications.notifyUsers(users.map((u) => u.id), 'payslip_ready', { period: run.period, pay_date: run.payDate }, '/me/payslips', m);
    }
  }

  private async sendBack(m: EntityManager, i: WorkflowInstance, comment: string | null) {
    const run = await this.run(i.subjectId, m);
    Object.assign(run, { status: 'calculated', decisionComment: comment, submittedAt: null, workflowInstanceId: null });
    await m.getRepository(PayrollRun).save(run);
  }

  async markPaid(id: string) {
    return this.dataSource.transaction(async (m) => {
      const run = await this.run(id, m);
      if (run.status !== 'approved') throw conflict('not_approved', 'Only an approved payroll can be marked paid');
      Object.assign(run, { status: 'paid', paidAt: new Date() });
      await m.getRepository(PayrollRun).save(run);
      await this.outbox.record(m, 'hr.payroll.run.paid.v1', run.id, { id: run.id, number: run.number, period: run.period, paid_at: run.paidAt!.toISOString() });
      return this.runDto(run);
    });
  }

  async close(id: string) {
    return this.dataSource.transaction(async (m) => {
      const run = await this.run(id, m);
      if (run.status !== 'paid') throw conflict('not_paid', 'Mark the payroll paid before closing it');
      Object.assign(run, { status: 'closed', closedAt: new Date() });
      return this.runDto(await m.getRepository(PayrollRun).save(run));
    });
  }

  // ================================================================== payslips
  payslipDto(s: Payslip, run: PayrollRun, lines?: PayslipLine[]) {
    return {
      id: s.id, run_id: s.runId, period: run.period, pay_date: run.payDate, run_status: run.status, number: s.number, employee_id: s.employeeId, employee_name: s.employeeName, staff_number: s.staffNumber,
      department_name: s.departmentName, cost_centre_code: s.costCentreCode, basic: m2(s.basic), gross: m2(s.gross), taxable_pay: m2(s.taxablePay), paye: m2(s.paye), nssf: m2(s.nssf), shif: m2(s.shif),
      housing_levy: m2(s.housingLevy), total_deductions: m2(s.totalDeductions), net: m2(s.net), employer_cost: m2(s.employerCost), tax: s.tax, warnings: s.warnings, payment_method: s.paymentMethod,
      ...(lines ? { lines: lines.map((l) => ({ code: l.code, name: l.name, kind: l.kind as 'earning', amount: m2(l.amount), detail: l.detail })) } : {}),
    };
  }

  async payslips(access: AccessProfile, runId: string) {
    const run = await this.run(runId);
    const qb = this.dataSource.getRepository(Payslip).createQueryBuilder('s').innerJoin(Employee, 'e', 'e.id = s.employee_id').where('s.run_id = :runId', { runId }).orderBy('s.staff_number');
    applyScope(qb, await this.scope.filterFor(access, 'payroll:read'), { branch: 'e.branch_id', department: 'e.department_id', employee: 'e.id' });
    return (await qb.getMany()).map((s) => this.payslipDto(s, run));
  }

  async loadPayslip(id: string) {
    const s = await this.dataSource.getRepository(Payslip).findOneBy({ id });
    if (!s) throw notFound('Payslip');
    const run = await this.run(s.runId);
    const lines = await this.dataSource.getRepository(PayslipLine).find({ where: { payslipId: id }, order: { seq: 'ASC' } });
    return { s, run, lines };
  }

  /** Payroll staff see payslips in their scope; everyone sees their own approved ones. */
  async payslip(access: AccessProfile, id: string) {
    const { s, run, lines } = await this.loadPayslip(id);
    await this.assertCanSee(access, s, run);
    return this.payslipDto(s, run, lines);
  }

  async assertCanSee(access: AccessProfile, s: Payslip, run: PayrollRun) {
    if (access.employeeId === s.employeeId && isLocked(run.status)) return;
    if (!access.has('payroll:read')) throw notFound('Payslip');
    const e = await this.employeeOr404(s.employeeId);
    await this.assertScope(access, 'payroll:read', e);
  }

  async myPayslips(access: AccessProfile) {
    if (!access.employeeId) return [];
    const rows = await this.dataSource.getRepository(Payslip).createQueryBuilder('s').innerJoinAndMapOne('s.run', PayrollRun, 'r', 'r.id = s.run_id')
      .where('s.employee_id = :e AND r.status IN (:...st)', { e: access.employeeId, st: LOCKED }).orderBy('r.period', 'DESC').getMany();
    return rows.map((s) => this.payslipDto(s, (s as Payslip & { run: PayrollRun }).run));
  }

  // ================================================================== variance
  async variance(id: string) {
    const run = await this.run(id);
    const prev = await this.dataSource.getRepository(PayrollRun).createQueryBuilder('r').where(`r.period < :p AND r.status IN ('approved', 'paid', 'closed')`, { p: run.period }).orderBy('r.period', 'DESC').getOne();
    const threshold = await this.settings.get('payroll.variance_threshold_pct');
    const cur = await this.dataSource.getRepository(Payslip).findBy({ runId: id });
    const old = prev ? await this.dataSource.getRepository(Payslip).findBy({ runId: prev.id }) : [];
    const oldBy = new Map(old.map((s) => [s.employeeId, s]));
    const curBy = new Map(cur.map((s) => [s.employeeId, s]));
    const rows = [];
    for (const s of cur) {
      const o = oldBy.get(s.employeeId);
      const change = new Decimal(s.net).minus(o?.net ?? 0);
      const pct = o && Number(o.net) !== 0 ? change.div(o.net).mul(100).toDecimalPlaces(1).toNumber() : null;
      rows.push({ employee_id: s.employeeId, employee_name: s.employeeName, staff_number: s.staffNumber, previous_gross: o ? m2(o.gross) : null, current_gross: m2(s.gross), previous_net: o ? m2(o.net) : null, current_net: m2(s.net), change: m2(change), change_pct: pct, flag: !o ? 'new' as const : pct !== null && Math.abs(pct) > threshold ? 'changed' as const : 'unchanged' as const });
    }
    for (const o of old) {
      if (curBy.has(o.employeeId)) continue;
      rows.push({ employee_id: o.employeeId, employee_name: o.employeeName, staff_number: o.staffNumber, previous_gross: m2(o.gross), current_gross: null, previous_net: m2(o.net), current_net: null, change: m2(new Decimal(o.net).neg()), change_pct: -100, flag: 'left' as const });
    }
    const order = { left: 0, new: 1, changed: 2, unchanged: 3 };
    rows.sort((a, b) => order[a.flag] - order[b.flag] || Math.abs(Number(b.change)) - Math.abs(Number(a.change)));
    return { previous_run_id: prev?.id ?? null, previous_period: prev?.period ?? null, threshold_pct: threshold, rows };
  }

  // ================================================================== journal
  /**
   * Double entry by cost centre: earnings and employer contributions are expenses (debit,
   * per cost centre); deductions, employer contributions and net pay are liabilities
   * (credit). Accounts come from the mapping table: the component code, else the
   * EARNINGS / DEDUCTIONS / EMPLOYER defaults, and NET_PAY for net salaries.
   */
  async journal(id: string) {
    const run = await this.run(id);
    const map = new Map((await this.dataSource.getRepository(GlAccountMap).find()).map((g) => [g.key, g]));
    const lines: { code: string; kind: string; amount: string; cc: string | null; name: string }[] = await this.dataSource.query(
      `SELECT pl.code, pl.kind, pl.amount::text AS amount, p.cost_centre_code AS cc, pl.name FROM payslip_line pl JOIN payslip p ON p.id = pl.payslip_id WHERE p.run_id = $1 AND pl.kind <> 'benefit'
       UNION ALL SELECT 'NET_PAY', 'net', p.net::text, p.cost_centre_code, 'Net salaries' FROM payslip p WHERE p.run_id = $1`,
      [id],
    );
    const unmapped = new Set<string>();
    const acct = (code: string, fallback: string, side: 'debit' | 'credit') => {
      const g = map.get(code) ?? (code.startsWith('OT_') ? map.get('OVERTIME') : undefined);
      const a = (side === 'debit' ? g?.debitAccount : g?.creditAccount) ?? (side === 'debit' ? map.get(fallback)?.debitAccount : map.get(fallback)?.creditAccount) ?? null;
      if (!a || a.startsWith('TBD')) unmapped.add(g?.key ?? fallback);
      return { account: a ?? `UNMAPPED-${fallback}`, description: g?.description ?? map.get(fallback)?.description ?? fallback };
    };
    const agg = new Map<string, { account: string; cost_centre_code: string | null; description: string; debit: Decimal; credit: Decimal }>();
    const add = (account: string, cc: string | null, description: string, debit: Decimal.Value, credit: Decimal.Value) => {
      const k = `${account}|${cc ?? ''}`;
      const row = agg.get(k) ?? { account, cost_centre_code: cc, description, debit: new Decimal(0), credit: new Decimal(0) };
      row.debit = row.debit.plus(debit);
      row.credit = row.credit.plus(credit);
      agg.set(k, row);
    };
    for (const l of lines) {
      const amt = new Decimal(l.amount);
      if (amt.isZero()) continue;
      if (l.kind === 'earning') { const a = acct(l.code, 'EARNINGS', 'debit'); add(a.account, l.cc, a.description, amt, 0); }
      else if (l.kind === 'deduction') { const a = acct(l.code, 'DEDUCTIONS', 'credit'); add(a.account, null, a.description, 0, amt); }
      else if (l.kind === 'employer_contribution') {
        const d = acct(l.code, 'EMPLOYER', 'debit'), c = acct(l.code, 'EMPLOYER', 'credit');
        add(d.account, l.cc, d.description, amt, 0);
        add(c.account, null, c.description, 0, amt);
      } else if (l.kind === 'net') { const a = acct('NET_PAY', 'NET_PAY', 'credit'); add(a.account, null, a.description, 0, amt); }
    }
    // A negative expense (unpaid leave) nets off its own account; keep each row on one side.
    const out = [...agg.values()].map((r) => {
      const net = r.debit.minus(r.credit);
      return { account: r.account, cost_centre_code: r.cost_centre_code, description: r.description, debit: m2(Decimal.max(net, 0)), credit: m2(Decimal.max(net.neg(), 0)) };
    }).filter((r) => r.debit !== '0.00' || r.credit !== '0.00').sort((a, b) => (Number(b.debit) > 0 ? 1 : 0) - (Number(a.debit) > 0 ? 1 : 0) || a.account.localeCompare(b.account) || (a.cost_centre_code ?? '').localeCompare(b.cost_centre_code ?? ''));
    const td = out.reduce((a, r) => a.plus(r.debit), new Decimal(0));
    const tc = out.reduce((a, r) => a.plus(r.credit), new Decimal(0));
    return { run_id: run.id, period: run.period, pay_date: run.payDate, lines: out, total_debit: m2(td), total_credit: m2(tc), unmapped: [...unmapped].sort() };
  }

  // ================================================================== helpers for outputs
  async organisation() {
    const [o] = await this.dataSource.query(`SELECT name, legal_name, kra_pin, nssf_employer_no, sha_employer_no FROM organisation ORDER BY created_at LIMIT 1`);
    return o as { name: string; legal_name: string | null; kra_pin: string | null; nssf_employer_no: string | null; sha_employer_no: string | null } | undefined;
  }

  async employeesById(ids: string[]) {
    if (!ids.length) return new Map<string, Employee>();
    const rows = await this.dataSource.getRepository(Employee).createQueryBuilder('e').addSelect(['e.kraPinEnc', 'e.nationalIdEnc']).leftJoinAndSelect('e.position', 'p').where({ id: In(ids) }).getMany();
    return new Map(rows.map((e) => [e.id, e]));
  }
}
