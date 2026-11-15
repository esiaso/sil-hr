import { carryForward, countLeaveDays, dueAccrualMonths, leaveYearBounds, leaveYearOf, proratedAnnual } from '../../src/modules/leave/leave.rules';

const MON_FRI = [1, 2, 3, 4, 5];
const KENYA_DEC = new Map([['2026-12-12', 'Jamhuri Day'], ['2026-12-25', 'Christmas Day'], ['2026-12-26', 'Boxing Day']]);

describe('leave day counting (worked examples)', () => {
  it('Mon 21 Dec to Thu 31 Dec 2026, working days: 9 weekdays minus Christmas = 8', () => {
    const r = countLeaveDays({ start: '2026-12-21', end: '2026-12-31', startHalfDay: false, endHalfDay: false, counting: 'working_days', workingDays: MON_FRI, holidays: KENYA_DEC });
    expect(r.days).toBe(8);
    // Boxing Day 2026 falls on a Saturday, so it is a rest day anyway.
    expect(r.excluded.map((e) => e.why)).toEqual(['Christmas Day', 'Rest day', 'Rest day']);
  });

  it('a weekend-only request takes nothing; a holiday on a Saturday changes nothing', () => {
    expect(countLeaveDays({ start: '2026-12-12', end: '2026-12-13', startHalfDay: false, endHalfDay: false, counting: 'working_days', workingDays: MON_FRI, holidays: KENYA_DEC }).days).toBe(0);
  });

  it('half days: Wednesday afternoon to Friday morning is 2 days', () => {
    expect(countLeaveDays({ start: '2026-11-18', end: '2026-11-20', startHalfDay: true, endHalfDay: true, counting: 'working_days', workingDays: MON_FRI, holidays: new Map() }).days).toBe(2);
  });

  it('a half day on a rest day costs nothing', () => {
    expect(countLeaveDays({ start: '2026-11-20', end: '2026-11-21', startHalfDay: false, endHalfDay: true, counting: 'working_days', workingDays: MON_FRI, holidays: new Map() }).days).toBe(1);
  });

  it('calendar-day leave (maternity) counts weekends and holidays: 90 days', () => {
    expect(countLeaveDays({ start: '2026-12-01', end: '2027-02-28', startHalfDay: false, endHalfDay: false, counting: 'calendar_days', workingDays: MON_FRI, holidays: KENYA_DEC }).days).toBe(90);
  });

  it('a six-day week (Mon–Sat) counts Saturdays', () => {
    expect(countLeaveDays({ start: '2026-11-16', end: '2026-11-22', startHalfDay: false, endHalfDay: false, counting: 'working_days', workingDays: [1, 2, 3, 4, 5, 6], holidays: new Map() }).days).toBe(6);
  });

  it('a roster overrides the working week for 24/7 staff', () => {
    const shifts = new Set(['2026-11-21', '2026-11-22']); // weekend nurse
    const r = countLeaveDays({ start: '2026-11-16', end: '2026-11-22', startHalfDay: false, endHalfDay: false, counting: 'working_days', workingDays: MON_FRI, holidays: new Map(), rostered: (d) => shifts.has(d) });
    expect(r.days).toBe(2);
  });
});

describe('leave years', () => {
  it('January year is the calendar year; a July year is labelled by its start', () => {
    expect(leaveYearOf('2026-03-10', 1)).toBe(2026);
    expect(leaveYearOf('2026-03-10', 7)).toBe(2025);
    expect(leaveYearOf('2026-07-01', 7)).toBe(2026);
    expect(leaveYearBounds(2026, 7)).toEqual({ start: '2026-07-01', end: '2027-06-30' });
    expect(leaveYearBounds(2026, 1)).toEqual({ start: '2026-01-01', end: '2026-12-31' });
  });
});

describe('accrual and carry-forward (worked examples)', () => {
  it('21 days, hired 10 March 2026 (January year): 10 months → 17.5 days', () => {
    expect(proratedAnnual(21, 2026, 1, '2026-03-10')).toBe(17.5);
  });
  it('hired 20 March: March does not count → 9 months → 15.75 rounds to 16', () => {
    expect(proratedAnnual(21, 2026, 1, '2026-03-20')).toBe(16);
  });
  it('hired before the year: full entitlement; hired after it: none', () => {
    expect(proratedAnnual(21, 2026, 1, '2019-05-01')).toBe(21);
    expect(proratedAnnual(21, 2026, 1, '2027-01-02')).toBe(0);
  });
  it('monthly accrual: months ended by the date, employed on the 15th', () => {
    expect(dueAccrualMonths(2026, 1, '2020-01-01', null, '2026-03-31')).toEqual(['2026-01', '2026-02', '2026-03']);
    expect(dueAccrualMonths(2026, 1, '2026-02-20', null, '2026-04-30')).toEqual(['2026-03', '2026-04']);
    expect(dueAccrualMonths(2026, 1, '2020-01-01', '2026-02-10', '2026-12-31')).toEqual(['2026-01']);
  });
  it('carry-forward is capped and never negative', () => {
    expect(carryForward(14.5, 10)).toBe(10);
    expect(carryForward(3, 10)).toBe(3);
    expect(carryForward(-2, 10)).toBe(0);
  });
});
