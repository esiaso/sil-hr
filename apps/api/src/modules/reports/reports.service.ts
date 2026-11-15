import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import Decimal from 'decimal.js';
import ExcelJS from 'exceljs';
import { DataSource } from 'typeorm';
import { REPORTS, type ReportCode } from '@sil/hr-shared';
import { AccessProfile, type ScopeFilter } from '../../common/access';
import { writeAudit } from '../audit/audit.subscriber';
import { ScopeService } from '../organisation/scope.service';
import { SettingsService } from '../settings/settings.module';

const m2 = (x: Decimal.Value | null) => new Decimal(x ?? 0).toFixed(2);
const r1 = (x: number) => Math.round(x * 10) / 10;

export interface Column { key: string; label: string; money?: boolean }
export interface ReportOutput<T> { rows: T[]; columns: Column[]; title: string }

/** Builds "AND (branch = any … OR department = any … OR employee = any …)" for raw SQL. */
function scopeSql(f: ScopeFilter, params: unknown[], cols: { branch: string; department: string; employee: string }): string {
  if (f.all) return '';
  const p = params.length;
  params.push(f.branchIds, f.departmentIds, f.employeeIds);
  return ` AND (${cols.branch} = ANY($${p + 1}::uuid[]) OR ${cols.department} = ANY($${p + 2}::uuid[]) OR ${cols.employee} = ANY($${p + 3}::uuid[]))`;
}

