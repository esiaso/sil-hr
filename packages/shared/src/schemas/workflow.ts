import { z } from 'zod';
import { auditStamps, isoDate, isoDateTime, listQuery, name, optionalText, uuid } from './common';

/**
 * Generic approval workflows. Every kind of request (leave, contact change, and later
 * requisitions, offers, contracts, promotions, transfers, terminations, trips, payroll
 * runs) is submitted to the engine; administrators decide the chains as data.
 */
export const REQUEST_TYPES = {
  leave_request: 'Leave request',
  contact_change: 'Self-service contact change',
} as const;
export type RequestType = keyof typeof REQUEST_TYPES;
export const REQUEST_TYPE_CODES = Object.keys(REQUEST_TYPES) as RequestType[];

/** How a step finds its approver. */
export const APPROVER_RULES = ['line_manager', 'manager_level', 'department_head', 'role', 'user'] as const;
export type ApproverRule = (typeof APPROVER_RULES)[number];

export const workflowConditions = z
  .object({
    /** Only for these leave types (codes) / sub-kinds of the request. */
    kinds: z.array(z.string()).optional(),
    employment_types: z.array(z.string()).optional(),
    /** Department and everything under it. */
    department_ids: z.array(uuid).optional(),
    min_value: z.number().optional(),
    max_value: z.number().optional(),
  })
  .strict();
export type WorkflowConditions = z.infer<typeof workflowConditions>;

export const stepInput = z
  .object({
    name: z.string().trim().min(1).max(100),
    approver_rule: z.enum(APPROVER_RULES),
    /** manager_level: 1 = line manager, 2 = their manager… */
    level: z.number().int().min(1).max(10).nullish(),
    role_id: uuid.nullish(),
    user_id: uuid.nullish(),
    /** Skip this step unless the request's value (days for leave) is at least this. */
    min_value: z.number().nullish(),
    escalate_after_hours: z.number().int().min(1).max(24 * 30).nullish(),
    /** Who gets it when it escalates: the approver's manager, or a role. */
    escalate_to: z.enum(['next_manager', 'role']).nullish(),
    escalate_role_id: uuid.nullish(),
  })
  .superRefine((s, ctx) => {
    if (s.approver_rule === 'role' && !s.role_id) ctx.addIssue({ code: 'custom', path: ['role_id'], message: 'Choose a role' });
    if (s.approver_rule === 'user' && !s.user_id) ctx.addIssue({ code: 'custom', path: ['user_id'], message: 'Choose a person' });
    if (s.approver_rule === 'manager_level' && !s.level) ctx.addIssue({ code: 'custom', path: ['level'], message: 'Choose a level' });
    if (s.escalate_to === 'role' && !s.escalate_role_id) ctx.addIssue({ code: 'custom', path: ['escalate_role_id'], message: 'Choose a role' });
  });
export type StepInput = z.infer<typeof stepInput>;

export const workflowStep = z.object({
  id: uuid,
  step_no: z.number().int(),
  name: z.string(),
  approver_rule: z.enum(APPROVER_RULES),
  level: z.number().int().nullable(),
  role_id: uuid.nullable(),
  user_id: uuid.nullable(),
  min_value: z.number().nullable(),
  escalate_after_hours: z.number().int().nullable(),
  escalate_to: z.enum(['next_manager', 'role']).nullable(),
  escalate_role_id: uuid.nullable(),
});

export const workflowDefinition = z.object({
  id: uuid,
  code: z.string(),
  name: z.string(),
  request_type: z.string(),
  description: z.string().nullable(),
  conditions: workflowConditions,
  priority: z.number().int(),
  is_active: z.boolean(),
  steps: z.array(workflowStep),
  ...auditStamps,
});
export type WorkflowDefinition = z.infer<typeof workflowDefinition>;

