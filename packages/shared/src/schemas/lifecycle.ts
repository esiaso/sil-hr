import { z } from 'zod';
import { auditStamps, isoDate, isoDateTime, money, name, optionalText, uuid } from './common';

// ---------------------------------------------------------------- contracts
export const CONTRACT_TYPES = { permanent: 'Permanent', fixed_term: 'Fixed term', probation: 'Probation', locum: 'Locum', internship: 'Internship', casual: 'Casual' } as const;
const contractType = z.enum(Object.keys(CONTRACT_TYPES) as [keyof typeof CONTRACT_TYPES]);
export const contract = z.object({
  id: uuid,
  number: z.string(),
  employee_id: uuid,
  employee_name: z.string().optional(),
  staff_number: z.string().optional(),
  contract_type: contractType,
  position_id: uuid.nullable(),
  position_title: z.string().nullable().optional(),
  start_date: isoDate,
  end_date: isoDate.nullable(),
  probation_months: z.number().int().nullable(),
  notice_days: z.number().int(),
  basic: money.nullable(),
  terms: z.string().nullable(),
  document_id: uuid.nullable(),
  status: z.enum(['draft', 'active', 'ended', 'renewed', 'terminated']),
  renewed_from_id: uuid.nullable(),
  /** Days until the end date, for fixed-term contracts. */
  days_left: z.number().int().nullable(),
  ...auditStamps,
});
export type Contract = z.infer<typeof contract>;
export const createContract = z
  .object({
    employee_id: uuid,
    contract_type: contractType,
    position_id: uuid.nullish(),
    start_date: isoDate,
    end_date: isoDate.nullish(),
    probation_months: z.number().int().min(0).max(12).nullish(),
    notice_days: z.number().int().min(0).max(365).default(30),
    basic: money.nullish(),
    terms: optionalText(4000),
    document_id: uuid.nullish(),
  })
  .refine((v) => !v.end_date || v.end_date >= v.start_date, { path: ['end_date'], message: 'Ends before it starts' })
  .refine((v) => !['fixed_term', 'locum', 'internship'].includes(v.contract_type) || !!v.end_date, { path: ['end_date'], message: 'A fixed-term contract needs an end date' });
export const contractQuery = z.object({ employee_id: uuid.optional(), expiring_within_days: z.coerce.number().int().min(0).max(730).optional(), status: z.enum(['draft', 'active', 'ended', 'renewed', 'terminated']).optional() });

// ---------------------------------------------------------------- lifecycle requests
export const LIFECYCLE_KINDS = {
  promotion: 'Promotion',
  transfer: 'Transfer',
  confirmation: 'Confirmation after probation',
  contract_renewal: 'Contract renewal',
  resignation: 'Resignation',
  termination: 'Termination',
  final_dues: 'Final dues',
} as const;
export type LifecycleKind = keyof typeof LIFECYCLE_KINDS;
export const EXIT_KINDS = { resignation: 'Resignation', termination: 'Termination', contract_end: 'End of contract', retirement: 'Retirement', death: 'Death in service', other: 'Other' } as const;

const reason = z.string().trim().min(3).max(2000);
export const createLifecycleRequest = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('promotion'), employee_id: uuid, effective_date: isoDate, position_id: uuid, manager_id: uuid.nullish(), new_basic: money.nullish(), reason }),
  z.object({ kind: z.literal('transfer'), employee_id: uuid, effective_date: isoDate, position_id: uuid, manager_id: uuid.nullish(), reason }),
  z.object({ kind: z.literal('confirmation'), employee_id: uuid, effective_date: isoDate, reason }),
  z.object({ kind: z.literal('contract_renewal'), employee_id: uuid, effective_date: isoDate, end_date: isoDate.nullish(), contract_type: contractType.default('fixed_term'), new_basic: money.nullish(), notice_days: z.number().int().min(0).max(365).optional(), reason }),
  z.object({ kind: z.literal('resignation'), employee_id: uuid, effective_date: isoDate, notice_given_on: isoDate, document_id: uuid.nullish(), reason }),
  z.object({ kind: z.literal('termination'), employee_id: uuid, effective_date: isoDate, exit_kind: z.enum(['termination', 'contract_end', 'retirement', 'death', 'other']).default('termination'), pay_notice_in_lieu: z.boolean().default(false), reason }),
]);
export type CreateLifecycleRequest = z.infer<typeof createLifecycleRequest>;
export const lifecycleRequest = z.object({
  id: uuid,
  number: z.string(),
  kind: z.enum(Object.keys(LIFECYCLE_KINDS) as [LifecycleKind]),
  employee_id: uuid,
  employee_name: z.string(),
  staff_number: z.string(),
  effective_date: isoDate,
  details: z.record(z.string(), z.unknown()),
  reason: z.string().nullable(),
  status: z.enum(['pending', 'approved', 'rejected', 'returned', 'cancelled']),
  decision_comment: z.string().nullable(),
  workflow_instance_id: uuid.nullable(),
  result: z.record(z.string(), z.unknown()).nullable(),
  created_at: isoDateTime,
});

