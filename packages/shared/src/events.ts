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

export const EVENT_CATALOGUE = [
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
