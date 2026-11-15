import { z } from 'zod';
import { auditStamps, isoDate, isoDateTime, listQuery, name, optionalText, uuid } from './common';

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Time as HH:MM (24-hour)');

// ---------------------------------------------------------------- shifts
export const shift = z.object({
  id: uuid,
  code: z.string(),
  name: z.string(),
  /** Local times. An end at or before the start means the shift ends the next day (night shift). */
  start_time: z.string(),
  end_time: z.string(),
  crosses_midnight: z.boolean(),
  paid_minutes: z.number().int(),
  break_minutes: z.number().int(),
  /** Overrides the organisation default (Settings → attendance.late_grace_minutes) when set. */
  late_grace_minutes: z.number().int().nullable(),
  early_leave_grace_minutes: z.number().int().nullable(),
  colour: z.string().nullable(),
  status: z.enum(['active', 'inactive']),
  ...auditStamps,
});
export type Shift = z.infer<typeof shift>;
export const upsertShift = z.object({
  code: z.string().trim().min(1).max(20).regex(/^[A-Za-z0-9_-]+$/),
  name,
  start_time: hhmm,
  end_time: hhmm,
  break_minutes: z.number().int().min(0).max(240).default(0),
  late_grace_minutes: z.number().int().min(0).max(240).nullish(),
  early_leave_grace_minutes: z.number().int().min(0).max(240).nullish(),
  colour: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullish(),
  status: z.enum(['active', 'inactive']).optional(),
});
export type UpsertShift = z.infer<typeof upsertShift>;

/**
 * Which shifts a department runs. `standing` departments (e.g. Finance, 08:00–17:00
 * Monday to Friday) need no roster: everyone works the standing shift on working days.
 * Rostered departments (wards, 24/7 units) plan each person's shifts day by day.
 */
export const departmentShifts = z.object({
  department_id: uuid,
  mode: z.enum(['standing', 'rostered']),
  standing_shift_id: uuid.nullable(),
  shift_ids: z.array(uuid),
  /** Inherited from the nearest ancestor that has a setting. */
  inherited_from: uuid.nullable(),
});
export const setDepartmentShifts = z
  .object({ mode: z.enum(['standing', 'rostered']), standing_shift_id: uuid.nullish(), shift_ids: z.array(uuid).min(1) })
  .refine((v) => v.mode !== 'standing' || !!v.standing_shift_id, { path: ['standing_shift_id'], message: 'Choose the standing shift' });

// ---------------------------------------------------------------- rosters
export const rosterEntry = z.object({
  id: uuid,
  employee_id: uuid,
  work_date: isoDate,
  shift_id: uuid.nullable(),
  /** off = planned rest day for rostered staff (no shift). */
  kind: z.enum(['shift', 'off']),
  note: z.string().nullable(),
});
export const rosterQuery = z.object({ from: isoDate, to: isoDate, department_id: uuid.optional(), employee_id: uuid.optional() });
export const rosterChange = z.object({
  entries: z
    .array(
      z.object({
        employee_id: uuid,
        work_date: isoDate,
        /** null with kind 'off' marks a rest day; an empty list of shifts for a date clears it. */
        shift_ids: z.array(uuid).max(3),
        kind: z.enum(['shift', 'off']).default('shift'),
        note: optionalText(200),
      }),
    )
    .min(1)
    .max(2000),
});
/** Repeats a pattern of shift codes over a date range for the given people (e.g. D,D,N,N,OFF,OFF). */
export const rosterPattern = z.object({
  employee_ids: z.array(uuid).min(1).max(500),
  from: isoDate,
  to: isoDate,
  /** Shift codes and OFF, cycled day by day; each employee may start at a different offset. */
  pattern: z.array(z.string().trim().min(1).max(20)).min(1).max(56),
  stagger: z.boolean().default(false),
});

// ---------------------------------------------------------------- clock events
export const CLOCK_SOURCES = ['web', 'mobile', 'device', 'import', 'api', 'regularisation'] as const;
export const clockEvent = z.object({
  id: uuid,
  employee_id: uuid.nullable(),
  occurred_at: isoDateTime,
  direction: z.enum(['in', 'out', 'unknown']),
  source: z.enum(CLOCK_SOURCES),
  device_id: z.string().nullable(),
  device_user_id: z.string().nullable(),
  connector_id: uuid.nullable(),
  received_at: isoDateTime,
});
export type ClockEvent = z.infer<typeof clockEvent>;

