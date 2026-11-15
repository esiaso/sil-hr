import { calculatePayslip, compileFormula, type CalcInput, type CalcItem } from '../../src/modules/payroll/payroll.calc';
import { seedTablesOn } from '../../src/modules/payroll/payroll.defaults';
import { housingLevy, nssf, paye, shif, taxOnBands, validateTable } from '../../src/modules/payroll/payroll.statutory';

const FEB26 = seedTablesOn('2026-02-28'); // NSSF year 4
const JAN26 = seedTablesOn('2026-01-31'); // NSSF year 3

const input = (basic: number, more: Partial<CalcInput> = {}): CalcInput => ({
  basicMonthly: basic, paidUnits: 22, totalUnits: 22, unpaidLeaveDays: 0, monthlyHours: 195, items: [], overtime: [], loans: [], oneOffs: [], tables: FEB26, ...more,
});
const item = (x: Partial<CalcItem> & Pick<CalcItem, 'code' | 'kind'>): CalcItem => ({ name: x.code, method: 'fixed', value: 0, formula: null, taxable: true, pensionable: false, prorate: true, treatment: 'none', ...x });
const line = (r: ReturnType<typeof calculatePayslip>, code: string) => r.lines.find((l) => l.code === code)?.amount;

describe('NSSF (Tier I and Tier II)', () => {
  it('year 4 (from February 2026): KES 100,000 pays 540 + 5,460 = 6,000', () => {
    expect(nssf(100000, FEB26.NSSF)).toEqual({ tier1: 540, tier2: 5460, total: 6000 });
  });
  it('year 4 caps at the upper limit: 540 + 5,940 = 6,480', () => {
    expect(nssf(250000, FEB26.NSSF).total).toBe(6480);
  });
  it('year 3 (January 2026): KES 20,000 pays 480 + 720 = 1,200', () => {
    expect(nssf(20000, JAN26.NSSF)).toEqual({ tier1: 480, tier2: 720, total: 1200 });
  });
  it('below the lower limit only Tier I applies: KES 6,000 pays 360', () => {
    expect(nssf(6000, FEB26.NSSF)).toEqual({ tier1: 360, tier2: 0, total: 360 });
  });
});

describe('SHIF and the Housing Levy', () => {
  it('SHIF is 2.75% of gross: KES 100,000 pays 2,750', () => expect(shif(100000, FEB26.SHIF)).toBe(2750));
  it('SHIF has a KES 300 floor: KES 10,000 would be 275, pays 300', () => expect(shif(10000, FEB26.SHIF)).toBe(300));
  it('SHIF has no cap: KES 1,000,000 pays 27,500', () => expect(shif(1000000, FEB26.SHIF)).toBe(27500));
  it('Housing Levy is 1.5% each side: KES 100,000 → 1,500 + 1,500', () => expect(housingLevy(100000, FEB26.HOUSING_LEVY)).toEqual({ employee: 1500, employer: 1500 }));
});

describe('PAYE bands', () => {
  it('24,000 at 10% is 2,400; the next 8,333 at 25% is 2,083.25', () => {
    expect(taxOnBands(24000, FEB26.PAYE)).toBe(2400);
    expect(taxOnBands(32333, FEB26.PAYE)).toBe(4483.25);
  });
  it('taxable 89,750: 2,400 + 2,083.25 + 57,417 × 30% = 21,708.35', () => expect(taxOnBands(89750, FEB26.PAYE)).toBe(21708.35));
  it('taxable 951,020 reaches the 35% band: 295,140.35', () => {
    // 2,400 + 2,083.25 + 467,667 × 0.30 + 300,000 × 0.325 + 151,020 × 0.35
    expect(taxOnBands(951020, FEB26.PAYE)).toBe(295140.35);
  });
});

