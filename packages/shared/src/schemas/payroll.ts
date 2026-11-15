import { z } from 'zod';
import { auditStamps, isoDate, isoDateTime, money, name, optionalText, uuid } from './common';

/** Pay periods are calendar months, written YYYY-MM. */
export const period = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Month as YYYY-MM');

// ---------------------------------------------------------------- components
export const COMPONENT_KINDS = { earning: 'Earning', deduction: 'Deduction', benefit: 'Non-cash benefit (taxed, not paid)', employer_contribution: 'Employer contribution' } as const;
export const COMPONENT_METHODS = { fixed: 'Fixed amount', percent_basic: 'Percentage of basic pay', percent_gross: 'Percentage of gross pay', formula: 'Formula' } as const;
export const TAX_TREATMENTS = {
  none: 'No tax effect',
  pension: 'Pension contribution (deductible with NSSF up to the cap)',
  insurance: 'Insurance premium (earns insurance relief)',
  mortgage_interest: 'Mortgage interest (deductible up to the cap)',
  post_retirement_medical: 'Post-retirement medical fund (deductible up to the cap)',
} as const;
const kind = z.enum(Object.keys(COMPONENT_KINDS) as [keyof typeof COMPONENT_KINDS]);
const method = z.enum(Object.keys(COMPONENT_METHODS) as [keyof typeof COMPONENT_METHODS]);
const treatment = z.enum(Object.keys(TAX_TREATMENTS) as [keyof typeof TAX_TREATMENTS]);

export const payComponent = z.object({
  id: uuid,
  code: z.string(),
  name: z.string(),
  kind,
  method,
  /** Amount for fixed components; percentage (15 = 15%) for percentage components. */
  default_value: z.number().nullable(),
  formula: z.string().nullable(),
  taxable: z.boolean(),
  pensionable: z.boolean(),
  /** Fixed amounts shrink for joiners, leavers and unpaid leave like basic pay. */
  prorate: z.boolean(),
  tax_treatment: treatment,
  /** Statutory and built-in components; their code and kind are fixed. */
  is_system: z.boolean(),
  sort_order: z.number().int(),
  status: z.enum(['active', 'inactive']),
  ...auditStamps,
});
export type PayComponent = z.infer<typeof payComponent>;
export const upsertPayComponent = z
  .object({
    code: z.string().trim().min(2).max(30).regex(/^[A-Z][A-Z0-9_]*$/, 'Capitals, digits and _'),
    name,
    kind,
    method: method.default('fixed'),
    default_value: z.number().min(0).max(1e10).nullish(),
    formula: z.string().trim().max(500).nullish(),
    taxable: z.boolean().default(true),
    pensionable: z.boolean().default(false),
    prorate: z.boolean().default(true),
    tax_treatment: treatment.default('none'),
    sort_order: z.number().int().min(0).max(1000).default(100),
    status: z.enum(['active', 'inactive']).default('active'),
  })
  .refine((v) => v.method !== 'formula' || !!v.formula, { path: ['formula'], message: 'Write the formula' });
export const formulaCheck = z.object({ formula: z.string().max(500), basic: z.number().default(100000), gross: z.number().default(120000) });

// ---------------------------------------------------------------- statutory tables
export const STATUTORY_TABLES = {
  PAYE: 'PAYE bands and reliefs',
  NSSF: 'NSSF tiers',
  SHIF: 'Social Health Insurance Fund',
  HOUSING_LEVY: 'Affordable Housing Levy',
  NITA: 'NITA training levy',
  ALLOWABLE: 'Caps on deductible pension, mortgage interest and medical fund',
} as const;
export type StatutoryTable = keyof typeof STATUTORY_TABLES;
export const statutoryRate = z.object({
  id: uuid,
  code: z.enum(Object.keys(STATUTORY_TABLES) as [StatutoryTable]),
  effective_from: isoDate,
  effective_to: isoDate.nullable(),
  params: z.record(z.string(), z.unknown()),
  source: z.string().nullable(),
  ...auditStamps,
});
export const upsertStatutoryRate = z.object({
  code: z.enum(Object.keys(STATUTORY_TABLES) as [StatutoryTable]),
  effective_from: isoDate,
  effective_to: isoDate.nullish(),
  params: z.record(z.string(), z.unknown()),
  source: optionalText(300),
});

