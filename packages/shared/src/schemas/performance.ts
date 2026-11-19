import { z } from 'zod';
import { auditStamps, isoDate, isoDateTime, optionalText, uuid } from './common';

// ---------------------------------------------------------------- indicators (KPI library)
export const INDICATOR_CATEGORIES = {
  clinical: 'Clinical care',
  quality: 'Quality and safety',
  patient_experience: 'Patient experience',
  operational: 'Operational',
  behaviour: 'Behaviour and values',
  learning: 'Learning and development',
} as const;
export const MEASURES = { rating: 'Rating (1–5)', percent: 'Percentage', number: 'Number', yes_no: 'Done / not done' } as const;
const category = z.enum(Object.keys(INDICATOR_CATEGORIES) as [keyof typeof INDICATOR_CATEGORIES, ...(keyof typeof INDICATOR_CATEGORIES)[]]);
const measure = z.enum(Object.keys(MEASURES) as [keyof typeof MEASURES, ...(keyof typeof MEASURES)[]]);

export const indicator = z.object({
  id: uuid,
  code: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  category,
  measure,
  default_target: z.string().nullable(),
  /** Suggested for this department (and its sub-departments) only; null = anyone. */
  department_id: uuid.nullable(),
  department_name: z.string().nullable(),
  position_id: uuid.nullable(),
  position_title: z.string().nullable(),
  status: z.enum(['active', 'inactive']),
  ...auditStamps,
});
export const upsertIndicator = z.object({
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9][A-Z0-9_-]{1,29}$/, 'Letters, digits, - and _'),
  name: z.string().trim().min(3).max(200),
  description: optionalText(2000),
  category,
  measure,
  default_target: optionalText(100),
  department_id: uuid.nullish(),
  position_id: uuid.nullish(),
  status: z.enum(['active', 'inactive']).default('active'),
});

// ---------------------------------------------------------------- review cycles
export const CYCLE_KINDS = { annual: 'Annual', mid_year: 'Mid-year', quarterly: 'Quarterly', probation: 'Probation' } as const;
export const CYCLE_STATUSES = { draft: 'Draft', goal_setting: 'Goal setting', reviewing: 'Reviewing', closed: 'Closed' } as const;
const cycleStatus = z.enum(['draft', 'goal_setting', 'reviewing', 'closed']);
export const reviewCycle = z.object({
  id: uuid,
  name: z.string(),
  kind: z.enum(['annual', 'mid_year', 'quarterly', 'probation']),
  period_start: isoDate,
  period_end: isoDate,
  goals_due: isoDate,
  self_review_due: isoDate,
  manager_review_due: isoDate,
  /** Only staff in this department (and below); null = all active staff. */
  department_id: uuid.nullable(),
  department_name: z.string().nullable(),
  status: cycleStatus,
  launched_at: isoDateTime.nullable(),
  counts: z.object({ reviews: z.number().int(), goals_agreed: z.number().int(), self_done: z.number().int(), manager_done: z.number().int(), completed: z.number().int() }),
  ...auditStamps,
});
export const createCycle = z
  .object({
    name: z.string().trim().min(3).max(120),
    kind: z.enum(['annual', 'mid_year', 'quarterly', 'probation']),
    period_start: isoDate,
    period_end: isoDate,
    goals_due: isoDate,
    self_review_due: isoDate,
    manager_review_due: isoDate,
    department_id: uuid.nullish(),
  })
  .refine((v) => v.period_end > v.period_start, { path: ['period_end'], message: 'Must be after the start' })
  .refine((v) => v.self_review_due <= v.manager_review_due, { path: ['manager_review_due'], message: 'Must be on or after the self-review date' });
export const cycleStatusChange = z.object({ status: z.enum(['goal_setting', 'reviewing', 'closed']) });

// ---------------------------------------------------------------- goals
export const goal = z.object({
  id: uuid,
  review_id: uuid,
  indicator_id: uuid.nullable(),
  indicator_name: z.string().nullable(),
  title: z.string(),
  description: z.string().nullable(),
  measure,
  target: z.string().nullable(),
  /** Percent of the overall rating; a review's goals add up to 100. */
  weight: z.number().int(),
  status: z.enum(['proposed', 'agreed', 'dropped']),
  progress: z.number().int(),
  progress_note: z.string().nullable(),
  self_score: z.number().int().nullable(),
  self_comment: z.string().nullable(),
  manager_score: z.number().int().nullable(),
  manager_comment: z.string().nullable(),
  version: z.number().int(),
});
export const upsertGoal = z.object({
  indicator_id: uuid.nullish(),
  title: z.string().trim().min(3).max(300),
  description: optionalText(2000),
  measure,
  target: optionalText(100),
  weight: z.number().int().min(5).max(100),
});
export const goalProgress = z.object({ progress: z.number().int().min(0).max(100), note: optionalText(1000) });

