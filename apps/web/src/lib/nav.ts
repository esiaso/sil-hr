/**
 * Navigation grouped by the domains of the system. Each entry names the permission that
 * makes it visible; the shell filters on the signed-in user's permissions. Later slices
 * add groups (People, Leave, Time, Payroll…) here.
 */
export interface NavItem {
  label: string;
  href: string;
  /** One permission, or several separated by | (any of them). */
  permission?: string;
}
export interface NavGroup {
  label: string;
  items: NavItem[];
}

export const NAV: NavGroup[] = [
  { label: 'Home', items: [{ label: 'Dashboard', href: '/' }, { label: 'Announcements', href: '/announcements' }, { label: 'My calendar', href: '/calendar' }, { label: 'Meetings', href: '/meetings' }, { label: 'Policies', href: '/policies' }, { label: 'Travel and expenses', href: '/expenses' }, { label: 'My profile', href: '/me' }, { label: 'My leave', href: '/leave' }, { label: 'Clock in / my attendance', href: '/attendance/me' }, { label: 'My payslips', href: '/me/payslips' }, { label: 'My medical cover', href: '/medical' }, { label: 'My tasks', href: '/lifecycle/tasks' }, { label: 'My performance', href: '/me/performance' }, { label: 'My training and CPD', href: '/me/training' }, { label: 'My interviews', href: '/recruitment/interviews' }, { label: 'My HR file', href: '/lifecycle/relations' }, { label: 'Approvals', href: '/approvals' }, { label: 'Staff directory', href: '/directory', permission: 'directory:read' }] },
  {
    label: 'People',
    items: [
      { label: 'Employees', href: '/people', permission: 'employee:read' },
      { label: 'Licences', href: '/people/licences', permission: 'licence:read' },
      { label: 'Contact changes', href: '/people/contact-changes', permission: 'contact_change:decide' },
      { label: 'Import & export', href: '/people/import', permission: 'import_export:run' },
      { label: 'Document types', href: '/people/document-types', permission: 'document_type:manage' },
    ],
  },
  {
    label: 'Leave',
    items: [
      { label: 'Team calendar', href: '/leave/calendar' },
      { label: 'Leave requests', href: '/leave/requests', permission: 'leave:read' },
      { label: 'Leave setup', href: '/leave/setup', permission: 'leave_setup:manage' },
    ],
  },
  {
    label: 'Time & attendance',
    items: [
      { label: 'Daily attendance', href: '/attendance', permission: 'attendance:read' },
      { label: 'Rosters', href: '/attendance/rosters', permission: 'roster:read' },
      { label: 'Shifts', href: '/attendance/shifts', permission: 'shift:manage' },
      { label: 'Overtime rules', href: '/attendance/overtime', permission: 'attendance:read' },
    ],
  },
  {
    label: 'Recruitment',
    items: [
      { label: 'Requisitions', href: '/recruitment', permission: 'requisition:request|requisition:read' },
      { label: 'Jobs and candidates', href: '/recruitment/jobs', permission: 'recruitment:manage' },
    ],
  },
  {
    label: 'Performance & training',
    items: [
      { label: 'Review cycles', href: '/performance', permission: 'performance:read' },
      { label: 'Indicator library', href: '/performance/indicators', permission: 'performance:manage' },
      { label: 'Training sessions', href: '/training', permission: 'training:read' },
      { label: 'Mandatory training', href: '/training/compliance', permission: 'training:read' },
      { label: 'CPD', href: '/training/cpd', permission: 'training:read|cpd:verify' },
    ],
  },
  {
    label: 'Workplace & reports',
    items: [
      { label: 'Reports', href: '/reports', permission: 'report:read' },
      { label: 'Expense claims', href: '/expenses/all', permission: 'expense:read' },
      { label: 'Meeting rooms', href: '/meetings/rooms', permission: 'meeting_room:manage' },
    ],
  },
  {
    label: 'Lifecycle',
    items: [
      { label: 'Contracts', href: '/lifecycle/contracts', permission: 'contract:read' },
      { label: 'Promotions and changes', href: '/lifecycle/changes', permission: 'lifecycle:request' },
      { label: 'Onboarding and offboarding', href: '/lifecycle/checklists', permission: 'checklist:manage' },
      { label: 'Exits', href: '/lifecycle/exits', permission: 'exit:manage' },
      { label: 'Letters', href: '/lifecycle/letters', permission: 'letter:issue' },
    ],
  },
  {
    label: 'Payroll',
    items: [
      { label: 'Payroll runs', href: '/payroll', permission: 'payroll:read' },
      { label: 'Pay and loans', href: '/payroll/people', permission: 'salary:read' },
      { label: 'Payroll setup', href: '/payroll/setup', permission: 'salary:read' },
    ],
  },
  {
    label: 'Medical scheme',
    items: [
      { label: 'Billing desk', href: '/medical/billing', permission: 'medical:lookup' },
      { label: 'Members and applications', href: '/medical/members', permission: 'medical:read' },
      { label: 'Reports', href: '/medical/reports', permission: 'medical:read' },
      { label: 'Scheme setup', href: '/medical/setup', permission: 'medical_setup:manage' },
    ],
  },
  {
    label: 'Organisation',
    items: [
      { label: 'Organisation profile', href: '/organisation', permission: 'organisation:read' },
      { label: 'Branches', href: '/organisation/branches', permission: 'branch:read' },
      { label: 'Departments', href: '/organisation/departments', permission: 'department:read' },
      { label: 'Cost centres', href: '/organisation/cost-centres', permission: 'cost_centre:read' },
      { label: 'Job grades', href: '/organisation/job-grades', permission: 'job_grade:read' },
      { label: 'Positions', href: '/organisation/positions', permission: 'position:read' },
    ],
  },
  {
    label: 'Administration',
    items: [
      { label: 'Users', href: '/admin/users', permission: 'user:read' },
      { label: 'Roles & permissions', href: '/admin/roles', permission: 'role:read' },
      { label: 'Approval workflows', href: '/admin/workflows', permission: 'workflow:read' },
      { label: 'Login history', href: '/admin/login-history', permission: 'login_history:read' },
      { label: 'IP allow-list', href: '/admin/ip-allow-list', permission: 'ip_allow:manage' },
      { label: 'Audit trail', href: '/admin/audit', permission: 'audit:read' },
      { label: 'Settings', href: '/admin/settings', permission: 'setting:read' },
      { label: 'Numbering', href: '/admin/numbering', permission: 'numbering:read' },
      { label: 'Documents', href: '/admin/documents', permission: 'document:read' },
    ],
  },
  {
    label: 'Integrations',
    items: [
      { label: 'API clients', href: '/integrations/api-clients', permission: 'api_client:manage' },
      { label: 'Webhooks', href: '/integrations/webhooks', permission: 'webhook:read' },
      { label: 'Device connectors', href: '/integrations/connectors', permission: 'connector:manage' },
      { label: 'Event catalogue', href: '/integrations/events' },
      { label: 'Outbox', href: '/integrations/outbox', permission: 'webhook:read' },
    ],
  },
];

export function visibleNav(permissions: ReadonlySet<string> | string[]): NavGroup[] {
  const held = permissions instanceof Set ? permissions : new Set(permissions);
  return NAV.map((g) => ({ ...g, items: g.items.filter((i) => !i.permission || i.permission.split('|').some((p) => held.has(p))) })).filter((g) => g.items.length > 0);
}
