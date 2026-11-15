import { z } from 'zod';
import { auditStamps, isoDate, isoDateTime, money, optionalText, uuid } from './common';

const points = z.string().regex(/^\d{1,3}(\.\d)?$/, 'Points with up to one decimal place');

// ---------------------------------------------------------------- programmes
export const PROGRAMME_CATEGORIES = {
  clinical: 'Clinical skills',
  mandatory: 'Mandatory',
  compliance: 'Compliance',
  induction: 'Induction',
  leadership: 'Leadership and management',
  technical: 'Technical and systems',
  soft_skills: 'Customer care and soft skills',
} as const;
export const DELIVERY_MODES = { classroom: 'Classroom', online: 'Online', on_the_job: 'On the job', external: 'External course', conference: 'Conference or seminar' } as const;
export const MANDATORY_FOR = { none: 'Not mandatory', all: 'All staff', clinical: 'Clinical staff' } as const;
const programmeCategory = z.enum(Object.keys(PROGRAMME_CATEGORIES) as [keyof typeof PROGRAMME_CATEGORIES, ...(keyof typeof PROGRAMME_CATEGORIES)[]]);
const delivery = z.enum(Object.keys(DELIVERY_MODES) as [keyof typeof DELIVERY_MODES, ...(keyof typeof DELIVERY_MODES)[]]);
const mandatoryFor = z.enum(['none', 'all', 'clinical']);

export const programme = z.object({
  id: uuid,
  code: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  category: programmeCategory,
  delivery,
  provider: z.string().nullable(),
  duration_hours: z.string(),
  /** CPD points earned by attending (and passing, when there is a pass mark). */
  cpd_points: points,
  /** Licensing bodies that recognise the points; empty = all. */
  cpd_bodies: z.array(z.string()),
  mandatory_for: mandatoryFor,
  /** Mandatory training must be repeated this often (e.g. BLS every 24 months); null = once. */
  refresh_months: z.number().int().nullable(),
  pass_mark: z.number().int().nullable(),
  status: z.enum(['active', 'inactive']),
  ...auditStamps,
});
export const upsertProgramme = z.object({
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9][A-Z0-9_-]{1,29}$/, 'Letters, digits, - and _'),
  title: z.string().trim().min(3).max(200),
  description: optionalText(4000),
  category: programmeCategory,
  delivery,
  provider: optionalText(200),
  duration_hours: z.string().regex(/^\d{1,4}(\.\d{1,2})?$/).default('0'),
  cpd_points: points.default('0'),
  cpd_bodies: z.array(z.string().trim().toUpperCase().min(2).max(20)).max(10).default([]),
  mandatory_for: mandatoryFor.default('none'),
  refresh_months: z.number().int().min(1).max(120).nullish(),
  pass_mark: z.number().int().min(1).max(100).nullish(),
  status: z.enum(['active', 'inactive']).default('active'),
});

// ---------------------------------------------------------------- sessions
export const SESSION_STATUSES = { scheduled: 'Scheduled', completed: 'Completed', cancelled: 'Cancelled' } as const;
export const session = z.object({
  id: uuid,
  number: z.string(),
  programme_id: uuid,
  programme_code: z.string(),
  programme_title: z.string(),
  cpd_points: points,
  starts_at: isoDateTime,
  ends_at: isoDateTime,
  venue: z.string().nullable(),
  trainer: z.string().nullable(),
  capacity: z.number().int().nullable(),
  /** Cost to the hospital per attendee; a request for a funded session needs HR approval too. */
  cost_per_person: money.nullable(),
  /** Staff may ask for a place themselves (the line manager approves). */
  open_for_requests: z.boolean(),
  status: z.enum(['scheduled', 'completed', 'cancelled']),
  enrolled: z.number().int(),
  attended: z.number().int(),
  requested: z.number().int(),
  ...auditStamps,
});
export const upsertSession = z
  .object({
    programme_id: uuid,
    starts_at: isoDateTime,
    ends_at: isoDateTime,
    venue: optionalText(200),
    trainer: optionalText(200),
    capacity: z.number().int().min(1).max(1000).nullish(),
    cost_per_person: money.nullish(),
    open_for_requests: z.boolean().default(true),
  })
  .refine((v) => v.ends_at > v.starts_at, { path: ['ends_at'], message: 'Must end after it starts' });

