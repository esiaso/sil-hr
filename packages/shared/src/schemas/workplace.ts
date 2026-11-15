import { z } from 'zod';
import { auditStamps, isoDate, isoDateTime, optionalText, uuid } from './common';

// ---------------------------------------------------------------- announcements
export const announcement = z.object({
  id: uuid,
  title: z.string(),
  body: z.string(),
  /** Empty lists = everyone; otherwise staff in any listed branch or department (and sub-departments). */
  branch_ids: z.array(uuid),
  department_ids: z.array(uuid),
  audience: z.string(),
  publish_at: isoDateTime,
  expires_at: isoDateTime.nullable(),
  pinned: z.boolean(),
  status: z.enum(['draft', 'published', 'withdrawn']),
  author_name: z.string().nullable(),
  ...auditStamps,
});
export const upsertAnnouncement = z
  .object({
    title: z.string().trim().min(3).max(200),
    body: z.string().trim().min(3).max(20000),
    branch_ids: z.array(uuid).max(50).default([]),
    department_ids: z.array(uuid).max(200).default([]),
    publish_at: isoDateTime.nullish(),
    expires_at: isoDateTime.nullish(),
    pinned: z.boolean().default(false),
    status: z.enum(['draft', 'published', 'withdrawn']).default('published'),
  })
  .refine((v) => !v.expires_at || !v.publish_at || v.expires_at > v.publish_at, { path: ['expires_at'], message: 'Must be after publishing' });

// ---------------------------------------------------------------- policy documents
export const POLICY_CATEGORIES = { hr: 'Human resources', clinical: 'Clinical', safety: 'Health and safety', ict: 'ICT and data protection', finance: 'Finance', code_of_conduct: 'Code of conduct', other: 'Other' } as const;
const policyCategory = z.enum(['hr', 'clinical', 'safety', 'ict', 'finance', 'code_of_conduct', 'other']);
export const policyVersion = z.object({ id: uuid, version_no: z.number().int(), document_id: uuid, effective_from: isoDate, changes: z.string().nullable(), created_at: isoDateTime });
export const policy = z.object({
  id: uuid,
  code: z.string(),
  title: z.string(),
  category: policyCategory,
  description: z.string().nullable(),
  department_ids: z.array(uuid),
  audience: z.string(),
  requires_ack: z.boolean(),
  status: z.enum(['active', 'retired']),
  current_version: policyVersion.nullable(),
  /** Staff in the audience who have acknowledged the current version, and how many are in it. */
  acknowledged: z.number().int(),
  audience_size: z.number().int(),
  ...auditStamps,
});
/** multipart/form-data fields for a new policy or a new version (the file is `file`). */
export const policyFields = z.object({
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9][A-Z0-9_-]{1,29}$/),
  title: z.string().trim().min(3).max(200),
  category: policyCategory,
  description: z.string().trim().max(2000).optional(),
  department_ids: z.string().optional().transform((s) => (s ? s.split(',').map((x) => x.trim()).filter(Boolean) : [])).pipe(z.array(uuid).max(200)),
  requires_ack: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
  effective_from: isoDate,
});
export const policyVersionFields = z.object({ effective_from: isoDate, changes: z.string().trim().max(2000).optional() });
export const updatePolicy = z.object({ title: z.string().trim().min(3).max(200), category: policyCategory, description: optionalText(2000), department_ids: z.array(uuid).max(200).default([]), requires_ack: z.boolean(), status: z.enum(['active', 'retired']) });
export const myPolicy = z.object({ id: uuid, code: z.string(), title: z.string(), category: policyCategory, version_id: uuid, version_no: z.number().int(), effective_from: isoDate, requires_ack: z.boolean(), acknowledged_at: isoDateTime.nullable() });
export const policyAckRow = z.object({ employee_id: uuid, employee_name: z.string(), staff_number: z.string(), department_name: z.string().nullable(), acknowledged_at: isoDateTime.nullable() });

