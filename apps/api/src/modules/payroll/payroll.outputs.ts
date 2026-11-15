import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { stringify } from 'csv-stringify/sync';
import ExcelJS from 'exceljs';
import { DataSource, In } from 'typeorm';
import { AccessProfile } from '../../common/access';
import { decrypt } from '../../common/crypto';
import { conflict, notFound, unprocessable } from '../../common/problem';
import { AuditAction } from '@sil/hr-shared';
import { writeAudit } from '../audit/audit.subscriber';
import { Employee, EmployeeBankAccount } from '../employees/employee.entities';
import { PaymentFileFormat, PayrollRun, Payslip, PayslipLine } from './payroll.entities';
import { p9Pdf, payslipPdf, type P9Row } from './payroll.pdf';
import { PayrollService } from './payroll.service';

export interface FileOut { fileName: string; mimeType: string; body: Buffer }
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const periodLabel = (p: string) => `${MONTHS[Number(p.slice(5)) - 1]} ${p.slice(0, 4)}`;
const n = (x: string | number | null | undefined) => (x === null || x === undefined ? 0 : Number(x));
const splitName = (full: string) => { const parts = full.trim().split(/\s+/); return { surname: parts.at(-1) ?? '', other: parts.slice(0, -1).join(' ') }; };

async function workbook(sheet: string, header: string[], rows: (string | number | null)[][], money: number[] = []): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'PeopleTrack';
  const ws = wb.addWorksheet(sheet.slice(0, 31));
  ws.addRow(header).font = { bold: true };
  for (const r of rows) ws.addRow(r);
  header.forEach((h, i) => {
    const col = ws.getColumn(i + 1);
    col.width = Math.min(40, Math.max(10, h.length + 2, ...rows.map((r) => String(r[i] ?? '').length + 2)));
    if (money.includes(i)) col.numFmt = '#,##0.00';
  });
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/**
 * Files produced from an approved payroll. Every file that carries ID numbers, PINs or
 * account numbers is audited as an export.
 */
