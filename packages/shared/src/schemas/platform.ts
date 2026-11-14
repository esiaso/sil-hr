import { z } from 'zod';
import { CLIENT_SCOPE_CODES } from '../permissions';
import { auditStamps, isoDateTime, listQuery, name, uuid } from './common';

// ---------------------------------------------------------------- audit
export const auditEntry = z.object({
  id: z.string(),
  occurred_at: isoDateTime,
  actor_type: z.enum(['user', 'client', 'system']),
  actor_id: z.string().nullable(),
  actor_name: z.string().nullable(),
  action: z.string(),
  entity_type: z.string(),
  entity_id: z.string().nullable(),
  before: z.record(z.string(), z.unknown()).nullable(),
  after: z.record(z.string(), z.unknown()).nullable(),
  ip: z.string().nullable(),
  user_agent: z.string().nullable(),
  correlation_id: z.string().nullable(),
});
export type AuditEntry = z.infer<typeof auditEntry>;
export const auditQuery = listQuery.extend({
  entity_type: z.string().max(100).optional(),
  entity_id: z.string().max(100).optional(),
  actor_id: z.string().max(100).optional(),
  action: z.string().max(30).optional(),
  from: isoDateTime.optional(),
  to: isoDateTime.optional(),
});

// ---------------------------------------------------------------- settings
export const setting = z.object({
  key: z.string(),
  value: z.unknown(),
  description: z.string(),
  type: z.enum(['string', 'number', 'boolean', 'json']),
  is_public: z.boolean(),
  updated_at: isoDateTime.nullable(),
});
export type Setting = z.infer<typeof setting>;
export const updateSetting = z.object({ value: z.unknown() });

export const publicSettings = z.object({
  organisation_name: z.string(),
  currency: z.string(),
  timezone: z.string(),
  date_format: z.string(),
  locale: z.string(),
  password_policy: z.object({
    min_length: z.number().int(),
    require_upper: z.boolean(),
    require_lower: z.boolean(),
    require_digit: z.boolean(),
    require_symbol: z.boolean(),
  }),
});
export type PublicSettings = z.infer<typeof publicSettings>;

// ---------------------------------------------------------------- numbering
export const numberingScheme = z.object({
  id: uuid,
  document_type: z.string(),
  name: z.string(),
  prefix: z.string(),
  format: z.string(),
  padding: z.number().int(),
  reset: z.enum(['never', 'yearly']),
  next_preview: z.string().optional(),
  is_active: z.boolean(),
  ...auditStamps,
});
export type NumberingScheme = z.infer<typeof numberingScheme>;
const formatString = z
  .string()
  .trim()
  .min(5)
  .max(100)
  .refine((f) => f.includes('{SEQ}'), 'Format must contain {SEQ}')
  .refine((f) => /^(?:[^{}]|\{(?:PREFIX|YYYY|YY|MM|SEQ|BRANCH)\})*$/.test(f), 'Unknown token; use {PREFIX} {YYYY} {YY} {MM} {SEQ} {BRANCH}');
export const createNumberingScheme = z.object({
  document_type: z.string().trim().min(2).max(60).regex(/^[a-z][a-z0-9_]*$/),
  name,
  prefix: z.string().trim().max(20).default(''),
  format: formatString.default('{PREFIX}{SEQ}'),
  padding: z.number().int().min(1).max(12).default(5),
  reset: z.enum(['never', 'yearly']).default('never'),
});
export const updateNumberingScheme = z.object({
  name: name.optional(),
  prefix: z.string().trim().max(20).optional(),
  format: formatString.optional(),
  padding: z.number().int().min(1).max(12).optional(),
  reset: z.enum(['never', 'yearly']).optional(),
  is_active: z.boolean().optional(),
});

// ---------------------------------------------------------------- external references
export const externalRef = z.object({
  id: uuid,
  entity_type: z.string(),
  entity_id: uuid,
  system: z.string(),
  external_id: z.string(),
  ...auditStamps,
});
export const upsertExternalRef = z.object({
  entity_type: z.string().trim().min(2).max(60),
  entity_id: uuid,
  system: z.string().trim().min(2).max(40).regex(/^[a-z][a-z0-9_]*$/),
  external_id: z.string().trim().min(1).max(200),
});
export const externalRefQuery = listQuery.extend({
  entity_type: z.string().optional(),
  entity_id: uuid.optional(),
  system: z.string().optional(),
  external_id: z.string().optional(),
});

// ---------------------------------------------------------------- documents
export const documentVersion = z.object({
  id: uuid,
  version_no: z.number().int(),
  file_name: z.string(),
  mime_type: z.string(),
  size_bytes: z.number().int(),
  sha256: z.string(),
  scan_status: z.enum(['pending', 'clean', 'infected', 'not_scanned']),
  uploaded_at: isoDateTime,
  uploaded_by: z.string().nullable(),
});
export const documentRecord = z.object({
  id: uuid,
  owner_type: z.string(),
  owner_id: uuid.nullable(),
  category: z.string().nullable(),
  title: z.string(),
  is_sensitive: z.boolean(),
  current_version: documentVersion.nullable(),
  versions: z.array(documentVersion).optional(),
  deleted_at: isoDateTime.nullable(),
  ...auditStamps,
});
export type DocumentRecord = z.infer<typeof documentRecord>;
export const documentQuery = listQuery.extend({ owner_type: z.string().optional(), owner_id: uuid.optional() });
export const createDocumentFields = z.object({
  owner_type: z.string().trim().min(2).max(60).regex(/^[a-z][a-z0-9_]*$/),
  owner_id: uuid.optional(),
  category: z.string().trim().max(60).optional(),
  title: z.string().trim().min(1).max(200),
  is_sensitive: z.enum(['true', 'false']).optional(),
});
export const downloadUrl = z.object({ url: z.string(), expires_at: isoDateTime });

