import type { StatutoryCode, StatutoryTables } from './payroll.statutory';

/**
 * Starting rate tables. Checked on 15 November 2026 against the KRA PAYE rates (unchanged by
 * the Finance Act 2026), the NSSF Act 2013 phase-in notice for Year 4 (February 2026), the
 * Social Health Insurance Act 2023 and the Affordable Housing Act 2024, with the
 * deductibility of SHIF and the Housing Levy from the Tax Laws (Amendment) Act 2024.
 * They are rows in `statutory_rate`, editable under Payroll → Setup; check them every year.
 */
export const STATUTORY_SEED: { code: StatutoryCode; effective_from: string; effective_to: string | null; params: StatutoryTables[StatutoryCode]; source: string }[] = [
  {
    code: 'PAYE', effective_from: '2023-07-01', effective_to: null, source: 'Income Tax Act, Third Schedule (Finance Act 2023); KRA',
    params: { bands: [{ upto: 24000, rate: 0.1 }, { upto: 32333, rate: 0.25 }, { upto: 500000, rate: 0.3 }, { upto: 800000, rate: 0.325 }, { upto: null, rate: 0.35 }], personal_relief: 2400, insurance_relief_rate: 0.15, insurance_relief_cap: 5000 },
  },
  { code: 'NSSF', effective_from: '2024-02-01', effective_to: '2025-01-31', source: 'NSSF Act 2013, year 2', params: { rate: 0.06, lel: 7000, uel: 36000 } },
  { code: 'NSSF', effective_from: '2025-02-01', effective_to: '2026-01-31', source: 'NSSF Act 2013, year 3', params: { rate: 0.06, lel: 8000, uel: 72000 } },
  { code: 'NSSF', effective_from: '2026-02-01', effective_to: null, source: 'NSSF Act 2013, year 4 (notice to employers, February 2026)', params: { rate: 0.06, lel: 9000, uel: 108000 } },
  { code: 'SHIF', effective_from: '2024-10-01', effective_to: '2024-11-30', source: 'Social Health Insurance Act 2023', params: { rate: 0.0275, minimum: 300, deductible: false } },
  { code: 'SHIF', effective_from: '2024-12-01', effective_to: null, source: 'Social Health Insurance Act 2023; deductible under the Tax Laws (Amendment) Act 2024', params: { rate: 0.0275, minimum: 300, deductible: true } },
  { code: 'HOUSING_LEVY', effective_from: '2024-03-19', effective_to: '2024-11-30', source: 'Affordable Housing Act 2024', params: { employee_rate: 0.015, employer_rate: 0.015, deductible: false } },
  { code: 'HOUSING_LEVY', effective_from: '2024-12-01', effective_to: null, source: 'Affordable Housing Act 2024; deductible under the Tax Laws (Amendment) Act 2024', params: { employee_rate: 0.015, employer_rate: 0.015, deductible: true } },
  { code: 'NITA', effective_from: '2011-01-01', effective_to: null, source: 'Industrial Training Act (training levy)', params: { employer_amount: 50 } },
  { code: 'ALLOWABLE', effective_from: '2020-01-01', effective_to: '2024-11-30', source: 'Income Tax Act s.22A and s.15 (before the Tax Laws (Amendment) Act 2024)', params: { pension_cap: 20000, mortgage_interest_cap: 25000, post_retirement_medical_cap: 0 } },
  { code: 'ALLOWABLE', effective_from: '2024-12-01', effective_to: null, source: 'Income Tax Act s.22A and s.15 (Tax Laws (Amendment) Act 2024)', params: { pension_cap: 30000, mortgage_interest_cap: 30000, post_retirement_medical_cap: 15000 } },
];

/** The tables in force on a date, from the seed list (tests and the seed use this). */
export function seedTablesOn(date: string): StatutoryTables {
  const out: Partial<StatutoryTables> = {};
  for (const r of STATUTORY_SEED) {
    if (r.effective_from <= date && (r.effective_to === null || r.effective_to >= date)) (out as Record<string, unknown>)[r.code] = r.params;
  }
  return out as StatutoryTables;
}
