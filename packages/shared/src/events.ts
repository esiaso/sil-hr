import { z } from 'zod';

/**
 * Event catalogue. Every event HR emits is declared here with its payload schema.
 * Payloads carry ids and non-sensitive fields only; consumers fetch detail through the
 * API with their own scopes. A type's payload never changes incompatibly: a breaking
 * change is a new version (`.v2`) published alongside the old one for a transition period.
 */

/** CloudEvents 1.0 structured-mode envelope. */
export interface CloudEvent<T = Record<string, unknown>> {
  specversion: '1.0';
  id: string;
  source: string;
  type: string;
  subject: string;
  time: string;
  datacontenttype: 'application/json';
  dataschema?: string;
  /** Extension: correlation id of the request or job that caused the change. */
  correlationid?: string;
  data: T;
}

const id = z.uuid();
const status = z.enum(['active', 'inactive']);

const departmentData = z.object({
  id,
  code: z.string(),
  name: z.string(),
  branch_id: id,
  parent_id: id.nullable(),
  cost_centre_id: id.nullable(),
  status,
  path: z.array(id),
});
const branchData = z.object({ id, code: z.string(), name: z.string(), status });
const costCentreData = z.object({ id, code: z.string(), name: z.string(), status });
const positionData = z.object({
  id,
  code: z.string(),
  title: z.string(),
  department_id: id,
  job_grade_id: id.nullable(),
  reports_to_position_id: id.nullable(),
  headcount: z.number().int(),
  status,
});
const changed = <T extends z.ZodObject>(shape: T) =>
  shape.extend({ changed_fields: z.array(z.string()) });

export interface EventDefinition {
  type: string;
  description: string;
  /** What `subject` holds. */
  subject: string;
  schema: z.ZodType;
  example: Record<string, unknown>;
}

const D1 = '0199a6b0-0000-7000-8000-000000000001';
const B1 = '0199a6b0-0000-7000-8000-0000000000b1';
const C1 = '0199a6b0-0000-7000-8000-0000000000c1';
const E1 = '0199a6b0-0000-7000-8000-0000000000e1';
const P1 = '0199a6b0-0000-7000-8000-0000000000f1';

const employmentType = z.enum(['permanent', 'contract', 'casual', 'locum', 'intern']);
const employeeStatus = z.enum(['onboarding', 'probation', 'active', 'on_notice', 'suspended', 'exited']);
/** People events carry no personal identifiers beyond the name and work contacts. */
const employeeData = z.object({
  id,
  staff_number: z.string(),
  display_name: z.string(),
  status: employeeStatus,
  employment_type: employmentType,
  branch_id: id.nullable(),
  department_id: id.nullable(),
  position_id: id.nullable(),
  cost_centre_id: id.nullable(),
  manager_id: id.nullable(),
  work_email: z.string().nullable(),
  user_id: id.nullable(),
});
const employeeExample = {
  id: E1, staff_number: 'SIL00042', display_name: 'Jane Wambui', status: 'active', employment_type: 'permanent',
  branch_id: B1, department_id: D1, position_id: P1, cost_centre_id: C1, manager_id: null, work_email: 'jane.wambui@example.org', user_id: null,
};
const licenceData = z.object({
  id,
  employee_id: id,
  staff_number: z.string(),
  licensing_body: z.string(),
  licence_number: z.string(),
  expiry_date: z.string(),
  status: z.enum(['valid', 'expiring', 'expired', 'suspended', 'not_verified']),
});
const licenceExample = { id: P1, employee_id: E1, staff_number: 'SIL00042', licensing_body: 'NCK', licence_number: 'NCK/12345', expiry_date: '2026-12-31', status: 'expiring' };

const leaveData = z.object({
  id,
  number: z.string(),
  employee_id: id,
  staff_number: z.string(),
  leave_type_code: z.string(),
  start_date: z.string(),
  end_date: z.string(),
  start_half_day: z.boolean(),
  end_half_day: z.boolean(),
  days: z.number(),
  is_paid: z.boolean(),
});
const leaveExample = { id: P1, number: 'LV/2026/0042', employee_id: E1, staff_number: 'SIL00042', leave_type_code: 'annual', start_date: '2026-12-21', end_date: '2026-12-31', start_half_day: false, end_half_day: false, days: 7, is_paid: true };

