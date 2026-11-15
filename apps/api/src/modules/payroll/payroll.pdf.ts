import { brandFooter, brandPdf } from '../../common/pdf';

/** Payslip and P9 layouts. Plain, A4, standard fonts: they print well and open anywhere. */

const fmt = (x: string | number) => Number(x).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function render(build: (doc: PDFKit.PDFDocument) => void, layout: 'portrait' | 'landscape' = 'portrait'): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = brandPdf({ size: 'A4', layout, margin: 40 });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    build(doc);
    doc.end();
  });
}

export interface PayslipPdf {
  organisation: string;
  number: string | null;
  periodLabel: string;
  payDate: string;
  employee: { name: string; staffNumber: string; department: string | null; position: string | null; kraPin: string | null; nssfNumber: string | null; shaNumber: string | null };
  lines: { name: string; kind: string; amount: string; detail: string | null }[];
  gross: string;
  totalDeductions: string;
  net: string;
  taxablePay: string;
  tax: { allowable: number; tax_before_relief: number; personal_relief: number; insurance_relief: number };
  payment: string | null;
  draft: boolean;
}

export function payslipPdf(p: PayslipPdf): Promise<Buffer> {
  return render((doc) => {
    const left = 40;
    const width = doc.page.width - 80;
    doc.font('Body-Bold').fontSize(14).text(p.organisation, left, 40);
    doc.font('Body').fontSize(10).fillColor('#444').text(`Payslip for ${p.periodLabel}  ·  paid ${p.payDate}${p.number ? `  ·  ${p.number}` : ''}`);
    if (p.draft) doc.fillColor('#b91c1c').font('Body-Bold').text('DRAFT: not approved');
    doc.fillColor('#000').moveDown(0.8);

    const e = p.employee;
    const info: [string, string | null][] = [['Name', e.name], ['Staff number', e.staffNumber], ['Department', e.department], ['Position', e.position], ['KRA PIN', e.kraPin], ['NSSF number', e.nssfNumber], ['SHA number', e.shaNumber]];
    const y0 = doc.y;
    info.forEach(([k, v], i) => {
      const col = i % 2, row = Math.floor(i / 2);
      doc.font('Body').fontSize(8).fillColor('#666').text(k, left + col * (width / 2), y0 + row * 24);
      doc.font('Body').fontSize(10).fillColor('#000').text(v ?? '—', left + col * (width / 2), y0 + row * 24 + 9);
    });
    doc.y = y0 + Math.ceil(info.length / 2) * 24 + 8;

    const section = (title: string, rows: { name: string; amount: string; detail: string | null }[], total?: [string, string]) => {
      doc.moveDown(0.4).font('Body-Bold').fontSize(10).text(title, left);
      doc.moveTo(left, doc.y + 2).lineTo(left + width, doc.y + 2).strokeColor('#ccc').stroke();
      doc.moveDown(0.3);
      for (const r of rows) {
        const y = doc.y;
        doc.font('Body').fontSize(9).text(r.name + (r.detail ? `  (${r.detail})` : ''), left, y, { width: width - 120 });
        doc.text(fmt(r.amount), left + width - 120, y, { width: 120, align: 'right' });
        doc.moveDown(0.15);
      }
      if (total) {
        const y = doc.y + 2;
        doc.font('Body-Bold').fontSize(9).text(total[0], left, y);
        doc.text(fmt(total[1]), left + width - 120, y, { width: 120, align: 'right' });
        doc.moveDown(0.3);
      }
    };
    section('Earnings', p.lines.filter((l) => l.kind === 'earning'), ['Gross pay', p.gross]);
    const benefits = p.lines.filter((l) => l.kind === 'benefit');
    if (benefits.length) section('Non-cash benefits (taxed, not paid)', benefits);
    section('Deductions', p.lines.filter((l) => l.kind === 'deduction'), ['Total deductions', p.totalDeductions]);

    doc.moveDown(0.6);
    const y = doc.y;
    doc.rect(left, y, width, 30).fillColor('#f1f5f9').fill();
    doc.fillColor('#000').font('Body-Bold').fontSize(13).text('Net pay', left + 10, y + 9);
    doc.text(`KES ${fmt(p.net)}`, left + width - 210, y + 9, { width: 200, align: 'right' });
    doc.y = y + 40;

    doc.font('Body').fontSize(8).fillColor('#444');
    doc.text(`Tax: taxable pay ${fmt(p.taxablePay)} after allowable deductions of ${fmt(p.tax.allowable)}; tax ${fmt(p.tax.tax_before_relief)} less personal relief ${fmt(p.tax.personal_relief)}${p.tax.insurance_relief ? ` and insurance relief ${fmt(p.tax.insurance_relief)}` : ''}.`, left, doc.y, { width });
    const employer = p.lines.filter((l) => l.kind === 'employer_contribution');
    if (employer.length) doc.moveDown(0.3).text(`Paid by the employer on top of your pay: ${employer.map((l) => `${l.name} ${fmt(l.amount)}`).join(', ')}.`, { width });
    if (p.payment) doc.moveDown(0.3).text(`Paid to: ${p.payment}`, { width });
    doc.moveDown(0.6).fillColor('#5b6b80').text('Questions about this payslip: the payroll office.', { width });
    brandFooter(doc);
  });
}

