import { z } from 'zod';
import { isoDate, money, uuid } from './common';

/** Every report takes ?format=json|csv|xlsx; csv and xlsx download the same rows. */
export const reportFormat = z.enum(['json', 'csv', 'xlsx']).default('json');
export const REPORTS = {
  headcount: 'Headcount',
  turnover: 'Turnover',
  'leave-liability': 'Leave liability',
  'overtime-cost': 'Overtime cost',
  'payroll-cost': 'Payroll cost by department',
  'licence-expiry': 'Licence expiry',
  'contract-expiry': 'Contract expiry',
} as const;
export type ReportCode = keyof typeof REPORTS;

export const headcountQuery = z.object({ as_at: isoDate.optional(), group_by: z.enum(['department', 'branch', 'employment_type', 'grade', 'gender']).default('department'), format: reportFormat });
export const headcountRow = z.object({ group: z.string(), active: z.number().int(), probation: z.number().int(), on_notice: z.number().int(), suspended: z.number().int(), total: z.number().int(), female: z.number().int(), male: z.number().int() });

export const periodQuery = z.object({ from: isoDate, to: isoDate, format: reportFormat }).refine((v) => v.to >= v.from, { path: ['to'], message: 'Must be on or after from' });
export const turnoverRow = z.object({ department: z.string(), opening: z.number().int(), closing: z.number().int(), joiners: z.number().int(), leavers: z.number().int(), voluntary: z.number().int(), average: z.number(), turnover_pct: z.number() });

export const asAtQuery = z.object({ as_at: isoDate.optional(), format: reportFormat });
export const leaveLiabilityRow = z.object({ employee_id: uuid, staff_number: z.string(), employee_name: z.string(), department: z.string().nullable(), days: z.number(), daily_rate: money, liability: money });

export const periodsQuery = z.object({ from: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/), to: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/), format: reportFormat }).refine((v) => v.to >= v.from, { path: ['to'], message: 'Must be on or after from' });
export const overtimeRow = z.object({ period: z.string(), department: z.string(), hours_recorded: z.number(), hours_paid: z.number(), amount_paid: money });
export const payrollCostRow = z.object({ period: z.string(), department: z.string(), cost_centre: z.string().nullable(), employees: z.number().int(), gross: money, employer_contributions: money, total_cost: money, net: money });

export const expiryQuery = z.object({ within_days: z.coerce.number().int().min(0).max(730).default(90), include_expired: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'), format: reportFormat });
export const licenceExpiryRow = z.object({ employee_id: uuid, staff_number: z.string(), employee_name: z.string(), department: z.string().nullable(), licensing_body: z.string(), licence_number: z.string(), expiry_date: isoDate, days_left: z.number().int(), verified: z.boolean() });
export const contractExpiryRow = z.object({ employee_id: uuid, staff_number: z.string(), employee_name: z.string(), department: z.string().nullable(), contract_number: z.string(), contract_type: z.string(), end_date: isoDate, days_left: z.number().int() });

/** Numbers for the dashboard, each limited to the caller's scope. */
export const dashboard = z.object({
  headcount: z.number().int().nullable(),
  joiners_30d: z.number().int().nullable(),
  leavers_30d: z.number().int().nullable(),
  on_leave_today: z.number().int().nullable(),
  licences_expiring_60d: z.number().int().nullable(),
  contracts_ending_60d: z.number().int().nullable(),
  last_payroll: z.object({ period: z.string(), status: z.string(), gross: money, net: money, employees: z.number().int() }).nullable(),
  headcount_by_department: z.array(z.object({ department: z.string(), count: z.number().int() })).nullable(),
  pending_approvals: z.number().int(),
  unacknowledged_policies: z.number().int(),
  open_actions: z.number().int(),
});
