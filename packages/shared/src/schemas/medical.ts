import { z } from 'zod';
import { auditStamps, isoDate, isoDateTime, money, name, optionalText, uuid } from './common';
import { EMPLOYMENT_TYPES } from './employees';

const pct = z.number().min(0).max(100);
const employmentType = z.enum(EMPLOYMENT_TYPES);

// ---------------------------------------------------------------- setup
export const medicalScheme = z.object({
  id: uuid,
  code: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  /** The scheme year starts on the 1st of this month. */
  year_start_month: z.number().int(),
  /** At the end of a scheme year unused limits either reset or carry over (up to a share of the limit). */
  unused_limit_policy: z.enum(['reset', 'carry_over']),
  carry_over_max_pct: z.number(),
  max_dependants: z.number().int(),
  /** A claim over the remaining limit (or inside a waiting period) is refused, or held for approval. */
  over_limit_action: z.enum(['block', 'approval']),
  /** Staff contributions by payroll deduction; off means the hospital pays everything. */
  contributions_enabled: z.boolean(),
  status: z.enum(['active', 'inactive']),
  ...auditStamps,
});
export type MedicalScheme = z.infer<typeof medicalScheme>;
export const upsertMedicalScheme = z.object({
  code: z.string().trim().min(2).max(30).regex(/^[A-Z][A-Z0-9_-]*$/, 'Capitals, digits, - and _'),
  name,
  description: optionalText(1000),
  year_start_month: z.number().int().min(1).max(12).default(1),
  unused_limit_policy: z.enum(['reset', 'carry_over']).default('reset'),
  carry_over_max_pct: pct.default(100),
  max_dependants: z.number().int().min(0).max(20).default(5),
  over_limit_action: z.enum(['block', 'approval']).default('approval'),
  contributions_enabled: z.boolean().default(false),
  status: z.enum(['active', 'inactive']).default('active'),
});

export const MEDICAL_CATEGORY_SUGGESTIONS = ['inpatient', 'outpatient', 'maternity', 'dental', 'optical', 'chronic'] as const;
export const medicalCategory = z.object({
  id: uuid,
  scheme_id: uuid,
  code: z.string(),
  name: z.string(),
  /** shared: the family draws on the principal's limit; per_person: each member has their own. */
  sharing: z.enum(['shared', 'per_person']),
  co_pay_pct: z.number(),
  per_visit_cap: money.nullable(),
  waiting_days: z.number().int(),
  principal_and_spouse_only: z.boolean(),
  sort_order: z.number().int(),
  status: z.enum(['active', 'inactive']),
  version: z.number().int(),
});
export const upsertMedicalCategory = z.object({
  code: z.string().trim().min(2).max(30).regex(/^[a-z][a-z0-9_]*$/, 'Lower case, digits and _'),
  name,
  sharing: z.enum(['shared', 'per_person']).default('shared'),
  co_pay_pct: pct.default(0),
  per_visit_cap: money.nullish(),
  waiting_days: z.number().int().min(0).max(730).default(0),
  principal_and_spouse_only: z.boolean().default(false),
  sort_order: z.number().int().min(0).max(1000).default(100),
  status: z.enum(['active', 'inactive']).default('active'),
});

export const medicalLimitRule = z.object({
  id: uuid,
  scheme_id: uuid,
  category_id: uuid,
  job_grade_id: uuid.nullable(),
  employment_type: employmentType.nullable(),
  /** The family's (shared) or the principal's (per person) limit per scheme year. */
  annual_limit: money,
  /** Per-person categories: each dependant's own limit; empty means the same as the principal. */
  dependant_limit: money.nullable(),
  effective_from: isoDate,
  effective_to: isoDate.nullable(),
  version: z.number().int(),
});
export const upsertMedicalLimitRule = z.object({
  category_id: uuid,
  job_grade_id: uuid.nullish(),
  employment_type: employmentType.nullish(),
  annual_limit: money,
  dependant_limit: money.nullish(),
  effective_from: isoDate,
  effective_to: isoDate.nullish(),
});

export const medicalContributionRate = z.object({
  id: uuid,
  scheme_id: uuid,
  job_grade_id: uuid.nullable(),
  employment_type: employmentType.nullable(),
  method: z.enum(['fixed', 'percent_basic']),
  /** KES a month, or percent of basic pay. */
  value: z.number(),
  per_dependant: money,
  effective_from: isoDate,
  effective_to: isoDate.nullable(),
  version: z.number().int(),
});
export const upsertMedicalContributionRate = z.object({
  job_grade_id: uuid.nullish(),
  employment_type: employmentType.nullish(),
  method: z.enum(['fixed', 'percent_basic']),
  value: z.number().min(0).max(1e9),
  per_dependant: money.default('0.00'),
  effective_from: isoDate,
  effective_to: isoDate.nullish(),
});