export interface P9Row { month: string; basic: number; benefits: number; gross: number; allowable: number; taxable: number; tax: number; personalRelief: number; insuranceRelief: number; paye: number }
export interface P9Pdf { organisation: string; employerPin: string | null; year: number; employee: { name: string; staffNumber: string; kraPin: string | null }; rows: P9Row[] }

/** Tax deduction card for the year, in the shape of KRA's P9A. */
export function p9Pdf(p: P9Pdf): Promise<Buffer> {
  return render((doc) => {
    const left = 40;
    doc.font('Body-Bold').fontSize(13).text(`P9A Tax Deduction Card, ${p.year}`, left, 40);
    doc.font('Body').fontSize(9).text(`Employer: ${p.organisation}${p.employerPin ? `  ·  PIN ${p.employerPin}` : ''}`);
    doc.text(`Employee: ${p.employee.name}  ·  ${p.employee.staffNumber}  ·  PIN ${p.employee.kraPin ?? '—'}`);
    doc.moveDown(0.8);
    const cols = ['Month', 'A Basic', 'B Benefits', 'C Gross', 'E Allowable', 'H Chargeable', 'J Tax charged', 'K Personal relief', 'K Insurance relief', 'L PAYE'];
    const widths = [70, 75, 70, 80, 75, 80, 75, 75, 75, 75];
    const row = (cells: string[], bold = false) => {
      const y = doc.y;
      let x = left;
      cells.forEach((c, i) => {
        doc.font(bold ? 'Body-Bold' : 'Body').fontSize(8).text(c, x, y, { width: widths[i] - 4, align: i === 0 ? 'left' : 'right' });
        x += widths[i];
      });
      doc.y = y + 14;
    };
    row(cols, true);
    const n = (x: number) => fmt(x);
    for (const r of p.rows) row([r.month, n(r.basic), n(r.benefits), n(r.gross), n(r.allowable), n(r.taxable), n(r.tax), n(r.personalRelief), n(r.insuranceRelief), n(r.paye)]);
    const t = (k: keyof P9Row) => p.rows.reduce((a, r) => a + (r[k] as number), 0);
    row(['Total', n(t('basic')), n(t('benefits')), n(t('gross')), n(t('allowable')), n(t('taxable')), n(t('tax')), n(t('personalRelief')), n(t('insuranceRelief')), n(t('paye'))], true);
    doc.moveDown(1).font('Body').fontSize(8).fillColor('#444').text('E: NSSF and pension contributions up to the cap, SHIF and the Housing Levy where deductible, mortgage interest and post-retirement medical fund up to their caps. Months without an approved payroll are left out.', left, doc.y, { width: 720 });
  }, 'landscape');
}