export const upsertWorkflowDefinition = z.object({
  code: z.string().trim().min(2).max(40).regex(/^[A-Za-z0-9_-]+$/),
  name,
  request_type: z.enum(REQUEST_TYPE_CODES as [RequestType, ...RequestType[]]),
  description: optionalText(500),
  conditions: workflowConditions.default({}),
  /** Among matching definitions the highest priority wins. */
  priority: z.number().int().min(0).max(1000).default(100),
  is_active: z.boolean().default(true),
  steps: z.array(stepInput).min(1).max(10),
});
export type UpsertWorkflowDefinition = z.infer<typeof upsertWorkflowDefinition>;

export const TASK_STATUSES = ['open', 'approved', 'rejected', 'returned', 'escalated', 'skipped', 'cancelled'] as const;
export const INSTANCE_STATUSES = ['pending', 'approved', 'rejected', 'returned', 'cancelled'] as const;

export const workflowTask = z.object({
  id: uuid,
  instance_id: uuid,
  step_no: z.number().int(),
  step_name: z.string(),
  assignee_user_id: uuid.nullable(),
  assignee_name: z.string().nullable(),
  on_behalf_of_user_id: uuid.nullable(),
  status: z.enum(TASK_STATUSES),
  due_at: isoDateTime.nullable(),
  acted_at: isoDateTime.nullable(),
  comment: z.string().nullable(),
  created_at: isoDateTime,
});

export const workflowInstance = z.object({
  id: uuid,
  request_type: z.string(),
  subject_id: uuid,
  subject_employee_id: uuid.nullable(),
  subject_employee_name: z.string().nullable(),
  requester_user_id: uuid.nullable(),
  definition_code: z.string(),
  status: z.enum(INSTANCE_STATUSES),
  current_step_no: z.number().int().nullable(),
  summary: z.string(),
  value: z.number().nullable(),
  submitted_at: isoDateTime,
  completed_at: isoDateTime.nullable(),
  tasks: z.array(workflowTask),
});
export type WorkflowInstance = z.infer<typeof workflowInstance>;

export const inboxItem = workflowTask.extend({
  request_type: z.string(),
  subject_id: uuid,
  subject_employee_id: uuid.nullable(),
  subject_employee_name: z.string().nullable(),
  summary: z.string(),
  value: z.number().nullable(),
  submitted_at: isoDateTime,
});
export type InboxItem = z.infer<typeof inboxItem>;
export const inboxQuery = listQuery.extend({ request_type: z.string().optional() });

export const taskDecision = z
  .object({
    decision: z.enum(['approve', 'reject', 'return']),
    comment: optionalText(1000),
  })
  .superRefine((v, ctx) => {
    if (v.decision !== 'approve' && !v.comment) ctx.addIssue({ code: 'custom', path: ['comment'], message: 'Say why' });
  });

export const delegation = z.object({
  id: uuid,
  from_user_id: uuid,
  from_name: z.string().nullable(),
  to_user_id: uuid,
  to_name: z.string().nullable(),
  starts_on: isoDate,
  ends_on: isoDate,
  request_types: z.array(z.string()),
  reason: z.string().nullable(),
  created_at: isoDateTime,
});
export const createDelegation = z
  .object({
    /** Defaults to yourself; delegating for someone else needs workflow:manage. */
    from_user_id: uuid.optional(),
    to_user_id: uuid.optional(),
    /** Alternative to to_user_id: the delegate's employee record (their linked login is used). */
    to_employee_id: uuid.optional(),
    starts_on: isoDate,
    ends_on: isoDate,
    /** Empty = every kind of request. */
    request_types: z.array(z.string()).default([]),
    reason: optionalText(300),
  })
  .refine((v) => v.ends_on >= v.starts_on, { path: ['ends_on'], message: 'Ends before it starts' })
  .refine((v) => !!v.to_user_id !== !!v.to_employee_id, { path: ['to_user_id'], message: 'Give to_user_id or to_employee_id' });