// ---------------------------------------------------------------- checklists
export const ASSIGNEES = { hr: 'HR', it: 'IT', facilities: 'Facilities', finance: 'Finance', line_manager: 'Line manager', employee: 'The employee' } as const;
export type AssigneeGroup = keyof typeof ASSIGNEES;
const assignee = z.enum(Object.keys(ASSIGNEES) as [AssigneeGroup]);
export const checklistTemplateTask = z.object({ id: uuid.optional(), title: z.string().trim().min(2).max(200), description: optionalText(1000), assignee, due_offset_days: z.number().int().min(-365).max(365).default(0), blocks_exit: z.boolean().default(false) });
export const checklistTemplate = z.object({ id: uuid, code: z.string(), name: z.string(), kind: z.enum(['onboarding', 'offboarding']), employment_types: z.array(z.string()), is_default: z.boolean(), status: z.enum(['active', 'inactive']), tasks: z.array(checklistTemplateTask.extend({ id: uuid })), version: z.number().int() });
export const upsertChecklistTemplate = z.object({
  code: z.string().trim().min(2).max(30).regex(/^[A-Z][A-Z0-9_-]*$/),
  name,
  kind: z.enum(['onboarding', 'offboarding']),
  employment_types: z.array(z.string()).max(10).default([]),
  is_default: z.boolean().default(false),
  status: z.enum(['active', 'inactive']).default('active'),
  tasks: z.array(checklistTemplateTask).min(1).max(100),
});
export const checklistTask = z.object({
  id: uuid, checklist_id: uuid, seq: z.number().int(), title: z.string(), description: z.string().nullable(), assignee, due_date: isoDate, blocks_exit: z.boolean(),
  status: z.enum(['open', 'done', 'not_applicable']), done_by_name: z.string().nullable(), done_at: isoDateTime.nullable(), note: z.string().nullable(),
  employee_id: uuid.optional(), employee_name: z.string().optional(), kind: z.enum(['onboarding', 'offboarding']).optional(),
});
export const checklist = z.object({
  id: uuid, employee_id: uuid, employee_name: z.string(), staff_number: z.string(), kind: z.enum(['onboarding', 'offboarding']), anchor_date: isoDate, status: z.enum(['open', 'completed', 'cancelled']),
  done: z.number().int(), total: z.number().int(), overdue: z.number().int(), tasks: z.array(checklistTask), created_at: isoDateTime,
});
export const updateChecklistTask = z.object({ status: z.enum(['open', 'done', 'not_applicable']), note: optionalText(1000) });

// ---------------------------------------------------------------- exit clearance
export const procurementClearance = z.object({
  reachable: z.boolean(),
  error: z.string().nullable(),
  cleared: z.boolean().nullable(),
  blockers: z.array(z.string()),
  assets: z.array(z.object({ tagNo: z.string(), description: z.string().nullable(), serialNo: z.string().nullable().optional(), location: z.string().nullable().optional(), cost: z.union([z.string(), z.number()]).nullable().optional() })),
  outstanding_advances: z.array(z.object({ number: z.string(), purpose: z.string().nullable().optional(), amount: z.union([z.string(), z.number()]), overdue: z.boolean().optional() })),
  petty_cash_floats: z.array(z.object({ code: z.string(), name: z.string().nullable().optional(), balance: z.union([z.string(), z.number()]).nullable().optional() })),
  checked_at: isoDateTime.nullable(),
});
export const exitClearance = z.object({
  id: uuid,
  employee_id: uuid,
  employee_name: z.string(),
  staff_number: z.string(),
  exit_date: isoDate,
  exit_kind: z.enum(Object.keys(EXIT_KINDS) as [keyof typeof EXIT_KINDS]),
  notice_days: z.number().int(),
  notice_served_days: z.number().int(),
  procurement: procurementClearance,
  loans_outstanding: money,
  leave_days: z.number(),
  leave_pay: money,
  notice_pay: money,
  checklist_open_blocking: z.number().int(),
  /** Nothing blocks the exit: procurement cleared and blocking checklist tasks done. */
  ready: z.boolean(),
  final_dues_status: z.enum(['draft', 'submitted', 'approved', 'posted']),
  final_dues_request_id: uuid.nullable(),
  completed_at: isoDateTime.nullable(),
  version: z.number().int(),
});
export const completeExit = z.object({ override_reason: optionalText(500) });

