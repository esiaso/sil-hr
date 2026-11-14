import Link from 'next/link';
import { serverGet } from '@/lib/server-session';

export const metadata = { title: 'Dashboard' };

interface Count {
  label: string;
  href: string;
  path: string;
}

const COUNTS: Count[] = [
  { label: 'Branches', href: '/organisation/branches', path: '/api/v1/branches?limit=500' },
  { label: 'Departments', href: '/organisation/departments', path: '/api/v1/departments?limit=500' },
  { label: 'Positions', href: '/organisation/positions', path: '/api/v1/positions?limit=500' },
  { label: 'Cost centres', href: '/organisation/cost-centres', path: '/api/v1/cost-centres?limit=500' },
];

/** Server component: counts come straight from the public API with the user's token. */
export default async function Dashboard() {
  const results = await Promise.all(COUNTS.map((c) => serverGet<{ data: { headcount?: number }[] }>(c.path)));
  const positions = results[2];
  const headcount = positions.ok ? positions.data.data.reduce((s, p) => s + (p.headcount ?? 0), 0) : null;
  return (
    <div>
      <h1 className="mb-1 text-xl font-semibold">Dashboard</h1>
      <p className="muted mb-6 text-sm">Organisation structure at a glance. Staff, leave, attendance and payroll arrive in the next slices.</p>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        {COUNTS.map((c, i) => {
          const r = results[i];
          return (
            <Link key={c.label} href={c.href} className="surface rounded-lg p-4 hover:shadow-sm">
              <div className="muted text-xs">{c.label}</div>
              <div className="mt-1 text-2xl font-semibold">{r.ok ? r.data.data.length : '—'}</div>
            </Link>
          );
        })}
        <Link href="/organisation/positions" className="surface rounded-lg p-4 hover:shadow-sm">
          <div className="muted text-xs">Approved headcount</div>
          <div className="mt-1 text-2xl font-semibold">{headcount ?? '—'}</div>
        </Link>
      </div>
    </div>
  );
}