// ---------------------------------------------------------------- reviews
export const REVIEW_STATUSES = {
  goal_setting: 'Goal setting',
  self_review: 'Self-review',
  manager_review: 'Manager review',
  approval: 'Approval and calibration',
  acknowledgement: 'Waiting for the employee',
  completed: 'Completed',
} as const;
export const RATING_BANDS: { min: number; label: string }[] = [
  { min: 4.5, label: 'Outstanding' },
  { min: 3.5, label: 'Exceeds expectations' },
  { min: 2.5, label: 'Meets expectations' },
  { min: 1.5, label: 'Below expectations' },
  { min: 0, label: 'Unsatisfactory' },
];
/** The band a rating falls in; `bands` comes from the performance.rating_bands setting (highest first). */
export const ratingBand = (r: string | number | null | undefined, bands: { min: number; label: string }[] = RATING_BANDS): string | null =>
  r === null || r === undefined || r === '' ? null : ([...bands].sort((a, b) => b.min - a.min).find((b) => Number(r) >= b.min) ?? bands[bands.length - 1])?.label ?? null;
const rating = z.string().regex(/^\d(\.\d{1,2})?$/);
const reviewStatus = z.enum(['goal_setting', 'self_review', 'manager_review', 'approval', 'acknowledgement', 'completed']);

export const reviewSummary = z.object({
  id: uuid,
  cycle_id: uuid,
  cycle_name: z.string(),
  employee_id: uuid,
  employee_name: z.string(),
  staff_number: z.string(),
  position_title: z.string().nullable(),
  department_name: z.string().nullable(),
  reviewer_user_id: uuid.nullable(),
  reviewer_name: z.string().nullable(),
  status: reviewStatus,
  self_rating: rating.nullable(),
  manager_rating: rating.nullable(),
  final_rating: rating.nullable(),
  band: z.string().nullable(),
  goals: z.number().int(),
  updated_at: isoDateTime,
  version: z.number().int(),
});
export const review = reviewSummary.extend({
  cycle_status: cycleStatus,
  period_start: isoDate,
  period_end: isoDate,
  self_review_due: isoDate,
  manager_review_due: isoDate,
  goal_list: z.array(goal),
  self_comment: z.string().nullable(),
  self_submitted_at: isoDateTime.nullable(),
  manager_comment: z.string().nullable(),
  strengths: z.string().nullable(),
  development_needs: z.string().nullable(),
  manager_submitted_at: isoDateTime.nullable(),
  calibration_comment: z.string().nullable(),
  employee_agrees: z.boolean().nullable(),
  employee_comment: z.string().nullable(),
  acknowledged_at: isoDateTime.nullable(),
  workflow_instance_id: uuid.nullable(),
  /** What the caller may do now. */
  can: z.object({ edit_goals: z.boolean(), agree_goals: z.boolean(), self_review: z.boolean(), manager_review: z.boolean(), calibrate: z.boolean(), acknowledge: z.boolean(), reassign: z.boolean() }),
});
const score = z.number().int().min(1).max(5);
export const selfReview = z.object({
  scores: z.array(z.object({ goal_id: uuid, score: score.nullish(), comment: optionalText(2000) })).max(30).default([]),
  comment: optionalText(4000),
  submit: z.boolean().default(false),
});
export const managerReview = z.object({
  scores: z.array(z.object({ goal_id: uuid, score: score.nullish(), comment: optionalText(2000) })).max(30).default([]),
  /** Only when the review has no agreed goals; otherwise the weighted goal scores decide it. */
  overall_rating: z.number().min(1).max(5).nullish(),
  comment: optionalText(4000),
  strengths: optionalText(4000),
  development_needs: optionalText(4000),
  submit: z.boolean().default(false),
});
export const calibrate = z.object({ final_rating: z.number().min(1).max(5), comment: z.string().trim().min(5).max(2000) });
export const acknowledgeReview = z.object({ agree: z.boolean(), comment: optionalText(2000) }).refine((v) => v.agree || !!v.comment, { path: ['comment'], message: 'Say what you disagree with' });
export const reassignReviewer = z.object({ reviewer_user_id: uuid });
export const cycleReport = z.object({
  cycle_id: uuid,
  bands: z.array(z.object({ band: z.string(), count: z.number().int() })),
  departments: z.array(z.object({ department_name: z.string().nullable(), reviews: z.number().int(), completed: z.number().int(), average: rating.nullable() })),
});