@Injectable()
export class PayrollOutputs {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly payroll: PayrollService,
  ) {}

  private async approvedRun(id: string) {
    const run = await this.payroll.run(id);
    if (!['approved', 'paid', 'closed'].includes(run.status)) throw conflict('not_approved', 'Files are produced from an approved payroll');
    return run;
  }
  private slips(runId: string) {
    return this.dataSource.getRepository(Payslip).find({ where: { runId }, order: { staffNumber: 'ASC' } });
  }
  private async lines(runId: string) {
    const rows = await this.dataSource.getRepository(PayslipLine).createQueryBuilder('l').innerJoin(Payslip, 's', 's.id = l.payslip_id').where('s.run_id = :runId', { runId }).getMany();
    const by = new Map<string, PayslipLine[]>();
    for (const l of rows) by.set(l.payslipId, [...(by.get(l.payslipId) ?? []), l]);
    return by;
  }
  private async audit(run: PayrollRun, file: string, extra: Record<string, unknown> = {}) {
    await writeAudit(this.dataSource.manager, { action: AuditAction.EXPORT, entityType: 'PayrollRun', entityId: run.id, after: { file, period: run.period, ...extra } });
  }

  async export(id: string, file: string, opts: { channel?: 'bank' | 'mobile_money'; format_code?: string }): Promise<FileOut> {
    switch (file) {
      case 'payments': return this.payments(id, opts.channel ?? 'bank', opts.format_code);
      case 'register': return this.register(id);
      case 'p10': return this.p10(id);
      case 'nssf': return this.nssf(id);
      case 'shif': return this.shif(id);
      case 'housing_levy': return this.housingLevy(id);
      case 'journal': return this.journalFile(id);
      default: throw unprocessable('unknown_file', `Unknown file ${file}`);
    }
  }

  /** Bank (Excel by default) or M-Pesa bulk file in a configurable column layout. */
  async payments(id: string, channel: 'bank' | 'mobile_money', formatCode?: string): Promise<FileOut> {
    const run = await this.approvedRun(id);
    const repo = this.dataSource.getRepository(PaymentFileFormat);
    const fmt = formatCode ? await repo.findOneBy({ code: formatCode }) : await repo.findOne({ where: { channel, isDefault: true } });
    if (!fmt) throw notFound(`Payment file format${formatCode ? ` ${formatCode}` : ` for ${channel}`}`);
    const slips = (await this.slips(id)).filter((s) => s.paymentMethod === fmt.channel && n(s.net) > 0);
    const accounts = new Map((await this.dataSource.getRepository(EmployeeBankAccount).createQueryBuilder('a').addSelect('a.accountNumberEnc').where({ id: In(slips.map((s) => s.paymentAccountId).filter(Boolean)) }).getMany()).map((a) => [a.id, a]));
    const people = await this.payroll.employeesById(slips.map((s) => s.employeeId));
    const ref = `Salary ${periodLabel(run.period)}`;
    const rows = slips.map((s) => {
      const a = s.paymentAccountId ? accounts.get(s.paymentAccountId) : undefined;
      const e = people.get(s.employeeId);
      return fmt.columns.map((c) => {
        switch (c.field) {
          case 'employee_name': return s.employeeName;
          case 'staff_number': return s.staffNumber;
          case 'national_id': return decrypt(e?.nationalIdEnc) ?? '';
          case 'account_name': return a?.accountName ?? s.employeeName;
          case 'account_number': return decrypt(a?.accountNumberEnc) ?? '';
          case 'bank_name': return a?.bankName ?? '';
          case 'bank_code': return a?.bankCode ?? '';
          case 'branch_name': return a?.branchName ?? '';
          case 'branch_code': return a?.branchCode ?? '';
          case 'amount': return n(s.net);
          case 'reference': return ref;
          case 'pay_date': return run.payDate;
          case 'fixed': return c.value ?? '';
        }
        return '';
      });
    });
    await this.audit(run, 'payments', { format: fmt.code, rows: rows.length });
    const base = `${fmt.code.toLowerCase()}-${run.period}`;
    if (fmt.fileType === 'csv') return { fileName: `${base}.csv`, mimeType: 'text/csv', body: Buffer.from(stringify([fmt.columns.map((c) => c.header), ...rows])) };
    const moneyCols = fmt.columns.map((c, i) => (c.field === 'amount' ? i : -1)).filter((i) => i >= 0);
    return { fileName: `${base}.xlsx`, mimeType: XLSX, body: await workbook('Payments', fmt.columns.map((c) => c.header), rows, moneyCols) };
  }

  async register(id: string): Promise<FileOut> {
    const run = await this.payroll.run(id);
    const slips = await this.slips(id);
    const lines = await this.lines(id);
    const header = ['Staff number', 'Name', 'Department', 'Cost centre', 'Basic', 'Gross', 'Taxable pay', 'PAYE', 'NSSF', 'SHIF', 'Housing Levy', 'Other deductions', 'Total deductions', 'Net pay', 'Employer cost', 'Payment', 'Payslip'];
    const rows = slips.map((s) => {
      const other = (lines.get(s.id) ?? []).filter((l) => l.kind === 'deduction' && !['PAYE', 'NSSF', 'SHIF', 'AHL'].includes(l.code)).reduce((a, l) => a + n(l.amount), 0);
      return [s.staffNumber, s.employeeName, s.departmentName, s.costCentreCode, n(s.basic), n(s.gross), n(s.taxablePay), n(s.paye), n(s.nssf), n(s.shif), n(s.housingLevy), Math.round(other * 100) / 100, n(s.totalDeductions), n(s.net), n(s.employerCost), s.paymentMethod, s.number];
    });
    return { fileName: `payroll-register-${run.period}.xlsx`, mimeType: XLSX, body: await workbook(`Register ${run.period}`, header, rows, [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]) };
  }

  /**
   * KRA P10, employee-details sheet: the columns the iTax P10 template asks for, one row per
   * employee. Paste into the current KRA template (columns follow its order).
   */
  async p10(id: string): Promise<FileOut> {
    const run = await this.approvedRun(id);
    const slips = await this.slips(id);
    const lines = await this.lines(id);
    const people = await this.payroll.employeesById(slips.map((s) => s.employeeId));
    const header = ['PIN of Employee', 'Name of Employee', 'Residential Status', 'Type of Employee', 'Basic Salary', 'Housing Allowance', 'Transport Allowance', 'Leave Pay', 'Overtime Allowance', 'Directors Fee', 'Lump Sum Payment', 'Other Allowance', 'Total Cash Pay', 'Value of Car Benefit', 'Other Non Cash Benefits', 'Total Non Cash Pay', 'Global Income', 'Type of Housing', 'Actual Contribution (NSSF + pension)', 'SHIF', 'Housing Levy', 'Mortgage Interest', 'Taxable Pay', 'Tax Payable', 'Personal Relief', 'Insurance Relief', 'PAYE Tax'];
    const rows = slips.map((s) => {
      const ls = lines.get(s.id) ?? [];
      const sum = (f: (l: PayslipLine) => boolean) => Math.round(ls.filter(f).reduce((a, l) => a + n(l.amount), 0) * 100) / 100;
      const basic = sum((l) => l.code === 'BASIC' || l.code === 'UNPAID_LEAVE');
      const housing = sum((l) => l.kind === 'earning' && l.code === 'HOUSE');
      const transport = sum((l) => l.kind === 'earning' && l.code === 'TRANSPORT');
      const ot = sum((l) => l.code.startsWith('OT_'));
      const other = Math.round((n(s.gross) - basic - housing - transport - ot) * 100) / 100;
      const benefits = sum((l) => l.kind === 'benefit');
      const pension = sum((l) => l.kind === 'deduction' && l.code === 'PENSION') + n(s.nssf);
      return [decrypt(people.get(s.employeeId)?.kraPinEnc) ?? '', s.employeeName, 'Resident', 'Primary Employee', basic, housing, transport, 0, ot, 0, 0, other, n(s.gross), 0, benefits, benefits, 0, 'Benefit not given', pension, n(s.shif), n(s.housingLevy), 0, n(s.taxablePay), s.tax.tax_before_relief, s.tax.personal_relief, s.tax.insurance_relief, n(s.paye)];
    });
    await this.audit(run, 'p10', { rows: rows.length });
    return { fileName: `kra-p10-${run.period}.xlsx`, mimeType: XLSX, body: await workbook('B_Employees_Dtls', header, rows, [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 18, 19, 20, 21, 22, 23, 24, 25, 26]) };
  }

  async nssf(id: string): Promise<FileOut> {
    const run = await this.approvedRun(id);
    const slips = (await this.slips(id)).filter((s) => n(s.nssf) > 0);
    const people = await this.payroll.employeesById(slips.map((s) => s.employeeId));
    const header = ['Payroll Number', 'Surname', 'Other Names', 'ID Number', 'KRA PIN', 'NSSF Number', 'Gross Pay', 'Employee Contribution', 'Employer Contribution', 'Total', 'Voluntary'];
    const rows = slips.map((s) => {
      const e = people.get(s.employeeId);
      const { surname, other } = splitName(s.employeeName);
      return [s.staffNumber, surname, other, decrypt(e?.nationalIdEnc) ?? '', decrypt(e?.kraPinEnc) ?? '', e?.nssfNumber ?? '', n(s.gross), n(s.nssf), n(s.nssf), n(s.nssf) * 2, 0];
    });
    await this.audit(run, 'nssf', { rows: rows.length });
    return { fileName: `nssf-${run.period}.xlsx`, mimeType: XLSX, body: await workbook('NSSF', header, rows, [6, 7, 8, 9, 10]) };
  }

  async shif(id: string): Promise<FileOut> {
    const run = await this.approvedRun(id);
    const slips = (await this.slips(id)).filter((s) => n(s.shif) > 0);
    const people = await this.payroll.employeesById(slips.map((s) => s.employeeId));
    const header = ['Payroll Number', 'First Name', 'Last Name', 'ID Number', 'KRA PIN', 'SHA Number', 'Gross Pay', 'Contribution Amount', 'Phone'];
    const rows = slips.map((s) => {
      const e = people.get(s.employeeId);
      return [s.staffNumber, e?.firstName ?? '', e?.lastName ?? '', decrypt(e?.nationalIdEnc) ?? '', decrypt(e?.kraPinEnc) ?? '', e?.shaNumber ?? '', n(s.gross), n(s.shif), e?.workPhone ?? e?.personalPhone ?? ''];
    });
    await this.audit(run, 'shif', { rows: rows.length });
    return { fileName: `sha-shif-${run.period}.xlsx`, mimeType: XLSX, body: await workbook('SHIF', header, rows, [6, 7]) };
  }

  async housingLevy(id: string): Promise<FileOut> {
    const run = await this.approvedRun(id);
    const slips = (await this.slips(id)).filter((s) => n(s.housingLevy) > 0);
    const lines = await this.lines(id);
    const people = await this.payroll.employeesById(slips.map((s) => s.employeeId));
    const header = ['ID Number', 'KRA PIN', 'Name of Employee', 'Gross Pay', 'Employee Contribution', 'Employer Contribution', 'Total'];
    const rows = slips.map((s) => {
      const e = people.get(s.employeeId);
      const er = n((lines.get(s.id) ?? []).find((l) => l.code === 'AHL_ER')?.amount);
      return [decrypt(e?.nationalIdEnc) ?? '', decrypt(e?.kraPinEnc) ?? '', s.employeeName, n(s.gross), n(s.housingLevy), er, Math.round((n(s.housingLevy) + er) * 100) / 100];
    });
    await this.audit(run, 'housing_levy', { rows: rows.length });
    return { fileName: `housing-levy-${run.period}.xlsx`, mimeType: XLSX, body: await workbook('Housing Levy', header, rows, [3, 4, 5, 6]) };
  }

  async journalFile(id: string): Promise<FileOut> {
    const j = await this.payroll.journal(id);
    const rows = j.lines.map((l) => [l.account, l.cost_centre_code, l.description, n(l.debit), n(l.credit)]);
    rows.push(['', '', 'Total', n(j.total_debit), n(j.total_credit)]);
    return { fileName: `payroll-journal-${j.period}.xlsx`, mimeType: XLSX, body: await workbook(`Journal ${j.period}`, ['Account', 'Cost centre', 'Description', 'Debit', 'Credit'], rows, [3, 4]) };
  }

  // ------------------------------------------------------------------ PDFs
  async payslipPdf(access: AccessProfile, id: string): Promise<FileOut> {
    const { s, run, lines } = await this.payroll.loadPayslip(id);
    await this.payroll.assertCanSee(access, s, run);
    const org = await this.payroll.organisation();
    const e = (await this.payroll.employeesById([s.employeeId])).get(s.employeeId);
    let payment: string | null = null;
    if (s.paymentAccountId) {
      const a = await this.dataSource.getRepository(EmployeeBankAccount).findOneBy({ id: s.paymentAccountId });
      if (a) payment = a.kind === 'mobile_money' ? `M-Pesa ending ${a.accountLast4}` : `${a.bankName ?? 'Bank'}${a.branchName ? `, ${a.branchName}` : ''}, account ending ${a.accountLast4}`;
    }
    const pin = decrypt(e?.kraPinEnc);
    const body = await payslipPdf({
      organisation: org?.legal_name ?? org?.name ?? 'PeopleTrack', number: s.number, periodLabel: periodLabel(run.period), payDate: run.payDate,
      employee: { name: s.employeeName, staffNumber: s.staffNumber, department: s.departmentName, position: (s.inputs.position as string | null) ?? e?.position?.title ?? null, kraPin: pin ? `${pin.slice(0, 1)}•••••••${pin.slice(-3)}` : null, nssfNumber: e?.nssfNumber ?? null, shaNumber: e?.shaNumber ?? null },
      lines: lines.map((l) => ({ name: l.name, kind: l.kind, amount: l.amount, detail: l.detail })), gross: s.gross, totalDeductions: s.totalDeductions, net: s.net, taxablePay: s.taxablePay, tax: s.tax,
      payment, draft: !['approved', 'paid', 'closed'].includes(run.status),
    });
    return { fileName: `payslip-${run.period}-${s.staffNumber}.pdf`, mimeType: 'application/pdf', body };
  }

  /** P9A for a year from approved payrolls. Staff get their own; payroll staff anyone's. */
  async p9(access: AccessProfile, employeeId: string, year: number): Promise<FileOut> {
    if (access.employeeId !== employeeId && !access.has('payroll:read')) throw notFound('Employee');
    const e = await this.dataSource.getRepository(Employee).createQueryBuilder('e').addSelect('e.kraPinEnc').where({ id: employeeId }).getOne();
    if (!e) throw notFound('Employee');
    const slips = await this.dataSource.getRepository(Payslip).createQueryBuilder('s').innerJoinAndMapOne('s.run', PayrollRun, 'r', 'r.id = s.run_id')
      .where(`s.employee_id = :id AND r.status IN ('approved', 'paid', 'closed') AND r.period LIKE :y`, { id: employeeId, y: `${year}-%` }).orderBy('r.period').getMany();
    const lines = slips.length ? await this.dataSource.getRepository(PayslipLine).findBy({ payslipId: In(slips.map((s) => s.id)) }) : [];
    const rows: P9Row[] = slips.map((s) => {
      const run = (s as Payslip & { run: PayrollRun }).run;
      const ls = lines.filter((l) => l.payslipId === s.id);
      const benefits = ls.filter((l) => l.kind === 'benefit').reduce((a, l) => a + n(l.amount), 0);
      return {
        month: MONTHS[Number(run.period.slice(5)) - 1], basic: n(s.basic), benefits, gross: n(s.gross) + benefits, allowable: s.tax.allowable, taxable: n(s.taxablePay),
        tax: s.tax.tax_before_relief, personalRelief: s.tax.personal_relief, insuranceRelief: s.tax.insurance_relief, paye: n(s.paye),
      };
    });
    const org = await this.payroll.organisation();
    const body = await p9Pdf({ organisation: org?.legal_name ?? org?.name ?? 'PeopleTrack', employerPin: org?.kra_pin ?? null, year, employee: { name: e.displayName, staffNumber: e.staffNumber, kraPin: decrypt(e.kraPinEnc) }, rows });
    if (access.employeeId !== employeeId) await writeAudit(this.dataSource.manager, { action: AuditAction.SENSITIVE_READ, entityType: 'Employee', entityId: e.id, after: { p9: year } });
    return { fileName: `p9-${year}-${e.staffNumber}.pdf`, mimeType: 'application/pdf', body };
  }
}
