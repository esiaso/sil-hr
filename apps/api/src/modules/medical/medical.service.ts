import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import Decimal from 'decimal.js';
import { DataSource, EntityManager, In } from 'typeorm';
import { z } from 'zod';
import {
  adjustLimit, applyMedical, AuditAction, placeHold, postClaim, upsertMedicalCategory, upsertMedicalContributionRate, upsertMedicalLimitRule, upsertMedicalScheme,
} from '@sil/hr-shared';
import { AccessProfile, applyScope, scopeAllows } from '../../common/access';
import { assertVersion } from '../../common/etag';
import { conflict, forbidden, notFound, unprocessable } from '../../common/problem';
import { RequestContext } from '../../common/request-context';
import { writeAudit } from '../audit/audit.subscriber';
import { Employee, EmployeeDependant } from '../employees/employee.entities';
import { OutboxService } from '../events/events.module';
import { NotificationsService } from '../notifications/notifications.module';
import { ScopeService } from '../organisation/scope.service';
import { PayrollService } from '../payroll/payroll.service';
import { SettingsService } from '../settings/settings.module';
import { WorkflowInstance } from '../workflow/workflow.entities';
import { WorkflowService } from '../workflow/workflow.service';
import {
  MedicalApplication, MedicalCategory, MedicalContributionRate, MedicalLedger, MedicalLimitRule, MedicalMember, MedicalScheme, type LedgerType,
} from './medical.entities';
import { balance, carryOver, claimSplit, contribution, crossed, pickRule, schemeYear, type Balance } from './medical.rules';

type Dto<T extends z.ZodType> = z.infer<T>;
const m2 = (x: Decimal.Value) => new Decimal(x).toFixed(2);
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

interface Person { id: string; staffNumber: string; name: string; employmentType: string; jobGradeId: string | null; branchId: string | null; departmentId: string | null; departmentName: string | null; status: string; exitDate: string | null }