export const ENROLMENT_STATUSES = { requested: 'Requested', enrolled: 'Enrolled', attended: 'Attended', absent: 'Absent', withdrawn: 'Withdrawn', declined: 'Declined' } as const;
const enrolmentStatus = z.enum(['requested', 'enrolled', 'attended', 'absent', 'withdrawn', 'declined']);
export const enrolment = z.object({
  id: uuid,
  session_id: uuid,
  session_number: z.string(),
  programme_title: z.string(),
  starts_at: isoDateTime,
  ends_at: isoDateTime,
  venue: z.string().nullable(),
  employee_id: uuid,
  employee_name: z.string(),
  staff_number: z.string(),
  department_name: z.string().nullable(),
  status: enrolmentStatus,
  score: z.number().int().nullable(),
  passed: z.boolean().nullable(),
  cpd_points: points.nullable(),
  completed_on: isoDate.nullable(),
  feedback_rating: z.number().int().nullable(),
  feedback_comment: z.string().nullable(),
  decision_comment: z.string().nullable(),
  workflow_instance_id: uuid.nullable(),
});
export const sessionDetail = session.extend({ attendees: z.array(enrolment), pass_mark: z.number().int().nullable() });
export const enrolStaff = z.object({ employee_ids: z.array(uuid).min(1).max(200) });
export const requestPlace = z.object({ reason: optionalText(1000) });
export const recordAttendance = z.object({
  records: z.array(z.object({ enrolment_id: uuid, attended: z.boolean(), score: z.number().int().min(0).max(100).nullish() })).min(1).max(500),
});
export const trainingFeedback = z.object({ rating: z.number().int().min(1).max(5), comment: optionalText(2000) });

// ---------------------------------------------------------------- CPD
export const CPD_STATUSES = { pending: 'Waiting for verification', verified: 'Verified', rejected: 'Rejected' } as const;
export const cpdEntry = z.object({
  id: uuid,
  employee_id: uuid,
  employee_name: z.string(),
  staff_number: z.string(),
  source: z.enum(['training', 'external']),
  enrolment_id: uuid.nullable(),
  title: z.string(),
  provider: z.string().nullable(),
  activity_date: isoDate,
  points,
  licensing_body: z.string().nullable(),
  evidence_document_id: uuid.nullable(),
  status: z.enum(['pending', 'verified', 'rejected']),
  decision_comment: z.string().nullable(),
  verified_at: isoDateTime.nullable(),
  created_at: isoDateTime,
});
/** multipart/form-data fields of an outside-activity claim (the evidence file is `evidence`). */
export const cpdClaimFields = z.object({
  title: z.string().trim().min(3).max(300),
  provider: z.string().trim().max(200).optional(),
  activity_date: isoDate,
  points: z.string().regex(/^\d{1,3}(\.\d)?$/).refine((p) => Number(p) > 0 && Number(p) <= 100, 'Between 0.5 and 100'),
  licensing_body: z.string().trim().toUpperCase().max(20).optional(),
});
export const cpdDecision = z.object({ decision: z.enum(['verify', 'reject']), comment: optionalText(1000) }).refine((v) => v.decision === 'verify' || !!v.comment, { path: ['comment'], message: 'Say why' });
export const cpdRequirement = z.object({ licensing_body: z.string(), points_per_year: points, description: z.string().nullable() });
export const setCpdRequirements = z.object({ requirements: z.array(z.object({ licensing_body: z.string().trim().toUpperCase().min(2).max(20), points_per_year: points, description: optionalText(300) })).max(30) });
export const cpdComplianceRow = z.object({
  employee_id: uuid,
  employee_name: z.string(),
  staff_number: z.string(),
  department_name: z.string().nullable(),
  licensing_body: z.string(),
  licence_expiry: isoDate.nullable(),
  required: points,
  earned: points,
  pending: points,
  status: z.enum(['met', 'short', 'no_requirement']),
});
export const myCpd = z.object({ year: z.number().int(), entries: z.array(cpdEntry), summary: z.array(cpdComplianceRow) });

// ---------------------------------------------------------------- mandatory training compliance
export const MANDATORY_STATES = { current: 'Current', due_soon: 'Due within 60 days', overdue: 'Overdue', never: 'Never done' } as const;
export const mandatoryRow = z.object({
  employee_id: uuid,
  employee_name: z.string(),
  staff_number: z.string(),
  department_name: z.string().nullable(),
  programme_id: uuid,
  programme_title: z.string(),
  last_completed: isoDate.nullable(),
  due_on: isoDate.nullable(),
  state: z.enum(['current', 'due_soon', 'overdue', 'never']),
});
export const mandatoryCompliance = z.object({
  programmes: z.array(z.object({ programme_id: uuid, programme_title: z.string(), staff: z.number().int(), current: z.number().int(), due_soon: z.number().int(), overdue: z.number().int(), never: z.number().int() })),
  /** Only the people who are not current, worst first. */
  gaps: z.array(mandatoryRow),
});
export const myTraining = z.object({ enrolments: z.array(enrolment), mandatory: z.array(mandatoryRow), open_sessions: z.array(session) });
