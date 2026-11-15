import Decimal from 'decimal.js';
import { housingLevy, money, nssf, paye, shif, type StatutoryTables } from './payroll.statutory';

/**
 * One employee's payslip for one period, as a pure function of its inputs. The run gathers
 * the inputs (effective-dated salary and items, loans, one-off items, overtime, unpaid
 * leave, proration and the rate tables in force) and stores them with the result, so a
 * March payslip can be recalculated in October and come out the same.
 */

export type ComponentKind = 'earning' | 'deduction' | 'benefit' | 'employer_contribution';
export type ComponentMethod = 'fixed' | 'percent_basic' | 'percent_gross' | 'formula';
export type TaxTreatment = 'none' | 'pension' | 'insurance' | 'mortgage_interest' | 'post_retirement_medical';

export interface CalcItem {
  code: string;
  name: string;
  kind: ComponentKind;
  method: ComponentMethod;
  /** Fixed amount, or a percentage (15 = 15%). */
  value: number | null;
  formula: string | null;
  taxable: boolean;
  pensionable: boolean;
  /** Fixed amounts are reduced for joiners, leavers and unpaid leave like basic pay. */
  prorate: boolean;
  treatment: TaxTreatment;
}

export interface CalcLoan { loanId: string; code: string; name: string; installment: number; balance: number }
export interface CalcOneOff { code: string; name: string; kind: ComponentKind; amount: number; taxable: boolean; pensionable: boolean; treatment: TaxTreatment; note: string | null }
export interface CalcOvertime { dayType: string; minutes: number; multiplier: number }

export interface CalcInput {
  basicMonthly: number;
  /** Units (working or calendar days) the person was employed in the period, and the period's total. */
  paidUnits: number;
  totalUnits: number;
  unpaidLeaveDays: number;
  /** Hours in a month for the hourly rate used by overtime. */
  monthlyHours: number;
  items: CalcItem[];
  overtime: CalcOvertime[];
  loans: CalcLoan[];
  oneOffs: CalcOneOff[];
  tables: StatutoryTables;
}

export type LineKind = 'earning' | 'deduction' | 'benefit' | 'employer_contribution';
export interface PayLine {
  code: string;
  name: string;
  kind: LineKind;
  amount: number;
  taxable?: boolean;
  /** Free text shown on the payslip, e.g. "6.5 h × 1.5". */
  detail?: string;
  loanId?: string;
}

export interface CalcResult {
  lines: PayLine[];
  basic: number;
  gross: number;
  taxable_pay: number;
  allowable: number;
  tax_before_relief: number;
  personal_relief: number;
  insurance_relief: number;
  paye: number;
  nssf: number;
  shif: number;
  housing_levy: number;
  total_deductions: number;
  net: number;
  employer_cost: number;
  warnings: string[];
}

// ------------------------------------------------------------------ formulas

/**
 * A small, safe arithmetic language for formula components: numbers, + − × ÷, brackets,
 * min(a, b…), max(a, b…), round(x) and the variables below. No other names are known.
 */
export const FORMULA_VARIABLES = {
  basic: 'Basic pay for the period (after proration and unpaid leave)',
  basic_full: 'Monthly basic salary before proration',
  gross: 'Gross pay (deductions and employer contributions only)',
  days_paid: 'Days paid in the period',
  days_in_period: 'Days in the period on the proration basis',
  overtime_hours: 'Overtime hours in the period',
} as const;

type Tok = { t: 'num'; v: number } | { t: 'id'; v: string } | { t: 'op'; v: string };

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (/[0-9.]/.test(c)) {
      const m = /^[0-9]*\.?[0-9]+/.exec(src.slice(i));
      if (!m) throw new Error(`Bad number at ${i + 1}`);
      out.push({ t: 'num', v: Number(m[0]) });
      i += m[0].length;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i))!;
      out.push({ t: 'id', v: m[0].toLowerCase() });
      i += m[0].length;
      continue;
    }
    if ('+-*/(),'.includes(c)) { out.push({ t: 'op', v: c }); i++; continue; }
    throw new Error(`Unexpected "${c}" at ${i + 1}`);
  }
  return out;
}

