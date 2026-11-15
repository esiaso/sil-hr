/**
 * Pure leave rules (no database), unit-tested with worked examples.
 * Dates are `YYYY-MM-DD` strings; weekdays use ISO numbering (1 = Monday … 7 = Sunday).
 */

export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function isoWeekday(date: string): number {
  const w = new Date(`${date}T00:00:00Z`).getUTCDay();
  return w === 0 ? 7 : w;
}

export interface CountInput {
  start: string;
  end: string;
  startHalfDay: boolean;
  endHalfDay: boolean;
  counting: 'working_days' | 'calendar_days';
  workingDays: number[];
  holidays: Map<string, string>;
  /**
   * Per-employee override from the roster (slice 4): true = scheduled to work that day.
   * When given it replaces the working-week rule, so 24/7 staff are counted on their
   * shifts rather than Monday to Friday.
   */
  rostered?: (date: string) => boolean | undefined;
}

export interface CountResult {
  days: number;
  excluded: { date: string; why: string }[];
}

/**
 * Days a request consumes. Working-day leave skips rest days and public holidays (a
 * holiday inside annual leave is not taken from the balance); calendar-day leave
 * (maternity, paternity) counts every day. A half day takes 0.5 off the first or last
 * day, only when that day counts at all.
 */
export function countLeaveDays(i: CountInput): CountResult {
  if (i.end < i.start) throw new Error('end before start');
  const excluded: CountResult['excluded'] = [];
  let days = 0;
  for (let d = i.start; d <= i.end; d = addDays(d, 1)) {
    let counts = true;
    if (i.counting === 'working_days') {
      const roster = i.rostered?.(d);
      if (roster === false || (roster === undefined && !i.workingDays.includes(isoWeekday(d)))) {
        counts = false;
        excluded.push({ date: d, why: roster === false ? 'Not rostered' : 'Rest day' });
      } else if (i.holidays.has(d)) {
        counts = false;
        excluded.push({ date: d, why: i.holidays.get(d)! });
      }
    }
    if (!counts) continue;
    let value = 1;
    if (d === i.start && i.startHalfDay) value -= 0.5;
    if (d === i.end && i.endHalfDay) value -= 0.5;
    days += value;
  }
  return { days, excluded };
}

/** The leave year a date falls in, labelled by the calendar year it starts in. */
export function leaveYearOf(date: string, startMonth: number): number {
  const [y, m] = date.split('-').map(Number);
  return m >= startMonth ? y : y - 1;
}

export function leaveYearBounds(year: number, startMonth: number): { start: string; end: string } {
  const start = `${year}-${String(startMonth).padStart(2, '0')}-01`;
  return { start, end: addDays(`${startMonth === 1 ? year + 1 : year + 1}-${String(startMonth).padStart(2, '0')}-01`, -1) };
}

/** Rounds to the nearest half day (entitlements are granted in halves). */
export function roundHalf(n: number): number {
  return Math.round(n * 2) / 2;
}

function monthsBetween(a: string, b: string): number {
  const [ay, am] = a.split('-').map(Number);
  const [by, bm] = b.split('-').map(Number);
  return (by - ay) * 12 + (bm - am);
}

/**
 * Annual grant for one leave year. Someone hired during the year gets the share of the
 * remaining whole months, counting the hire month if they started by the 15th (e.g. 21
 * days, hired 10 March in a January year: 10/12 × 21 = 17.5).
 */
export function proratedAnnual(entitlement: number, year: number, startMonth: number, hireDate: string): number {
  const { start, end } = leaveYearBounds(year, startMonth);
  if (hireDate > end) return 0;
  if (hireDate <= start) return entitlement;
  const day = Number(hireDate.slice(8, 10));
  const firstMonth = day <= 15 ? hireDate.slice(0, 8) + '01' : addDays(hireDate.slice(0, 8) + '01', 32).slice(0, 8) + '01';
  const months = Math.max(0, 12 - monthsBetween(start, firstMonth));
  return roundHalf((entitlement * months) / 12);
}

/**
 * Monthly accrual: entitlement / 12 for each month of the leave year in which the
 * employee was employed on the 15th and that has ended by `asOf`. Returns the month
 * keys (YYYY-MM) that are due.
 */
export function dueAccrualMonths(year: number, startMonth: number, hireDate: string, exitDate: string | null, asOf: string): string[] {
  const out: string[] = [];
  const { start } = leaveYearBounds(year, startMonth);
  for (let i = 0; i < 12; i++) {
    const first = addDays(start, 0).slice(0, 8) + '01';
    const [y, m] = first.split('-').map(Number);
    const mm = ((m - 1 + i) % 12) + 1;
    const yy = y + Math.floor((m - 1 + i) / 12);
    const key = `${yy}-${String(mm).padStart(2, '0')}`;
    const mid = `${key}-15`;
    const monthEnd = addDays(`${mm === 12 ? yy + 1 : yy}-${String((mm % 12) + 1).padStart(2, '0')}-01`, -1);
    if (monthEnd > asOf) break;
    if (hireDate <= mid && (!exitDate || exitDate >= mid)) out.push(key);
  }
  return out;
}

/** How much of last year's balance carries over: never more than the cap, never negative. */
export function carryForward(balance: number, cap: number): number {
  return Math.max(0, Math.min(balance, cap));
}
