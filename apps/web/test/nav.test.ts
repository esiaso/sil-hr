import { visibleNav } from '@/lib/nav';

describe('navigation', () => {
  it('shows only what the permissions allow and drops empty groups', () => {
    const groups = visibleNav(['department:read']);
    expect(groups.map((g) => g.label)).toEqual(['Home', 'Organisation', 'Integrations']);
    expect(groups[0].items.map((i) => i.href)).toEqual(['/', '/me']);
    expect(groups[1].items.map((i) => i.href)).toEqual(['/organisation/departments']);
    expect(groups[2].items.map((i) => i.href)).toEqual(['/integrations/events']);
  });

  it('gives an administrator every section', () => {
    const all = visibleNav(['organisation:read', 'branch:read', 'department:read', 'cost_centre:read', 'job_grade:read', 'position:read', 'user:read', 'role:read', 'login_history:read', 'ip_allow:manage', 'audit:read', 'setting:read', 'numbering:read', 'document:read', 'api_client:manage', 'webhook:read']);
    expect(all.map((g) => g.label)).toEqual(['Home', 'Organisation', 'Administration', 'Integrations']);
    expect(all.flatMap((g) => g.items)).toHaveLength(20);
  });
});