export const EVENT_CATALOGUE = [
  {
    type: 'hr.roster.changed.v1',
    description: 'Planned shifts changed for some people over a date range. Fetch GET /api/v1/rosters for the detail (clinical systems use it to know who is on duty).',
    subject: 'department id, or employee id when no department applies',
    schema: z.object({ department_id: id.nullable(), employee_ids: z.array(id), from: z.string(), to: z.string() }),
    example: { department_id: D1, employee_ids: [E1], from: '2026-12-01', to: '2026-12-07' },
  },
  {
    type: 'hr.leave.approved.v1',
    description: 'A leave request was finally approved. Attendance and payroll treat these days as leave; rosters should plan around them.',
    subject: 'leave request id',
    schema: leaveData,
    example: leaveExample,
  },
  {
    type: 'hr.leave.cancelled.v1',
    description: 'Previously approved leave was cancelled; the days are back in the balance and the person is expected at work.',
    subject: 'leave request id',
    schema: leaveData,
    example: leaveExample,
  },
  {
    type: 'hr.employee.hired.v1',
    description: 'A person was hired: the employee record and its first position assignment exist.',
    subject: 'employee id',
    schema: employeeData.extend({ hire_date: z.string() }),
    example: { ...employeeExample, status: 'probation', hire_date: '2026-11-01' },
  },
  {
    type: 'hr.employee.updated.v1',
    description: 'Non-sensitive employee fields changed (name, work contacts, employment type). `changed_fields` lists them; sensitive fields are reported only as changed, never with values.',
    subject: 'employee id',
    schema: employeeData.extend({ changed_fields: z.array(z.string()) }),
    example: { ...employeeExample, changed_fields: ['work_email'] },
  },
  {
    type: 'hr.employee.transferred.v1',
    description: 'The employee moved to another position (and possibly department, branch, cost centre or manager) from `effective_from`.',
    subject: 'employee id',
    schema: employeeData.extend({
      effective_from: z.string(),
      previous: z.object({ position_id: id.nullable(), department_id: id.nullable(), branch_id: id.nullable(), cost_centre_id: id.nullable(), manager_id: id.nullable() }),
    }),
    example: { ...employeeExample, effective_from: '2026-12-01', previous: { position_id: null, department_id: null, branch_id: null, cost_centre_id: null, manager_id: null } },
  },
  {
    type: 'hr.employee.status_changed.v1',
    description: 'Employment status changed (probation → active, suspended, on notice…). Exits also publish hr.employee.exited.v1.',
    subject: 'employee id',
    schema: employeeData.extend({ previous_status: employeeStatus, effective_date: z.string() }),
    example: { ...employeeExample, previous_status: 'probation', effective_date: '2026-11-01' },
  },
  {
    type: 'hr.employee.exited.v1',
    description: 'The employee left. Deprovision their access: SCIM marks the user inactive at the same time.',
    subject: 'employee id',
    schema: employeeData.extend({ exit_date: z.string() }),
    example: { ...employeeExample, status: 'exited', exit_date: '2026-11-30' },
  },
  {
    type: 'hr.employee.manager_changed.v1',
    description: 'The employee’s line manager changed. Approval routing for them changes with it.',
    subject: 'employee id',
    schema: employeeData.extend({ previous_manager_id: id.nullable() }),
    example: { ...employeeExample, previous_manager_id: null },
  },
  {
    type: 'hr.licence.updated.v1',
    description: 'A professional licence was recorded or changed (renewed, verified, suspended).',
    subject: 'licence id',
    schema: licenceData,
    example: { ...licenceExample, status: 'valid' },
  },
  {
    type: 'hr.licence.expiring.v1',
    description: 'A licence entered its reminder window (default 60 days before expiry). Sent once per licence and expiry date.',
    subject: 'licence id',
    schema: licenceData.extend({ days_to_expiry: z.number().int() }),
    example: { ...licenceExample, days_to_expiry: 45 },
  },
  {
    type: 'hr.licence.expired.v1',
    description: 'A licence lapsed. Clinical systems (HMIS) should stop treating the practitioner as licensed.',
    subject: 'licence id',
    schema: licenceData,
    example: { ...licenceExample, status: 'expired' },
  },
  {
    type: 'hr.organisation.branch.created.v1',
    description: 'A branch (site) was created.',
    subject: 'branch id',
    schema: branchData,
    example: { id: B1, code: 'MAIN', name: 'Main Hospital', status: 'active' },
  },
  {
    type: 'hr.organisation.branch.updated.v1',
    description: 'A branch changed (name, code or status). `changed_fields` lists what changed.',
    subject: 'branch id',
    schema: changed(branchData),
    example: { id: B1, code: 'MAIN', name: 'Main Hospital', status: 'inactive', changed_fields: ['status'] },
  },
  {
    type: 'hr.organisation.department.created.v1',
    description: 'A department was created.',
    subject: 'department id',
    schema: departmentData,
    example: { id: D1, code: 'NURS', name: 'Nursing', branch_id: B1, parent_id: null, cost_centre_id: C1, status: 'active', path: [] },
  },
  {
    type: 'hr.organisation.department.updated.v1',
    description:
      'A department changed: renamed, recoded, moved in the tree (`parent_id`, `path`), re-costed or (de)activated. `changed_fields` lists what changed.',
    subject: 'department id',
    schema: changed(departmentData),
    example: { id: D1, code: 'NURS', name: 'Nursing Services', branch_id: B1, parent_id: null, cost_centre_id: C1, status: 'active', path: [], changed_fields: ['name'] },
  },
  {
    type: 'hr.organisation.department.deleted.v1',
    description: 'A department was soft-deleted. It stays readable through the API as a tombstone.',
    subject: 'department id',
    schema: z.object({ id, code: z.string() }),
    example: { id: D1, code: 'NURS' },
  },
  {
    type: 'hr.organisation.cost_centre.created.v1',
    description: 'A cost centre was created.',
    subject: 'cost centre id',
    schema: costCentreData,
    example: { id: C1, code: 'CC-NURS', name: 'Nursing', status: 'active' },
  },
  {
    type: 'hr.organisation.cost_centre.updated.v1',
    description: 'A cost centre changed. `changed_fields` lists what changed.',
    subject: 'cost centre id',
    schema: changed(costCentreData),
    example: { id: C1, code: 'CC-NURS', name: 'Nursing Services', status: 'active', changed_fields: ['name'] },
  },
  {
    type: 'hr.organisation.position.created.v1',
    description: 'A position (with its headcount) was created.',
    subject: 'position id',
    schema: positionData,
    example: { id: D1, code: 'RN', title: 'Registered Nurse', department_id: D1, job_grade_id: null, reports_to_position_id: null, headcount: 40, status: 'active' },
  },
  {
    type: 'hr.organisation.position.updated.v1',
    description: 'A position changed (title, headcount, grade, reporting line, status). `changed_fields` lists what changed.',
    subject: 'position id',
    schema: changed(positionData),
    example: { id: D1, code: 'RN', title: 'Registered Nurse', department_id: D1, job_grade_id: null, reports_to_position_id: null, headcount: 42, status: 'active', changed_fields: ['headcount'] },
  },
  {
    type: 'hr.payroll.run.approved.v1',
    description: 'A payroll run was finally approved; its payslips are locked. Finance fetches the journal (GET /api/v1/payroll/runs/{id}/journal, scope payroll.journal:read).',
    subject: 'payroll run id',
    schema: z.object({ id, number: z.string(), period: z.string(), pay_date: z.string(), employees: z.number().int(), gross: z.string(), net: z.string(), employer_cost: z.string() }),
    example: { id: '0199a6b0-0000-7000-8000-0000000000a1', number: 'PR/2026/11', period: '2026-11', pay_date: '2026-11-27', employees: 412, gross: '41250000.00', net: '30112500.00', employer_cost: '42330000.00' },
  },
  {
    type: 'hr.payroll.run.paid.v1',
    description: 'The salaries of an approved payroll run were paid (recorded by finance).',
    subject: 'payroll run id',
    schema: z.object({ id, number: z.string(), period: z.string(), paid_at: z.string() }),
    example: { id: '0199a6b0-0000-7000-8000-0000000000a1', number: 'PR/2026/11', period: '2026-11', paid_at: '2026-11-27T09:12:00Z' },
  },
  {
    type: 'hr.medical.enrolled.v1',
    description: 'A member (staff or dependant) joined a medical scheme. Billing systems can start accepting the member number from cover_start.',
    subject: 'medical member id',
    schema: z.object({ id, employee_id: id, scheme_id: id, member_number: z.string(), relationship: z.enum(['principal', 'spouse', 'child', 'other']), cover_start: z.string() }),
    example: { id: '0199a6b0-0000-7000-8000-0000000000d1', employee_id: E1, scheme_id: '0199a6b0-0000-7000-8000-0000000000d0', member_number: 'MED-SIL00042-00', relationship: 'principal', cover_start: '2026-12-01' },
  },
  {
    type: 'hr.medical.claim_posted.v1',
    description: 'A claim was posted against a medical limit (no diagnosis is ever recorded).',
    subject: 'medical member id',
    schema: z.object({ id, member_id: id, member_number: z.string(), category: z.string(), scheme_amount: z.string(), invoice_amount: z.string().nullable(), occurred_on: z.string(), facility: z.string().nullable(), source: z.enum(['web', 'api', 'system']) }),
    example: { id: '0199a6b0-0000-7000-8000-0000000000d2', member_id: '0199a6b0-0000-7000-8000-0000000000d1', member_number: 'MED-SIL00042-00', category: 'outpatient', scheme_amount: '4500.00', invoice_amount: '5000.00', occurred_on: '2026-12-03', facility: 'SIL Hospital OPD', source: 'api' },
  },
  {
    type: 'hr.medical.limit_threshold.v1',
    description: 'A medical limit reached 80% or 100% of its value for the scheme year.',
    subject: 'medical member id (the limit holder)',
    schema: z.object({ member_id: id, employee_id: id, category: z.string(), scheme_year: z.number().int(), threshold: z.number().int(), utilisation_pct: z.number(), remaining: z.string() }),
    example: { member_id: '0199a6b0-0000-7000-8000-0000000000d1', employee_id: E1, category: 'outpatient', scheme_year: 2026, threshold: 80, utilisation_pct: 82.5, remaining: '8750.00' },
  },
  {
    type: 'hr.medical.cover_ended.v1',
    description: 'A member\'s cover ended (the employee left, a dependant was removed, or the scheme closed). Stop accepting the member number after cover_end.',
    subject: 'medical member id',
    schema: z.object({ id, employee_id: id, scheme_id: id, member_number: z.string(), cover_end: z.string(), reason: z.string() }),
    example: { id: '0199a6b0-0000-7000-8000-0000000000d1', employee_id: E1, scheme_id: '0199a6b0-0000-7000-8000-0000000000d0', member_number: 'MED-SIL00042-00', cover_end: '2026-12-31', reason: 'Employee left' },
  },
  {
    type: 'hr.webhook.test.v1',
    description: 'Sent only to one subscription when an administrator presses "Send test event".',
    subject: 'subscription id',
    schema: z.object({ message: z.string() }),
    example: { message: 'Test event from SIL HR' },
  },
] as const satisfies readonly EventDefinition[];

export type EventType = (typeof EVENT_CATALOGUE)[number]['type'];
export const EVENT_TYPES = EVENT_CATALOGUE.map((e) => e.type) as EventType[];

export type EventData<T extends EventType> = z.infer<Extract<(typeof EVENT_CATALOGUE)[number], { type: T }>['schema']>;

export function eventDefinition(type: string): EventDefinition | undefined {
  return (EVENT_CATALOGUE as readonly EventDefinition[]).find((e) => e.type === type);
}

/** Webhook signing (Standard Webhooks): headers HR sends with every delivery. */
export const WEBHOOK_HEADERS = {
  id: 'webhook-id',
  timestamp: 'webhook-timestamp',
  signature: 'webhook-signature',
} as const;