@Injectable()
export class MedicalService implements OnModuleInit {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly settings: SettingsService,
    private readonly workflow: WorkflowService,
    private readonly outbox: OutboxService,
    private readonly notifications: NotificationsService,
    private readonly scope: ScopeService,
    private readonly payroll: PayrollService,
  ) {}

  onModuleInit(): void {
    this.workflow.registerHandler('medical_application', {
      onApproved: (m, i, actor) => this.approve(m, i, actor),
      onRejected: (m, i, c) => this.closeApplication(m, i, 'rejected', c),
      onReturned: (m, i, c) => this.closeApplication(m, i, 'returned', c),
    });
    this.payroll.registerItemsProvider((m, e, p, basic) => this.contributionsFor(m, e.id, p.to, basic));
  }

  // ================================================================== setup
  schemeDto(s: MedicalScheme) {
    return {
      id: s.id, code: s.code, name: s.name, description: s.description, year_start_month: s.yearStartMonth, unused_limit_policy: s.unusedLimitPolicy, carry_over_max_pct: Number(s.carryOverMaxPct),
      max_dependants: s.maxDependants, over_limit_action: s.overLimitAction, contributions_enabled: s.contributionsEnabled, status: s.status,
      created_at: s.createdAt.toISOString(), updated_at: s.updatedAt.toISOString(), version: s.version,
    };
  }
  categoryDto(c: MedicalCategory) {
    return { id: c.id, scheme_id: c.schemeId, code: c.code, name: c.name, sharing: c.sharing, co_pay_pct: Number(c.coPayPct), per_visit_cap: c.perVisitCap === null ? null : m2(c.perVisitCap), waiting_days: c.waitingDays, principal_and_spouse_only: c.principalAndSpouseOnly, sort_order: c.sortOrder, status: c.status, version: c.version };
  }
  ruleDto(r: MedicalLimitRule) {
    return { id: r.id, scheme_id: r.schemeId, category_id: r.categoryId, job_grade_id: r.jobGradeId, employment_type: r.employmentType as never, annual_limit: m2(r.annualLimit), dependant_limit: r.dependantLimit === null ? null : m2(r.dependantLimit), effective_from: r.effectiveFrom, effective_to: r.effectiveTo, version: r.version };
  }
  rateDto(r: MedicalContributionRate) {
    return { id: r.id, scheme_id: r.schemeId, job_grade_id: r.jobGradeId, employment_type: r.employmentType as never, method: r.method, value: Number(r.value), per_dependant: m2(r.perDependant), effective_from: r.effectiveFrom, effective_to: r.effectiveTo, version: r.version };
  }

  async schemes() {
    return (await this.dataSource.getRepository(MedicalScheme).find({ order: { name: 'ASC' } })).map((s) => this.schemeDto(s));
  }

  async scheme(id: string) {
    const s = await this.dataSource.getRepository(MedicalScheme).findOneBy({ id });
    if (!s) throw notFound('Medical scheme');
    const [cats, rules, rates] = await Promise.all([
      this.dataSource.getRepository(MedicalCategory).find({ where: { schemeId: id }, order: { sortOrder: 'ASC', name: 'ASC' } }),
      this.dataSource.getRepository(MedicalLimitRule).find({ where: { schemeId: id }, order: { effectiveFrom: 'DESC' } }),
      this.dataSource.getRepository(MedicalContributionRate).find({ where: { schemeId: id }, order: { effectiveFrom: 'DESC' } }),
    ]);
    return { ...this.schemeDto(s), categories: cats.map((c) => this.categoryDto(c)), limit_rules: rules.map((r) => this.ruleDto(r)), contribution_rates: rates.map((r) => this.rateDto(r)) };
  }

  async saveScheme(dto: Dto<typeof upsertMedicalScheme>, id?: string, version?: number) {
    const repo = this.dataSource.getRepository(MedicalScheme);
    const s = id ? await repo.findOneBy({ id }) : repo.create();
    if (!s) throw notFound('Medical scheme');
    if (id && version !== undefined) assertVersion(s.version, version);
    Object.assign(s, {
      code: dto.code, name: dto.name, description: dto.description ?? null, yearStartMonth: dto.year_start_month, unusedLimitPolicy: dto.unused_limit_policy, carryOverMaxPct: String(dto.carry_over_max_pct),
      maxDependants: dto.max_dependants, overLimitAction: dto.over_limit_action, contributionsEnabled: dto.contributions_enabled, status: dto.status,
    });
    return this.schemeDto(await repo.save(s));
  }

  async saveCategory(schemeId: string, dto: Dto<typeof upsertMedicalCategory>, id?: string, version?: number) {
    const repo = this.dataSource.getRepository(MedicalCategory);
    const c = id ? await repo.findOneBy({ id, schemeId }) : repo.create({ schemeId });
    if (!c) throw notFound('Cover category');
    if (id && version !== undefined) assertVersion(c.version, version);
    Object.assign(c, { code: dto.code, name: dto.name, sharing: dto.sharing, coPayPct: String(dto.co_pay_pct), perVisitCap: dto.per_visit_cap ?? null, waitingDays: dto.waiting_days, principalAndSpouseOnly: dto.principal_and_spouse_only, sortOrder: dto.sort_order, status: dto.status });
    return this.categoryDto(await repo.save(c));
  }

  /** Limits are dated: a new open-ended rule for the same grade and type closes the old one the day before. */
  async saveLimitRule(schemeId: string, dto: Dto<typeof upsertMedicalLimitRule>, id?: string, version?: number) {
    return this.dataSource.transaction(async (m) => {
      const cat = await m.getRepository(MedicalCategory).findOneBy({ id: dto.category_id, schemeId });
      if (!cat) throw unprocessable('category_not_found', 'That category is not in this scheme', [{ path: 'category_id', message: 'Not found' }]);
      const repo = m.getRepository(MedicalLimitRule);
      const r = id ? await repo.findOneBy({ id, schemeId }) : repo.create({ schemeId });
      if (!r) throw notFound('Limit rule');
      if (id && version !== undefined) assertVersion(r.version, version);
      if (!id) {
        await m.query(
          `UPDATE medical_limit_rule SET effective_to = $5, updated_at = now(), version = version + 1
            WHERE category_id = $1 AND job_grade_id IS NOT DISTINCT FROM $2 AND employment_type IS NOT DISTINCT FROM $3 AND effective_to IS NULL AND effective_from < $4`,
          [dto.category_id, dto.job_grade_id ?? null, dto.employment_type ?? null, dto.effective_from, addDays(dto.effective_from, -1)],
        );
      }
      Object.assign(r, { categoryId: dto.category_id, jobGradeId: dto.job_grade_id ?? null, employmentType: dto.employment_type ?? null, annualLimit: dto.annual_limit, dependantLimit: dto.dependant_limit ?? null, effectiveFrom: dto.effective_from, effectiveTo: dto.effective_to ?? null });
      return this.ruleDto(await repo.save(r));
    });
  }

  async deleteLimitRule(id: string) {
    const r = await this.dataSource.getRepository(MedicalLimitRule).findOneBy({ id });
    if (!r) throw notFound('Limit rule');
    const today = await this.settings.today();
    if (r.effectiveFrom <= today) throw conflict('rule_in_use', 'This limit is already in force; end it with a new dated limit instead');
    await this.dataSource.getRepository(MedicalLimitRule).delete({ id });
  }

  async saveRate(schemeId: string, dto: Dto<typeof upsertMedicalContributionRate>, id?: string, version?: number) {
    return this.dataSource.transaction(async (m) => {
      const repo = m.getRepository(MedicalContributionRate);
      const r = id ? await repo.findOneBy({ id, schemeId }) : repo.create({ schemeId });
      if (!r) throw notFound('Contribution rate');
      if (id && version !== undefined) assertVersion(r.version, version);
      if (!id) {
        await m.query(
          `UPDATE medical_contribution_rate SET effective_to = $5, updated_at = now(), version = version + 1
            WHERE scheme_id = $1 AND job_grade_id IS NOT DISTINCT FROM $2 AND employment_type IS NOT DISTINCT FROM $3 AND effective_to IS NULL AND effective_from < $4`,
          [schemeId, dto.job_grade_id ?? null, dto.employment_type ?? null, dto.effective_from, addDays(dto.effective_from, -1)],
        );
      }
      Object.assign(r, { jobGradeId: dto.job_grade_id ?? null, employmentType: dto.employment_type ?? null, method: dto.method, value: String(dto.value), perDependant: dto.per_dependant, effectiveFrom: dto.effective_from, effectiveTo: dto.effective_to ?? null });
      return this.rateDto(await repo.save(r));
    });
  }

  async deleteRate(id: string) {
    const r = await this.dataSource.getRepository(MedicalContributionRate).findOneBy({ id });
    if (!r) throw notFound('Contribution rate');
    if (r.effectiveFrom <= (await this.settings.today())) throw conflict('rate_in_use', 'This rate is already in force; set a new dated rate instead');
    await this.dataSource.getRepository(MedicalContributionRate).delete({ id });
  }

  // ================================================================== people and members
  private async person(m: EntityManager, employeeId: string): Promise<Person> {
    const [r] = await m.query(
      `SELECT e.id, e.staff_number, e.first_name || ' ' || e.last_name AS name, e.employment_type, p.job_grade_id, e.branch_id, e.department_id, d.name AS department_name, e.status, to_char(e.exit_date, 'YYYY-MM-DD') AS exit_date
         FROM employee e LEFT JOIN position p ON p.id = e.position_id LEFT JOIN department d ON d.id = e.department_id WHERE e.id = $1`,
      [employeeId],
    );
    if (!r) throw notFound('Employee');
    return { id: r.id, staffNumber: r.staff_number, name: r.name, employmentType: r.employment_type, jobGradeId: r.job_grade_id, branchId: r.branch_id, departmentId: r.department_id, departmentName: r.department_name, status: r.status, exitDate: r.exit_date };
  }

  private memberDto(mb: MedicalMember, scheme: { name: string }, staffNumber: string) {
    return {
      id: mb.id, scheme_id: mb.schemeId, scheme_name: scheme.name, employee_id: mb.employeeId, staff_number: staffNumber, principal_member_id: mb.principalMemberId, member_number: mb.memberNumber, name: mb.name,
      relationship: mb.relationship, date_of_birth: mb.dateOfBirth, cover_start: mb.coverStart, cover_end: mb.coverEnd, status: mb.status,
    };
  }

  async resolveMember(m: EntityManager, ref: { member_id?: string; member_number?: string }): Promise<MedicalMember> {
    const mb = ref.member_id ? await m.getRepository(MedicalMember).findOneBy({ id: ref.member_id }) : await m.getRepository(MedicalMember).findOneBy({ memberNumber: (ref.member_number ?? '').toUpperCase() });
    if (!mb) throw notFound('Medical scheme member');
    return mb;
  }

  private principalOf(mb: MedicalMember) {
    return mb.principalMemberId ?? mb.id;
  }

  /** Every category's limit for one member on a date. */
  async balancesFor(m: EntityManager, mb: MedicalMember, on: string) {
    const scheme = await m.getRepository(MedicalScheme).findOneByOrFail({ id: mb.schemeId });
    const person = await this.person(m, mb.employeeId);
    const principal = mb.principalMemberId ? await m.getRepository(MedicalMember).findOneByOrFail({ id: mb.principalMemberId }) : mb;
    const cats = await m.getRepository(MedicalCategory).find({ where: { schemeId: mb.schemeId, status: 'active' }, order: { sortOrder: 'ASC' } });
    const rules = await m.getRepository(MedicalLimitRule).findBy({ schemeId: mb.schemeId });
    const sy = schemeYear(on, scheme.yearStartMonth);
    const out = [];
    for (const c of cats) {
      const rule = pickRule(rules.filter((r) => r.categoryId === c.id), { jobGradeId: person.jobGradeId, employmentType: person.employmentType }, on);
      const pool = c.sharing === 'shared' ? principal : mb;
      const base = !rule ? '0' : c.sharing === 'per_person' && pool.relationship !== 'principal' ? (rule.dependantLimit ?? rule.annualLimit) : rule.annualLimit;
      const rows = await m.getRepository(MedicalLedger).find({ where: { poolMemberId: pool.id, categoryId: c.id, schemeYear: sy.year } });
      const b = balance(base, rows, on);
      const waitingUntil = c.waitingDays > 0 ? addDays(mb.coverStart, c.waitingDays) : null;
      const eligible = !!rule && mb.status === 'active' && mb.coverStart <= on && (!mb.coverEnd || mb.coverEnd >= on) && !(c.principalAndSpouseOnly && !['principal', 'spouse'].includes(mb.relationship));
      out.push({
        category_id: c.id, category_code: c.code, category_name: c.name, sharing: c.sharing, pool_member_id: pool.id, scheme_year: sy.year, ...b, co_pay_pct: Number(c.coPayPct),
        per_visit_cap: c.perVisitCap === null ? null : m2(c.perVisitCap), waiting_until: waitingUntil, eligible,
      });
    }
    return { scheme, person, balances: out };
  }

  private async holdsFor(m: EntityManager, memberIds: string[], on: string) {
    if (!memberIds.length) return [];
    const rows: { id: string; member_id: string; code: string; amount: string; expires_on: string; external_ref: string | null; created_at: Date }[] = await m.query(
      `SELECT l.id, l.member_id, c.code, l.amount, to_char(l.expires_on, 'YYYY-MM-DD') AS expires_on, l.external_ref, l.created_at FROM medical_ledger l JOIN medical_category c ON c.id = l.category_id
        WHERE l.member_id = ANY($1::uuid[]) AND l.entry_type = 'hold' AND l.expires_on >= $2 AND NOT EXISTS (SELECT 1 FROM medical_ledger r WHERE r.hold_id = l.id AND r.entry_type = 'hold_release') ORDER BY l.created_at`,
      [memberIds, on],
    );
    return rows.map((r) => ({ id: r.id, member_id: r.member_id, category_code: r.code, amount: m2(r.amount), expires_on: r.expires_on, reference: r.external_ref, created_at: new Date(r.created_at).toISOString() }));
  }

  /** A member's cover card: limits, holds and family. Contains no pay or HR data. */
  async cover(memberId: string, on?: string) {
    const m = this.dataSource.manager;
    const date = on ?? (await this.settings.today());
    const mb = await this.resolveMember(m, { member_id: memberId });
    const { scheme, person, balances } = await this.balancesFor(m, mb, date);
    const family = await m.getRepository(MedicalMember).find({ where: [{ id: this.principalOf(mb) }, { principalMemberId: this.principalOf(mb) }], order: { memberNumber: 'ASC' } });
    return {
      ...this.memberDto(mb, scheme, person.staffNumber), department: person.departmentName, balances,
      holds: await this.holdsFor(m, family.map((f) => f.id), date),
      family: family.map((f) => this.memberDto(f, scheme, person.staffNumber)),
    };
  }

  /** Billing lookup by staff number, member number or name (staff or dependant). Every lookup is audited. */
  async lookup(access: AccessProfile, q: string) {
    const term = q.trim();
    if (term.length < 2) return [];
    const qb = this.dataSource.getRepository(MedicalMember).createQueryBuilder('mb').innerJoin(Employee, 'e', 'e.id = mb.employee_id')
      .where(`(mb.member_number ILIKE :p OR e.staff_number ILIKE :p OR mb.name ILIKE :like)`, { p: `${term}%`, like: `%${term}%` })
      .orderBy('mb.status').addOrderBy('mb.memberNumber').take(25);
    applyScope(qb, await this.scope.filterFor(access, 'medical:lookup'), { branch: 'e.branch_id', department: 'e.department_id', employee: 'e.id' });
    const rows = await qb.getMany();
    await writeAudit(this.dataSource.manager, { action: AuditAction.SENSITIVE_READ, entityType: 'MedicalMember', entityId: null, after: { lookup: term, results: rows.length } });
    const schemes = new Map((await this.dataSource.getRepository(MedicalScheme).find()).map((s) => [s.id, s]));
    const staff = new Map((await this.dataSource.getRepository(Employee).findBy({ id: In([...new Set(rows.map((r) => r.employeeId))].concat(['00000000-0000-0000-0000-000000000000'])) })).map((e) => [e.id, e.staffNumber]));
    return rows.map((r) => this.memberDto(r, schemes.get(r.schemeId)!, staff.get(r.employeeId) ?? ''));
  }

  async coverAudited(access: AccessProfile, memberId: string) {
    const c = await this.cover(memberId);
    await this.assertScopeFor(access, 'medical:lookup', c.employee_id);
    await writeAudit(this.dataSource.manager, { action: AuditAction.SENSITIVE_READ, entityType: 'MedicalMember', entityId: memberId, after: { cover: true } });
    return c;
  }

  private async assertScopeFor(access: AccessProfile, permission: string, employeeId: string) {
    const e = await this.dataSource.getRepository(Employee).findOneBy({ id: employeeId });
    if (!e) throw notFound('Employee');
    if (!scopeAllows(await this.scope.filterFor(access, permission), { branchId: e.branchId, departmentId: e.departmentId, employeeId: e.id })) throw forbidden(`Outside your ${permission} scope`, 'out_of_scope');
  }

  async members(access: AccessProfile, q: { scheme_id?: string; search?: string; status?: string }) {
    const qb = this.dataSource.getRepository(MedicalMember).createQueryBuilder('mb').innerJoin(Employee, 'e', 'e.id = mb.employee_id').orderBy('mb.memberNumber').take(1000);
    if (q.scheme_id) qb.andWhere('mb.scheme_id = :s', { s: q.scheme_id });
    if (q.status) qb.andWhere('mb.status = :st', { st: q.status });
    if (q.search) qb.andWhere('(mb.member_number ILIKE :p OR e.staff_number ILIKE :p OR mb.name ILIKE :like)', { p: `${q.search}%`, like: `%${q.search}%` });
    applyScope(qb, await this.scope.filterFor(access, 'medical:read'), { branch: 'e.branch_id', department: 'e.department_id', employee: 'e.id' });
    const rows = await qb.getMany();
    const schemes = new Map((await this.dataSource.getRepository(MedicalScheme).find()).map((s) => [s.id, s]));
    const staff = new Map((await this.dataSource.getRepository(Employee).findBy({ id: In([...new Set(rows.map((r) => r.employeeId))].concat(['00000000-0000-0000-0000-000000000000'])) })).map((e) => [e.id, e.staffNumber]));
    return rows.map((r) => this.memberDto(r, schemes.get(r.schemeId)!, staff.get(r.employeeId) ?? ''));
  }

  async myCover(access: AccessProfile) {
    if (!access.employeeId) return { memberships: [], applications: [] };
    const mine = await this.dataSource.getRepository(MedicalMember).find({ where: { employeeId: access.employeeId }, order: { status: 'ASC', memberNumber: 'ASC' } });
    const covers = [];
    for (const mb of mine.filter((x) => x.status === 'active' && x.relationship === 'principal')) covers.push(await this.cover(mb.id));
    return { memberships: covers, applications: await this.applications({ employee_id: access.employeeId }) };
  }

  async ledger(memberId: string) {
    const mb = await this.resolveMember(this.dataSource.manager, { member_id: memberId });
    const family = await this.dataSource.getRepository(MedicalMember).find({ where: [{ id: this.principalOf(mb) }, { principalMemberId: this.principalOf(mb) }] });
    const rows: (MedicalLedger & { category_code: string; member_name: string; reversed: boolean })[] = await this.dataSource.query(
      `SELECT l.*, c.code AS category_code, mm.name AS member_name, EXISTS (SELECT 1 FROM medical_ledger r WHERE r.reverses_id = l.id) AS reversed
         FROM medical_ledger l JOIN medical_category c ON c.id = l.category_id JOIN medical_member mm ON mm.id = l.member_id
        WHERE l.member_id = ANY($1::uuid[]) ORDER BY l.created_at DESC LIMIT 500`,
      [family.map((f) => f.id)],
    );
    return rows.map((r) => this.ledgerDto(r as unknown as Record<string, unknown>));
  }

  private ledgerDto(r: Record<string, unknown>) {
    const d = (x: unknown) => (x instanceof Date ? x.toISOString().slice(0, 10) : (x as string | null));
    return {
      id: r.id as string, member_id: r.member_id as string, member_name: r.member_name as string, category_code: r.category_code as string, scheme_year: r.scheme_year as number, entry_type: r.entry_type as LedgerType,
      amount: m2(r.amount as string), invoice_amount: r.invoice_amount === null ? null : m2(r.invoice_amount as string), member_share: r.member_share === null ? null : m2(r.member_share as string),
      occurred_on: d(r.occurred_on)!, facility: r.facility as string | null, department: r.department as string | null, invoice_ref: r.invoice_ref as string | null, external_ref: r.external_ref as string | null,
      source: r.source as 'web', reverses_id: r.reverses_id as string | null, reversed: !!r.reversed, hold_id: r.hold_id as string | null, expires_on: d(r.expires_on), reason: r.reason as string | null,
      document_id: r.document_id as string | null, created_at: new Date(r.created_at as string).toISOString(),
    };
  }

  // ================================================================== applications
  appDto(a: MedicalApplication & { scheme_name?: string; employee_name?: string; member_name?: string | null; category_name?: string | null }) {
    return {
      id: a.id, number: a.number, kind: a.kind, scheme_id: a.schemeId, scheme_name: a.scheme_name ?? '', employee_id: a.employeeId, employee_name: a.employee_name ?? '', member_id: a.memberId, member_name: a.member_name ?? null,
      category_id: a.categoryId, category_name: a.category_name ?? null, amount: a.amount === null ? null : m2(a.amount), effective_date: a.effectiveDate, details: a.details, document_ids: a.documentIds,
      reason: a.reason, status: a.status, decision_comment: a.decisionComment, workflow_instance_id: a.workflowInstanceId, created_at: a.createdAt.toISOString(),
    };
  }

  async applications(q: { employee_id?: string; status?: string }) {
    const qb = this.dataSource.getRepository(MedicalApplication).createQueryBuilder('a')
      .leftJoin(MedicalScheme, 's', 's.id = a.scheme_id').leftJoin(Employee, 'e', 'e.id = a.employee_id').leftJoin(MedicalMember, 'mb', 'mb.id = a.member_id').leftJoin(MedicalCategory, 'c', 'c.id = a.category_id')
      .addSelect(['s.name', 'e.firstName', 'e.lastName', 'mb.name', 'c.name']).orderBy('a.createdAt', 'DESC').take(500);
    if (q.employee_id) qb.andWhere('a.employee_id = :e', { e: q.employee_id });
    if (q.status) qb.andWhere('a.status = :st', { st: q.status });
    const { entities, raw } = await qb.getRawAndEntities();
    return entities.map((a, i) => this.appDto(Object.assign(a, { scheme_name: raw[i].s_name, employee_name: `${raw[i].e_first_name} ${raw[i].e_last_name}`, member_name: raw[i].mb_name, category_name: raw[i].c_name })));
  }

  private async nextNumber(m: EntityManager): Promise<string> {
    const [{ n }] = await m.query(`SELECT count(*)::int + 1 AS n FROM medical_application WHERE created_at >= date_trunc('year', now())`);
    return `MED/${new Date().getUTCFullYear()}/${String(n).padStart(5, '0')}`;
  }

  /** Staff apply for themselves; everything goes through the approval engine. */
  async apply(access: AccessProfile, dto: Dto<typeof applyMedical>) {
    if (!access.employeeId) throw unprocessable('no_employee', 'Your account is not linked to an employee record');
    const employeeId = access.employeeId;
    return this.dataSource.transaction(async (m) => {
      const scheme = await m.getRepository(MedicalScheme).findOneBy({ id: dto.scheme_id, status: 'active' });
      if (!scheme) throw unprocessable('scheme_not_found', 'Unknown or closed scheme', [{ path: 'scheme_id', message: 'Not found' }]);
      const today = await this.settings.today(m);
      const docs = 'document_ids' in dto ? dto.document_ids : [];
      if (docs.length) {
        const [{ n }] = await m.query(`SELECT count(*)::int AS n FROM document WHERE id = ANY($1::uuid[]) AND owner_type = 'medical_employee' AND owner_id = $2`, [docs, employeeId]);
        if (n !== new Set(docs).size) throw unprocessable('document_not_yours', 'Attach documents you uploaded for this application', [{ path: 'document_ids', message: 'Unknown document' }]);
      }
      const principal = await m.getRepository(MedicalMember).findOneBy({ schemeId: scheme.id, employeeId, relationship: 'principal', status: 'active' });
      const family = principal ? await m.getRepository(MedicalMember).findBy({ principalMemberId: principal.id, status: 'active' }) : [];
      const pendingSame = await m.getRepository(MedicalApplication).existsBy({ schemeId: scheme.id, employeeId, kind: dto.kind, status: 'pending' });
      const a = m.getRepository(MedicalApplication).create({ number: await this.nextNumber(m), kind: dto.kind, schemeId: scheme.id, employeeId, status: 'pending', documentIds: 'document_ids' in dto ? dto.document_ids : [], reason: dto.reason ?? null, details: {} });
      let value: number | null = null;
      let summaryBit = '';
      switch (dto.kind) {
        case 'enrol': {
          if (principal) throw conflict('already_member', 'You are already in this scheme');
          if (pendingSame) throw conflict('pending', 'You already have an application to join this scheme');
          if (dto.dependants.length > scheme.maxDependants) throw unprocessable('too_many_dependants', `This scheme covers at most ${scheme.maxDependants} dependants`, [{ path: 'dependants', message: 'Too many' }]);
          a.effectiveDate = dto.effective_date && dto.effective_date > today ? dto.effective_date : today;
          a.details = { dependants: dto.dependants };
          summaryBit = `join ${scheme.name}${dto.dependants.length ? ` with ${dto.dependants.length} dependant(s)` : ''}`;
          break;
        }
        case 'add_dependant': {
          if (!principal) throw conflict('not_member', 'Join the scheme first');
          if (family.length >= scheme.maxDependants) throw unprocessable('too_many_dependants', `This scheme covers at most ${scheme.maxDependants} dependants`);
          a.memberId = principal.id;
          a.effectiveDate = dto.effective_date && dto.effective_date > today ? dto.effective_date : today;
          a.details = { dependant: dto.dependant };
          summaryBit = `add ${dto.dependant.name} (${dto.dependant.relationship})`;
          break;
        }
        case 'remove_dependant': {
          const mb = family.find((f) => f.id === dto.member_id);
          if (!mb) throw unprocessable('not_dependant', 'That person is not one of your covered dependants', [{ path: 'member_id', message: 'Not found' }]);
          a.memberId = mb.id;
          a.effectiveDate = dto.effective_date && dto.effective_date > today ? dto.effective_date : today;
          summaryBit = `remove ${mb.name}`;
          break;
        }
        case 'top_up':
        case 'pre_auth': {
          if (!principal) throw conflict('not_member', 'Join the scheme first');
          const mb = [principal, ...family].find((f) => f.id === dto.member_id);
          if (!mb) throw unprocessable('not_member', 'That person is not covered under you', [{ path: 'member_id', message: 'Not found' }]);
          const cat = await m.getRepository(MedicalCategory).findOneBy({ id: dto.category_id, schemeId: scheme.id });
          if (!cat) throw unprocessable('category_not_found', 'Unknown category', [{ path: 'category_id', message: 'Not found' }]);
          a.memberId = mb.id;
          a.categoryId = cat.id;
          a.amount = dto.amount;
          value = Number(dto.amount);
          if (dto.kind === 'pre_auth') {
            const b = (await this.balancesFor(m, mb, dto.planned_date < today ? today : dto.planned_date)).balances.find((x) => x.category_id === cat.id);
            if (!b?.eligible) throw unprocessable('not_eligible', `${mb.name} is not covered for ${cat.name}`);
            a.effectiveDate = dto.planned_date;
            a.details = { planned_date: dto.planned_date, facility: dto.facility, procedure: dto.procedure, remaining_at_request: b.remaining };
            summaryBit = `pre-authorise KES ${dto.amount} for ${mb.name}, ${cat.name}: ${dto.procedure}`;
          } else {
            summaryBit = `top up ${cat.name} by KES ${dto.amount} for ${mb.name}`;
          }
          break;
        }
      }
      const saved = await m.getRepository(MedicalApplication).save(a);
      const u: { id: string } | undefined = (await m.query(`SELECT id FROM user_account WHERE id = $1`, [access.actorId]))[0];
      const person = await this.person(m, employeeId);
      const instance = await this.workflow.submit(m, { requestType: 'medical_application', kind: dto.kind, subjectId: saved.id, subjectEmployeeId: employeeId, requesterUserId: u?.id ?? null, value, summary: `Medical scheme: ${person.name} asks to ${summaryBit}` });
      saved.workflowInstanceId = instance.id;
      await m.getRepository(MedicalApplication).save(saved);
      return this.appDto(saved);
    });
  }

  private async closeApplication(m: EntityManager, i: WorkflowInstance, status: 'rejected' | 'returned', comment: string | null) {
    await m.getRepository(MedicalApplication).update({ id: i.subjectId }, { status, decisionComment: comment });
  }

  private async memberNumber(m: EntityManager, employeeId: string, schemeId: string): Promise<string> {
    const p = await this.person(m, employeeId);
    const scheme = await m.getRepository(MedicalScheme).findOneByOrFail({ id: schemeId });
    const [{ n }] = await m.query(`SELECT count(*)::int AS n FROM medical_member WHERE employee_id = $1 AND scheme_id = $2`, [employeeId, schemeId]);
    return `${scheme.code}-${p.staffNumber}-${String(n).padStart(2, '0')}`.toUpperCase();
  }

  private async addMember(m: EntityManager, a: { schemeId: string; employeeId: string; principal: MedicalMember | null; dependant?: { name: string; relationship: 'spouse' | 'child' | 'other'; date_of_birth: string; gender?: string | null }; coverStart: string }) {
    const person = await this.person(m, a.employeeId);
    let dependantId: string | null = null;
    if (a.dependant) {
      const d = await m.getRepository(EmployeeDependant).save(m.getRepository(EmployeeDependant).create({ employeeId: a.employeeId, name: a.dependant.name, relationship: a.dependant.relationship, dateOfBirth: a.dependant.date_of_birth, gender: a.dependant.gender ?? null, isBeneficiary: false }));
      dependantId = d.id;
    }
    const mb = await m.getRepository(MedicalMember).save(m.getRepository(MedicalMember).create({
      schemeId: a.schemeId, employeeId: a.employeeId, dependantId, principalMemberId: a.principal?.id ?? null, memberNumber: await this.memberNumber(m, a.employeeId, a.schemeId),
      name: a.dependant?.name ?? person.name, relationship: a.dependant?.relationship ?? 'principal', dateOfBirth: a.dependant?.date_of_birth ?? null, coverStart: a.coverStart, coverEnd: null, status: 'active',
    }));
    await this.outbox.record(m, 'hr.medical.enrolled.v1', mb.id, { id: mb.id, employee_id: mb.employeeId, scheme_id: mb.schemeId, member_number: mb.memberNumber, relationship: mb.relationship, cover_start: mb.coverStart });
    return mb;
  }

  private async endCover(m: EntityManager, mb: MedicalMember, on: string, reason: string) {
    if (mb.status !== 'active') return;
    Object.assign(mb, { status: 'ended', coverEnd: on, endReason: reason });
    await m.getRepository(MedicalMember).save(mb);
    await this.outbox.record(m, 'hr.medical.cover_ended.v1', mb.id, { id: mb.id, employee_id: mb.employeeId, scheme_id: mb.schemeId, member_number: mb.memberNumber, cover_end: on, reason });
  }

  /** Workflow: what an approved application does. */
  private async approve(m: EntityManager, i: WorkflowInstance, actorUserId: string) {
    const a = await m.getRepository(MedicalApplication).findOneByOrFail({ id: i.subjectId });
    const result: Record<string, unknown> = {};
    switch (a.kind) {
      case 'enrol': {
        const principal = await this.addMember(m, { schemeId: a.schemeId, employeeId: a.employeeId, principal: null, coverStart: a.effectiveDate! });
        result.member_ids = [principal.id];
        for (const d of (a.details.dependants as { name: string; relationship: 'spouse' | 'child' | 'other'; date_of_birth: string; gender?: string | null }[]) ?? []) {
          (result.member_ids as string[]).push((await this.addMember(m, { schemeId: a.schemeId, employeeId: a.employeeId, principal, dependant: d, coverStart: a.effectiveDate! })).id);
        }
        break;
      }
      case 'add_dependant': {
        const principal = await m.getRepository(MedicalMember).findOneByOrFail({ id: a.memberId! });
        result.member_ids = [(await this.addMember(m, { schemeId: a.schemeId, employeeId: a.employeeId, principal, dependant: a.details.dependant as never, coverStart: a.effectiveDate! })).id];
        break;
      }
      case 'remove_dependant':
        await this.endCover(m, await m.getRepository(MedicalMember).findOneByOrFail({ id: a.memberId! }), a.effectiveDate!, 'Dependant removed');
        break;
      case 'top_up': {
        const mb = await m.getRepository(MedicalMember).findOneByOrFail({ id: a.memberId! });
        const e = await this.post(m, { member: mb, categoryId: a.categoryId!, type: 'top_up', amount: a.amount!, occurredOn: await this.settings.today(m), reason: a.reason, applicationId: a.id, source: 'system', actor: actorUserId });
        result.ledger_id = e.id;
        break;
      }
      case 'pre_auth': {
        const mb = await m.getRepository(MedicalMember).findOneByOrFail({ id: a.memberId! });
        const e = await this.post(m, { member: mb, categoryId: a.categoryId!, type: 'hold', amount: a.amount!, occurredOn: await this.settings.today(m), expiresOn: addDays(a.effectiveDate!, 30), reason: `Pre-authorisation ${a.number}: ${String(a.details.procedure ?? '')}`, externalRef: a.number, facility: (a.details.facility as string) ?? null, applicationId: a.id, source: 'system', actor: actorUserId });
        result.hold_id = e.id;
        break;
      }
      case 'over_limit_claim': {
        const c = a.details.claim as Dto<typeof postClaim> & { source: 'web' | 'api' };
        const mb = await m.getRepository(MedicalMember).findOneByOrFail({ id: a.memberId! });
        const posted = await this.postClaimFor(m, mb, c, c.source, actorUserId, { override: true, applicationId: a.id });
        result.ledger_id = posted.claim?.id ?? null;
        break;
      }
    }
    Object.assign(a, { status: 'approved', result });
    await m.getRepository(MedicalApplication).save(a);
  }

  // ================================================================== the ledger
  /** Writes one ledger row and raises 80% / 100% alerts when a limit crosses them. */
  private async post(m: EntityManager, p: {
    member: MedicalMember; categoryId: string; type: LedgerType; amount: string; occurredOn: string; invoiceAmount?: string | null; memberShare?: string | null; facility?: string | null; department?: string | null;
    invoiceRef?: string | null; externalRef?: string | null; reversesId?: string | null; holdId?: string | null; expiresOn?: string | null; reason?: string | null; documentId?: string | null; applicationId?: string | null;
    source: 'web' | 'api' | 'system'; actor?: string | null; poolOverride?: string;
  }): Promise<MedicalLedger> {
    const cat = await m.getRepository(MedicalCategory).findOneByOrFail({ id: p.categoryId });
    const scheme = await m.getRepository(MedicalScheme).findOneByOrFail({ id: p.member.schemeId });
    const pool = p.poolOverride ?? (cat.sharing === 'shared' ? this.principalOf(p.member) : p.member.id);
    const sy = schemeYear(p.occurredOn, scheme.yearStartMonth).year;
    await m.query(`SELECT pg_advisory_xact_lock(hashtext('medical'), hashtext($1))`, [`${pool}:${cat.id}`]);
    const poolMember = pool === p.member.id ? p.member : await m.getRepository(MedicalMember).findOneByOrFail({ id: pool });
    const today = await this.settings.today(m);
    const before = (await this.balancesFor(m, poolMember, p.occurredOn > today ? p.occurredOn : today)).balances.find((b) => b.category_id === cat.id);
    const row = await m.getRepository(MedicalLedger).save(m.getRepository(MedicalLedger).create({
      createdBy: p.actor ?? RequestContext.get()?.actorId ?? null, schemeId: scheme.id, categoryId: cat.id, poolMemberId: pool, memberId: p.member.id, schemeYear: sy, entryType: p.type, amount: p.amount,
      invoiceAmount: p.invoiceAmount ?? null, memberShare: p.memberShare ?? null, occurredOn: p.occurredOn, facility: p.facility ?? null, department: p.department ?? null, invoiceRef: p.invoiceRef ?? null,
      externalRef: p.externalRef ?? null, source: p.source, reversesId: p.reversesId ?? null, holdId: p.holdId ?? null, expiresOn: p.expiresOn ?? null, reason: p.reason ?? null, documentId: p.documentId ?? null, applicationId: p.applicationId ?? null,
    }));
    if (['claim', 'hold', 'adjustment'].includes(p.type) && before && before.scheme_year === sy) {
      const after = (await this.balancesFor(m, poolMember, p.occurredOn > today ? p.occurredOn : today)).balances.find((b) => b.category_id === cat.id)!;
      for (const t of crossed(before.utilisation_pct, after.utilisation_pct)) await this.alert(m, poolMember, cat, sy, t, after);
    }
    return row;
  }

  private async alert(m: EntityManager, pool: MedicalMember, cat: MedicalCategory, year: number, threshold: number, b: Balance) {
    const inserted: unknown[] = await m.query(`INSERT INTO medical_threshold_alert (pool_member_id, category_id, scheme_year, threshold) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING RETURNING 1`, [pool.id, cat.id, year, threshold]);
    if (!inserted.length) return;
    await this.outbox.record(m, 'hr.medical.limit_threshold.v1', pool.id, { member_id: pool.id, employee_id: pool.employeeId, category: cat.code, scheme_year: year, threshold, utilisation_pct: b.utilisation_pct, remaining: b.remaining });
    const vars = { name: pool.name, category: cat.name, threshold, remaining: b.remaining };
    const users: { id: string }[] = await m.query(`SELECT id FROM user_account WHERE employee_id = $1 AND status = 'active'`, [pool.employeeId]);
    await this.notifications.notifyUsers(users.map((u) => u.id), 'medical_limit_threshold', vars, '/medical', m);
    await this.notifications.notifyPermissionHolders('medical_setup:manage', 'medical_limit_threshold', vars, '/medical/members', m);
  }

  async postClaim(access: AccessProfile, dto: Dto<typeof postClaim>, source: 'web' | 'api') {
    return this.dataSource.transaction(async (m) => {
      const mb = await this.resolveMember(m, dto);
      await this.assertScopeFor(access, 'medical:lookup', mb.employeeId);
      return this.postClaimFor(m, mb, dto, source, access.actorId, { override: false });
    });
  }

  /**
   * A claim: the scheme's share (after co-pay and the per-visit cap) is drawn from the
   * limit. Over the limit, or inside a waiting period, it is refused or sent for approval
   * as the scheme says. Settling a hold releases it in the same transaction.
   */
  private async postClaimFor(m: EntityManager, mb: MedicalMember, dto: Dto<typeof postClaim>, source: 'web' | 'api', actor: string | null, opts: { override: boolean; applicationId?: string }) {
    const scheme = await m.getRepository(MedicalScheme).findOneByOrFail({ id: mb.schemeId });
    const cat = await m.getRepository(MedicalCategory).findOneBy({ schemeId: mb.schemeId, code: dto.category_code.toLowerCase() });
    if (!cat) throw unprocessable('category_not_found', `This scheme has no ${dto.category_code} cover`, [{ path: 'category_code', message: 'Not found' }]);
    if (mb.coverStart > dto.occurred_on || (mb.coverEnd && mb.coverEnd < dto.occurred_on)) throw unprocessable('not_covered', `${mb.name} was not covered on ${dto.occurred_on}`);
    const pool = cat.sharing === 'shared' ? this.principalOf(mb) : mb.id;
    await m.query(`SELECT pg_advisory_xact_lock(hashtext('medical'), hashtext($1))`, [`${pool}:${cat.id}`]);
    const b = (await this.balancesFor(m, mb, dto.occurred_on)).balances.find((x) => x.category_id === cat.id)!;
    if (cat.principalAndSpouseOnly && !['principal', 'spouse'].includes(mb.relationship)) throw unprocessable('not_eligible', `${cat.name} covers the principal and spouse only`);
    if (mb.status !== 'active' && !opts.override) throw unprocessable('not_covered', `${mb.name}'s cover has ended`);
    let hold: MedicalLedger | null = null;
    if (dto.hold_id) {
      hold = await m.getRepository(MedicalLedger).findOneBy({ id: dto.hold_id, entryType: 'hold', categoryId: cat.id, poolMemberId: pool });
      if (!hold) throw unprocessable('hold_not_found', 'That hold is not on this member’s limit', [{ path: 'hold_id', message: 'Not found' }]);
      if (await m.getRepository(MedicalLedger).existsBy({ holdId: hold.id, entryType: 'hold_release' })) throw conflict('hold_used', 'That hold was already used or released');
    }
    const split = claimSplit(dto.invoice_amount, b.co_pay_pct, b.per_visit_cap);
    const available = new Decimal(b.remaining).plus(hold ? hold.amount : 0);
    const problems: string[] = [];
    if (b.waiting_until && dto.occurred_on < b.waiting_until) problems.push(`inside the waiting period (until ${b.waiting_until})`);
    if (new Decimal(split.scheme).gt(available)) problems.push(`KES ${split.scheme} is more than the KES ${m2(available)} left`);
    if (problems.length && !opts.override) {
      const message = `The claim is ${problems.join(' and ')}`;
      if (scheme.overLimitAction === 'block') throw unprocessable('over_limit', message, [{ path: 'invoice_amount', message }]);
      // Hold it for approval through the medical workflow.
      const a = await m.getRepository(MedicalApplication).save(m.getRepository(MedicalApplication).create({
        number: await this.nextNumber(m), kind: 'over_limit_claim', schemeId: scheme.id, employeeId: mb.employeeId, memberId: mb.id, categoryId: cat.id, amount: split.scheme, effectiveDate: dto.occurred_on,
        details: { claim: { ...dto, member_id: mb.id, source }, problems }, documentIds: dto.document_id ? [dto.document_id] : [], reason: message, status: 'pending',
      }));
      const u: { id: string } | undefined = actor ? (await m.query(`SELECT id FROM user_account WHERE id = $1`, [actor]))[0] : undefined;
      const instance = await this.workflow.submit(m, { requestType: 'medical_application', kind: 'over_limit_claim', subjectId: a.id, subjectEmployeeId: mb.employeeId, requesterUserId: u?.id ?? null, value: Number(split.scheme), summary: `Medical claim for ${mb.name} (${cat.name}, ${dto.facility}) needs approval: ${message}` });
      a.workflowInstanceId = instance.id;
      await m.getRepository(MedicalApplication).save(a);
      return { status: 'pending_approval' as const, claim: null, application_id: a.id, remaining: b.remaining, message };
    }
    if (dto.external_ref && (await m.getRepository(MedicalLedger).existsBy({ source, entryType: 'claim', externalRef: dto.external_ref }))) throw conflict('duplicate_claim', `Claim ${dto.external_ref} was already posted`);
    if (hold) await this.post(m, { member: mb, categoryId: cat.id, type: 'hold_release', amount: hold.amount, occurredOn: dto.occurred_on, holdId: hold.id, reason: 'Claimed', source, actor, poolOverride: pool });
    const claim = await this.post(m, {
      member: mb, categoryId: cat.id, type: 'claim', amount: split.scheme, invoiceAmount: dto.invoice_amount, memberShare: split.member, occurredOn: dto.occurred_on, facility: dto.facility, department: dto.department ?? null,
      invoiceRef: dto.invoice_ref, externalRef: dto.external_ref ?? null, documentId: dto.document_id ?? null, applicationId: opts.applicationId ?? null, source, actor, poolOverride: pool,
    });
    await this.outbox.record(m, 'hr.medical.claim_posted.v1', mb.id, { id: claim.id, member_id: mb.id, member_number: mb.memberNumber, category: cat.code, scheme_amount: split.scheme, invoice_amount: dto.invoice_amount, occurred_on: dto.occurred_on, facility: dto.facility, source });
    const after = (await this.balancesFor(m, mb, dto.occurred_on)).balances.find((x) => x.category_id === cat.id)!;
    const full = (await this.ledgerRows(m, [claim.id]))[0];
    return { status: 'posted' as const, claim: full, application_id: null, remaining: after.remaining, message: problems.length ? `Approved over the limit: ${problems.join(' and ')}` : null };
  }

  private async ledgerRows(m: EntityManager, ids: string[]) {
    const rows = await m.query(
      `SELECT l.*, c.code AS category_code, mm.name AS member_name, EXISTS (SELECT 1 FROM medical_ledger r WHERE r.reverses_id = l.id) AS reversed
         FROM medical_ledger l JOIN medical_category c ON c.id = l.category_id JOIN medical_member mm ON mm.id = l.member_id WHERE l.id = ANY($1::uuid[])`,
      [ids],
    );
    return rows.map((r: Record<string, unknown>) => this.ledgerDto(r));
  }

  async reverse(access: AccessProfile, claimId: string, reason: string, source: 'web' | 'api') {
    return this.dataSource.transaction(async (m) => {
      const c = await m.getRepository(MedicalLedger).findOneBy({ id: claimId, entryType: 'claim' });
      if (!c) throw notFound('Claim');
      const mb = await m.getRepository(MedicalMember).findOneByOrFail({ id: c.memberId });
      await this.assertScopeFor(access, 'medical:lookup', mb.employeeId);
      if (await m.getRepository(MedicalLedger).existsBy({ reversesId: c.id })) throw conflict('already_reversed', 'This claim was already reversed');
      const r = await this.post(m, { member: mb, categoryId: c.categoryId, type: 'reversal', amount: c.amount, occurredOn: c.occurredOn, reversesId: c.id, reason, invoiceRef: c.invoiceRef, facility: c.facility, source, actor: access.actorId, poolOverride: c.poolMemberId });
      return (await this.ledgerRows(m, [r.id]))[0];
    });
  }

  async placeHold(access: AccessProfile, dto: Dto<typeof placeHold>, source: 'web' | 'api') {
    return this.dataSource.transaction(async (m) => {
      const mb = await this.resolveMember(m, dto);
      await this.assertScopeFor(access, 'medical:lookup', mb.employeeId);
      const cat = await m.getRepository(MedicalCategory).findOneBy({ schemeId: mb.schemeId, code: dto.category_code.toLowerCase() });
      if (!cat) throw unprocessable('category_not_found', `This scheme has no ${dto.category_code} cover`);
      const today = await this.settings.today(m);
      if (dto.expires_on < today) throw unprocessable('bad_expiry', 'The hold would already have expired', [{ path: 'expires_on', message: 'In the past' }]);
      const pool = cat.sharing === 'shared' ? this.principalOf(mb) : mb.id;
      await m.query(`SELECT pg_advisory_xact_lock(hashtext('medical'), hashtext($1))`, [`${pool}:${cat.id}`]);
      const b = (await this.balancesFor(m, mb, today)).balances.find((x) => x.category_id === cat.id)!;
      if (!b.eligible) throw unprocessable('not_eligible', `${mb.name} is not covered for ${cat.name}`);
      if (new Decimal(dto.amount).gt(b.remaining)) throw unprocessable('over_limit', `Only KES ${b.remaining} is left on ${cat.name}`, [{ path: 'amount', message: 'More than is left' }]);
      if (dto.external_ref && (await m.getRepository(MedicalLedger).existsBy({ source, entryType: 'hold', externalRef: dto.external_ref }))) throw conflict('duplicate_hold', `Hold ${dto.external_ref} already exists`);
      const h = await this.post(m, { member: mb, categoryId: cat.id, type: 'hold', amount: dto.amount, occurredOn: today, expiresOn: dto.expires_on, externalRef: dto.external_ref ?? null, reason: dto.reason ?? null, source, actor: access.actorId, poolOverride: pool });
      return (await this.ledgerRows(m, [h.id]))[0];
    });
  }

  async releaseHold(access: AccessProfile, holdId: string, reason: string, source: 'web' | 'api') {
    return this.dataSource.transaction(async (m) => {
      const h = await m.getRepository(MedicalLedger).findOneBy({ id: holdId, entryType: 'hold' });
      if (!h) throw notFound('Hold');
      const mb = await m.getRepository(MedicalMember).findOneByOrFail({ id: h.memberId });
      await this.assertScopeFor(access, 'medical:lookup', mb.employeeId);
      if (await m.getRepository(MedicalLedger).existsBy({ holdId: h.id, entryType: 'hold_release' })) throw conflict('hold_used', 'That hold was already used or released');
      const r = await this.post(m, { member: mb, categoryId: h.categoryId, type: 'hold_release', amount: h.amount, occurredOn: await this.settings.today(m), holdId: h.id, reason, source, actor: access.actorId, poolOverride: h.poolMemberId });
      return (await this.ledgerRows(m, [r.id]))[0];
    });
  }

  async adjust(access: AccessProfile, memberId: string, dto: Dto<typeof adjustLimit>) {
    return this.dataSource.transaction(async (m) => {
      const mb = await this.resolveMember(m, { member_id: memberId });
      await this.assertScopeFor(access, 'medical:read', mb.employeeId);
      const cat = await m.getRepository(MedicalCategory).findOneBy({ id: dto.category_id, schemeId: mb.schemeId });
      if (!cat) throw unprocessable('category_not_found', 'Unknown category');
      if (new Decimal(dto.amount).isZero()) throw unprocessable('zero', 'An adjustment needs an amount', [{ path: 'amount', message: 'Zero' }]);
      const r = await this.post(m, { member: mb, categoryId: cat.id, type: 'adjustment', amount: dto.amount, occurredOn: await this.settings.today(m), reason: dto.reason, source: 'web', actor: access.actorId });
      return (await this.ledgerRows(m, [r.id]))[0];
    });
  }

  async eligibility(q: { member_number?: string; member_id?: string; category_code?: string; on?: string }) {
    const m = this.dataSource.manager;
    const on = q.on ?? (await this.settings.today());
    let mb: MedicalMember;
    try { mb = await this.resolveMember(m, q); } catch { return { eligible: false, reason: 'Unknown member', member: null, balances: [] }; }
    const { scheme, person, balances } = await this.balancesFor(m, mb, on);
    const list = q.category_code ? balances.filter((b) => b.category_code === q.category_code!.toLowerCase()) : balances;
    const covered = mb.status === 'active' && mb.coverStart <= on && (!mb.coverEnd || mb.coverEnd >= on);
    const reason = !covered ? (mb.status === 'ended' ? `Cover ended ${mb.coverEnd}` : `Cover starts ${mb.coverStart}`) : !list.length ? 'No such cover in this scheme' : !list.some((b) => b.eligible) ? 'Not covered for this category' : null;
    return { eligible: !reason, reason, member: this.memberDto(mb, scheme, person.staffNumber), balances: list };
  }

  // ================================================================== background work
  /** Hourly: end cover for leavers, release expired holds, and carry unused limits into a new year. */
  async sweep(): Promise<number> {
    let n = 0;
    const today = await this.settings.today();
    await this.dataSource.transaction(async (m) => {
      const leavers: { id: string; exit: string | null }[] = await m.query(
        `SELECT mb.id, to_char(e.exit_date, 'YYYY-MM-DD') AS exit FROM medical_member mb JOIN employee e ON e.id = mb.employee_id
          WHERE mb.status = 'active' AND (e.status = 'exited' OR (e.exit_date IS NOT NULL AND e.exit_date < $1))`,
        [today],
      );
      for (const l of leavers) {
        await this.endCover(m, await m.getRepository(MedicalMember).findOneByOrFail({ id: l.id }), l.exit && l.exit < today ? l.exit : today, 'Employee left');
        n++;
      }
      const expired: MedicalLedger[] = await m.getRepository(MedicalLedger).createQueryBuilder('l')
        .where(`l.entry_type = 'hold' AND l.expires_on < :t AND NOT EXISTS (SELECT 1 FROM medical_ledger r WHERE r.hold_id = l.id AND r.entry_type = 'hold_release')`, { t: today }).getMany();
      for (const h of expired) {
        await m.getRepository(MedicalLedger).save(m.getRepository(MedicalLedger).create({ schemeId: h.schemeId, categoryId: h.categoryId, poolMemberId: h.poolMemberId, memberId: h.memberId, schemeYear: h.schemeYear, entryType: 'hold_release', amount: h.amount, occurredOn: today, holdId: h.id, reason: 'Expired', source: 'system' }));
        n++;
      }
    });
    n += await this.carryOverAll(today);
    return n;
  }

  /** At the start of a scheme year, unused limits carry over (once per limit and year) where the scheme says so. */
  async carryOverAll(today: string): Promise<number> {
    let n = 0;
    const schemes = await this.dataSource.getRepository(MedicalScheme).findBy({ unusedLimitPolicy: 'carry_over', status: 'active' });
    for (const s of schemes) {
      const sy = schemeYear(today, s.yearStartMonth);
      const lastDay = addDays(sy.start, -1);
      const cats = await this.dataSource.getRepository(MedicalCategory).findBy({ schemeId: s.id, status: 'active' });
      const members = await this.dataSource.getRepository(MedicalMember).findBy({ schemeId: s.id, status: 'active' });
      for (const mb of members) {
        if (mb.coverStart > lastDay) continue;
        const prev = (await this.balancesFor(this.dataSource.manager, mb, lastDay)).balances;
        for (const c of cats) {
          const isPool = c.sharing === 'per_person' || mb.relationship === 'principal';
          if (!isPool) continue;
          const b = prev.find((x) => x.category_id === c.id);
          if (!b || new Decimal(b.remaining).lte(0)) continue;
          const amount = carryOver(b.remaining, b.limit, s.carryOverMaxPct);
          if (new Decimal(amount).lte(0)) continue;
          const res: unknown[] = await this.dataSource.query(
            `INSERT INTO medical_ledger (scheme_id, category_id, pool_member_id, member_id, scheme_year, entry_type, amount, occurred_on, reason, source)
             VALUES ($1, $2, $3, $3, $4, 'carry_over', $5, $6, $7, 'system') ON CONFLICT DO NOTHING RETURNING id`,
            [s.id, c.id, mb.id, sy.year, amount, sy.start, `Unused from ${sy.year - 1}`],
          );
          n += res.length;
        }
      }
    }
    return n;
  }

  // ================================================================== payroll contributions
  /** The monthly deduction for staff in schemes with contributions on; nothing when cover has ended. */
  async contributionsFor(m: EntityManager, employeeId: string, on: string, basic: number) {
    const principals = await m.getRepository(MedicalMember).createQueryBuilder('mb').innerJoin(MedicalScheme, 's', 's.id = mb.scheme_id AND s.contributions_enabled')
      .where(`mb.employee_id = :e AND mb.relationship = 'principal' AND mb.cover_start <= :on AND (mb.cover_end IS NULL OR mb.cover_end >= :on)`, { e: employeeId, on }).getMany();
    if (!principals.length) return [];
    const person = await this.person(m, employeeId);
    const out = [];
    for (const p of principals) {
      const scheme = await m.getRepository(MedicalScheme).findOneByOrFail({ id: p.schemeId });
      const rate = pickRule(await m.getRepository(MedicalContributionRate).findBy({ schemeId: p.schemeId }), { jobGradeId: person.jobGradeId, employmentType: person.employmentType }, on);
      if (!rate) continue;
      const [{ n }] = await m.query(`SELECT count(*)::int AS n FROM medical_member WHERE principal_member_id = $1 AND cover_start <= $2 AND (cover_end IS NULL OR cover_end >= $2)`, [p.id, on]);
      const amount = contribution({ method: rate.method, value: rate.value, perDependant: rate.perDependant }, basic, n);
      if (new Decimal(amount).lte(0)) continue;
      out.push({ code: 'MEDICAL', name: `Medical scheme (${scheme.name})`, kind: 'deduction' as const, amount: Number(amount), taxable: false, pensionable: false, treatment: 'none' as const, note: n ? `with ${n} dependant(s)` : null });
    }
    return out;
  }
}