export const medicalSchemeDetail = medicalScheme.extend({
  categories: z.array(medicalCategory),
  limit_rules: z.array(medicalLimitRule),
  contribution_rates: z.array(medicalContributionRate),
});

// ---------------------------------------------------------------- members and balances
export const medicalBalance = z.object({
  category_id: uuid,
  category_code: z.string(),
  category_name: z.string(),
  sharing: z.enum(['shared', 'per_person']),
  /** For shared categories, whose limit this is (the principal). */
  pool_member_id: uuid,
  scheme_year: z.number().int(),
  limit: money,
  top_ups: money,
  carried_over: money,
  used: money,
  held: money,
  remaining: money,
  utilisation_pct: z.number(),
  co_pay_pct: z.number(),
  per_visit_cap: money.nullable(),
  /** Claims before this date are inside the waiting period. */
  waiting_until: isoDate.nullable(),
  eligible: z.boolean(),
});
export const medicalHold = z.object({ id: uuid, member_id: uuid, category_code: z.string(), amount: money, expires_on: isoDate, reference: z.string().nullable(), created_at: isoDateTime });
export const medicalMember = z.object({
  id: uuid,
  scheme_id: uuid,
  scheme_name: z.string(),
  employee_id: uuid,
  staff_number: z.string(),
  principal_member_id: uuid.nullable(),
  member_number: z.string(),
  name: z.string(),
  relationship: z.enum(['principal', 'spouse', 'child', 'other']),
  date_of_birth: isoDate.nullable(),
  cover_start: isoDate,
  cover_end: isoDate.nullable(),
  status: z.enum(['active', 'ended']),
});
/** What billing staff and the HMIS see: cover and limits only, never pay or HR data. */
export const medicalCover = medicalMember.extend({
  department: z.string().nullable(),
  balances: z.array(medicalBalance),
  holds: z.array(medicalHold),
  family: z.array(medicalMember),
});

export const LEDGER_TYPES = ['claim', 'reversal', 'adjustment', 'top_up', 'carry_over', 'hold', 'hold_release'] as const;
export const medicalLedgerEntry = z.object({
  id: uuid,
  member_id: uuid,
  member_name: z.string(),
  category_code: z.string(),
  scheme_year: z.number().int(),
  entry_type: z.enum(LEDGER_TYPES),
  amount: money,
  invoice_amount: money.nullable(),
  member_share: money.nullable(),
  occurred_on: isoDate,
  facility: z.string().nullable(),
  department: z.string().nullable(),
  invoice_ref: z.string().nullable(),
  external_ref: z.string().nullable(),
  source: z.enum(['web', 'api', 'system']),
  reverses_id: uuid.nullable(),
  reversed: z.boolean(),
  hold_id: uuid.nullable(),
  expires_on: isoDate.nullable(),
  reason: z.string().nullable(),
  document_id: uuid.nullable(),
  created_at: isoDateTime,
});

// ---------------------------------------------------------------- applications
export const MEDICAL_APPLICATION_KINDS = {
  enrol: 'Join a scheme',
  add_dependant: 'Add a dependant',
  remove_dependant: 'Remove a dependant',
  top_up: 'Limit top-up',
  pre_auth: 'Pre-authorisation for a planned procedure',
  over_limit_claim: 'Claim over the limit or in a waiting period',
} as const;
export type MedicalApplicationKind = keyof typeof MEDICAL_APPLICATION_KINDS;
const dependantInput = z.object({ name, relationship: z.enum(['spouse', 'child', 'other']), date_of_birth: isoDate, gender: z.enum(['female', 'male', 'other', 'undisclosed']).nullish() });
export const applyMedical = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('enrol'), scheme_id: uuid, effective_date: isoDate.optional(), dependants: z.array(dependantInput).max(20).default([]), document_ids: z.array(uuid).max(20).default([]), reason: optionalText(1000) }),
  z.object({ kind: z.literal('add_dependant'), scheme_id: uuid, effective_date: isoDate.optional(), dependant: dependantInput, document_ids: z.array(uuid).min(1, 'Attach a birth or marriage certificate').max(10), reason: optionalText(1000) }),
  z.object({ kind: z.literal('remove_dependant'), scheme_id: uuid, member_id: uuid, effective_date: isoDate.optional(), reason: z.string().trim().min(3).max(1000) }),
  z.object({ kind: z.literal('top_up'), scheme_id: uuid, member_id: uuid, category_id: uuid, amount: money, document_ids: z.array(uuid).max(10).default([]), reason: z.string().trim().min(3).max(1000) }),
  z.object({ kind: z.literal('pre_auth'), scheme_id: uuid, member_id: uuid, category_id: uuid, amount: money, planned_date: isoDate, facility: z.string().trim().min(1).max(200), procedure: z.string().trim().min(3).max(300), document_ids: z.array(uuid).max(10).default([]), reason: optionalText(1000) }),
]);
export type ApplyMedical = z.infer<typeof applyMedical>;
export const medicalApplication = z.object({
  id: uuid,
  number: z.string(),
  kind: z.enum(Object.keys(MEDICAL_APPLICATION_KINDS) as [MedicalApplicationKind]),
  scheme_id: uuid,
  scheme_name: z.string(),
  employee_id: uuid,
  employee_name: z.string(),
  member_id: uuid.nullable(),
  member_name: z.string().nullable(),
  category_id: uuid.nullable(),
  category_name: z.string().nullable(),
  amount: money.nullable(),
  effective_date: isoDate.nullable(),
  details: z.record(z.string(), z.unknown()),
  document_ids: z.array(uuid),
  reason: z.string().nullable(),
  status: z.enum(['pending', 'approved', 'rejected', 'returned', 'cancelled']),
  decision_comment: z.string().nullable(),
  workflow_instance_id: uuid.nullable(),
  created_at: isoDateTime,
});

