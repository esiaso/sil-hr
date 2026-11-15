import { z } from 'zod';
import { auditStamps, isoDate, money, optionalText, uuid } from './common';

export const EXPENSE_CATEGORIES = { transport: 'Transport', accommodation: 'Accommodation', meals: 'Meals', per_diem: 'Per diem', fuel: 'Fuel', registration: 'Registration fees', supplies: 'Supplies', other: 'Other' } as const;
const category = z.enum(['transport', 'accommodation', 'meals', 'per_diem', 'fuel', 'registration', 'supplies', 'other']);

export const travelRequest = z.object({
  id: uuid,
  number: z.string(),
  employee_id: uuid,
  employee_name: z.string(),
  staff_number: z.string(),
  department_name: z.string().nullable(),
  purpose: z.string(),
  destination: z.string(),
  depart_on: isoDate,
  return_on: isoDate,
  estimated_cost: money,
  advance: money,
  /** The payroll month the advance is paid in (set on approval). */
  advance_period: z.string().nullable(),
  status: z.enum(['pending', 'approved', 'rejected', 'returned', 'cancelled']),
  decision_comment: z.string().nullable(),
  workflow_instance_id: uuid.nullable(),
  claim_id: uuid.nullable(),
  ...auditStamps,
});
export const createTravel = z
  .object({
    purpose: z.string().trim().min(5).max(1000),
    destination: z.string().trim().min(2).max(200),
    depart_on: isoDate,
    return_on: isoDate,
    estimated_cost: money.default('0'),
    advance: money.default('0'),
  })
  .refine((v) => v.return_on >= v.depart_on, { path: ['return_on'], message: 'Must be on or after departure' })
  .refine((v) => Number(v.advance) <= Number(v.estimated_cost), { path: ['advance'], message: 'Cannot exceed the estimated cost' });

export const expenseItem = z.object({ id: uuid, spent_on: isoDate, category, description: z.string(), amount: money, receipt_document_id: uuid.nullable() });
export const expenseClaim = z.object({
  id: uuid,
  number: z.string(),
  employee_id: uuid,
  employee_name: z.string(),
  staff_number: z.string(),
  department_name: z.string().nullable(),
  travel_request_id: uuid.nullable(),
  travel_number: z.string().nullable(),
  title: z.string(),
  total: money,
  /** The trip's advance, recovered from this claim. */
  advance_offset: money,
  /** What payroll pays (positive) or recovers (negative). */
  net: money,
  status: z.enum(['draft', 'pending', 'approved', 'rejected', 'returned', 'cancelled']),
  paid_period: z.string().nullable(),
  decision_comment: z.string().nullable(),
  workflow_instance_id: uuid.nullable(),
  items: z.array(expenseItem),
  ...auditStamps,
});
export const createClaim = z.object({ title: z.string().trim().min(3).max(200), travel_request_id: uuid.nullish() });
/** multipart/form-data fields of one item (the receipt is `receipt`). */
export const expenseItemFields = z.object({
  spent_on: isoDate,
  category,
  description: z.string().trim().min(2).max(300),
  amount: money.refine((a) => Number(a) > 0, 'Must be more than zero'),
});
export const travelQuery = z.object({ status: z.string().max(10).optional(), employee_id: uuid.optional() });
export const cancelReason = z.object({ reason: optionalText(500) });
