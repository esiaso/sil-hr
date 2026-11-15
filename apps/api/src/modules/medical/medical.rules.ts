import Decimal from 'decimal.js';

/**
 * Pure rules for the medical scheme: scheme years, which limit rule applies to a person,
 * what a claim costs the scheme, and the balance of a limit from its ledger. Money is
 * handled in decimal.js and returned as two-decimal strings.
 */

const m2 = (x: Decimal.Value) => new Decimal(x).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);

/** The scheme year a date falls in, named by the calendar year it starts in, with its bounds. */
export function schemeYear(date: string, startMonth: number): { year: number; start: string; end: string } {
  const y = Number(date.slice(0, 4));
  const mo = Number(date.slice(5, 7));
  const year = mo >= startMonth ? y : y - 1;
  const start = `${year}-${String(startMonth).padStart(2, '0')}-01`;
  const endD = new Date(Date.UTC(year + 1, startMonth - 1, 0));
  return { year, start, end: endD.toISOString().slice(0, 10) };
}

export interface RuleLike { jobGradeId: string | null; employmentType: string | null; effectiveFrom: string; effectiveTo: string | null }

/**
 * The most specific rule in force on a date: grade and employment type, then grade, then
 * employment type, then the default (neither).
 */
export function pickRule<T extends RuleLike>(rules: T[], who: { jobGradeId: string | null; employmentType: string }, date: string): T | null {
  const live = rules.filter((r) => r.effectiveFrom <= date && (!r.effectiveTo || r.effectiveTo >= date));
  const score = (r: T) => {
    if (r.jobGradeId && r.jobGradeId !== who.jobGradeId) return -1;
    if (r.employmentType && r.employmentType !== who.employmentType) return -1;
    return (r.jobGradeId ? 2 : 0) + (r.employmentType ? 1 : 0);
  };
  let best: T | null = null;
  let bestScore = -1;
  for (const r of live) {
    const s = score(r);
    if (s > bestScore) { best = r; bestScore = s; }
  }
  return best;
}

/**
 * What the scheme pays for an invoice: the invoice less the member's co-payment, at most
 * the per-visit cap. The member pays the rest at the facility.
 */
export function claimSplit(invoice: Decimal.Value, coPayPct: Decimal.Value, perVisitCap: Decimal.Value | null): { scheme: string; member: string } {
  const inv = new Decimal(invoice);
  let scheme = inv.mul(new Decimal(100).minus(coPayPct)).div(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  if (perVisitCap !== null && scheme.gt(perVisitCap)) scheme = new Decimal(perVisitCap);
  return { scheme: m2(scheme), member: m2(inv.minus(scheme)) };
}

export interface LedgerRow { id: string; entryType: 'claim' | 'reversal' | 'adjustment' | 'top_up' | 'carry_over' | 'hold' | 'hold_release'; amount: string; reversesId: string | null; holdId: string | null; expiresOn: string | null }

export interface Balance {
  limit: string;
  top_ups: string;
  carried_over: string;
  used: string;
  held: string;
  remaining: string;
  /** Used plus held, as a share of the whole limit (0–100+). */
  utilisation_pct: number;
}

/**
 * The balance of one limit for one scheme year: base limit + top-ups + carry-over − used
 * (claims − reversals ± adjustments) − active holds. A hold is active until it is released
 * (claimed, cancelled or expired) or its date passes.
 */
export function balance(base: Decimal.Value, rows: LedgerRow[], today: string): Balance {
  let topUps = new Decimal(0), carried = new Decimal(0), used = new Decimal(0), held = new Decimal(0);
  const released = new Set(rows.filter((r) => r.entryType === 'hold_release').map((r) => r.holdId));
  for (const r of rows) {
    const a = new Decimal(r.amount);
    switch (r.entryType) {
      case 'claim': used = used.plus(a); break;
      case 'reversal': used = used.minus(a); break;
      case 'adjustment': used = used.plus(a); break;
      case 'top_up': topUps = topUps.plus(a); break;
      case 'carry_over': carried = carried.plus(a); break;
      case 'hold': if (!released.has(r.id) && (!r.expiresOn || r.expiresOn >= today)) held = held.plus(a); break;
      default: break;
    }
  }
  const total = new Decimal(base).plus(topUps).plus(carried);
  const remaining = total.minus(used).minus(held);
  const pct = total.gt(0) ? used.plus(held).div(total).mul(100).toDecimalPlaces(1).toNumber() : used.plus(held).gt(0) ? 100 : 0;
  return { limit: m2(base), top_ups: m2(topUps), carried_over: m2(carried), used: m2(used), held: m2(held), remaining: m2(remaining), utilisation_pct: pct };
}

/** Thresholds crossed when utilisation moves from `before` to `after` (in percent). */
export function crossed(before: number, after: number, thresholds = [80, 100]): number[] {
  return thresholds.filter((t) => before < t && after >= t);
}

/** Carry-over into the next year: what was left, at most the cap's share of the year's limit. */
export function carryOver(remaining: Decimal.Value, yearLimit: Decimal.Value, maxPct: Decimal.Value): string {
  const r = Decimal.max(0, remaining);
  return m2(Decimal.min(r, new Decimal(yearLimit).mul(maxPct).div(100)));
}

/** Monthly staff contribution: fixed or a percentage of basic, plus an amount per covered dependant. */
export function contribution(rate: { method: 'fixed' | 'percent_basic'; value: Decimal.Value; perDependant: Decimal.Value }, basic: Decimal.Value, dependants: number): string {
  const main = rate.method === 'fixed' ? new Decimal(rate.value) : new Decimal(basic).mul(rate.value).div(100);
  return m2(main.plus(new Decimal(rate.perDependant).mul(dependants)));
}