// ---------------------------------------------------------------- billing and HMIS
/** Identify the member by id or by member number. */
const memberRef = z.object({ member_id: uuid.optional(), member_number: z.string().trim().max(30).optional() }).refine((v) => v.member_id || v.member_number, 'Give member_id or member_number');
export const postClaim = z.object({
  member_id: uuid.optional(),
  member_number: z.string().trim().max(30).optional(),
  category_code: z.string().trim().max(30),
  occurred_on: isoDate,
  /** The invoice total; co-payment and the per-visit cap decide what the scheme pays. */
  invoice_amount: money,
  facility: z.string().trim().min(1).max(200),
  department: optionalText(200),
  invoice_ref: z.string().trim().min(1).max(100),
  /** Your own id for the claim (the HMIS bill number); a repeat is refused as a duplicate. */
  external_ref: z.string().trim().max(200).optional(),
  /** Settles a pre-authorisation or hold, releasing it. */
  hold_id: uuid.optional(),
  document_id: uuid.optional(),
}).refine((v) => v.member_id || v.member_number, 'Give member_id or member_number');
export const claimResult = z.object({
  status: z.enum(['posted', 'pending_approval']),
  claim: medicalLedgerEntry.nullable(),
  application_id: uuid.nullable(),
  remaining: money,
  message: z.string().nullable(),
});
export const reverseClaim = z.object({ reason: z.string().trim().min(3).max(500) });
export const placeHold = z.object({
  member_id: uuid.optional(),
  member_number: z.string().trim().max(30).optional(),
  category_code: z.string().trim().max(30),
  amount: money,
  expires_on: isoDate,
  external_ref: z.string().trim().max(200).optional(),
  reason: optionalText(500),
}).refine((v) => v.member_id || v.member_number, 'Give member_id or member_number');
export const adjustLimit = z.object({ category_id: uuid, amount: z.string().regex(/^-?\d{1,12}(\.\d{1,2})?$/), reason: z.string().trim().min(3).max(500), scheme_year: z.number().int().optional() });
export const eligibilityQuery = z.object({ member_number: z.string().trim().max(30).optional(), member_id: uuid.optional(), category_code: z.string().max(30).optional(), on: isoDate.optional() });
export const eligibility = z.object({
  eligible: z.boolean(),
  reason: z.string().nullable(),
  member: medicalMember.nullable(),
  balances: z.array(medicalBalance),
});
export { memberRef as medicalMemberRef };

// ---------------------------------------------------------------- reports
export const MEDICAL_REPORTS = {
  utilisation: 'Utilisation by category, department and scheme',
  near_limit: 'Members near their limit',
  facilities: 'Claims by facility',
  funding: 'Hospital share and staff contributions by month',
} as const;
export type MedicalReport = keyof typeof MEDICAL_REPORTS;
export const utilisationRow = z.object({ scheme: z.string(), category: z.string(), department: z.string().nullable(), members: z.number().int(), limit: money, used: money, held: money, utilisation_pct: z.number() });
export const nearLimitRow = z.object({ member_number: z.string(), name: z.string(), staff_number: z.string(), department: z.string().nullable(), scheme: z.string(), category: z.string(), limit: money, used: money, remaining: money, utilisation_pct: z.number() });
export const facilityRow = z.object({ facility: z.string(), claims: z.number().int(), invoiced: money, scheme_paid: money, member_paid: money });
export const fundingRow = z.object({ period: z.string(), hospital_share: money, staff_contributions: money, claims: z.number().int() });