// ---------------------------------------------------------------- employee relations
export const CASE_KINDS = { warning: 'Warning', improvement_plan: 'Performance improvement plan', complaint: 'Complaint or grievance', award: 'Award or recognition', disciplinary: 'Disciplinary case' } as const;
export type CaseKind = keyof typeof CASE_KINDS;
export const improvementObjective = z.object({ id: uuid.optional(), objective: z.string().trim().min(3).max(1000), measure: optionalText(1000), due_date: isoDate.nullish(), status: z.enum(['open', 'met', 'not_met']).default('open'), comment: optionalText(1000) });
export const relationsCase = z.object({
  id: uuid,
  number: z.string(),
  kind: z.enum(Object.keys(CASE_KINDS) as [CaseKind]),
  employee_id: uuid.nullable(),
  employee_name: z.string().nullable(),
  subject: z.string(),
  details: z.string().nullable(),
  severity: z.enum(['verbal', 'first', 'final']).nullable(),
  opened_on: isoDate,
  review_date: isoDate.nullable(),
  expires_on: isoDate.nullable(),
  status: z.enum(['open', 'closed', 'withdrawn']),
  outcome: z.string().nullable(),
  restricted: z.boolean(),
  /** Only on cases the caller may see in full. */
  complainant_name: z.string().nullable(),
  acknowledged_at: isoDateTime.nullable(),
  document_ids: z.array(uuid),
  objectives: z.array(improvementObjective.extend({ id: uuid })),
  notes: z.array(z.object({ id: uuid, created_at: isoDateTime, author_name: z.string().nullable(), body: z.string(), visible_to_employee: z.boolean() })),
  access: z.array(z.object({ user_id: uuid, name: z.string(), role: z.enum(['owner', 'investigator']) })),
  ...auditStamps,
});
export const createRelationsCase = z
  .object({
    kind: z.enum(Object.keys(CASE_KINDS) as [CaseKind]),
    employee_id: uuid.nullish(),
    subject: z.string().trim().min(3).max(300),
    details: optionalText(8000),
    severity: z.enum(['verbal', 'first', 'final']).nullish(),
    opened_on: isoDate.optional(),
    review_date: isoDate.nullish(),
    expires_on: isoDate.nullish(),
    complainant_employee_id: uuid.nullish(),
    /** Complaints are always restricted; other kinds may be. */
    restricted: z.boolean().optional(),
    investigator_user_ids: z.array(uuid).max(10).default([]),
    objectives: z.array(improvementObjective).max(20).default([]),
    document_ids: z.array(uuid).max(20).default([]),
  })
  .refine((v) => v.kind === 'complaint' || !!v.employee_id, { path: ['employee_id'], message: 'Choose the employee' })
  .refine((v) => v.kind !== 'warning' || !!v.severity, { path: ['severity'], message: 'Choose the level of warning' });
export const updateRelationsCase = z.object({
  status: z.enum(['open', 'closed', 'withdrawn']).optional(),
  outcome: optionalText(4000),
  review_date: isoDate.nullish(),
  objectives: z.array(improvementObjective).max(20).optional(),
  investigator_user_ids: z.array(uuid).max(10).optional(),
});
export const addRelationsNote = z.object({ body: z.string().trim().min(1).max(4000), visible_to_employee: z.boolean().default(false) });
/** Staff raise their own grievance; it is restricted from the start. */
export const raiseComplaint = z.object({ subject: z.string().trim().min(3).max(300), details: z.string().trim().min(10).max(8000), about_employee_id: uuid.nullish(), document_ids: z.array(uuid).max(10).default([]) });

// ---------------------------------------------------------------- letters
export const LETTER_FIELDS = {
  'employee.full_name': 'Full name', 'employee.first_name': 'First name', 'employee.staff_number': 'Staff number', 'employee.position': 'Position', 'employee.department': 'Department',
  'employee.branch': 'Branch', 'employee.hire_date': 'Date joined', 'employee.exit_date': 'Exit date', 'employee.employment_type': 'Employment type', 'employee.basic_salary': 'Basic salary (KES)',
  'employee.national_id_last4': 'National ID (last 4)', 'contract.number': 'Contract number', 'contract.start_date': 'Contract start', 'contract.end_date': 'Contract end',
  'contract.notice_days': 'Notice (days)', 'organisation.name': 'Organisation', 'organisation.address': 'Organisation address', 'today': 'Today’s date', 'letter.number': 'Letter number',
  'signatory.name': 'Signed by (name)', 'signatory.title': 'Signed by (title)',
} as const;
export const letterTemplate = z.object({ id: uuid, code: z.string(), name: z.string(), body: z.string(), status: z.enum(['active', 'inactive']), fields: z.array(z.string()), version: z.number().int() });
export const upsertLetterTemplate = z.object({ code: z.string().trim().min(2).max(30).regex(/^[A-Z][A-Z0-9_-]*$/), name, body: z.string().min(10).max(50000), status: z.enum(['active', 'inactive']).default('active') });
export const issueLetter = z.object({ template_id: uuid, employee_id: uuid, format: z.enum(['pdf', 'docx']).default('pdf'), extra: z.record(z.string(), z.string().max(500)).default({}) });
export const issuedLetter = z.object({ id: uuid, number: z.string(), template_id: uuid, template_name: z.string(), employee_id: uuid, employee_name: z.string(), format: z.enum(['pdf', 'docx']), document_id: uuid, created_at: isoDateTime });
