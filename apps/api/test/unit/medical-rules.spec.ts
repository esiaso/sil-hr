import { balance, carryOver, claimSplit, contribution, crossed, pickRule, schemeYear, type LedgerRow } from '../../src/modules/medical/medical.rules';

const row = (id: string, entryType: LedgerRow['entryType'], amount: string, extra: Partial<LedgerRow> = {}): LedgerRow => ({ id, entryType, amount, reversesId: null, holdId: null, expiresOn: null, ...extra });

describe('scheme years', () => {
  it('a January scheme year is the calendar year', () => expect(schemeYear('2026-11-15', 1)).toEqual({ year: 2026, start: '2026-01-01', end: '2026-12-31' }));
  it('a July scheme year runs July to June and is named by its first year', () => {
    expect(schemeYear('2026-03-10', 7)).toEqual({ year: 2025, start: '2025-07-01', end: '2026-06-30' });
    expect(schemeYear('2026-07-01', 7).year).toBe(2026);
  });
});

describe('which limit applies', () => {
  const rules = [
    { id: 'default', jobGradeId: null, employmentType: null, effectiveFrom: '2026-01-01', effectiveTo: null },
    { id: 'contract', jobGradeId: null, employmentType: 'contract', effectiveFrom: '2026-01-01', effectiveTo: null },
    { id: 'g1', jobGradeId: 'G1', employmentType: null, effectiveFrom: '2026-01-01', effectiveTo: null },
    { id: 'g1-old', jobGradeId: 'G1', employmentType: null, effectiveFrom: '2025-01-01', effectiveTo: '2025-12-31' },
  ];
  it('grade beats employment type, which beats the default', () => {
    expect(pickRule(rules, { jobGradeId: 'G1', employmentType: 'contract' }, '2026-05-01')?.id).toBe('g1');
    expect(pickRule(rules, { jobGradeId: 'G9', employmentType: 'contract' }, '2026-05-01')?.id).toBe('contract');
    expect(pickRule(rules, { jobGradeId: null, employmentType: 'permanent' }, '2026-05-01')?.id).toBe('default');
  });
  it('dated: last year used last year’s rule', () => {
    expect(pickRule(rules, { jobGradeId: 'G1', employmentType: 'permanent' }, '2025-06-01')?.id).toBe('g1-old');
    expect(pickRule(rules.slice(2), { jobGradeId: 'G2', employmentType: 'permanent' }, '2026-06-01')).toBeNull();
  });
});

describe('claims', () => {
  it('co-payment: a 10% co-pay on KES 5,000 is 4,500 to the scheme and 500 to the member', () => expect(claimSplit('5000', '10', null)).toEqual({ scheme: '4500.00', member: '500.00' }));
  it('per-visit cap: the scheme pays at most the cap', () => expect(claimSplit('12000', '0', '8000')).toEqual({ scheme: '8000.00', member: '4000.00' }));
});

describe('balance from the ledger', () => {
  const today = '2026-06-15';
  it('limit + top-up + carry-over − claims + reversals − active holds', () => {
    const b = balance('100000', [
      row('c1', 'claim', '30000'), row('c2', 'claim', '5000'), row('r1', 'reversal', '5000', { reversesId: 'c2' }),
      row('t1', 'top_up', '20000'), row('k1', 'carry_over', '10000'),
      row('h1', 'hold', '15000', { expiresOn: '2026-07-01' }),
      row('h2', 'hold', '9000', { expiresOn: '2026-07-01' }), row('hr2', 'hold_release', '9000', { holdId: 'h2' }),
      row('h3', 'hold', '4000', { expiresOn: '2026-06-01' }),
    ], today);
    // total 130,000; used 30,000; held 15,000 (h2 released, h3 expired)
    expect(b).toEqual({ limit: '100000.00', top_ups: '20000.00', carried_over: '10000.00', used: '30000.00', held: '15000.00', remaining: '85000.00', utilisation_pct: 34.6 });
  });
  it('an adjustment can give back or take away', () => {
    expect(balance('50000', [row('c', 'claim', '10000'), row('a', 'adjustment', '-2500')], today).remaining).toBe('42500.00');
  });
  it('80% and 100% thresholds', () => {
    expect(crossed(70, 85)).toEqual([80]);
    expect(crossed(70, 100)).toEqual([80, 100]);
    expect(crossed(85, 90)).toEqual([]);
  });
});

describe('carry-over and contributions', () => {
  it('carries what is left, up to the cap', () => {
    expect(carryOver('30000', '100000', '25')).toBe('25000.00');
    expect(carryOver('10000', '100000', '25')).toBe('10000.00');
    expect(carryOver('-500', '100000', '25')).toBe('0.00');
  });
  it('fixed or % of basic, plus each dependant', () => {
    expect(contribution({ method: 'fixed', value: '1500', perDependant: '500' }, '80000', 3)).toBe('3000.00');
    expect(contribution({ method: 'percent_basic', value: '2', perDependant: '0' }, '80000', 2)).toBe('1600.00');
  });
});