// ---------------------------------------------------------------- meetings
export const meetingRoom = z.object({ id: uuid, name: z.string(), location: z.string().nullable(), capacity: z.number().int().nullable(), facilities: z.string().nullable(), status: z.enum(['active', 'inactive']), ...auditStamps });
export const upsertRoom = z.object({ name: z.string().trim().min(2).max(120), location: optionalText(200), capacity: z.number().int().min(1).max(2000).nullish(), facilities: optionalText(500), status: z.enum(['active', 'inactive']).default('active') });
const response = z.enum(['pending', 'accepted', 'tentative', 'declined']);
export const meetingSummary = z.object({
  id: uuid,
  title: z.string(),
  room_id: uuid.nullable(),
  room_name: z.string().nullable(),
  location: z.string().nullable(),
  online_link: z.string().nullable(),
  starts_at: isoDateTime,
  ends_at: isoDateTime,
  organiser_user_id: uuid,
  organiser_name: z.string(),
  status: z.enum(['scheduled', 'held', 'cancelled']),
  attendees: z.number().int(),
  my_response: response.nullable(),
  open_actions: z.number().int(),
  version: z.number().int(),
});
export const meetingAction = z.object({ id: uuid, description: z.string(), owner_user_id: uuid.nullable(), owner_name: z.string().nullable(), due_date: isoDate.nullable(), status: z.enum(['open', 'done']), done_at: isoDateTime.nullable(), meeting_id: uuid, meeting_title: z.string() });
export const meeting = meetingSummary.extend({
  agenda: z.string().nullable(),
  minutes: z.string().nullable(),
  minutes_at: isoDateTime.nullable(),
  attendee_list: z.array(z.object({ user_id: uuid, name: z.string(), response, attended: z.boolean().nullable() })),
  actions: z.array(meetingAction),
  can_edit: z.boolean(),
});
export const upsertMeeting = z
  .object({
    title: z.string().trim().min(3).max(200),
    room_id: uuid.nullish(),
    location: optionalText(200),
    online_link: z.url().max(500).nullish(),
    starts_at: isoDateTime,
    ends_at: isoDateTime,
    agenda: optionalText(20000),
    attendee_user_ids: z.array(uuid).max(300).default([]),
  })
  .refine((v) => v.ends_at > v.starts_at, { path: ['ends_at'], message: 'Must end after it starts' });
export const meetingResponse = z.object({ response: z.enum(['accepted', 'tentative', 'declined']) });
export const meetingMinutes = z.object({ minutes: z.string().trim().min(3).max(50000), attended_user_ids: z.array(uuid).max(300).default([]) });
export const createAction = z.object({ description: z.string().trim().min(3).max(1000), owner_user_id: uuid.nullish(), due_date: isoDate.nullish() });
export const updateAction = z.object({ status: z.enum(['open', 'done']) });
export const roomAvailability = z.array(z.object({ room_id: uuid, room_name: z.string(), busy: z.array(z.object({ starts_at: isoDateTime, ends_at: isoDateTime, title: z.string() })) }));

// ---------------------------------------------------------------- calendar
export const CALENDAR_KINDS = { leave: 'Leave', team_leave: 'Team leave', holiday: 'Public holiday', meeting: 'Meeting', training: 'Training', interview: 'Interview', shift: 'Shift' } as const;
export const calendarEvent = z.object({
  id: z.string(),
  kind: z.enum(['leave', 'team_leave', 'holiday', 'meeting', 'training', 'interview', 'shift']),
  title: z.string(),
  /** All-day events carry dates (end inclusive); timed events carry instants. */
  all_day: z.boolean(),
  start: z.string(),
  end: z.string(),
  link: z.string().nullable(),
});
export const myCalendarQuery = z.object({ from: isoDate, to: isoDate }).refine((v) => v.to >= v.from, { path: ['to'], message: 'Must be on or after from' });
export const calendarFeed = z.object({ url: z.string(), created_at: isoDateTime });