@Injectable()
export class ReportsService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly scope: ScopeService,
    private readonly settings: SettingsService,
  ) {}

  private filter(access: AccessProfile) {
    return this.scope.filterFor(access, 'report:read');
  }

  // ---------------------------------------------------------------- headcount
  /** Staff employed on a date, grouped; the department and branch are those in force that day. */
  async headcount(access: AccessProfile, q: { as_at?: string; group_by: 'department' | 'branch' | 'employment_type' | 'grade' | 'gender' }): Promise<ReportOutput<Record<string, string | number>>> {
    const asAt = q.as_at ?? (await this.settings.today());
    const params: unknown[] = [asAt];
    const scope = scopeSql(await this.filter(access), params, { branch: 'x.branch_id', department: 'x.department_id', employee: 'x.id' });
    const group = { department: `coalesce(d.name, 'No department')`, branch: `coalesce(b.name, 'No branch')`, employment_type: `initcap(x.employment_type)`, grade: `coalesce(g.code || ' ' || g.name, 'No grade')`, gender: `initcap(x.gender)` }[q.group_by];
    const rows: Record<string, string | number>[] = await this.dataSource.query(
      `WITH x AS (
         SELECT e.id, e.status, e.gender, e.employment_type, coalesce(pa.department_id, e.department_id) AS department_id, coalesce(pa.branch_id, e.branch_id) AS branch_id, p.job_grade_id
           FROM employee e
           LEFT JOIN LATERAL (SELECT department_id, branch_id, position_id FROM employee_position_assignment a WHERE a.employee_id = e.id AND a.effective_from <= $1 AND (a.effective_to IS NULL OR a.effective_to >= $1) ORDER BY a.effective_from DESC LIMIT 1) pa ON true
           LEFT JOIN position p ON p.id = coalesce(pa.position_id, e.position_id)
          WHERE e.deleted_at IS NULL AND e.hire_date <= $1 AND (e.exit_date IS NULL OR e.exit_date > $1))
       SELECT ${group} AS "group",
              count(*) FILTER (WHERE x.status IN ('active', 'exited'))::int AS active, count(*) FILTER (WHERE x.status = 'probation')::int AS probation,
              count(*) FILTER (WHERE x.status = 'on_notice')::int AS on_notice, count(*) FILTER (WHERE x.status = 'suspended')::int AS suspended,
              count(*)::int AS total, count(*) FILTER (WHERE x.gender = 'female')::int AS female, count(*) FILTER (WHERE x.gender = 'male')::int AS male
         FROM x LEFT JOIN department d ON d.id = x.department_id LEFT JOIN branch b ON b.id = x.branch_id LEFT JOIN job_grade g ON g.id = x.job_grade_id
        WHERE x.status <> 'onboarding' ${scope}
        GROUP BY 1 ORDER BY 1`,
      params,
    );
    return { title: `Headcount at ${asAt} by ${q.group_by.replace('_', ' ')}`, rows, columns: [{ key: 'group', label: q.group_by.replace('_', ' ') }, { key: 'active', label: 'Active' }, { key: 'probation', label: 'Probation' }, { key: 'on_notice', label: 'On notice' }, { key: 'suspended', label: 'Suspended' }, { key: 'female', label: 'Female' }, { key: 'male', label: 'Male' }, { key: 'total', label: 'Total' }] };
  }

  // ---------------------------------------------------------------- turnover
  async turnover(access: AccessProfile, q: { from: string; to: string }) {
    const params: unknown[] = [q.from, q.to];
    const scope = scopeSql(await this.filter(access), params, { branch: 'e.branch_id', department: 'e.department_id', employee: 'e.id' });
    const raw: { department: string; opening: number; closing: number; joiners: number; leavers: number; voluntary: number }[] = await this.dataSource.query(
      `SELECT coalesce(d.name, 'No department') AS department,
              count(*) FILTER (WHERE e.hire_date <= $1 AND (e.exit_date IS NULL OR e.exit_date > $1))::int AS opening,
              count(*) FILTER (WHERE e.hire_date <= $2 AND (e.exit_date IS NULL OR e.exit_date > $2))::int AS closing,
              count(*) FILTER (WHERE e.hire_date BETWEEN $1 AND $2)::int AS joiners,
              count(*) FILTER (WHERE e.exit_date BETWEEN $1 AND $2)::int AS leavers,
              count(*) FILTER (WHERE e.exit_date BETWEEN $1 AND $2 AND EXISTS (SELECT 1 FROM lifecycle_request l WHERE l.employee_id = e.id AND l.kind = 'resignation' AND l.status = 'approved'))::int AS voluntary
         FROM employee e LEFT JOIN department d ON d.id = e.department_id
        WHERE e.deleted_at IS NULL AND e.status <> 'onboarding' ${scope}
        GROUP BY 1 HAVING count(*) FILTER (WHERE e.hire_date <= $2 AND (e.exit_date IS NULL OR e.exit_date >= $1)) > 0 ORDER BY 1`,
      params,
    );
    const rows = raw.map((r) => {
      const average = (r.opening + r.closing) / 2;
      return { ...r, average: r1(average), turnover_pct: average ? r1((r.leavers / average) * 100) : 0 };
    });
    const t = rows.reduce((a, r) => ({ opening: a.opening + r.opening, closing: a.closing + r.closing, joiners: a.joiners + r.joiners, leavers: a.leavers + r.leavers, voluntary: a.voluntary + r.voluntary }), { opening: 0, closing: 0, joiners: 0, leavers: 0, voluntary: 0 });
    const avg = (t.opening + t.closing) / 2;
    if (rows.length > 1) rows.push({ department: 'All', ...t, average: r1(avg), turnover_pct: avg ? r1((t.leavers / avg) * 100) : 0 });
    return { title: `Turnover ${q.from} to ${q.to}`, rows, columns: [{ key: 'department', label: 'Department' }, { key: 'opening', label: 'Opening' }, { key: 'joiners', label: 'Joiners' }, { key: 'leavers', label: 'Leavers' }, { key: 'voluntary', label: 'Resigned' }, { key: 'closing', label: 'Closing' }, { key: 'average', label: 'Average' }, { key: 'turnover_pct', label: 'Turnover %' }] };
  }

  // ---------------------------------------------------------------- leave liability
  /** Unused annual leave valued at basic ÷ the leave-pay divisor (the same rate as leave pay at exit). */
  async leaveLiability(access: AccessProfile, q: { as_at?: string }) {
    const asAt = q.as_at ?? (await this.settings.today());
    const divisor = await this.settings.get('lifecycle.leave_pay_days_divisor');
    const startMonth = await this.settings.get('leave.year_start_month');
    const [y, mo] = asAt.split('-').map(Number);
    const leaveYear = mo >= startMonth ? y : y - 1;
    const params: unknown[] = [asAt, leaveYear];
    const scope = scopeSql(await this.filter(access), params, { branch: 'e.branch_id', department: 'e.department_id', employee: 'e.id' });
    const raw: { employee_id: string; staff_number: string; employee_name: string; department: string | null; days: string; basic: string | null }[] = await this.dataSource.query(
      `SELECT e.id AS employee_id, e.staff_number, e.first_name || ' ' || e.last_name AS employee_name, d.name AS department, sum(l.days)::text AS days,
              (SELECT s.basic FROM employee_salary s WHERE s.employee_id = e.id AND s.effective_from <= $1 AND (s.effective_to IS NULL OR s.effective_to >= $1) ORDER BY s.effective_from DESC LIMIT 1) AS basic
         FROM leave_ledger l JOIN leave_type t ON t.id = l.leave_type_id AND t.code = 'annual'
         JOIN employee e ON e.id = l.employee_id LEFT JOIN department d ON d.id = e.department_id
        WHERE l.leave_year = $2 AND l.effective_date <= $1 AND e.deleted_at IS NULL AND (e.exit_date IS NULL OR e.exit_date > $1) ${scope}
        GROUP BY e.id, d.name HAVING sum(l.days) > 0 ORDER BY d.name, e.last_name`,
      params,
    );
    const rows = raw.map((r) => {
      const rate = new Decimal(r.basic ?? 0).div(divisor);
      return { employee_id: r.employee_id, staff_number: r.staff_number, employee_name: r.employee_name, department: r.department, days: Number(r.days), daily_rate: m2(rate), liability: m2(rate.mul(r.days)) };
    });
    return { title: `Leave liability at ${asAt}`, rows, columns: [{ key: 'staff_number', label: 'Staff no.' }, { key: 'employee_name', label: 'Name' }, { key: 'department', label: 'Department' }, { key: 'days', label: 'Days' }, { key: 'daily_rate', label: 'Daily rate', money: true }, { key: 'liability', label: 'Liability', money: true }] };
  }

  // ---------------------------------------------------------------- overtime and payroll cost
  async overtimeCost(access: AccessProfile, q: { from: string; to: string }) {
    const f = await this.filter(access);
    const p1: unknown[] = [q.from, q.to];
    const s1 = scopeSql(f, p1, { branch: 'e.branch_id', department: 'e.department_id', employee: 'e.id' });
    const recorded: { period: string; department: string; hours: string }[] = await this.dataSource.query(
      `SELECT to_char(a.work_date, 'YYYY-MM') AS period, coalesce(d.name, 'No department') AS department, (sum(a.overtime_minutes) / 60.0)::text AS hours
         FROM attendance_day a JOIN employee e ON e.id = a.employee_id LEFT JOIN department d ON d.id = e.department_id
        WHERE a.overtime_minutes > 0 AND to_char(a.work_date, 'YYYY-MM') BETWEEN $1 AND $2 ${s1} GROUP BY 1, 2`,
      p1,
    );
    const p2: unknown[] = [q.from, q.to];
    const s2 = scopeSql(f, p2, { branch: 'dp.branch_id', department: 'ps.department_id', employee: 'ps.employee_id' });
    const paid: { period: string; department: string; hours: string; amount: string }[] = await this.dataSource.query(
      `SELECT r.period, coalesce(ps.department_name, 'No department') AS department, coalesce(sum(substring(l.detail from '^([0-9.]+) h')::numeric), 0)::text AS hours, sum(l.amount)::text AS amount
         FROM payslip_line l JOIN payslip ps ON ps.id = l.payslip_id JOIN payroll_run r ON r.id = ps.run_id LEFT JOIN department dp ON dp.id = ps.department_id
        WHERE l.code LIKE 'OT\\_%' AND r.status IN ('approved', 'paid', 'closed') AND r.period BETWEEN $1 AND $2 ${s2} GROUP BY 1, 2`,
      p2,
    );
    const key = (p: string, d: string) => `${p}|${d}`;
    const by = new Map<string, { period: string; department: string; hours_recorded: number; hours_paid: number; amount_paid: string }>();
    for (const r of recorded) by.set(key(r.period, r.department), { period: r.period, department: r.department, hours_recorded: r1(Number(r.hours)), hours_paid: 0, amount_paid: '0.00' });
    for (const r of paid) {
      const x = by.get(key(r.period, r.department)) ?? { period: r.period, department: r.department, hours_recorded: 0, hours_paid: 0, amount_paid: '0.00' };
      Object.assign(x, { hours_paid: r1(Number(r.hours)), amount_paid: m2(r.amount) });
      by.set(key(r.period, r.department), x);
    }
    const rows = [...by.values()].sort((a, b) => a.period.localeCompare(b.period) || a.department.localeCompare(b.department));
    return { title: `Overtime ${q.from} to ${q.to}`, rows, columns: [{ key: 'period', label: 'Month' }, { key: 'department', label: 'Department' }, { key: 'hours_recorded', label: 'Hours recorded' }, { key: 'hours_paid', label: 'Hours paid' }, { key: 'amount_paid', label: 'Paid', money: true }] };
  }

  async payrollCost(access: AccessProfile, q: { from: string; to: string }) {
    const params: unknown[] = [q.from, q.to];
    const scope = scopeSql(await this.filter(access), params, { branch: 'dp.branch_id', department: 'ps.department_id', employee: 'ps.employee_id' });
    const raw: { period: string; department: string; cost_centre: string | null; employees: number; gross: string; er: string; net: string }[] = await this.dataSource.query(
      `SELECT r.period, coalesce(ps.department_name, 'No department') AS department, ps.cost_centre_code AS cost_centre, count(*)::int AS employees, sum(ps.gross)::text AS gross, sum(ps.net)::text AS net,
              coalesce(sum((SELECT sum(l.amount) FROM payslip_line l WHERE l.payslip_id = ps.id AND l.kind = 'employer_contribution')), 0)::text AS er
         FROM payslip ps JOIN payroll_run r ON r.id = ps.run_id LEFT JOIN department dp ON dp.id = ps.department_id
        WHERE r.status IN ('approved', 'paid', 'closed') AND r.period BETWEEN $1 AND $2 ${scope}
        GROUP BY 1, 2, 3 ORDER BY 1, 2`,
      params,
    );
    const rows = raw.map((r) => ({ period: r.period, department: r.department, cost_centre: r.cost_centre, employees: r.employees, gross: m2(r.gross), employer_contributions: m2(r.er), total_cost: m2(new Decimal(r.gross).plus(r.er)), net: m2(r.net) }));
    return { title: `Payroll cost ${q.from} to ${q.to}`, rows, columns: [{ key: 'period', label: 'Month' }, { key: 'department', label: 'Department' }, { key: 'cost_centre', label: 'Cost centre' }, { key: 'employees', label: 'Staff' }, { key: 'gross', label: 'Gross', money: true }, { key: 'employer_contributions', label: 'Employer contributions', money: true }, { key: 'total_cost', label: 'Total cost', money: true }, { key: 'net', label: 'Net', money: true }] };
  }

  // ---------------------------------------------------------------- expiries
  async licenceExpiry(access: AccessProfile, q: { within_days: number; include_expired: boolean }) {
    const today = await this.settings.today();
    const params: unknown[] = [today, q.within_days, q.include_expired];
    const scope = scopeSql(await this.filter(access), params, { branch: 'e.branch_id', department: 'e.department_id', employee: 'e.id' });
    const rows = await this.dataSource.query(
      `SELECT e.id AS employee_id, e.staff_number, e.first_name || ' ' || e.last_name AS employee_name, d.name AS department, l.licensing_body, l.licence_number, l.expiry_date::text AS expiry_date,
              (l.expiry_date - $1::date)::int AS days_left, l.verified_at IS NOT NULL AS verified
         FROM professional_licence l JOIN employee e ON e.id = l.employee_id LEFT JOIN department d ON d.id = e.department_id
        WHERE l.deleted_at IS NULL AND e.deleted_at IS NULL AND e.status <> 'exited' AND l.expiry_date <= $1::date + $2::int AND ($3 OR l.expiry_date >= $1)
          AND NOT EXISTS (SELECT 1 FROM professional_licence n WHERE n.employee_id = l.employee_id AND n.licensing_body = l.licensing_body AND n.deleted_at IS NULL AND n.expiry_date > l.expiry_date) ${scope}
        ORDER BY l.expiry_date, e.last_name`,
      params,
    );
    return { title: `Licences expiring within ${q.within_days} days`, rows, columns: [{ key: 'staff_number', label: 'Staff no.' }, { key: 'employee_name', label: 'Name' }, { key: 'department', label: 'Department' }, { key: 'licensing_body', label: 'Body' }, { key: 'licence_number', label: 'Licence' }, { key: 'expiry_date', label: 'Expires' }, { key: 'days_left', label: 'Days left' }, { key: 'verified', label: 'Verified' }] };
  }

  async contractExpiry(access: AccessProfile, q: { within_days: number; include_expired: boolean }) {
    const today = await this.settings.today();
    const params: unknown[] = [today, q.within_days, q.include_expired];
    const scope = scopeSql(await this.filter(access), params, { branch: 'e.branch_id', department: 'e.department_id', employee: 'e.id' });
    const rows = await this.dataSource.query(
      `SELECT e.id AS employee_id, e.staff_number, e.first_name || ' ' || e.last_name AS employee_name, d.name AS department, c.number AS contract_number, c.contract_type, c.end_date::text AS end_date, (c.end_date - $1::date)::int AS days_left
         FROM employee_contract c JOIN employee e ON e.id = c.employee_id LEFT JOIN department d ON d.id = e.department_id
        WHERE c.status = 'active' AND c.end_date IS NOT NULL AND e.deleted_at IS NULL AND e.status <> 'exited' AND c.end_date <= $1::date + $2::int AND ($3 OR c.end_date >= $1) ${scope}
        ORDER BY c.end_date, e.last_name`,
      params,
    );
    return { title: `Contracts ending within ${q.within_days} days`, rows, columns: [{ key: 'staff_number', label: 'Staff no.' }, { key: 'employee_name', label: 'Name' }, { key: 'department', label: 'Department' }, { key: 'contract_number', label: 'Contract' }, { key: 'contract_type', label: 'Type' }, { key: 'end_date', label: 'Ends' }, { key: 'days_left', label: 'Days left' }] };
  }

  // ---------------------------------------------------------------- export
  async export(code: ReportCode, out: ReportOutput<Record<string, unknown>>, format: 'csv' | 'xlsx'): Promise<{ body: Buffer; fileName: string; mimeType: string }> {
    await writeAudit(this.dataSource.manager, { action: 'export', entityType: 'Report', entityId: '00000000-0000-0000-0000-000000000000', after: { report: code, rows: out.rows.length, format } });
    const name = `${code}-${new Date().toISOString().slice(0, 10)}`;
    if (format === 'csv') {
      const cell = (v: unknown) => {
        const s = v === null || v === undefined ? '' : String(v);
        // Neutralise formulas a spreadsheet would run.
        const safe = /^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s) ? `'${s}` : s;
        return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
      };
      const lines = [out.columns.map((c) => cell(c.label)).join(','), ...out.rows.map((r) => out.columns.map((c) => cell(r[c.key])).join(','))];
      return { body: Buffer.from(`﻿${lines.join('\r\n')}\r\n`), fileName: `${name}.csv`, mimeType: 'text/csv; charset=utf-8' };
    }
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(REPORTS[code].slice(0, 31));
    ws.addRow([out.title]).font = { bold: true, size: 13 };
    ws.addRow([]);
    ws.addRow(out.columns.map((c) => c.label)).font = { bold: true };
    for (const r of out.rows) ws.addRow(out.columns.map((c) => (c.money ? Number(r[c.key] ?? 0) : r[c.key] ?? '')));
    out.columns.forEach((c, i) => {
      const col = ws.getColumn(i + 1);
      col.width = Math.min(40, Math.max(10, c.label.length + 2, ...out.rows.slice(0, 200).map((r) => String(r[c.key] ?? '').length + 2)));
      if (c.money) col.numFmt = '#,##0.00';
    });
    return { body: Buffer.from(await wb.xlsx.writeBuffer()), fileName: `${name}.xlsx`, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
  }

  // ---------------------------------------------------------------- dashboard
  async dashboard(access: AccessProfile) {
    const m = this.dataSource.manager;
    const today = await this.settings.today();
    const mine = await m.query(
      `SELECT (SELECT count(*)::int FROM workflow_task t JOIN workflow_instance i ON i.id = t.instance_id
                WHERE t.status = 'open' AND i.status = 'pending' AND i.requester_user_id IS DISTINCT FROM $1
                  AND (t.assignee_user_id = $1 OR (t.assignee_user_id IS NULL AND t.candidate_role_id IN (SELECT role_id FROM role_assignment WHERE user_id = $1)))) AS pending_approvals,
              (SELECT count(*)::int FROM meeting_action WHERE owner_user_id = $1 AND status = 'open') AS open_actions`,
      [access.actorId],
    );
    const [unack] = access.employeeId
      ? await m.query(
          `SELECT count(*)::int AS n FROM policy_document p JOIN employee e ON e.id = $1
            WHERE p.status = 'active' AND p.requires_ack AND p.current_version_id IS NOT NULL
              AND (cardinality(p.department_ids) = 0 OR e.department_id IN (SELECT id FROM department WHERE id = ANY(p.department_ids) OR path && p.department_ids))
              AND NOT EXISTS (SELECT 1 FROM policy_acknowledgement a WHERE a.version_id = p.current_version_id AND a.employee_id = e.id)`,
          [access.employeeId],
        )
      : [{ n: 0 }];
    const base = { pending_approvals: mine[0].pending_approvals, open_actions: mine[0].open_actions, unacknowledged_policies: unack.n };
    if (!access.has('report:read')) return { ...base, headcount: null, joiners_30d: null, leavers_30d: null, on_leave_today: null, licences_expiring_60d: null, contracts_ending_60d: null, last_payroll: null, headcount_by_department: null };
    const params: unknown[] = [today];
    const scope = scopeSql(await this.filter(access), params, { branch: 'e.branch_id', department: 'e.department_id', employee: 'e.id' });
    const [n] = await m.query(
      `SELECT count(*) FILTER (WHERE e.status IN ('active', 'probation', 'on_notice', 'suspended'))::int AS headcount,
              count(*) FILTER (WHERE e.hire_date > $1::date - 30 AND e.hire_date <= $1)::int AS joiners,
              count(*) FILTER (WHERE e.exit_date > $1::date - 30 AND e.exit_date <= $1)::int AS leavers,
              count(*) FILTER (WHERE EXISTS (SELECT 1 FROM leave_request r WHERE r.employee_id = e.id AND r.status = 'approved' AND $1 BETWEEN r.start_date AND r.end_date))::int AS on_leave,
              count(*) FILTER (WHERE e.status <> 'exited' AND EXISTS (SELECT 1 FROM professional_licence l WHERE l.employee_id = e.id AND l.deleted_at IS NULL AND l.expiry_date BETWEEN $1 AND $1::date + 60
                                 AND NOT EXISTS (SELECT 1 FROM professional_licence n WHERE n.employee_id = l.employee_id AND n.licensing_body = l.licensing_body AND n.deleted_at IS NULL AND n.expiry_date > l.expiry_date)))::int AS licences,
              count(*) FILTER (WHERE e.status <> 'exited' AND EXISTS (SELECT 1 FROM employee_contract c WHERE c.employee_id = e.id AND c.status = 'active' AND c.end_date BETWEEN $1 AND $1::date + 60))::int AS contracts
         FROM employee e WHERE e.deleted_at IS NULL ${scope}`,
      params,
    );
    const p2: unknown[] = [];
    const scope2 = scopeSql(await this.filter(access), p2, { branch: 'e.branch_id', department: 'e.department_id', employee: 'e.id' });
    const depts: { department: string; count: number }[] = await m.query(
      `SELECT coalesce(d.name, 'No department') AS department, count(*)::int AS count FROM employee e LEFT JOIN department d ON d.id = e.department_id
        WHERE e.deleted_at IS NULL AND e.status IN ('active', 'probation', 'on_notice', 'suspended') ${scope2} GROUP BY 1 ORDER BY 2 DESC LIMIT 12`,
      p2,
    );
    let lastPayroll = null;
    if (access.has('payroll:read')) {
      const [r] = await m.query(`SELECT period, status, gross::text, net::text, employees FROM payroll_run WHERE status <> 'draft' ORDER BY period DESC LIMIT 1`);
      if (r) lastPayroll = { period: r.period, status: r.status, gross: m2(r.gross), net: m2(r.net), employees: r.employees };
    }
    return { ...base, headcount: n.headcount, joiners_30d: n.joiners, leavers_30d: n.leavers, on_leave_today: n.on_leave, licences_expiring_60d: n.licences, contracts_ending_60d: n.contracts, last_payroll: lastPayroll, headcount_by_department: depts };
  }
}
