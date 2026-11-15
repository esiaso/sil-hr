/**
 * Pure attendance rules: turning a shift, a date and raw punches into one day's record.
 * Unit-tested with worked examples (night shifts, grace, half days, overtime).
 */
import type { AttendanceStatus } from '@sil/hr-shared';

/** Offset (minutes) of a timezone from UTC at a given instant. */
function offsetMinutes(timeZone: string, instant: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(instant);
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return Math.round((asUtc - instant.getTime()) / 60_000);
}

/** A local wall-clock date and time in `timeZone`, as a UTC instant. */
export function zonedToUtc(date: string, time: string, timeZone: string): Date {
  const [h, m] = time.split(':').map(Number);
  const guess = new Date(`${date}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`);
  const off = offsetMinutes(timeZone, new Date(guess.getTime() - offsetMinutes(timeZone, guess) * 60_000));
  return new Date(guess.getTime() - off * 60_000);
}

/** The local calendar date of an instant in `timeZone`. */
export function localDate(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(instant);
}

export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export interface ShiftDef {
  startTime: string; // HH:MM[:SS]
  endTime: string;
  breakMinutes: number;
  lateGraceMinutes: number;
  earlyLeaveGraceMinutes: number;
}

/** Scheduled start and end of a shift that starts on `workDate` (night shifts end the next day). */
export function scheduleFor(workDate: string, s: Pick<ShiftDef, 'startTime' | 'endTime'>, timeZone: string): { start: Date; end: Date } {
  const start = zonedToUtc(workDate, s.startTime.slice(0, 5), timeZone);
  const endDate = s.endTime.slice(0, 5) <= s.startTime.slice(0, 5) ? addDays(workDate, 1) : workDate;
  return { start, end: zonedToUtc(endDate, s.endTime.slice(0, 5), timeZone) };
}

export function shiftMinutes(s: Pick<ShiftDef, 'startTime' | 'endTime' | 'breakMinutes'>): number {
  const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  let d = toMin(s.endTime) - toMin(s.startTime);
  if (d <= 0) d += 24 * 60;
  return d - s.breakMinutes;
}

/** Punches that belong to a shift: from 4 hours before it starts to 6 hours after it ends. */
export const WINDOW_BEFORE_MIN = 4 * 60;
export const WINDOW_AFTER_MIN = 6 * 60;

export interface Punch {
  at: Date;
  direction: 'in' | 'out' | 'unknown';
}

export interface DayInput {
  schedule: { start: Date; end: Date } | null;
  shift: ShiftDef | null;
  punches: Punch[];
  dayType: 'normal' | 'rest_day' | 'public_holiday';
  /** Approved leave covering the day: 1 = full day, 0.5 = half. */
  leave: 0 | 0.5 | 1;
  halfDayMinMinutes: number;
  overtimeMinMinutes: number;
}

export interface DayResult {
  firstIn: Date | null;
  lastOut: Date | null;
  workedMinutes: number;
  lateMinutes: number;
  earlyLeaveMinutes: number;
  overtimeMinutes: number;
  status: AttendanceStatus;
}

const mins = (ms: number) => Math.round(ms / 60_000);
/** The shift break is deducted only from a stint longer than this (nobody takes lunch in a 3-hour visit). */
export const BREAK_AFTER_MIN = 5 * 60;

/**
 * One shift-day. Direction is used when the source gives it; devices that report
 * "unknown" are read as first punch = in, last punch = out. Lateness counts from the
 * scheduled start once the grace is exceeded (arriving 31 minutes late with a 30-minute
 * grace is 31 minutes late, not 1). A break is deducted only from stints over 5 hours. Overtime is work beyond the shift end (from the threshold on);
 * on rest days and public holidays every worked minute is overtime of that day type.
 */
export function computeDay(i: DayInput): DayResult {
  const sorted = [...i.punches].sort((a, b) => a.at.getTime() - b.at.getTime());
  const ins = sorted.filter((p) => p.direction !== 'out');
  const outs = sorted.filter((p) => p.direction !== 'in');
  const firstIn = ins[0]?.at ?? null;
  let lastOut = outs.length ? outs[outs.length - 1].at : null;
  if (lastOut && firstIn && lastOut.getTime() <= firstIn.getTime()) lastOut = null;
  const empty = { firstIn, lastOut, workedMinutes: 0, lateMinutes: 0, earlyLeaveMinutes: 0, overtimeMinutes: 0 };

  if (i.leave === 1) return { ...empty, status: 'on_leave' };
  if (!firstIn && !lastOut) {
    if (i.dayType === 'public_holiday') return { ...empty, status: 'holiday' };
    if (i.dayType === 'rest_day' || !i.schedule) return { ...empty, status: i.schedule ? 'rest_day' : 'not_scheduled' };
    return { ...empty, status: i.leave === 0.5 ? 'half_day' : 'absent' };
  }
  if (!firstIn || !lastOut) return { ...empty, status: 'incomplete' };

  let worked = mins(lastOut.getTime() - firstIn.getTime());
  if (i.shift && worked > BREAK_AFTER_MIN) worked -= i.shift.breakMinutes;

  if (!i.schedule || i.dayType !== 'normal') {
    return { firstIn, lastOut, workedMinutes: worked, lateMinutes: 0, earlyLeaveMinutes: 0, overtimeMinutes: worked, status: 'present' };
  }
  const lateBy = mins(firstIn.getTime() - i.schedule.start.getTime());
  const late = i.shift && lateBy > i.shift.lateGraceMinutes ? lateBy : 0;
  const earlyBy = mins(i.schedule.end.getTime() - lastOut.getTime());
  const early = i.shift && earlyBy > i.shift.earlyLeaveGraceMinutes ? earlyBy : 0;
  const beyond = mins(lastOut.getTime() - i.schedule.end.getTime());
  const overtime = beyond >= i.overtimeMinMinutes ? beyond : 0;
  let status: AttendanceStatus = late > 0 ? 'late' : 'present';
  if (worked < i.halfDayMinMinutes || i.leave === 0.5) status = 'half_day';
  return { firstIn, lastOut, workedMinutes: worked, lateMinutes: late, earlyLeaveMinutes: early, overtimeMinutes: overtime, status };
}
