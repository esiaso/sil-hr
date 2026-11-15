import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import Decimal from 'decimal.js';
import ExcelJS from 'exceljs';
import { DataSource } from 'typeorm';
import { AuditAction, MEDICAL_REPORTS, type MedicalReport } from '@sil/hr-shared';
import { unprocessable } from '../../common/problem';
import { writeAudit } from '../audit/audit.subscriber';
import { SettingsService } from '../settings/settings.module';
import { MedicalMember, MedicalScheme } from './medical.entities';
import { MedicalService } from './medical.service';
import { schemeYear } from './medical.rules';

const m2 = (x: Decimal.Value) => new Decimal(x).toFixed(2);

/** Utilisation, members near their limit, claims by facility, and who paid for what. */
@Injectable()
export class MedicalReports {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly medical: MedicalService,
    private readonly settings: SettingsService,
  ) {}

  /** Every limit in force today (one per pool and category), with its holder's department. */
  private async limits(schemeId?: string) {
    const today = await this.settings.today();
    const members = await this.dataSource.getRepository(MedicalMember).find({ where: { status: 'active', ...(schemeId ? { schemeId } : {}) } });
    const out: { scheme: string; category: string; department: string | null; memberNumber: string; name: string; staffNumber: string; limit: string; used: string; held: string; remaining: string; pct: number }[] = [];
    for (const mb of members) {
      const { scheme, person, balances } = await this.medical.balancesFor(this.dataSource.manager, mb, today);
      for (const b of balances) {
        if (b.pool_member_id !== mb.id) continue; // count each shared limit once, under its principal
        out.push({ scheme: scheme.name, category: b.category_name, department: person.departmentName, memberNumber: mb.memberNumber, name: mb.name, staffNumber: person.staffNumber, limit: new Decimal(b.limit).plus(b.top_ups).plus(b.carried_over).toFixed(2), used: b.used, held: b.held, remaining: b.remaining, pct: b.utilisation_pct });
      }
    }
    return out;
  }

  async utilisation(schemeId?: string) {
    const rows = await this.limits(schemeId);
    const agg = new Map<string, { scheme: string; category: string; department: string | null; members: number; limit: Decimal; used: Decimal; held: Decimal }>();
    for (const r of rows) {
      const k = `${r.scheme}|${r.category}|${r.department ?? ''}`;
      const a = agg.get(k) ?? { scheme: r.scheme, category: r.category, department: r.department, members: 0, limit: new Decimal(0), used: new Decimal(0), held: new Decimal(0) };
      a.members++;
      a.limit = a.limit.plus(r.limit);
      a.used = a.used.plus(r.used);
      a.held = a.held.plus(r.held);
      agg.set(k, a);
    }
    return [...agg.values()].sort((a, b) => a.scheme.localeCompare(b.scheme) || a.category.localeCompare(b.category) || (a.department ?? '').localeCompare(b.department ?? ''))
      .map((a) => ({ scheme: a.scheme, category: a.category, department: a.department, members: a.members, limit: m2(a.limit), used: m2(a.used), held: m2(a.held), utilisation_pct: a.limit.gt(0) ? a.used.plus(a.held).div(a.limit).mul(100).toDecimalPlaces(1).toNumber() : 0 }));
  }

  async nearLimit(threshold = 80, schemeId?: string) {
    return (await this.limits(schemeId)).filter((r) => r.pct >= threshold).sort((a, b) => b.pct - a.pct)
      .map((r) => ({ member_number: r.memberNumber, name: r.name, staff_number: r.staffNumber, department: r.department, scheme: r.scheme, category: r.category, limit: r.limit, used: r.used, remaining: r.remaining, utilisation_pct: r.pct }));
  }

  async facilities(from: string, to: string) {
    const rows: { facility: string; claims: number; invoiced: string; scheme_paid: string; member_paid: string }[] = await this.dataSource.query(
      `SELECT coalesce(c.facility, '(not given)') AS facility, count(*)::int AS claims, coalesce(sum(c.invoice_amount), 0) AS invoiced, sum(c.amount) AS scheme_paid, coalesce(sum(c.member_share), 0) AS member_paid
         FROM medical_ledger c WHERE c.entry_type = 'claim' AND c.occurred_on BETWEEN $1 AND $2 AND NOT EXISTS (SELECT 1 FROM medical_ledger r WHERE r.reverses_id = c.id)
        GROUP BY 1 ORDER BY 4 DESC`,
      [from, to],
    );
    return rows.map((r) => ({ facility: r.facility, claims: r.claims, invoiced: m2(r.invoiced), scheme_paid: m2(r.scheme_paid), member_paid: m2(r.member_paid) }));
  }

  /** Per month: what the hospital paid in claims (net of reversals) and what staff paid in contributions. */
  async funding(from: string, to: string) {
    const claims: { p: string; amount: string; n: number }[] = await this.dataSource.query(
      `SELECT to_char(occurred_on, 'YYYY-MM') AS p, sum(CASE WHEN entry_type = 'claim' THEN amount ELSE -amount END) AS amount, count(*) FILTER (WHERE entry_type = 'claim')::int AS n
         FROM medical_ledger WHERE entry_type IN ('claim', 'reversal') AND to_char(occurred_on, 'YYYY-MM') BETWEEN $1 AND $2 GROUP BY 1`,
      [from, to],
    );
    const contrib: { p: string; amount: string }[] = await this.dataSource.query(
      `SELECT r.period AS p, sum(pl.amount) AS amount FROM payslip_line pl JOIN payslip s ON s.id = pl.payslip_id JOIN payroll_run r ON r.id = s.run_id
        WHERE pl.code = 'MEDICAL' AND r.status IN ('approved', 'paid', 'closed') AND r.period BETWEEN $1 AND $2 GROUP BY 1`,
      [from, to],
    );
    const periods = new Set([...claims.map((c) => c.p), ...contrib.map((c) => c.p)]);
    return [...periods].sort().map((p) => ({
      period: p, hospital_share: m2(claims.find((c) => c.p === p)?.amount ?? 0), staff_contributions: m2(contrib.find((c) => c.p === p)?.amount ?? 0), claims: claims.find((c) => c.p === p)?.n ?? 0,
    }));
  }

  async export(report: string, q: { scheme_id?: string; from?: string; to?: string; threshold?: number }) {
    if (!(report in MEDICAL_REPORTS)) throw unprocessable('unknown_report', `report must be one of ${Object.keys(MEDICAL_REPORTS).join(', ')}`);
    const today = await this.settings.today();
    const yr = schemeYear(today, 1);
    let header: string[] = [];
    let rows: (string | number | null)[][] = [];
    let money: number[] = [];
    switch (report as MedicalReport) {
      case 'utilisation': {
        const r = await this.utilisation(q.scheme_id);
        header = ['Scheme', 'Category', 'Department', 'Limits', 'Total limit', 'Used', 'Held', 'Utilisation %'];
        rows = r.map((x) => [x.scheme, x.category, x.department, x.members, Number(x.limit), Number(x.used), Number(x.held), x.utilisation_pct]);
        money = [4, 5, 6];
        break;
      }
      case 'near_limit': {
        const r = await this.nearLimit(q.threshold ?? 80, q.scheme_id);
        header = ['Member number', 'Name', 'Staff number', 'Department', 'Scheme', 'Category', 'Limit', 'Used', 'Remaining', 'Utilisation %'];
        rows = r.map((x) => [x.member_number, x.name, x.staff_number, x.department, x.scheme, x.category, Number(x.limit), Number(x.used), Number(x.remaining), x.utilisation_pct]);
        money = [6, 7, 8];
        break;
      }
      case 'facilities': {
        const r = await this.facilities(q.from ?? yr.start, q.to ?? today);
        header = ['Facility', 'Claims', 'Invoiced', 'Paid by the scheme', 'Paid by members'];
        rows = r.map((x) => [x.facility, x.claims, Number(x.invoiced), Number(x.scheme_paid), Number(x.member_paid)]);
        money = [2, 3, 4];
        break;
      }
      case 'funding': {
        const r = await this.funding(q.from?.slice(0, 7) ?? yr.start.slice(0, 7), q.to?.slice(0, 7) ?? today.slice(0, 7));
        header = ['Month', 'Hospital share (claims)', 'Staff contributions', 'Claims'];
        rows = r.map((x) => [x.period, Number(x.hospital_share), Number(x.staff_contributions), x.claims]);
        money = [1, 2];
        break;
      }
    }
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(MEDICAL_REPORTS[report as MedicalReport].slice(0, 31));
    ws.addRow(header).font = { bold: true };
    for (const r of rows) ws.addRow(r);
    header.forEach((h, i) => {
      ws.getColumn(i + 1).width = Math.min(40, Math.max(12, h.length + 2));
      if (money.includes(i)) ws.getColumn(i + 1).numFmt = '#,##0.00';
    });
    await writeAudit(this.dataSource.manager, { action: AuditAction.EXPORT, entityType: 'MedicalScheme', entityId: q.scheme_id ?? null, after: { report, rows: rows.length } });
    void MedicalScheme;
    return { fileName: `medical-${report.replace('_', '-')}-${today}.xlsx`, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', body: Buffer.from(await wb.xlsx.writeBuffer()) };
  }
}