describe('worked examples: whole payslips', () => {
  it('KES 100,000 basic, February 2026', () => {
    const r = calculatePayslip(input(100000));
    // NSSF 6,000; SHIF 2,750; Housing Levy 1,500 (all deductible) → allowable 10,250
    // taxable 89,750 → tax 21,708.35 − relief 2,400 = PAYE 19,308.35
    expect(r.gross).toBe(100000);
    expect(r.allowable).toBe(10250);
    expect(r.taxable_pay).toBe(89750);
    expect(r.paye).toBe(19308.35);
    expect(r.total_deductions).toBe(29558.35);
    expect(r.net).toBe(70441.65);
    // employer: NSSF 6,000 + Housing Levy 1,500 + NITA 50
    expect(r.employer_cost).toBe(107550);
    expect(r.warnings).toEqual([]);
  });

  it('KES 20,000 basic, January 2026: below the tax threshold after reliefs', () => {
    const r = calculatePayslip(input(20000, { tables: JAN26 }));
    // NSSF 1,200; SHIF 550; Housing Levy 300; taxable 17,950 → tax 1,795 < relief 2,400 → PAYE 0
    expect([r.nssf, r.shif, r.housing_levy, r.taxable_pay, r.paye]).toEqual([1200, 550, 300, 17950, 0]);
    expect(r.net).toBe(17950);
  });

  it('KES 1,000,000 basic: top band, NSSF capped, SHIF uncapped', () => {
    const r = calculatePayslip(input(1000000));
    // allowable 6,480 + 27,500 + 15,000 = 48,980 → taxable 951,020 → 295,140.35 − 2,400
    expect(r.allowable).toBe(48980);
    expect(r.paye).toBe(292740.35);
    expect(r.net).toBe(658279.65);
  });

  it('allowances: house allowance is taxable but not pensionable', () => {
    const r = calculatePayslip(input(80000, { items: [item({ code: 'HOUSE', kind: 'earning', value: 20000 })] }));
    // gross 100,000, but NSSF on 80,000 pensionable: 540 + 4,260 = 4,800
    expect(r.gross).toBe(100000);
    expect(r.nssf).toBe(4800);
    expect(r.shif).toBe(2750);
    // allowable 4,800 + 2,750 + 1,500 = 9,050 → taxable 90,950
    expect(r.taxable_pay).toBe(90950);
    expect(r.paye).toBeCloseTo(taxOnBands(90950, FEB26.PAYE) - 2400, 2);
  });

  it('pension contributions are deductible with NSSF up to KES 30,000 a month', () => {
    const r = calculatePayslip(input(300000, { items: [item({ code: 'PENSION', kind: 'deduction', value: 40000, treatment: 'pension' })] }));
    // NSSF 6,480 + pension 40,000 = 46,480 → capped at 30,000; + SHIF 8,250 + Housing Levy 4,500
    expect(r.allowable).toBe(42750);
    expect(r.taxable_pay).toBe(257250);
    expect(line(r, 'PENSION')).toBe(40000);
  });

  it('insurance premiums earn 15% relief, at most KES 5,000', () => {
    const small = calculatePayslip(input(100000, { items: [item({ code: 'LIFE', kind: 'deduction', value: 10000, treatment: 'insurance' })] }));
    expect(small.insurance_relief).toBe(1500);
    expect(small.paye).toBe(17808.35);
    const big = calculatePayslip(input(300000, { items: [item({ code: 'LIFE', kind: 'deduction', value: 50000, treatment: 'insurance' })] }));
    expect(big.insurance_relief).toBe(5000);
  });

  it('before December 2024 SHIF was not deductible and earned insurance relief instead', () => {
    const r = calculatePayslip(input(100000, { tables: seedTablesOn('2024-11-30') }));
    // NSSF year 2 on 100,000: 420 + 1,740 = 2,160; SHIF 2,750 and Housing Levy not deductible
    expect(r.nssf).toBe(2160);
    expect(r.allowable).toBe(2160);
    expect(r.taxable_pay).toBe(97840);
    expect(r.insurance_relief).toBe(412.5); // 15% of 2,750
    expect(r.paye).toBeCloseTo(taxOnBands(97840, FEB26.PAYE) - 2400 - 412.5, 2);
  });

  it('a joiner on the 11th of a 22-working-day month is paid 14 of 22 days', () => {
    const r = calculatePayslip(input(66000, { paidUnits: 14, items: [item({ code: 'HOUSE', kind: 'earning', value: 11000 })] }));
    expect(line(r, 'BASIC')).toBe(42000);
    expect(line(r, 'HOUSE')).toBe(7000);
    expect(r.gross).toBe(49000);
  });

  it('unpaid leave comes off at the daily rate, and prorated allowances follow', () => {
    const r = calculatePayslip(input(66000, { unpaidLeaveDays: 2, items: [item({ code: 'HOUSE', kind: 'earning', value: 11000 }), item({ code: 'MEDICAL', kind: 'earning', value: 2200, prorate: false })] }));
    // 66,000 / 22 = 3,000 a day × 2 = 6,000; house 11,000 × 20/22 = 10,000; medical not prorated
    expect(line(r, 'UNPAID_LEAVE')).toBe(-6000);
    expect(line(r, 'HOUSE')).toBe(10000);
    expect(r.gross).toBe(60000 + 10000 + 2200);
  });

  it('overtime is the hourly rate (basic ÷ monthly hours) × hours × multiplier', () => {
    const r = calculatePayslip(input(78000, { monthlyHours: 195, overtime: [{ dayType: 'normal', minutes: 600, multiplier: 1.5 }, { dayType: 'public_holiday', minutes: 480, multiplier: 2 }] }));
    // 78,000 / 195 = 400 an hour; 10 h × 1.5 = 6,000; 8 h × 2 = 6,400
    expect(line(r, 'OT_NORMAL')).toBe(6000);
    expect(line(r, 'OT_PUBLIC_HOLIDAY')).toBe(6400);
    expect(r.gross).toBe(90400);
  });

  it('loans deduct the instalment, never more than the balance', () => {
    const r = calculatePayslip(input(100000, { loans: [{ loanId: 'a', code: 'LOAN', name: 'Staff loan', installment: 5000, balance: 3200 }] }));
    expect(line(r, 'LOAN')).toBe(3200);
    expect(r.net).toBe(67241.65);
  });

  it('one-off bonus and recovery', () => {
    const r = calculatePayslip(input(100000, { oneOffs: [
      { code: 'BONUS', name: 'Bonus', kind: 'earning', amount: 10000, taxable: true, pensionable: false, treatment: 'none', note: null },
      { code: 'RECOVERY', name: 'Overpayment recovery', kind: 'deduction', amount: 2000, taxable: false, pensionable: false, treatment: 'none', note: 'October' },
    ] }));
    expect(r.gross).toBe(110000);
    expect(r.nssf).toBe(6000); // the bonus is not pensionable here
    expect(r.shif).toBe(3025);
  });

  it('warns when deductions exceed two-thirds of pay', () => {
    const r = calculatePayslip(input(30000, { items: [item({ code: 'SACCO', kind: 'deduction', value: 20000 })] }));
    expect(r.warnings).toContain('Deductions exceed two-thirds of gross pay (Employment Act s.19(3))');
  });

  it('percentage and formula components', () => {
    const r = calculatePayslip(input(100000, { items: [
      item({ code: 'HOUSE', kind: 'earning', method: 'percent_basic', value: 15 }),
      item({ code: 'RISK', kind: 'earning', method: 'formula', formula: 'min(basic * 0.05, 4000)' }),
      item({ code: 'WELFARE', kind: 'deduction', method: 'percent_gross', value: 1 }),
    ] }));
    expect(line(r, 'HOUSE')).toBe(15000);
    expect(line(r, 'RISK')).toBe(4000);
    expect(line(r, 'WELFARE')).toBe(1190);
  });
});