/** Parses once; throws a readable message on any mistake. */
export function compileFormula(src: string): (vars: Record<string, number>) => number {
  if (src.length > 500) throw new Error('Formula is too long');
  const toks = tokenize(src);
  let p = 0;
  type Node = (v: Record<string, number>) => Decimal;
  const peek = () => toks[p];
  const eat = (v?: string) => {
    const t = toks[p];
    if (!t || (v && t.v !== v)) throw new Error(v ? `Expected "${v}"` : 'Unexpected end');
    p++;
    return t;
  };
  const expr = (): Node => {
    let left = term();
    while (peek()?.t === 'op' && (peek().v === '+' || peek().v === '-')) {
      const op = eat().v;
      const l = left, r = term();
      left = op === '+' ? (v) => l(v).plus(r(v)) : (v) => l(v).minus(r(v));
    }
    return left;
  };
  const term = (): Node => {
    let left = unary();
    while (peek()?.t === 'op' && (peek().v === '*' || peek().v === '/')) {
      const op = eat().v;
      const l = left, r = unary();
      left = op === '*' ? (v) => l(v).mul(r(v)) : (v) => { const d = r(v); return d.isZero() ? new Decimal(0) : l(v).div(d); };
    }
    return left;
  };
  const unary = (): Node => {
    if (peek()?.t === 'op' && peek().v === '-') { eat(); const n = unary(); return (v) => n(v).neg(); }
    return atom();
  };
  const atom = (): Node => {
    const t = eat();
    if (t.t === 'num') { const n = new Decimal(t.v); return () => n; }
    if (t.t === 'op' && t.v === '(') { const n = expr(); eat(')'); return n; }
    if (t.t === 'id') {
      if (['min', 'max', 'round'].includes(t.v)) {
        eat('(');
        const args: Node[] = [expr()];
        while (peek()?.v === ',') { eat(','); args.push(expr()); }
        eat(')');
        if (t.v === 'round') return (v) => args[0](v).toDecimalPlaces(args[1] ? args[1](v).toNumber() : 0, Decimal.ROUND_HALF_UP);
        return t.v === 'min' ? (v) => Decimal.min(...args.map((a) => a(v))) : (v) => Decimal.max(...args.map((a) => a(v)));
      }
      if (!(t.v in FORMULA_VARIABLES)) throw new Error(`Unknown name "${t.v}"`);
      const name = t.v;
      return (v) => new Decimal(v[name] ?? 0);
    }
    throw new Error(`Unexpected "${t.v}"`);
  };
  const root = expr();
  if (p < toks.length) throw new Error(`Unexpected "${toks[p].v}"`);
  return (vars) => root(vars).toNumber();
}

// ------------------------------------------------------------------ the payslip

const sum = (xs: number[]) => money(xs.reduce((a, b) => a.plus(b), new Decimal(0)));