// ---------------------------------------------------------------- API clients
export const apiClient = z.object({
  id: uuid,
  client_id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  scopes: z.array(z.string()),
  is_active: z.boolean(),
  rate_limit_per_minute: z.number().int(),
  last_used_at: isoDateTime.nullable(),
  secrets: z.array(z.object({ id: uuid, prefix: z.string(), created_at: isoDateTime, expires_at: isoDateTime.nullable(), last_used_at: isoDateTime.nullable(), revoked_at: isoDateTime.nullable() })),
  ...auditStamps,
});
export type ApiClient = z.infer<typeof apiClient>;
const scopeList = z.array(z.enum(CLIENT_SCOPE_CODES as [string, ...string[]])).min(1);
export const createApiClient = z.object({
  name,
  description: z.string().trim().max(500).nullish(),
  scopes: scopeList,
  rate_limit_per_minute: z.number().int().min(1).max(100000).default(600),
});
export const updateApiClient = z.object({
  name: name.optional(),
  description: z.string().trim().max(500).nullish(),
  scopes: scopeList.optional(),
  rate_limit_per_minute: z.number().int().min(1).max(100000).optional(),
  is_active: z.boolean().optional(),
});
export const rotateSecretRequest = z.object({
  /** Hours the previous secret keeps working, so consumers can switch without downtime. */
  previous_secret_grace_hours: z.number().int().min(0).max(720).default(24),
});
export const issuedSecret = z.object({ client_id: z.string(), client_secret: z.string(), secret_id: uuid });

export const clientCredentialsRequest = z.object({
  grant_type: z.literal('client_credentials'),
  client_id: z.string().optional(),
  client_secret: z.string().optional(),
  scope: z.string().max(1000).optional(),
});

// ---------------------------------------------------------------- webhooks
export const webhookSubscription = z.object({
  id: uuid,
  name: z.string(),
  url: z.string(),
  event_types: z.array(z.string()),
  status: z.enum(['active', 'paused', 'disabled']),
  paused_reason: z.string().nullable(),
  consecutive_failures: z.number().int(),
  secret_prefix: z.string(),
  last_delivery_at: isoDateTime.nullable(),
  ...auditStamps,
});
export type WebhookSubscription = z.infer<typeof webhookSubscription>;
export const createWebhookSubscription = z.object({
  name,
  url: z.url({ protocol: /^https?$/ }).max(500),
  /** Exact event types, or `*` for all. */
  event_types: z.array(z.string().trim().min(1).max(100)).min(1),
});
export const updateWebhookSubscription = z.object({
  name: name.optional(),
  url: z.url({ protocol: /^https?$/ }).max(500).optional(),
  event_types: z.array(z.string().trim().min(1).max(100)).min(1).optional(),
  status: z.enum(['active', 'paused', 'disabled']).optional(),
});
export const webhookSecret = z.object({ id: uuid, secret: z.string() });

export const webhookDelivery = z.object({
  id: uuid,
  subscription_id: uuid,
  event_id: z.string(),
  event_type: z.string(),
  status: z.enum(['pending', 'retrying', 'delivered', 'dead_lettered', 'cancelled']),
  attempt_count: z.number().int(),
  next_attempt_at: isoDateTime.nullable(),
  last_status_code: z.number().int().nullable(),
  last_error: z.string().nullable(),
  delivered_at: isoDateTime.nullable(),
  created_at: isoDateTime,
  attempts: z
    .array(z.object({ attempt_no: z.number().int(), started_at: isoDateTime, duration_ms: z.number().int(), status_code: z.number().int().nullable(), error: z.string().nullable(), response_excerpt: z.string().nullable() }))
    .optional(),
});
export type WebhookDelivery = z.infer<typeof webhookDelivery>;
export const webhookDeliveryQuery = listQuery.extend({
  status: z.enum(['pending', 'retrying', 'delivered', 'dead_lettered', 'cancelled']).optional(),
  event_type: z.string().optional(),
});

// ---------------------------------------------------------------- events
export const catalogueEntry = z.object({
  type: z.string(),
  version: z.number().int(),
  description: z.string(),
  subject: z.string(),
  data_schema: z.record(z.string(), z.unknown()),
  example: z.record(z.string(), z.unknown()),
});
export type CatalogueEntry = z.infer<typeof catalogueEntry>;

export const outboxEvent = z.object({
  id: z.string(),
  type: z.string(),
  subject: z.string(),
  occurred_at: isoDateTime,
  published_at: isoDateTime.nullable(),
  attempts: z.number().int(),
  last_error: z.string().nullable(),
  data: z.record(z.string(), z.unknown()),
});
export const outboxQuery = listQuery.extend({ type: z.string().optional(), unpublished: z.enum(['true', 'false']).optional() });
