import { z } from 'zod';
import { auditStamps, isoDate, isoDateTime, listQuery, name, optionalText, uuid } from './common';

export const LEAVE_REQUEST_STATUSES = ['draft', 'pending', 'returned', 'approved', 'rejected', 'cancelled'] as const;
export type LeaveRequestStatus = (typeof LEAVE_REQUEST_STATUSES)[number];
export const LEDGER_ENTRY_TYPES = ['accrual', 'carry_forward', 'adjustment', 'reserved', 'release', 'taken', 'expiry', 'encashment'] as const;
export type LedgerEntryType = (typeof LEDGER_ENTRY_TYPES)[number];

const days = z.number().min(0).max(366);

export const leaveType = z.object({
  id: uuid,
  code: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  is_paid: z.boolean(),
  /** 1 = full pay, 0.5 = half pay (e.g. second week of sick leave). */
  pay_rate: z.number(),
  /** working_days skips rest days and public holidays; calendar_days counts every day. */
  counting: z.enum(['working_days', 'calendar_days']),
  accrual: z.enum(['monthly', 'annual', 'none']),
  default_entitlement_days: z.number(),
  allow_half_day: z.boolean(),
  allow_negative_balance: z.boolean(),
  gender: z.enum(['female', 'male']).nullable(),
  min_service_months: z.number().int(),
  min_notice_days: z.number().int(),
  max_consecutive_days: z.number().nullable(),
  requires_document_over_days: z.number().nullable(),
  carry_forward_max_days: z.number(),
  carry_forward_expiry_months: z.number().int().nullable(),
  encashable: z.boolean(),
  colour: z.string().nullable(),
  status: z.enum(['active', 'inactive']),
  ...auditStamps,
});
export type LeaveType = z.infer<typeof leaveType>;

export const upsertLeaveType = z.object({
  code: z.string().trim().min(2).max(30).regex(/^[a-z][a-z0-9_]*$/),
  name,
  description: optionalText(500),
  is_paid: z.boolean().default(true),
  pay_rate: z.number().min(0).max(1).default(1),
  counting: z.enum(['working_days', 'calendar_days']).default('working_days'),
  accrual: z.enum(['monthly', 'annual', 'none']).default('annual'),
  default_entitlement_days: days.default(0),
  allow_half_day: z.boolean().default(true),
  allow_negative_balance: z.boolean().default(false),
  gender: z.enum(['female', 'male']).nullish(),
  min_service_months: z.number().int().min(0).max(120).default(0),
  min_notice_days: z.number().int().min(0).max(365).default(0),
  max_consecutive_days: days.nullish(),
  requires_document_over_days: days.nullish(),
  carry_forward_max_days: days.default(0),
  carry_forward_expiry_months: z.number().int().min(1).max(24).nullish(),
  encashable: z.boolean().default(false),
  colour: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullish(),
  status: z.enum(['active', 'inactive']).optional(),
});
export type UpsertLeaveType = z.infer<typeof upsertLeaveType>;

/** Entitlement overrides by grade and/or employment type, effective-dated. */
export const leavePolicy = z.object({
  id: uuid,
  leave_type_id: uuid,
  job_grade_id: uuid.nullable(),
  employment_type: z.string().nullable(),
  entitlement_days: z.number(),
  effective_from: isoDate,
  effective_to: isoDate.nullable(),
});
export const upsertLeavePolicy = z.object({
  leave_type_id: uuid,
  job_grade_id: uuid.nullish(),
  employment_type: z.enum(['permanent', 'contract', 'casual', 'locum', 'intern']).nullish(),
  entitlement_days: days,
  effective_from: isoDate,
  effective_to: isoDate.nullish(),
});

export const publicHoliday = z.object({ id: uuid, date: isoDate, name: z.string(), branch_id: uuid.nullable() });
export const upsertPublicHoliday = z.object({ date: isoDate, name, branch_id: uuid.nullish() });

