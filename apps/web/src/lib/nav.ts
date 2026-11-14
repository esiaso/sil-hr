/**
 * Navigation grouped by the domains of the system. Each entry names the permission that
 * makes it visible; the shell filters on the signed-in user's permissions. Later slices
 * add groups (People, Leave, Time, Payroll…) here.
 */
export interface NavItem {
  label: string;
  href: string;
  permission?: string;
}
export interface NavGroup {
  label: string;
  items: NavItem[];
}

export const NAV: NavGroup[] = [
  { label: 'Home', items: [{ label: 'Dashboard', href: '/' }] },
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
      { label: 'Event catalogue', href: '/integrations/events' },
      { label: 'Outbox', href: '/integrations/outbox', permission: 'webhook:read' },
    ],
  },
];

export function visibleNav(permissions: ReadonlySet<string> | string[]): NavGroup[] {
  const held = permissions instanceof Set ? permissions : new Set(permissions);
  return NAV.map((g) => ({ ...g, items: g.items.filter((i) => !i.permission || held.has(i.permission)) })).filter((g) => g.items.length > 0);
}
