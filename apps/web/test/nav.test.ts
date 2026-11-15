import { NAV, visibleNav } from '@/lib/nav';

describe('navigation', () => {
  it('shows only what the permissions allow and drops empty groups', () => {
    const groups = visibleNav(['department:read']);
    expect(groups.map((g) => g.label)).toEqual(['Home', 'Leave', 'Organisation', 'Integrations']);
    // Self-service entries need no permission; the staff directory does.
    const home = NAV.find((g) => g.label === 'Home')!.items.filter((i) => !i.permission).map((i) => i.href);
    expect(groups[0].items.map((i) => i.href)).toEqual(home);
    expect(home).toEqual(expect.arrayContaining(['/', '/me', '/leave', '/me/payslips', '/approvals', '/calendar', '/policies', '/expenses']));
    expect(groups[2].items.map((i) => i.href)).toEqual(['/organisation/departments']);
    expect(groups[3].items.map((i) => i.href)).toEqual(['/integrations/events']);
  });

  it('gives an administrator every section', () => {
    const all = visibleNav(['organisation:read', 'branch:read', 'department:read', 'cost_centre:read', 'job_grade:read', 'position:read', 'user:read', 'role:read', 'login_history:read', 'ip_allow:manage', 'audit:read', 'setting:read', 'numbering:read', 'document:read', 'api_client:manage', 'webhook:read']);
    expect(all.map((g) => g.label)).toEqual(['Home', 'Leave', 'Organisation', 'Administration', 'Integrations']);
    expect(all.find((g) => g.label === 'Administration')!.items).toHaveLength(8); // all but Approval workflows (workflow:read)
  });

  it('every permission-gated entry is reachable by some permission and hrefs are unique', () => {
    const items = NAV.flatMap((g) => g.items);
    expect(new Set(items.map((i) => i.href)).size).toBe(items.length);
    for (const i of items) if (i.permission) expect(visibleNav(i.permission.split('|')).flatMap((g) => g.items).some((x) => x.href === i.href)).toBe(true);
  });
});
