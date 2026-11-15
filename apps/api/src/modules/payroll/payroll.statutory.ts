import Decimal from 'decimal.js';

/**
 * Kenyan statutory deductions, driven entirely by effective-dated rate tables
 * (`statutory_rate` rows; seeded, editable under Payroll → Setup). Nothing here knows a
 * rate: change the table and the next calculation follows it. All money is KES with two
 * decimals, rounded half-up per line.
 */

export interface PayeTable {
  /** Monthly bands; `upto` null is the top band. */
  bands: { upto: number | null; rate: number }[];
  personal_relief: number;
  /** Relief on insurance premiums (life, education, and SHIF while it is not deductible). */
  insurance_relief_rate: number;
  insurance_relief_cap: number;
}
export interface NssfTable {
  rate: number;
  /** Lower earnings limit: Tier I is charged on pensionable pay up to it. */
  lel: number;
  /** Upper earnings limit: Tier II is charged between the two limits. */
  uel: number;
}
export interface ShifTable {
  rate: number;
  minimum: number;
  /** Deductible from taxable pay (from December 2024). Otherwise it earns insurance relief. */
  deductible: boolean;
}
export interface HousingLevyTable {
  employee_rate: number;
  employer_rate: number;
  deductible: boolean;
}
export interface NitaTable {
  /** Employer only, per employee per month. */
  employer_amount: number;
}
export interface AllowableTable {
  /** Pension contributions (NSSF + registered schemes) deductible per month. */
  pension_cap: number;
  mortgage_interest_cap: number;
  post_retirement_medical_cap: number;
}

export interface StatutoryTables {
  PAYE: PayeTable;
  NSSF: NssfTable;
  SHIF: ShifTable;
  HOUSING_LEVY: HousingLevyTable;
  NITA: NitaTable;
  ALLOWABLE: AllowableTable;
}
export type StatutoryCode = keyof StatutoryTables;
export const STATUTORY_CODES: StatutoryCode[] = ['PAYE', 'NSSF', 'SHIF', 'HOUSING_LEVY', 'NITA', 'ALLOWABLE'];

export const money = (x: Decimal.Value): number => new Decimal(x).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toNumber();
const D = (x: Decimal.Value) => new Decimal(x);

/** Tier I and Tier II on pensionable pay; the employer matches. */
export function nssf(pensionable: number, t: NssfTable): { tier1: number; tier2: number; total: number } {
  const p = Decimal.max(0, pensionable);
  const tier1 = D(t.rate).mul(Decimal.min(p, t.lel));
  const tier2 = D(t.rate).mul(Decimal.max(0, Decimal.min(p, t.uel).minus(t.lel)));
  return { tier1: money(tier1), tier2: money(tier2), total: money(tier1.plus(tier2)) };
}

/** 2.75% of gross with a floor; no cap. Nothing is due on zero pay. */
export function shif(gross: number, t: ShifTable): number {
  if (gross <= 0) return 0;
  return money(Decimal.max(t.minimum, D(gross).mul(t.rate)));
}

export function housingLevy(gross: number, t: HousingLevyTable): { employee: number; employer: number } {
  const g = Decimal.max(0, gross);
  return { employee: money(g.mul(t.employee_rate)), employer: money(g.mul(t.employer_rate)) };
}

/** Tax on monthly taxable pay before reliefs. */
export function taxOnBands(taxable: number, t: PayeTable): number {
  let remaining = Decimal.max(0, taxable);
  let lower = D(0);
  let tax = D(0);
  for (const b of t.bands) {
    if (remaining.lte(0)) break;
    const width = b.upto === null ? remaining : Decimal.min(remaining, D(b.upto).minus(lower));
    tax = tax.plus(width.mul(b.rate));
    remaining = remaining.minus(width);
    if (b.upto !== null) lower = D(b.upto);
  }
  return money(tax);
}

