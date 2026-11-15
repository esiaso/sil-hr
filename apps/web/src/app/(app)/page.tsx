'use client';

import { useQueries } from '@tanstack/react-query';
import Link from 'next/link';
import { BadgeCheck, CalendarDays, CheckSquare, Clock, Users, Wallet, type LucideIcon } from 'lucide-react';
import { formatMoney } from '@sil/hr-shared';

/** Fetches through the same-origin proxy (which refreshes the session); a failed fetch just hides its tile. */
async function get<T>(path: string): Promise<{ ok: true; data: T } | { ok: false }> {
  const r = await fetch(path, { cache: 'no-store' });
  return r.ok ? { ok: true, data: (await r.json()) as T } : { ok: false };
}
const PENDING = { ok: false } as const;

interface Tile { label: string; value: string; note?: string; href: string; icon: LucideIcon; tone: string }

const TONES = {
  blue: 'bg-blue-50 text-blue-600 dark:bg-blue-500/15 dark:text-blue-300',
  green: 'bg-emerald-50 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-300',
  orange: 'bg-orange-50 text-orange-600 dark:bg-orange-500/15 dark:text-orange-300',
  purple: 'bg-violet-50 text-violet-600 dark:bg-violet-500/15 dark:text-violet-300',
  red: 'bg-red-50 text-red-600 dark:bg-red-500/15 dark:text-red-300',
};
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** Each figure comes from the public API with the user's own permissions; tiles the user may not see do not appear. */
export default function Dashboard() {
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const q = useQueries({
    queries: [
      { queryKey: ['dash', 'inbox'], queryFn: () => get<unknown[]>('/api/v1/workflow/inbox') },
      { queryKey: ['dash', 'balances'], queryFn: () => get<{ leave_type_code: string; available: number }[]>('/api/v1/me/leave/balances') },
      { queryKey: ['dash', 'staff'], queryFn: () => get<{ data: unknown[]; next_cursor: string | null }>('/api/v1/employees?status=active&limit=500') },
      { queryKey: ['dash', 'licences'], queryFn: () => get<{ data: unknown[] }>('/api/v1/licences?expiring_within_days=60&limit=500') },
      { queryKey: ['dash', 'attendance', yesterday], queryFn: () => get<{ data: { status: string }[] }>(`/api/v1/attendance/days?from=${yesterday}&to=${yesterday}&limit=500`) },
      { queryKey: ['dash', 'runs'], queryFn: () => get<{ period: string; status: string; net: string; employees: number }[]>('/api/v1/payroll/runs') },
    ],
  });
  const [inbox, balances, staff, licences, attendance, runs] = q.map((x) => x.data ?? PENDING) as [
    Awaited<ReturnType<typeof get<unknown[]>>>, Awaited<ReturnType<typeof get<{ leave_type_code: string; available: number }[]>>>,
    Awaited<ReturnType<typeof get<{ data: unknown[]; next_cursor: string | null }>>>, Awaited<ReturnType<typeof get<{ data: unknown[] }>>>,
    Awaited<ReturnType<typeof get<{ data: { status: string }[] }>>>, Awaited<ReturnType<typeof get<{ period: string; status: string; net: string; employees: number }[]>>>,
  ];

  const tiles: Tile[] = [];
  if (inbox.ok) tiles.push({ label: 'Waiting for my approval', value: String(inbox.data.length), href: '/approvals', icon: CheckSquare, tone: TONES.purple });
  if (balances.ok) {
    const annual = balances.data.find((b) => b.leave_type_code === 'annual');
    if (annual) tiles.push({ label: 'My annual leave left', value: `${annual.available}`, note: 'days', href: '/leave', icon: CalendarDays, tone: TONES.green });
  }
  if (staff.ok) tiles.push({ label: 'Active staff', value: `${staff.data.data.length}${staff.data.next_cursor ? '+' : ''}`, href: '/people', icon: Users, tone: TONES.blue });
  if (licences.ok) tiles.push({ label: 'Licences expiring in 60 days', value: String(licences.data.data.length), href: '/people/licences', icon: BadgeCheck, tone: licences.data.data.length ? TONES.red : TONES.green });
  if (attendance.ok && attendance.data.data.length) {
    const present = attendance.data.data.filter((d) => ['present', 'late', 'half_day'].includes(d.status)).length;
    const scheduled = attendance.data.data.filter((d) => !['rest_day', 'holiday', 'not_scheduled'].includes(d.status)).length;
    tiles.push({ label: 'Present yesterday', value: `${present}`, note: `of ${scheduled} scheduled`, href: '/attendance', icon: Clock, tone: TONES.orange });
  }
  const run = runs.ok ? runs.data[0] : undefined;
  if (run) tiles.push({ label: `Payroll ${MONTHS[Number(run.period.slice(5)) - 1]}`, value: formatMoney(run.net), note: `${run.employees} staff · ${run.status.replace('_', ' ')}`, href: '/payroll', icon: Wallet, tone: TONES.blue });

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
      <p className="muted mt-1.5 mb-6 text-sm">What needs attention today.</p>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {tiles.map((t) => (
          <Link key={t.label} href={t.href} className="surface rounded-xl p-5 shadow-[0_1px_2px_rgba(16,24,40,0.04)] transition-shadow hover:shadow-md">
            <span className={`flex h-10 w-10 items-center justify-center rounded-lg ${t.tone}`}><t.icon size={20} strokeWidth={1.75} /></span>
            <div className="mt-5 text-2xl font-semibold tracking-tight" style={{ color: 'var(--title)' }}>{t.value}</div>
            <div className="mt-1 flex items-center justify-between text-sm"><span className="muted">{t.label}</span>{t.note && <span className="muted text-xs">{t.note}</span>}</div>
          </Link>
        ))}
      </div>
    </div>
  );
}
