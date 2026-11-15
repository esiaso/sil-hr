import { computeDay, localDate, scheduleFor, shiftMinutes, zonedToUtc, type ShiftDef } from '../../src/modules/attendance/attendance.rules';

const TZ = 'Africa/Nairobi'; // UTC+3, no daylight saving
const DAY: ShiftDef = { startTime: '07:00', endTime: '19:00', breakMinutes: 60, lateGraceMinutes: 30, earlyLeaveGraceMinutes: 0 };
const NIGHT: ShiftDef = { startTime: '19:00', endTime: '07:00', breakMinutes: 60, lateGraceMinutes: 30, earlyLeaveGraceMinutes: 0 };
const OFFICE: ShiftDef = { startTime: '08:00', endTime: '17:00', breakMinutes: 60, lateGraceMinutes: 30, earlyLeaveGraceMinutes: 0 };
const at = (iso: string) => new Date(iso);
const base = { dayType: 'normal' as const, leave: 0 as const, halfDayMinMinutes: 240, overtimeMinMinutes: 30 };

describe('time zones and schedules', () => {
  it('08:00 in Nairobi is 05:00 UTC; the local date of 23:30 UTC is the next day', () => {
    expect(zonedToUtc('2026-11-16', '08:00', TZ).toISOString()).toBe('2026-11-16T05:00:00.000Z');
    expect(localDate(at('2026-11-16T23:30:00Z'), TZ)).toBe('2026-11-17');
  });
  it('a night shift starting Monday ends Tuesday morning', () => {
    const s = scheduleFor('2026-11-16', NIGHT, TZ);
    expect(s.start.toISOString()).toBe('2026-11-16T16:00:00.000Z');
    expect(s.end.toISOString()).toBe('2026-11-17T04:00:00.000Z');
    expect(shiftMinutes(NIGHT)).toBe(11 * 60);
  });
});

describe('a day from punches (worked examples)', () => {
  const office = scheduleFor('2026-11-16', OFFICE, TZ);

  it('on time: in 07:55, out 17:05 → present, 8h10m worked (after 60 min break), no overtime under 30 min', () => {
    const r = computeDay({ ...base, schedule: office, shift: OFFICE, punches: [{ at: at('2026-11-16T04:55:00Z'), direction: 'in' }, { at: at('2026-11-16T14:05:00Z'), direction: 'out' }] });
    expect(r).toMatchObject({ status: 'present', workedMinutes: 490, lateMinutes: 0, overtimeMinutes: 0 });
  });

  it('inside the 30-minute grace: in 08:29 → present', () => {
    const r = computeDay({ ...base, schedule: office, shift: OFFICE, punches: [{ at: at('2026-11-16T05:29:00Z'), direction: 'in' }, { at: at('2026-11-16T14:00:00Z'), direction: 'out' }] });
    expect(r.status).toBe('present');
    expect(r.lateMinutes).toBe(0);
  });

  it('past the grace: in 08:31 → late by 31 minutes', () => {
    const r = computeDay({ ...base, schedule: office, shift: OFFICE, punches: [{ at: at('2026-11-16T05:31:00Z'), direction: 'in' }, { at: at('2026-11-16T14:00:00Z'), direction: 'out' }] });
    expect(r).toMatchObject({ status: 'late', lateMinutes: 31 });
  });

  it('leaves at 15:00 → 2 hours early; under 4 hours worked → half day', () => {
    const early = computeDay({ ...base, schedule: office, shift: OFFICE, punches: [{ at: at('2026-11-16T05:00:00Z'), direction: 'in' }, { at: at('2026-11-16T12:00:00Z'), direction: 'out' }] });
    expect(early).toMatchObject({ earlyLeaveMinutes: 120, status: 'present' });
    const half = computeDay({ ...base, schedule: office, shift: OFFICE, punches: [{ at: at('2026-11-16T05:00:00Z'), direction: 'in' }, { at: at('2026-11-16T08:00:00Z'), direction: 'out' }] });
    expect(half).toMatchObject({ status: 'half_day', workedMinutes: 180 });
  });

  it('stays until 18:30 → 90 minutes overtime on a normal day', () => {
    const r = computeDay({ ...base, schedule: office, shift: OFFICE, punches: [{ at: at('2026-11-16T05:00:00Z'), direction: 'in' }, { at: at('2026-11-16T15:30:00Z'), direction: 'out' }] });
    expect(r.overtimeMinutes).toBe(90);
  });

  it('night shift: in 18:50 Monday, out 07:10 Tuesday (device gives no direction) → present, 11h20m', () => {
    const night = scheduleFor('2026-11-16', NIGHT, TZ);
    const r = computeDay({ ...base, schedule: night, shift: NIGHT, punches: [{ at: at('2026-11-16T15:50:00Z'), direction: 'unknown' }, { at: at('2026-11-17T04:10:00Z'), direction: 'unknown' }] });
    expect(r).toMatchObject({ status: 'present', workedMinutes: 680, lateMinutes: 0 });
  });

  it('no punches: absent on a working day; rest day / holiday otherwise; approved leave wins', () => {
    const day = scheduleFor('2026-11-16', DAY, TZ);
    expect(computeDay({ ...base, schedule: day, shift: DAY, punches: [] }).status).toBe('absent');
    expect(computeDay({ ...base, dayType: 'public_holiday', schedule: day, shift: DAY, punches: [] }).status).toBe('holiday');
    expect(computeDay({ ...base, leave: 1, schedule: day, shift: DAY, punches: [] }).status).toBe('on_leave');
    expect(computeDay({ ...base, schedule: null, shift: null, punches: [] }).status).toBe('not_scheduled');
  });

  it('a single punch is incomplete (needs a regularisation)', () => {
    expect(computeDay({ ...base, schedule: office, shift: OFFICE, punches: [{ at: at('2026-11-16T05:00:00Z'), direction: 'in' }] }).status).toBe('incomplete');
  });

  it('working a public holiday: every minute is overtime of that day type', () => {
    const r = computeDay({ ...base, dayType: 'public_holiday', schedule: office, shift: OFFICE, punches: [{ at: at('2026-11-16T05:00:00Z'), direction: 'in' }, { at: at('2026-11-16T09:00:00Z'), direction: 'out' }] });
    expect(r).toMatchObject({ status: 'present', workedMinutes: 240, overtimeMinutes: 240 });
  });
});