export function calculatePayslip(i: CalcInput): CalcResult {
  const warnings: string[] = [];
  const lines: PayLine[] = [];
  const fraction = i.totalUnits > 0 ? new Decimal(Math.min(i.paidUnits, i.totalUnits)).div(i.totalUnits) : new Decimal(0);
  const dailyRate = i.totalUnits > 0 ? new Decimal(i.basicMonthly).div(i.totalUnits) : new Decimal(0);
  const unpaidDays = Math.min(i.unpaidLeaveDays, i.paidUnits);

  // Basic pay, prorated for joiners and leavers, less unpaid leave.
  const basicProrated = money(new Decimal(i.basicMonthly).mul(fraction));
  lines.push({ code: 'BASIC', name: 'Basic pay', kind: 'earning', amount: basicProrated, taxable: true, detail: fraction.lt(1) ? `${i.paidUnits} of ${i.totalUnits} days` : undefined });
  const unpaid = money(dailyRate.mul(unpaidDays));
  if (unpaid > 0) lines.push({ code: 'UNPAID_LEAVE', name: 'Unpaid leave', kind: 'earning', amount: -unpaid, taxable: true, detail: `${unpaidDays} day(s)` });
  const basic = money(new Decimal(basicProrated).minus(unpaid));
  const payFraction = i.totalUnits > 0 ? new Decimal(Math.max(0, Math.min(i.paidUnits, i.totalUnits) - unpaidDays)).div(i.totalUnits) : new Decimal(0);
  const overtimeHours = i.overtime.reduce((a, o) => a + o.minutes / 60, 0);
  const vars: Record<string, number> = { basic, basic_full: i.basicMonthly, gross: 0, days_paid: Math.max(0, i.paidUnits - unpaidDays), days_in_period: i.totalUnits, overtime_hours: Math.round(overtimeHours * 100) / 100 };

  const resolve = (it: CalcItem): number => {
    switch (it.method) {
      case 'fixed': return money(new Decimal(it.value ?? 0).mul(it.prorate ? payFraction : 1));
      case 'percent_basic': return money(new Decimal(basic).mul(it.value ?? 0).div(100));
      case 'percent_gross': return money(new Decimal(vars.gross).mul(it.value ?? 0).div(100));
      case 'formula':
        try { return money(compileFormula(it.formula ?? '0')(vars)); } catch (e) { warnings.push(`${it.name}: ${(e as Error).message}`); return 0; }
    }
  };
  const needsGross = (it: CalcItem) => it.method === 'percent_gross' || (it.method === 'formula' && /\bgross\b/i.test(it.formula ?? ''));

  // Earnings and benefits that do not depend on gross.
  const pensionable: number[] = [basic];
  const taxableEarnings: number[] = [basic];
  for (const it of i.items.filter((x) => (x.kind === 'earning' || x.kind === 'benefit') && !needsGross(x))) {
    const amount = resolve(it);
    if (!amount) continue;
    lines.push({ code: it.code, name: it.name, kind: it.kind, amount, taxable: it.taxable });
    if (it.taxable) taxableEarnings.push(amount);
    if (it.pensionable && it.kind === 'earning') pensionable.push(amount);
  }
  // Overtime at the hourly rate × the rule's multiplier.
  const hourly = i.monthlyHours > 0 ? new Decimal(i.basicMonthly).div(i.monthlyHours) : new Decimal(0);
  for (const o of i.overtime) {
    if (o.minutes <= 0 || o.multiplier <= 0) continue;
    const amount = money(hourly.mul(o.minutes).div(60).mul(o.multiplier));
    const label = o.dayType === 'normal' ? 'Overtime' : o.dayType === 'rest_day' ? 'Overtime (rest day)' : 'Overtime (public holiday)';
    lines.push({ code: `OT_${o.dayType.toUpperCase()}`, name: label, kind: 'earning', amount, taxable: true, detail: `${Math.round((o.minutes / 60) * 100) / 100} h × ${o.multiplier}` });
    taxableEarnings.push(amount);
  }
  // One-off earnings and benefits (arrears, bonuses).
  for (const o of i.oneOffs.filter((x) => x.kind === 'earning' || x.kind === 'benefit')) {
    lines.push({ code: o.code, name: o.name, kind: o.kind, amount: money(o.amount), taxable: o.taxable, detail: o.note ?? undefined });
    if (o.taxable) taxableEarnings.push(o.amount);
    if (o.pensionable && o.kind === 'earning') pensionable.push(o.amount);
  }
  const cashEarnings = () => sum(lines.filter((l) => l.kind === 'earning').map((l) => l.amount));
  vars.gross = cashEarnings();
  // Earnings that depend on gross (rare, but allowed).
  for (const it of i.items.filter((x) => (x.kind === 'earning' || x.kind === 'benefit') && needsGross(x))) {
    const amount = resolve(it);
    if (!amount) continue;
    lines.push({ code: it.code, name: it.name, kind: it.kind, amount, taxable: it.taxable });
    if (it.taxable) taxableEarnings.push(amount);
    if (it.pensionable && it.kind === 'earning') pensionable.push(amount);
  }
  const gross = cashEarnings();
  vars.gross = gross;

  // Statutory.
  const nssfAmount = nssf(sum(pensionable), i.tables.NSSF).total;
  const shifAmount = shif(gross, i.tables.SHIF);
  const ahl = housingLevy(gross, i.tables.HOUSING_LEVY);

  // Voluntary deductions, and what they mean for tax.
  const treatment: Record<TaxTreatment, number[]> = { none: [], pension: [], insurance: [], mortgage_interest: [], post_retirement_medical: [] };
  const deductionLines: PayLine[] = [];
  for (const it of i.items.filter((x) => x.kind === 'deduction')) {
    const amount = resolve(it);
    if (!amount) continue;
    deductionLines.push({ code: it.code, name: it.name, kind: 'deduction', amount });
    treatment[it.treatment].push(amount);
  }
  for (const o of i.oneOffs.filter((x) => x.kind === 'deduction')) {
    deductionLines.push({ code: o.code, name: o.name, kind: 'deduction', amount: money(o.amount), detail: o.note ?? undefined });
    treatment[o.treatment].push(o.amount);
  }
  const tax = paye({
    taxableEarnings: sum(taxableEarnings), nssf: nssfAmount, pensionContributions: sum(treatment.pension), shif: shifAmount, housingLevy: ahl.employee,
    mortgageInterest: sum(treatment.mortgage_interest), postRetirementMedical: sum(treatment.post_retirement_medical), insurancePremiums: sum(treatment.insurance),
  }, i.tables);

  lines.push({ code: 'PAYE', name: 'PAYE', kind: 'deduction', amount: tax.paye });
  lines.push({ code: 'NSSF', name: 'NSSF', kind: 'deduction', amount: nssfAmount });
  lines.push({ code: 'SHIF', name: 'SHIF', kind: 'deduction', amount: shifAmount });
  lines.push({ code: 'AHL', name: 'Housing Levy', kind: 'deduction', amount: ahl.employee });
  lines.push(...deductionLines);

  // Loans and advances: the instalment, never more than what is left.
  for (const l of i.loans) {
    const amount = money(Decimal.min(l.installment, l.balance));
    if (amount > 0) lines.push({ code: l.code, name: l.name, kind: 'deduction', amount, loanId: l.loanId, detail: `balance after: ${money(new Decimal(l.balance).minus(amount)).toFixed(2)}` });
  }

  // Employer contributions.
  const employerLines: PayLine[] = [
    { code: 'NSSF_ER', name: 'NSSF (employer)', kind: 'employer_contribution', amount: nssfAmount },
    { code: 'AHL_ER', name: 'Housing Levy (employer)', kind: 'employer_contribution', amount: ahl.employer },
    { code: 'NITA', name: 'NITA levy', kind: 'employer_contribution', amount: gross > 0 ? money(i.tables.NITA.employer_amount) : 0 },
  ];
  for (const it of i.items.filter((x) => x.kind === 'employer_contribution')) {
    const amount = resolve(it);
    if (amount) employerLines.push({ code: it.code, name: it.name, kind: 'employer_contribution', amount });
  }
  lines.push(...employerLines.filter((l) => l.amount > 0));

  const totalDeductions = sum(lines.filter((l) => l.kind === 'deduction').map((l) => l.amount));
  const net = money(new Decimal(gross).minus(totalDeductions));
  if (net < 0) warnings.push('Deductions are more than gross pay');
  // Employment Act s.19(3): deductions may not exceed two-thirds of wages.
  else if (gross > 0 && new Decimal(totalDeductions).gt(new Decimal(gross).mul(2).div(3))) warnings.push('Deductions exceed two-thirds of gross pay (Employment Act s.19(3))');

  return {
    lines,
    basic,
    gross,
    taxable_pay: tax.taxablePay,
    allowable: tax.allowable,
    tax_before_relief: tax.taxBeforeRelief,
    personal_relief: tax.paye > 0 || tax.taxBeforeRelief > 0 ? Math.min(tax.personalRelief, tax.taxBeforeRelief) : 0,
    insurance_relief: tax.insuranceRelief,
    paye: tax.paye,
    nssf: nssfAmount,
    shif: shifAmount,
    housing_levy: ahl.employee,
    total_deductions: totalDeductions,
    net,
    employer_cost: money(new Decimal(gross).plus(sum(employerLines.map((l) => l.amount)))),
    warnings,
  };
}