describe('formulas', () => {
  it('evaluates arithmetic, brackets and functions', () => {
    expect(compileFormula('(basic + 1000) * 2 / 4 - round(2.5)')({ basic: 3000 })).toBe(1997);
    expect(compileFormula('max(0, basic - 50000) * 0.1')({ basic: 60000 })).toBe(1000);
  });
  it('refuses unknown names and junk', () => {
    expect(() => compileFormula('salary * 2')).toThrow('Unknown name "salary"');
    expect(() => compileFormula('basic * (2')).toThrow('Expected ")"');
    expect(() => compileFormula('process.exit()')).toThrow();
  });
});

describe('editing a table', () => {
  it('catches bands that do not increase and a missing top band', () => {
    expect(validateTable('PAYE', { bands: [{ upto: 30000, rate: 0.1 }, { upto: 20000, rate: 0.25 }], personal_relief: 2400, insurance_relief_rate: 0.15, insurance_relief_cap: 5000 })).toEqual(['bands.1.upto: increasing amounts', 'bands: the last band has no upper limit (upto: null)']);
    expect(validateTable('NSSF', { rate: 0.06, lel: 9000, uel: 108000 })).toEqual([]);
    expect(validateTable('NSSF', { rate: 6, lel: 9000, uel: 100 })).toHaveLength(2);
  });
  it('a PAYE input with all reliefs', () => {
    const r = paye({ taxableEarnings: 150000, nssf: 6480, pensionContributions: 0, shif: 4125, housingLevy: 2250, mortgageInterest: 40000, postRetirementMedical: 0, insurancePremiums: 0 }, FEB26);
    // mortgage interest capped at 30,000 → allowable 42,855
    expect(r.allowable).toBe(42855);
    expect(r.taxablePay).toBe(107145);
  });
});
