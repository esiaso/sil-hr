import { z } from 'zod';
import { auditStamps, email, isoDate, isoDateTime, money, name, optionalText, phone, uuid } from './common';
import { EMPLOYMENT_TYPES } from './employees';

const employmentType = z.enum(EMPLOYMENT_TYPES);

// ---------------------------------------------------------------- requisitions
export const REQUISITION_REASONS = { new: 'New post', replacement: 'Replacement', temporary: 'Temporary cover' } as const;
export const requisition = z.object({
  id: uuid,
  number: z.string(),
  position_id: uuid,
  position_title: z.string(),
  department_name: z.string().nullable(),
  headcount: z.number().int(),
  hired: z.number().int(),
  employment_type: employmentType,
  reason: z.enum(['new', 'replacement', 'temporary']),
  replaces_employee_id: uuid.nullable(),
  replaces_employee_name: z.string().nullable(),
  salary_min: money.nullable(),
  salary_max: money.nullable(),
  needed_by: isoDate.nullable(),
  justification: z.string(),
  status: z.enum(['pending', 'approved', 'rejected', 'returned', 'filled', 'cancelled']),
  requested_by_name: z.string().nullable(),
  decision_comment: z.string().nullable(),
  workflow_instance_id: uuid.nullable(),
  /** Vacant seats in the position's approved headcount when the request was made. */
  vacancies: z.number().int(),
  ...auditStamps,
});
export const createRequisition = z
  .object({
    position_id: uuid,
    headcount: z.number().int().min(1).max(100).default(1),
    employment_type: employmentType,
    reason: z.enum(['new', 'replacement', 'temporary']),
    replaces_employee_id: uuid.nullish(),
    salary_min: money.nullish(),
    salary_max: money.nullish(),
    needed_by: isoDate.nullish(),
    justification: z.string().trim().min(10).max(4000),
  })
  .refine((v) => v.reason !== 'replacement' || !!v.replaces_employee_id, { path: ['replaces_employee_id'], message: 'Who is being replaced?' });

// ---------------------------------------------------------------- postings
export const postingQuestion = z.object({ key: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/), label: z.string().trim().min(3).max(300), type: z.enum(['text', 'yes_no', 'number']), required: z.boolean().default(true) });
export const posting = z.object({
  id: uuid,
  requisition_id: uuid,
  requisition_number: z.string(),
  slug: z.string(),
  title: z.string(),
  summary: z.string().nullable(),
  description: z.string(),
  requirements: z.string().nullable(),
  location: z.string().nullable(),
  employment_type: employmentType,
  show_salary: z.boolean(),
  salary_min: money.nullable(),
  salary_max: money.nullable(),
  closing_date: isoDate,
  internal_only: z.boolean(),
  questions: z.array(postingQuestion),
  status: z.enum(['draft', 'published', 'closed']),
  published_at: isoDateTime.nullable(),
  applications: z.number().int(),
  ...auditStamps,
});
export const upsertPosting = z.object({
  requisition_id: uuid,
  title: z.string().trim().min(3).max(200),
  summary: optionalText(500),
  description: z.string().trim().min(20).max(20000),
  requirements: optionalText(20000),
  location: optionalText(200),
  show_salary: z.boolean().default(false),
  closing_date: isoDate,
  internal_only: z.boolean().default(false),
  questions: z.array(postingQuestion).max(10).default([]),
  status: z.enum(['draft', 'published', 'closed']).default('draft'),
});
/** What the public careers site shows: no internal ids beyond the slug. */
export const publicPosting = z.object({
  slug: z.string(), title: z.string(), summary: z.string().nullable(), description: z.string(), requirements: z.string().nullable(), location: z.string().nullable(),
  employment_type: employmentType, salary: z.string().nullable(), closing_date: isoDate, questions: z.array(postingQuestion.omit({}).pick({ key: true, label: true, type: true, required: true })), organisation: z.string(),
});
export const careersApplicationFields = z.object({
  first_name: name,
  last_name: name,
  email,
  phone,
  location: optionalText(200),
  cover_note: optionalText(4000),
  /** JSON object of answers to the posting's questions, keyed by question key. */
  answers: z.string().max(10000).optional(),
  /** The Data Protection Act needs explicit consent to process an application. */
  consent: z.enum(['true']),
  /** Left empty by people; bots fill it. */
  website: z.string().max(0).optional(),
});
export const careersApplicationResult = z.object({ reference: z.string(), message: z.string() });

