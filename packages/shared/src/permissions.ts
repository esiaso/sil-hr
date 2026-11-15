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
  // people (slice 2)
  'employee:read': 'View employee records (personal data masked)',
  'employee:hire': 'Hire employees',
  'employee:update': 'Edit employee records, contacts, dependants, qualifications and payment details',
  'employee:lifecycle': 'Change employee status, transfer and set reporting lines',
  'employee.sensitive:read': 'See national ID, passport, KRA PIN and bank details unmasked (each read is audited)',
  'licence:read': 'View professional licences',
  'licence:manage': 'Record and edit professional licences',
  'licence:verify': 'Verify licences against the licensing body',
  'document_type:manage': 'Define employee document types and the required checklist',
  'employee_document:verify': 'Verify or reject employee documents',
  'directory:read': 'Read the staff directory and approver lookups',
  'import_export:run': 'Import and export employee data in bulk',
  'contact_change:decide': 'Approve or reject self-service contact changes',
  'scim:provision': 'Use the SCIM 2.0 provisioning endpoints',
  // workflow and leave (slice 3)
  'workflow:manage': 'Define approval workflows and manage anyone\u2019s delegations',
  'workflow:read': 'See any approval request and its history',
  'leave:read': 'View leave requests, balances and the team calendar',
  'leave:apply_for_others': 'Apply for leave on someone else\u2019s behalf',
  'leave:adjust': 'Adjust leave balances and record encashment',
  'leave_setup:manage': 'Manage leave types, entitlement policies and public holidays',
  // time and attendance (slice 4)
  'shift:manage': 'Define shifts and which shifts each department runs',
  'roster:read': 'View rosters',
  'roster:manage': 'Plan rosters',
  'attendance:read': 'View daily attendance and timesheets',
  'attendance:manage': 'Recompute attendance, set overtime rules and record clock events for others',
  'clock_event:write': 'Post clock events from a time source (machine clients)',
  'connector:manage': 'Configure device connectors and see their sync history',
  // payroll (slice 5)
  'payroll:read': 'View payroll runs, payslips, variance and reports',
  'payroll:prepare': 'Create, calculate and submit payroll runs; produce payment and statutory files',
  'payroll:pay': 'Mark an approved payroll as paid and close it',
  'payroll_setup:manage': 'Manage pay components, statutory rate tables, payment file formats and the account mapping',
  'salary:read': 'View salaries, pay items and loans',
  'salary:manage': 'Set salaries, pay items, loans and one-off items',
  'payroll.journal:read': 'Read payroll journals (finance systems)',
  // medical scheme
  'medical:read': 'View scheme members, applications, usage and reports',
  'medical_setup:manage': 'Define medical schemes, categories, limits and contribution rates; adjust limits',
  'medical:lookup': 'Look up a member’s cover and remaining limits (billing; no pay or HR data)',
  'medical_claim:write': 'Record claims, holds and reversals against medical limits',
} as const;

export type PermissionCode = keyof typeof PERMISSIONS;
export const PERMISSION_CODES = Object.keys(PERMISSIONS) as PermissionCode[];

