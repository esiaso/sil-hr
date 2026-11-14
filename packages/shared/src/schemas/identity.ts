import { z } from 'zod';
import { DATA_SCOPES } from '../enums';
import { auditStamps, email, isoDateTime, listQuery, name, uuid } from './common';

export const username = z
  .string()
  .trim()
  .min(3)
  .max(60)
  .regex(/^[a-z0-9][a-z0-9._-]*$/, 'Lowercase letters, digits, dot, dash and underscore');

// ---------------------------------------------------------------- auth
export const loginRequest = z.object({
  username: z.string().trim().min(1).max(200),
  password: z.string().min(1).max(200),
});
export type LoginRequest = z.infer<typeof loginRequest>;

export const tokenResponse = z.object({
  access_token: z.string(),
  token_type: z.literal('Bearer'),
  expires_in: z.number().int(),
  refresh_token: z.string().optional(),
  scope: z.string().optional(),
});
export type TokenResponse = z.infer<typeof tokenResponse>;

/** Login either completes or asks for a second factor. */
export const loginResponse = z.union([
  tokenResponse.extend({ mfa_required: z.literal(false), must_change_password: z.boolean() }),
  z.object({ mfa_required: z.literal(true), mfa_token: z.string(), expires_in: z.number().int() }),
]);
export type LoginResponse = z.infer<typeof loginResponse>;

export const mfaVerifyRequest = z.object({
  mfa_token: z.string().min(10).max(2000),
  /** 6-digit TOTP code or a recovery code. */
  code: z.string().trim().min(6).max(20),
});
export const refreshRequest = z.object({ refresh_token: z.string().min(20).max(200) });
export const logoutRequest = z.object({ refresh_token: z.string().min(20).max(200).optional() });

export const changePasswordRequest = z.object({
  current_password: z.string().min(1).max(200),
  new_password: z.string().min(1).max(200),
});

export const mfaEnrolResponse = z.object({ secret: z.string(), otpauth_url: z.string(), qr_data_url: z.string() });
export const mfaConfirmRequest = z.object({ code: z.string().trim().regex(/^\d{6}$/) });
export const mfaConfirmResponse = z.object({ recovery_codes: z.array(z.string()) });
export const mfaDisableRequest = z.object({ password: z.string().min(1).max(200) });

export const scopeGrant = z.object({
  scope: z.enum(DATA_SCOPES as [string, ...string[]]),
  branch_id: uuid.nullable(),
  department_id: uuid.nullable(),
});

export const me = z.object({
  id: uuid,
  username: z.string(),
  display_name: z.string(),
  email: z.string().nullable(),
  employee_id: uuid.nullable(),
  mfa_enabled: z.boolean(),
  must_change_password: z.boolean(),
  roles: z.array(z.object({ code: z.string(), name: z.string() }).extend(scopeGrant.shape)),
  permissions: z.array(z.string()),
});
export type Me = z.infer<typeof me>;

// ---------------------------------------------------------------- users
export const roleAssignmentInput = z
  .object({
    role_id: uuid,
    scope: z.enum(DATA_SCOPES as [string, ...string[]]),
    branch_id: uuid.nullish(),
    department_id: uuid.nullish(),
  })
  .superRefine((v, ctx) => {
    if (v.scope === 'branch' && !v.branch_id) ctx.addIssue({ code: 'custom', path: ['branch_id'], message: 'Branch scope needs a branch' });
    if (v.scope === 'department' && !v.department_id) ctx.addIssue({ code: 'custom', path: ['department_id'], message: 'Department scope needs a department' });
  });
export type RoleAssignmentInput = z.infer<typeof roleAssignmentInput>;

export const user = z.object({
  id: uuid,
  username: z.string(),
  display_name: z.string(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  employee_id: uuid.nullable(),
  status: z.enum(['active', 'disabled', 'locked']),
  mfa_enabled: z.boolean(),
  must_change_password: z.boolean(),
  last_login_at: isoDateTime.nullable(),
  roles: z.array(
    z.object({ assignment_id: uuid, role_id: uuid, code: z.string(), name: z.string() }).extend(scopeGrant.shape),
  ),
  deleted_at: isoDateTime.nullable(),
  ...auditStamps,
});
export type User = z.infer<typeof user>;

export const createUser = z.object({
  username,
  display_name: name,
  email: email.nullish(),
  phone: z.string().trim().max(40).nullish(),
  /** Initial password; the user must change it at first login. */
  password: z.string().min(1).max(200),
  roles: z.array(roleAssignmentInput).default([]),
});
export const updateUser = z.object({
  display_name: name.optional(),
  email: email.nullish(),
  phone: z.string().trim().max(40).nullish(),
  status: z.enum(['active', 'disabled']).optional(),
});
export const setUserRoles = z.object({ roles: z.array(roleAssignmentInput) });
export const resetPassword = z.object({ password: z.string().min(1).max(200) });
export type CreateUser = z.infer<typeof createUser>;
export type UpdateUser = z.infer<typeof updateUser>;
export const userQuery = listQuery.extend({ status: z.enum(['active', 'disabled', 'locked']).optional(), role: z.string().optional() });

// ---------------------------------------------------------------- roles
export const role = z.object({
  id: uuid,
  code: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  is_system: z.boolean(),
  permissions: z.array(z.string()),
  ...auditStamps,
});
export type Role = z.infer<typeof role>;
export const createRole = z.object({
  code: z.string().trim().min(2).max(60).regex(/^[a-z][a-z0-9_]*$/),
  name,
  description: z.string().trim().max(500).nullish(),
  permissions: z.array(z.string()).default([]),
});
export const updateRole = z.object({
  name: name.optional(),
  description: z.string().trim().max(500).nullish(),
  permissions: z.array(z.string()).optional(),
});
export type CreateRole = z.infer<typeof createRole>;
export type UpdateRole = z.infer<typeof updateRole>;

// ---------------------------------------------------------------- login history / IP allow-list
export const loginHistoryEntry = z.object({
  id: uuid,
  user_id: uuid.nullable(),
  username: z.string(),
  outcome: z.string(),
  method: z.string(),
  ip: z.string().nullable(),
  user_agent: z.string().nullable(),
  occurred_at: isoDateTime,
});
export const loginHistoryQuery = listQuery.extend({ user_id: uuid.optional(), outcome: z.string().optional() });

export const ipAllowRule = z.object({
  id: uuid,
  cidr: z.string(),
  description: z.string().nullable(),
  applies_to: z.enum(['all', 'admin']),
  is_active: z.boolean(),
  ...auditStamps,
});
export const createIpAllowRule = z.object({
  cidr: z.string().trim().regex(/^[0-9a-fA-F:.]+(\/\d{1,3})?$/, 'IPv4/IPv6 address or CIDR block'),
  description: z.string().trim().max(200).nullish(),
  /** `admin` restricts only users holding admin permissions; `all` restricts every login. */
  applies_to: z.enum(['all', 'admin']).default('all'),
});