// ---------------------------------------------------------------- applications
export const STAGES = { applied: 'Applied', screening: 'Screening', shortlisted: 'Shortlisted', interview: 'Interview', assessment: 'Assessment', offer: 'Offer', hired: 'Hired', rejected: 'Not taken forward', withdrawn: 'Withdrawn' } as const;
export type Stage = keyof typeof STAGES;
const stage = z.enum(Object.keys(STAGES) as [Stage]);
export const RECOMMENDATIONS = { strong_yes: 'Strongly recommend', yes: 'Recommend', no: 'Do not recommend', strong_no: 'Strongly against' } as const;
export const application = z.object({
  id: uuid,
  number: z.string(),
  posting_id: uuid,
  posting_title: z.string(),
  candidate_id: uuid,
  candidate_name: z.string(),
  email: z.string(),
  phone: z.string().nullable(),
  location: z.string().nullable(),
  source: z.enum(['careers', 'internal', 'referral', 'agency', 'other']),
  stage,
  cv_document_id: uuid.nullable(),
  cover_note: z.string().nullable(),
  answers: z.record(z.string(), z.string()),
  rating: z.number().int().nullable(),
  rejection_reason: z.string().nullable(),
  hired_employee_id: uuid.nullable(),
  interviews: z.number().int(),
  /** Average panel recommendation: 2 strong yes … −2 strong no. */
  panel_score: z.number().nullable(),
  created_at: isoDateTime,
});
export const applicationDetail = application.extend({
  events: z.array(z.object({ id: uuid, created_at: isoDateTime, actor_name: z.string().nullable(), from_stage: z.string().nullable(), to_stage: z.string().nullable(), note: z.string().nullable() })),
  interviews_detail: z.array(z.object({
    id: uuid, scheduled_at: isoDateTime, duration_minutes: z.number().int(), location: z.string().nullable(), kind: z.enum(['phone', 'panel', 'practical', 'online']), status: z.enum(['scheduled', 'completed', 'cancelled', 'no_show']),
    panel: z.array(z.object({ user_id: uuid, name: z.string() })),
    feedback: z.array(z.object({ user_id: uuid, name: z.string(), recommendation: z.enum(['strong_yes', 'yes', 'no', 'strong_no']), scores: z.record(z.string(), z.number()), comment: z.string().nullable(), created_at: isoDateTime })),
  })),
  assessments: z.array(z.object({ id: uuid, name: z.string(), score: z.number(), max_score: z.number(), taken_on: isoDate, notes: z.string().nullable() })),
  offers: z.array(z.lazy(() => offer)),
});
export const moveApplication = z.object({ stage, note: optionalText(2000), rejection_reason: optionalText(500), rating: z.number().int().min(1).max(5).nullish() }).refine((v) => v.stage !== 'rejected' || !!v.rejection_reason, { path: ['rejection_reason'], message: 'Say why' });
/** HR adds a candidate who did not use the careers site (internal, referral, agency). */
export const addCandidate = z.object({ posting_id: uuid, first_name: name, last_name: name, email, phone: phone.nullish(), source: z.enum(['internal', 'referral', 'agency', 'other']), employee_id: uuid.nullish(), cv_document_id: uuid.nullish(), cover_note: optionalText(4000) });
export const scheduleInterview = z.object({ scheduled_at: isoDateTime, duration_minutes: z.number().int().min(10).max(480).default(45), location: optionalText(300), kind: z.enum(['phone', 'panel', 'practical', 'online']).default('panel'), panel_user_ids: z.array(uuid).min(1).max(10) });
export const updateInterview = z.object({ status: z.enum(['scheduled', 'completed', 'cancelled', 'no_show']) });
export const INTERVIEW_CRITERIA = { clinical_knowledge: 'Clinical or technical knowledge', communication: 'Communication', teamwork: 'Teamwork', patient_focus: 'Patient focus', experience: 'Relevant experience' } as const;
export const interviewFeedback = z.object({ recommendation: z.enum(['strong_yes', 'yes', 'no', 'strong_no']), scores: z.record(z.string(), z.number().int().min(1).max(5)).default({}), comment: optionalText(4000) });
export const myInterview = z.object({ id: uuid, application_id: uuid, candidate_name: z.string(), posting_title: z.string(), scheduled_at: isoDateTime, duration_minutes: z.number().int(), location: z.string().nullable(), kind: z.string(), status: z.string(), cv_document_id: uuid.nullable(), my_feedback: z.boolean() });
export const createAssessment = z.object({ name: z.string().trim().min(2).max(200), score: z.number().min(0), max_score: z.number().positive(), taken_on: isoDate, notes: optionalText(2000) }).refine((v) => v.score <= v.max_score, { path: ['score'], message: 'More than the maximum' });

// ---------------------------------------------------------------- offers
export const offer = z.object({
  id: uuid,
  number: z.string(),
  application_id: uuid,
  candidate_name: z.string(),
  position_id: uuid,
  position_title: z.string(),
  contract_type: z.string(),
  start_date: isoDate,
  end_date: isoDate.nullable(),
  basic: money,
  probation_months: z.number().int().nullable(),
  notice_days: z.number().int(),
  conditions: z.string().nullable(),
  status: z.enum(['pending', 'approved', 'rejected', 'returned', 'accepted', 'declined', 'withdrawn']),
  decision_comment: z.string().nullable(),
  workflow_instance_id: uuid.nullable(),
  letter_document_id: uuid.nullable(),
  responded_at: isoDateTime.nullable(),
  employee_id: uuid.nullable(),
  created_at: isoDateTime,
});
export const createOffer = z.object({
  position_id: uuid.optional(),
  contract_type: z.enum(['permanent', 'fixed_term', 'probation', 'locum', 'internship', 'casual']),
  start_date: isoDate,
  end_date: isoDate.nullish(),
  basic: money,
  probation_months: z.number().int().min(0).max(12).nullish(),
  notice_days: z.number().int().min(0).max(365).default(30),
  conditions: optionalText(4000),
});
export const respondOffer = z.object({ response: z.enum(['accepted', 'declined', 'withdrawn']), note: optionalText(1000) });