/** Batch endpoint for any time source. Each event names the person one way or another. */
export const clockEventInput = z
  .object({
    employee_id: uuid.optional(),
    staff_number: z.string().max(30).optional(),
    device_user_id: z.string().max(60).optional(),
    occurred_at: isoDateTime,
    direction: z.enum(['in', 'out', 'unknown']).default('unknown'),
    device_id: z.string().max(60).optional(),
    /** Your own id for the punch; resending it is ignored (exactly-once). */
    external_id: z.string().max(120).optional(),
  })
  .refine((v) => v.employee_id || v.staff_number || v.device_user_id, 'Identify the person: employee_id, staff_number or device_user_id');
export const clockEventBatch = z.object({ events: z.array(clockEventInput).min(1).max(5000) });
export const clockEventBatchResult = z.object({
  accepted: z.number().int(),
  duplicates: z.number().int(),
  unmatched: z.number().int(),
  errors: z.array(z.object({ index: z.number().int(), message: z.string() })),
});
export const selfClock = z.object({ direction: z.enum(['in', 'out']), latitude: z.number().min(-90).max(90).optional(), longitude: z.number().min(-180).max(180).optional() });

// ---------------------------------------------------------------- daily attendance
export const ATTENDANCE_STATUSES = ['present', 'late', 'half_day', 'absent', 'on_leave', 'rest_day', 'holiday', 'incomplete', 'not_scheduled'] as const;
export type AttendanceStatus = (typeof ATTENDANCE_STATUSES)[number];
export const attendanceDay = z.object({
  id: uuid,
  employee_id: uuid,
  employee_name: z.string().optional(),
  work_date: isoDate,
  shift_id: uuid.nullable(),
  shift_code: z.string().nullable(),
  scheduled_start: isoDateTime.nullable(),
  scheduled_end: isoDateTime.nullable(),
  first_in: isoDateTime.nullable(),
  last_out: isoDateTime.nullable(),
  worked_minutes: z.number().int(),
  late_minutes: z.number().int(),
  early_leave_minutes: z.number().int(),
  overtime_minutes: z.number().int(),
  day_type: z.enum(['normal', 'rest_day', 'public_holiday']),
  status: z.enum(ATTENDANCE_STATUSES),
  leave_request_id: uuid.nullable(),
  regularised: z.boolean(),
  computed_at: isoDateTime,
});
export type AttendanceDay = z.infer<typeof attendanceDay>;
export const attendanceQuery = listQuery.extend({
  from: isoDate,
  to: isoDate,
  department_id: uuid.optional(),
  employee_id: uuid.optional(),
  status: z.enum(ATTENDANCE_STATUSES).optional(),
});

export const timesheet = z.object({
  employee_id: uuid,
  employee_name: z.string(),
  from: isoDate,
  to: isoDate,
  scheduled_days: z.number().int(),
  present_days: z.number(),
  absent_days: z.number().int(),
  late_days: z.number().int(),
  leave_days: z.number(),
  worked_minutes: z.number().int(),
  late_minutes: z.number().int(),
  overtime: z.array(z.object({ day_type: z.enum(['normal', 'rest_day', 'public_holiday']), minutes: z.number().int(), multiplier: z.number().nullable() })),
});

// ---------------------------------------------------------------- overtime rules
export const overtimeRule = z.object({
  id: uuid,
  day_type: z.enum(['normal', 'rest_day', 'public_holiday']),
  /** Pay multiplier (1.5 = time and a half). Empty means overtime is recorded but not paid extra. */
  multiplier: z.number().nullable(),
  /** Minutes beyond the shift before overtime starts counting. */
  min_minutes: z.number().int(),
  /** Overtime is only counted when approved (regularisation) if true. */
  requires_approval: z.boolean(),
  effective_from: isoDate,
  effective_to: isoDate.nullable(),
});
export const upsertOvertimeRule = z.object({
  day_type: z.enum(['normal', 'rest_day', 'public_holiday']),
  multiplier: z.number().min(1).max(5).nullish(),
  min_minutes: z.number().int().min(0).max(600).default(30),
  requires_approval: z.boolean().default(false),
  effective_from: isoDate,
  effective_to: isoDate.nullish(),
});

