/**
 * Permission codes are `resource:action`. Roles are data (seeded, editable); the codes
 * themselves are defined here so the API guards, the web navigation and the seed agree.
 */
export const PERMISSIONS = {
  // organisation structure
  'organisation:read': 'View the organisation profile',
  'organisation:update': 'Edit the organisation profile',
  'branch:read': 'View branches (sites)',
  'branch:manage': 'Create, edit and deactivate branches',
  'department:read': 'View departments',
  'department:manage': 'Create, edit, move and deactivate departments',
  'cost_centre:read': 'View cost centres',
  'cost_centre:manage': 'Create, edit and deactivate cost centres',
  'job_grade:read': 'View job grades',
  'job_grade:manage': 'Create, edit and deactivate job grades',
  'position:read': 'View positions and headcount',
  'position:manage': 'Create, edit and deactivate positions',
  // identity and access
  'user:read': 'View user accounts',
  'user:manage': 'Create, edit, disable users and assign roles',
  'role:read': 'View roles and permissions',
  'role:manage': 'Create and edit roles',
  'login_history:read': 'View login history',
  'ip_allow:manage': 'Manage the IP allow-list',
  // platform
  'audit:read': 'View the audit trail',
  'setting:read': 'View system settings',
  'setting:manage': 'Change system settings',
  'numbering:read': 'View numbering schemes',
  'numbering:manage': 'Change numbering schemes',
  'document:read': 'View and download documents',
  'document:write': 'Upload documents and new versions',
  'external_ref:read': 'View external identifiers',
  'external_ref:manage': 'Map external identifiers',
  // integration
  'api_client:manage': 'Manage API clients, scopes and secrets',
  'webhook:read': 'View webhook subscriptions and delivery logs',
  'webhook:manage': 'Manage webhook subscriptions and replay deliveries',
  'event:read': 'View the event catalogue',
  'system:metrics': 'Read operational metrics',
} as const;

export type PermissionCode = keyof typeof PERMISSIONS;
export const PERMISSION_CODES = Object.keys(PERMISSIONS) as PermissionCode[];

/** Groups for the role editor. */
export const PERMISSION_GROUPS: { label: string; prefixes: string[] }[] = [
  { label: 'Organisation', prefixes: ['organisation', 'branch', 'department', 'cost_centre', 'job_grade', 'position'] },
  { label: 'Identity & access', prefixes: ['user', 'role', 'login_history', 'ip_allow'] },
  { label: 'Platform', prefixes: ['audit', 'setting', 'numbering', 'document', 'external_ref'] },
  { label: 'Integration', prefixes: ['api_client', 'webhook', 'event', 'system'] },
];

/**
 * OAuth scopes a machine client can be granted, and the permissions each one confers.
 * Machine clients always act with organisation-wide data scope; what they can see is
 * limited by scope instead. Scopes for later slices are listed so clients can be
 * provisioned ahead of time; they confer nothing until their endpoints exist.
 */
export const CLIENT_SCOPES: Record<string, { description: string; permissions: PermissionCode[] }> = {
  'org:read': {
    description: 'Organisation structure: branches, departments, cost centres, grades, positions',
    permissions: ['organisation:read', 'branch:read', 'department:read', 'cost_centre:read', 'job_grade:read', 'position:read'],
  },
  'employees:read': { description: 'Staff directory and non-sensitive employee fields', permissions: [] },
  'employees.sensitive:read': { description: 'Unmasked national ID, KRA PIN and bank details', permissions: [] },
  'leave:read': { description: 'Approved leave', permissions: [] },
  'attendance:write': { description: 'Post clock events', permissions: [] },
  'payroll.journal:read': { description: 'Payroll journals per run', permissions: [] },
  'events:read': { description: 'Event catalogue', permissions: ['event:read'] },
  'external_refs:write': { description: 'Map this system’s identifiers onto HR records', permissions: ['external_ref:read', 'external_ref:manage'] },
  'documents:read': { description: 'Download documents', permissions: ['document:read'] },
};
export const CLIENT_SCOPE_CODES = Object.keys(CLIENT_SCOPES);

/** Built-in roles. `scope` is the default data scope when the role is assigned. */
export const SYSTEM_ROLES: {
  code: string;
  name: string;
  description: string;
  permissions: PermissionCode[] | '*';
}[] = [
  { code: 'system_admin', name: 'System Admin', description: 'Everything, including integration and security settings', permissions: '*' },
  {
    code: 'hr_manager',
    name: 'HR Manager',
    description: 'Owns organisation structure and HR records',
    permissions: [
      'organisation:read', 'organisation:update', 'branch:read', 'branch:manage', 'department:read', 'department:manage',
      'cost_centre:read', 'cost_centre:manage', 'job_grade:read', 'job_grade:manage', 'position:read', 'position:manage',
      'user:read', 'role:read', 'audit:read', 'setting:read', 'numbering:read', 'numbering:manage',
      'document:read', 'document:write', 'external_ref:read', 'event:read', 'webhook:read',
    ],
  },
  {
    code: 'hr_officer',
    name: 'HR Officer',
    description: 'Day-to-day HR administration within their scope',
    permissions: [
      'organisation:read', 'branch:read', 'department:read', 'department:manage', 'cost_centre:read', 'job_grade:read',
      'position:read', 'position:manage', 'document:read', 'document:write', 'setting:read', 'numbering:read',
    ],
  },
  {
    code: 'payroll_officer',
    name: 'Payroll Officer',
    description: 'Prepares payroll runs',
    permissions: ['organisation:read', 'branch:read', 'department:read', 'cost_centre:read', 'job_grade:read', 'position:read', 'setting:read'],
  },
  {
    code: 'finance_approver',
    name: 'Finance Approver',
    description: 'Approves payroll and payments',
    permissions: ['organisation:read', 'branch:read', 'department:read', 'cost_centre:read', 'cost_centre:manage', 'setting:read'],
  },
  {
    code: 'department_head',
    name: 'Department Head',
    description: 'Heads a department; approves for it',
    permissions: ['organisation:read', 'branch:read', 'department:read', 'cost_centre:read', 'job_grade:read', 'position:read'],
  },
  {
    code: 'line_manager',
    name: 'Line Manager',
    description: 'Manages direct reports',
    permissions: ['organisation:read', 'branch:read', 'department:read', 'position:read'],
  },
  {
    code: 'recruiter',
    name: 'Recruiter',
    description: 'Runs recruitment',
    permissions: ['organisation:read', 'branch:read', 'department:read', 'job_grade:read', 'position:read', 'document:read', 'document:write'],
  },
  {
    code: 'employee',
    name: 'Employee',
    description: 'Self-service',
    permissions: ['organisation:read', 'branch:read', 'department:read'],
  },
  {
    code: 'auditor',
    name: 'Auditor',
    description: 'Read-only access to everything, including the audit trail',
    permissions: PERMISSION_CODES.filter((c) => c.endsWith(':read')),
  },
];