// ---------------------------------------------------------------- per employee
export const employeeSalary = z.object({ id: uuid, employee_id: uuid, basic: money, effective_from: isoDate, effective_to: isoDate.nullable(), reason: z.string().nullable(), created_at: isoDateTime });
/** A new basic salary from a date; the current one is closed the day before. */
export const setSalary = z.object({ basic: money, effective_from: isoDate, reason: optionalText(300) });

export const employeePayItem = z.object({
  id: uuid,
  employee_id: uuid,
  component_id: uuid,
  component_code: z.string(),
  component_name: z.string(),
  kind,
  method,
  value: z.number().nullable(),
  formula: z.string().nullable(),
  effective_from: isoDate,
  effective_to: isoDate.nullable(),
  note: z.string().nullable(),
});
export const upsertPayItem = z.object({
  component_id: uuid,
  /** Overrides the component's default; omit to use it. */
  value: z.number().min(0).max(1e10).nullish(),
  formula: z.string().trim().max(500).nullish(),
  effective_from: isoDate,
  effective_to: isoDate.nullish(),
  note: optionalText(300),
});

export const LOAN_STATUSES = ['active', 'settled', 'cancelled'] as const;
export const employeeLoan = z.object({
  id: uuid,
  employee_id: uuid,
  employee_name: z.string().optional(),
  component_id: uuid,
  component_name: z.string(),
  reference: z.string().nullable(),
  principal: money,
  installment: money,
  start_period: period,
  repaid: money,
  balance: money,
  status: z.enum(LOAN_STATUSES),
  note: z.string().nullable(),
  created_at: isoDateTime,
  version: z.number().int(),
});
export const upsertLoan = z.object({
  employee_id: uuid,
  /** A deduction component such as Staff loan, Salary advance or HELB. */
  component_id: uuid,
  reference: optionalText(60),
  principal: money,
  installment: money,
  start_period: period,
  status: z.enum(LOAN_STATUSES).default('active'),
  note: optionalText(300),
});

export const oneOffItem = z.object({ id: uuid, employee_id: uuid, employee_name: z.string().optional(), component_id: uuid, component_name: z.string(), kind, period, amount: money, note: z.string().nullable(), created_at: isoDateTime });
export const createOneOff = z.object({ employee_id: uuid, component_id: uuid, period, amount: money, note: optionalText(300) });

/** Everything that decides one person's pay, for the pay screen. */
export const employeePay = z.object({
  employee_id: uuid,
  salaries: z.array(employeeSalary),
  items: z.array(employeePayItem),
  loans: z.array(employeeLoan),
  one_offs: z.array(oneOffItem),
});

// ---------------------------------------------------------------- runs and payslips
export const RUN_STATUSES = ['draft', 'calculated', 'under_review', 'approved', 'paid', 'closed'] as const;
export const runWarning = z.object({ employee_id: uuid.nullable(), name: z.string().nullable(), message: z.string() });
export const payrollRun = z.object({
  id: uuid,
  number: z.string(),
  period,
  period_start: isoDate,
  period_end: isoDate,
  pay_date: isoDate,
  status: z.enum(RUN_STATUSES),
  employees: z.number().int(),
  gross: money,
  total_deductions: money,
  net: money,
  paye: money,
  employer_cost: money,
  warnings: z.array(runWarning),
  calculated_at: isoDateTime.nullable(),
  submitted_at: isoDateTime.nullable(),
  approved_at: isoDateTime.nullable(),
  paid_at: isoDateTime.nullable(),
  closed_at: isoDateTime.nullable(),
  decision_comment: z.string().nullable(),
  workflow_instance_id: uuid.nullable(),
  ...auditStamps,
});
export type PayrollRun = z.infer<typeof payrollRun>;
export const createRun = z.object({ period, pay_date: isoDate.optional() });
export const runAction = z.object({ comment: optionalText(1000) });

