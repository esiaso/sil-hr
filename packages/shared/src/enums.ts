/**
 * Status and type values shared by the API, the web app and other systems.
 * Always lowercase snake_case.
 */

export const RecordStatus = { ACTIVE: 'active', INACTIVE: 'inactive' } as const;
export type RecordStatus = (typeof RecordStatus)[keyof typeof RecordStatus];

/** Where a role assignment's data scope applies. */
export const DataScope = {
  OWN: 'own',
  DIRECT_REPORTS: 'direct_reports',
  DEPARTMENT: 'department',
  BRANCH: 'branch',
  ORGANISATION: 'organisation',
} as const;
export type DataScope = (typeof DataScope)[keyof typeof DataScope];
export const DATA_SCOPES = Object.values(DataScope);

export const UserStatus = { ACTIVE: 'active', DISABLED: 'disabled', LOCKED: 'locked' } as const;
export type UserStatus = (typeof UserStatus)[keyof typeof UserStatus];

export const ActorType = { USER: 'user', CLIENT: 'client', SYSTEM: 'system' } as const;
export type ActorType = (typeof ActorType)[keyof typeof ActorType];

export const AuditAction = {
  CREATE: 'create',
  UPDATE: 'update',
  DELETE: 'delete',
  LOGIN: 'login',
  LOGIN_FAILED: 'login_failed',
  LOGOUT: 'logout',
  TOKEN_ISSUED: 'token_issued',
  SENSITIVE_READ: 'sensitive_read',
  EXPORT: 'export',
  APPROVE: 'approve',
  REJECT: 'reject',
  REPLAY: 'replay',
  SECRET_ROTATED: 'secret_rotated',
  ACKNOWLEDGE: 'acknowledge',
} as const;
export type AuditAction = (typeof AuditAction)[keyof typeof AuditAction];

export const LoginOutcome = {
  SUCCESS: 'success',
  BAD_CREDENTIALS: 'bad_credentials',
  LOCKED: 'locked',
  DISABLED: 'disabled',
  MFA_REQUIRED: 'mfa_required',
  MFA_FAILED: 'mfa_failed',
  IP_BLOCKED: 'ip_blocked',
} as const;
export type LoginOutcome = (typeof LoginOutcome)[keyof typeof LoginOutcome];

export const WebhookSubscriptionStatus = { ACTIVE: 'active', PAUSED: 'paused', DISABLED: 'disabled' } as const;
export type WebhookSubscriptionStatus = (typeof WebhookSubscriptionStatus)[keyof typeof WebhookSubscriptionStatus];

export const WebhookDeliveryStatus = {
  PENDING: 'pending',
  RETRYING: 'retrying',
  DELIVERED: 'delivered',
  DEAD_LETTERED: 'dead_lettered',
  CANCELLED: 'cancelled',
} as const;
export type WebhookDeliveryStatus = (typeof WebhookDeliveryStatus)[keyof typeof WebhookDeliveryStatus];

export const DocumentScanStatus = {
  PENDING: 'pending',
  CLEAN: 'clean',
  INFECTED: 'infected',
  NOT_SCANNED: 'not_scanned',
} as const;
export type DocumentScanStatus = (typeof DocumentScanStatus)[keyof typeof DocumentScanStatus];

export const SettingType = { STRING: 'string', NUMBER: 'number', BOOLEAN: 'boolean', JSON: 'json' } as const;
export type SettingType = (typeof SettingType)[keyof typeof SettingType];

/** Systems whose identifiers HR stores in external_ref. Extend as systems are integrated. */
export const ExternalSystem = {
  PROCUREMENT: 'procurement',
  HMIS: 'hmis',
  LIMS: 'lims',
  FINANCE: 'finance',
  BIOTIME: 'biotime',
  IDP: 'idp',
  LEGACY_HRM: 'legacy_hrm',
} as const;