export interface PayeInput {
  /** Taxable cash earnings plus taxable benefits. */
  taxableEarnings: number;
  nssf: number;
  /** Employee contributions to registered pension or provident schemes. */
  pensionContributions: number;
  shif: number;
  housingLevy: number;
  mortgageInterest: number;
  postRetirementMedical: number;
  /** Life, education and similar premiums that earn insurance relief. */
  insurancePremiums: number;
}
export interface PayeResult {
  allowable: number;
  taxablePay: number;
  taxBeforeRelief: number;
  personalRelief: number;
  insuranceRelief: number;
  paye: number;
}

/**
 * Taxable pay = taxable earnings − allowable deductions (pension incl. NSSF up to the cap,
 * SHIF and the Housing Levy when deductible, mortgage interest and PRMF up to their caps).
 * PAYE = tax on the bands − personal relief − insurance relief, never below zero.
 */
export function paye(i: PayeInput, t: StatutoryTables): PayeResult {
  const pension = Decimal.min(D(i.nssf).plus(i.pensionContributions), t.ALLOWABLE.pension_cap);
  const allowable = pension
    .plus(t.SHIF.deductible ? i.shif : 0)
    .plus(t.HOUSING_LEVY.deductible ? i.housingLevy : 0)
    .plus(Decimal.min(i.mortgageInterest, t.ALLOWABLE.mortgage_interest_cap))
    .plus(Decimal.min(i.postRetirementMedical, t.ALLOWABLE.post_retirement_medical_cap));
  const taxablePay = Decimal.max(0, D(i.taxableEarnings).minus(allowable));
  const taxBeforeRelief = taxOnBands(taxablePay.toNumber(), t.PAYE);
  const insuranceBase = D(i.insurancePremiums).plus(t.SHIF.deductible ? 0 : i.shif);
  const insuranceRelief = money(Decimal.min(insuranceBase.mul(t.PAYE.insurance_relief_rate), t.PAYE.insurance_relief_cap));
  const personalRelief = t.PAYE.personal_relief;
  const due = Decimal.max(0, D(taxBeforeRelief).minus(personalRelief).minus(insuranceRelief));
  return { allowable: money(allowable), taxablePay: money(taxablePay), taxBeforeRelief, personalRelief, insuranceRelief, paye: money(due) };
}

/** Basic sanity on an edited table, so a typo cannot reach a payroll. */
export function validateTable(code: StatutoryCode, p: Record<string, unknown>): string[] {
  const errs: string[] = [];
  const num = (k: string, min = 0, max = Number.MAX_SAFE_INTEGER) => {
    const v = p[k];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) errs.push(`${k}: a number from ${min} to ${max}`);
  };
  const bool = (k: string) => typeof p[k] !== 'boolean' && errs.push(`${k}: true or false`);
  switch (code) {
    case 'PAYE': {
      const bands = p.bands as { upto: number | null; rate: number }[] | undefined;
      if (!Array.isArray(bands) || !bands.length) errs.push('bands: at least one band');
      else {
        bands.forEach((b, i) => {
          if (typeof b?.rate !== 'number' || b.rate < 0 || b.rate > 1) errs.push(`bands.${i}.rate: a fraction from 0 to 1`);
          if (b.upto !== null && (typeof b.upto !== 'number' || (i > 0 && b.upto <= (bands[i - 1].upto ?? 0)))) errs.push(`bands.${i}.upto: increasing amounts`);
        });
        if (bands[bands.length - 1].upto !== null) errs.push('bands: the last band has no upper limit (upto: null)');
      }
      num('personal_relief');
      num('insurance_relief_rate', 0, 1);
      num('insurance_relief_cap');
      break;
    }
    case 'NSSF':
      num('rate', 0, 1);
      num('lel');
      num('uel');
      if (typeof p.lel === 'number' && typeof p.uel === 'number' && p.uel < p.lel) errs.push('uel: at least the lower limit');
      break;
    case 'SHIF':
      num('rate', 0, 1);
      num('minimum');
      bool('deductible');
      break;
    case 'HOUSING_LEVY':
      num('employee_rate', 0, 1);
      num('employer_rate', 0, 1);
      bool('deductible');
      break;
    case 'NITA':
      num('employer_amount');
      break;
    case 'ALLOWABLE':
      num('pension_cap');
      num('mortgage_interest_cap');
      num('post_retirement_medical_cap');
      break;
  }
  return errs;
}