export const payslipLine = z.object({ code: z.string(), name: z.string(), kind: z.enum(['earning', 'deduction', 'benefit', 'employer_contribution']), amount: money, detail: z.string().nullable() });
export const payslip = z.object({
  id: uuid,
  run_id: uuid,
  period,
  pay_date: isoDate,
  run_status: z.enum(RUN_STATUSES),
  number: z.string().nullable(),
  employee_id: uuid,
  employee_name: z.string(),
  staff_number: z.string(),
  department_name: z.string().nullable(),
  cost_centre_code: z.string().nullable(),
  basic: money,
  gross: money,
  taxable_pay: money,
  paye: money,
  nssf: money,
  shif: money,
  housing_levy: money,
  total_deductions: money,
  net: money,
  employer_cost: money,
  tax: z.object({ allowable: z.number(), tax_before_relief: z.number(), personal_relief: z.number(), insurance_relief: z.number() }),
  warnings: z.array(z.string()),
  payment_method: z.enum(['bank', 'mobile_money', 'cash']).nullable(),
  lines: z.array(payslipLine).optional(),
});
export type Payslip = z.infer<typeof payslip>;

export const varianceRow = z.object({
  employee_id: uuid,
  employee_name: z.string(),
  staff_number: z.string(),
  previous_gross: money.nullable(),
  current_gross: money.nullable(),
  previous_net: money.nullable(),
  current_net: money.nullable(),
  change: money,
  change_pct: z.number().nullable(),
  flag: z.enum(['new', 'left', 'changed', 'unchanged']),
});
export const variance = z.object({ previous_run_id: uuid.nullable(), previous_period: period.nullable(), threshold_pct: z.number(), rows: z.array(varianceRow) });

export const journalLine = z.object({ account: z.string(), cost_centre_code: z.string().nullable(), description: z.string(), debit: money, credit: money });
export const journal = z.object({ run_id: uuid, period, pay_date: isoDate, lines: z.array(journalLine), total_debit: money, total_credit: money, unmapped: z.array(z.string()) });

// ---------------------------------------------------------------- files and accounts
export const PAYMENT_FIELDS = {
  employee_name: 'Employee name', staff_number: 'Staff number', national_id: 'National ID', account_name: 'Account name', account_number: 'Account number / phone',
  bank_name: 'Bank', bank_code: 'Bank code', branch_name: 'Branch', branch_code: 'Branch code', amount: 'Net pay', reference: 'Reference (e.g. "Salary Nov 2026")', pay_date: 'Pay date', fixed: 'Fixed text (value)',
} as const;
export const fileColumn = z.object({ header: z.string().trim().min(1).max(60), field: z.enum(Object.keys(PAYMENT_FIELDS) as [keyof typeof PAYMENT_FIELDS]), value: z.string().max(100).optional() });
export const paymentFileFormat = z.object({
  id: uuid, code: z.string(), name: z.string(), channel: z.enum(['bank', 'mobile_money']), file_type: z.enum(['xlsx', 'csv']), columns: z.array(fileColumn), is_default: z.boolean(), note: z.string().nullable(), ...auditStamps,
});
export const upsertPaymentFileFormat = z.object({
  code: z.string().trim().min(2).max(30).regex(/^[A-Z][A-Z0-9_]*$/), name, channel: z.enum(['bank', 'mobile_money']), file_type: z.enum(['xlsx', 'csv']), columns: z.array(fileColumn).min(1).max(30), is_default: z.boolean().default(false), note: optionalText(500),
});

export const glAccountMap = z.object({ id: uuid, key: z.string(), description: z.string().nullable(), debit_account: z.string().nullable(), credit_account: z.string().nullable(), version: z.number().int() });
export const upsertGlAccountMap = z.object({ key: z.string().trim().min(1).max(40), description: optionalText(200), debit_account: z.string().trim().max(40).nullish(), credit_account: z.string().trim().max(40).nullish() });

export const PAYROLL_EXPORTS = {
  payments: 'Payment file (bank or M-Pesa)',
  p10: 'KRA P10 (PAYE, employee details)',
  nssf: 'NSSF contributions',
  shif: 'SHA (SHIF) contributions',
  housing_levy: 'Affordable Housing Levy',
  journal: 'Payroll journal by cost centre',
  register: 'Payroll register (all payslips)',
} as const;
export type PayrollExport = keyof typeof PAYROLL_EXPORTS;