export const leaveBalance = z.object({
  leave_type_id: uuid,
  leave_type_code: z.string(),
  leave_type_name: z.string(),
  leave_year: z.number().int(),
  entitled: z.number(),
  carried_forward: z.number(),
  adjustments: z.number(),
  taken: z.number(),
  reserved: z.number(),
  expired: z.number(),
  encashed: z.number(),
  /** The sum of every ledger entry: what can still be requested. */
  available: z.number(),
});
export type LeaveBalance = z.infer<typeof leaveBalance>;

export const ledgerEntry = z.object({
  id: uuid,
  leave_type_id: uuid,
  leave_year: z.number().int(),
  entry_type: z.enum(LEDGER_ENTRY_TYPES),
  days: z.number(),
  effective_date: isoDate,
  leave_request_id: uuid.nullable(),
  note: z.string().nullable(),
  created_at: isoDateTime,
});

export const leaveAdjustment = z.object({
  leave_type_id: uuid,
  leave_year: z.number().int().min(2000).max(2100),
  /** Positive adds days, negative removes them. */
  days: z.number().min(-366).max(366).refine((d) => d !== 0 && Math.round(d * 2) === d * 2, 'Whole or half days, not zero'),
  entry_type: z.enum(['adjustment', 'encashment']).default('adjustment'),
  note: z.string().trim().min(3).max(300),
});

export const leaveRequest = z.object({
  id: uuid,
  number: z.string(),
  employee_id: uuid,
  employee_name: z.string(),
  leave_type_id: uuid,
  leave_type_name: z.string(),
  start_date: isoDate,
  end_date: isoDate,
  /** Starts after midday on the first day. */
  start_half_day: z.boolean(),
  /** Ends at midday on the last day. */
  end_half_day: z.boolean(),
  days: z.number(),
  leave_year: z.number().int(),
  reason: z.string().nullable(),
  status: z.enum(LEAVE_REQUEST_STATUSES),
  document_id: uuid.nullable(),
  workflow_instance_id: uuid.nullable(),
  submitted_at: isoDateTime.nullable(),
  decided_at: isoDateTime.nullable(),
  decision_comment: z.string().nullable(),
  ...auditStamps,
});
export type LeaveRequest = z.infer<typeof leaveRequest>;

export const applyLeave = z
  .object({
    /** HR may apply on someone's behalf; staff apply for themselves (omit it). */
    employee_id: uuid.optional(),
    leave_type_id: uuid,
    start_date: isoDate,
    end_date: isoDate,
    start_half_day: z.boolean().default(false),
    end_half_day: z.boolean().default(false),
    reason: optionalText(1000),
    document_id: uuid.nullish(),
    /** false keeps it as a draft (no balance is reserved). */
    submit: z.boolean().default(true),
  })
  .refine((v) => v.end_date >= v.start_date, { path: ['end_date'], message: 'Ends before it starts' })
  .refine((v) => !(v.start_date === v.end_date && v.start_half_day && v.end_half_day), { path: ['end_half_day'], message: 'A single day cannot start and end at midday' });
export type ApplyLeave = z.infer<typeof applyLeave>;

export const leaveQuote = z.object({ days: z.number(), leave_year: z.number().int(), available: z.number(), excluded: z.array(z.object({ date: isoDate, why: z.string() })) });

export const leaveRequestQuery = listQuery.extend({
  status: z.enum(LEAVE_REQUEST_STATUSES).optional(),
  employee_id: uuid.optional(),
  leave_type_id: uuid.optional(),
  department_id: uuid.optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
});

export const calendarEntry = z.object({
  request_id: uuid,
  employee_id: uuid,
  employee_name: z.string(),
  department_id: uuid.nullable(),
  leave_type_code: z.string(),
  leave_type_name: z.string(),
  colour: z.string().nullable(),
  start_date: isoDate,
  end_date: isoDate,
  status: z.enum(['pending', 'approved']),
});
export const calendarQuery = z.object({ from: isoDate, to: isoDate, department_id: uuid.optional(), include_sub_departments: z.enum(['true', 'false']).optional() });