// ---------------------------------------------------------------- regularisation
export const regularisation = z.object({
  id: uuid,
  employee_id: uuid,
  work_date: isoDate,
  clock_in: isoDateTime.nullable(),
  clock_out: isoDateTime.nullable(),
  reason: z.string(),
  status: z.enum(['pending', 'approved', 'rejected', 'returned', 'cancelled']),
  decision_comment: z.string().nullable(),
  created_at: isoDateTime,
});
export const requestRegularisation = z
  .object({
    employee_id: uuid.optional(),
    work_date: isoDate,
    clock_in: isoDateTime.nullish(),
    clock_out: isoDateTime.nullish(),
    reason: z.string().trim().min(5).max(500),
  })
  .refine((v) => v.clock_in || v.clock_out, 'Give the missing clock-in, clock-out, or both')
  .refine((v) => !v.clock_in || !v.clock_out || v.clock_out > v.clock_in, { path: ['clock_out'], message: 'Clock-out must be after clock-in' });

// ---------------------------------------------------------------- connectors
export const CONNECTOR_TYPES = {
  zkteco_biotime: 'ZKTeco BioTime server (pull)',
  zkteco_push: 'ZKTeco devices pushing to SIL HR (ADMS / iclock)',
  hikvision_isapi: 'Hikvision access-control terminal (ISAPI pull)',
  hikvision_push: 'Hikvision terminals pushing events to SIL HR',
} as const;
export type ConnectorType = keyof typeof CONNECTOR_TYPES;

export const connector = z.object({
  id: uuid,
  code: z.string(),
  name: z.string(),
  type: z.enum(Object.keys(CONNECTOR_TYPES) as [ConnectorType, ...ConnectorType[]]),
  /** Non-secret settings (URL, device serials, timezone…). */
  config: z.record(z.string(), z.unknown()),
  has_credentials: z.boolean(),
  /** How device user ids map to employees: by staff number, or through the mapping table. */
  match_by: z.enum(['staff_number', 'mapping']),
  schedule_minutes: z.number().int().nullable(),
  is_active: z.boolean(),
  last_run_at: isoDateTime.nullable(),
  last_success_at: isoDateTime.nullable(),
  health: z.enum(['unknown', 'ok', 'degraded', 'failing']),
  health_message: z.string().nullable(),
  /** For push connectors: the URL to set on the device. */
  push_url: z.string().nullable(),
  ...auditStamps,
});
export type Connector = z.infer<typeof connector>;
export const upsertConnector = z.object({
  code: z.string().trim().min(2).max(40).regex(/^[a-z][a-z0-9_]*$/),
  name,
  type: z.enum(Object.keys(CONNECTOR_TYPES) as [ConnectorType, ...ConnectorType[]]),
  config: z.record(z.string(), z.unknown()).default({}),
  /** Write-only: username/password or tokens, stored encrypted; omit to keep the current ones. */
  credentials: z.record(z.string(), z.string()).optional(),
  match_by: z.enum(['staff_number', 'mapping']).default('staff_number'),
  schedule_minutes: z.number().int().min(1).max(1440).nullish(),
  is_active: z.boolean().default(true),
});
export const connectorRun = z.object({
  id: uuid,
  connector_id: uuid,
  trigger: z.enum(['schedule', 'manual', 'push', 'test']),
  status: z.enum(['running', 'succeeded', 'partial', 'failed']),
  started_at: isoDateTime,
  finished_at: isoDateTime.nullable(),
  window_from: isoDateTime.nullable(),
  window_to: isoDateTime.nullable(),
  received: z.number().int(),
  accepted: z.number().int(),
  duplicates: z.number().int(),
  unmatched: z.number().int(),
  error: z.string().nullable(),
});
export const deviceUserMapping = z.object({ id: uuid, connector_id: uuid, device_user_id: z.string(), employee_id: uuid, employee_name: z.string().nullable() });
export const upsertDeviceUserMapping = z.object({ device_user_id: z.string().trim().min(1).max(60), employee_id: uuid });