/** Groups for the role editor. */
export const PERMISSION_GROUPS: { label: string; prefixes: string[] }[] = [
  { label: 'Organisation', prefixes: ['organisation', 'branch', 'department', 'cost_centre', 'job_grade', 'position'] },
  { label: 'Identity & access', prefixes: ['user', 'role', 'login_history', 'ip_allow'] },
  { label: 'Platform', prefixes: ['audit', 'setting', 'numbering', 'document', 'external_ref'] },
  { label: 'People', prefixes: ['employee', 'employee.sensitive', 'licence', 'document_type', 'employee_document', 'directory', 'import_export', 'contact_change'] },
  { label: 'Workflow & leave', prefixes: ['workflow', 'leave', 'leave_setup'] },
  { label: 'Time & attendance', prefixes: ['shift', 'roster', 'attendance', 'clock_event', 'connector'] },
  { label: 'Payroll', prefixes: ['payroll', 'payroll_setup', 'salary', 'payroll.journal'] },
  { label: 'Medical scheme', prefixes: ['medical', 'medical_setup', 'medical_claim'] },
  { label: 'Integration', prefixes: ['api_client', 'webhook', 'event', 'system', 'scim'] },
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
  'employees:read': { description: 'Staff directory, approver lookups, employee records (sensitive fields masked) and licences', permissions: ['employee:read', 'directory:read', 'licence:read', 'department:read', 'position:read', 'cost_centre:read'] },
  'employees.sensitive:read': { description: 'Unmasked national ID, KRA PIN and bank details (every read audited)', permissions: ['employee.sensitive:read'] },
  scim: { description: 'SCIM 2.0 provisioning: read users (employees) and groups (departments)', permissions: ['scim:provision'] },
  'leave:read': { description: 'Leave requests, balances and the team calendar', permissions: ['leave:read'] },
  'attendance:write': { description: 'Post clock events (POST /clock-events)', permissions: ['clock_event:write'] },
  'attendance:read': { description: 'Daily attendance, rosters and timesheets', permissions: ['attendance:read', 'roster:read'] },
  'payroll.journal:read': { description: 'Payroll journals per approved run (GET /payroll/runs/{id}/journal)', permissions: ['payroll.journal:read'] },
  'medical:read': { description: 'Medical cover: eligibility and remaining limits by member number', permissions: ['medical:lookup'] },
  'medical:write': { description: 'Medical billing: place holds, post and reverse claims (HMIS)', permissions: ['medical:lookup', 'medical_claim:write'] },
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
    permissions: ['medical:read', 'medical_setup:manage', 'medical:lookup', 'payroll:read', 'salary:read', 'shift:manage', 'roster:read', 'roster:manage', 'attendance:read', 'attendance:manage', 'connector:manage', 'workflow:manage', 'workflow:read', 'leave:read', 'leave:apply_for_others', 'leave:adjust', 'leave_setup:manage', 'employee:read', 'employee:hire', 'employee:update', 'employee:lifecycle', 'employee.sensitive:read', 'licence:read', 'licence:manage', 'licence:verify', 'document_type:manage', 'employee_document:verify', 'directory:read', 'import_export:run', 'contact_change:decide', 
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
    permissions: ['medical:read', 'medical:lookup', 'roster:read', 'roster:manage', 'attendance:read', 'attendance:manage', 'workflow:read', 'leave:read', 'leave:apply_for_others', 'leave:adjust', 'employee:read', 'employee:hire', 'employee:update', 'employee:lifecycle', 'licence:read', 'licence:manage', 'licence:verify', 'employee_document:verify', 'directory:read', 'contact_change:decide', 
      'organisation:read', 'branch:read', 'department:read', 'department:manage', 'cost_centre:read', 'job_grade:read',
      'position:read', 'position:manage', 'document:read', 'document:write', 'setting:read', 'numbering:read',
    ],
  },
  {
    code: 'payroll_officer',
    name: 'Payroll Officer',
    description: 'Prepares payroll runs',
    permissions: ['payroll:read', 'payroll:prepare', 'payroll_setup:manage', 'salary:read', 'salary:manage', 'payroll.journal:read', 'attendance:read', 'roster:read', 'leave:read', 'employee:read', 'employee.sensitive:read', 'directory:read', 'organisation:read', 'branch:read', 'department:read', 'cost_centre:read', 'job_grade:read', 'position:read', 'setting:read'],
  },
  {
    code: 'finance_approver',
    name: 'Finance Approver',
    description: 'Approves payroll and payments',
    permissions: ['payroll:read', 'payroll:pay', 'payroll.journal:read', 'directory:read', 'organisation:read', 'branch:read', 'department:read', 'cost_centre:read', 'cost_centre:manage', 'setting:read'],
  },
  {
    code: 'department_head',
    name: 'Department Head',
    description: 'Heads a department; approves for it',
    permissions: ['roster:read', 'roster:manage', 'attendance:read', 'leave:read', 'employee:read', 'licence:read', 'directory:read', 'organisation:read', 'branch:read', 'department:read', 'cost_centre:read', 'job_grade:read', 'position:read'],
  },
  {
    code: 'line_manager',
    name: 'Line Manager',
    description: 'Manages direct reports',
    permissions: ['roster:read', 'roster:manage', 'attendance:read', 'leave:read', 'employee:read', 'licence:read', 'directory:read', 'organisation:read', 'branch:read', 'department:read', 'position:read'],
  },
  {
    code: 'recruiter',
    name: 'Recruiter',
    description: 'Runs recruitment',
    permissions: ['directory:read', 'organisation:read', 'branch:read', 'department:read', 'job_grade:read', 'position:read', 'document:read', 'document:write'],
  },
  {
    code: 'medical_billing',
    name: 'Medical scheme billing',
    description: 'Looks up staff cover and records claims; sees no pay or HR records',
    permissions: ['medical:lookup', 'medical_claim:write'],
  },
  {
    code: 'employee',
    name: 'Employee',
    description: 'Self-service',
    permissions: ['directory:read', 'organisation:read', 'branch:read', 'department:read'],
  },
  {
    code: 'auditor',
    name: 'Auditor',
    description: 'Read-only access to everything, including the audit trail',
    // Read-only, but not personal data in clear.
    permissions: PERMISSION_CODES.filter((c) => c.endsWith(':read') && !c.includes('.sensitive')),
  },
];
