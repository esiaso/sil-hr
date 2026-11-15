'use client';

import { useQueries } from '@tanstack/react-query';
import Link from 'next/link';
import { BadgeCheck, CalendarDays, CheckSquare, FileSignature, FileWarning, ListTodo, Megaphone, Pin, UserMinus, UserPlus, Users, Wallet, type LucideIcon } from 'lucide-react';
import { formatDate, formatMoney } from '@sil/hr-shared';
import { useSession } from '@/lib/session';

/** Fetches through the same-origin proxy (which refreshes the session); a failed fetch just hides its tile. */
async function get<T>(path: string): Promise<{ ok: true; data: T } | { ok: false }> {
  const r = await fetch(path, { cache: 'no-store' });
  return r.ok ? { ok: true, data: (await r.json()) as T } : { ok: false };
}
const PENDING = { ok: false } as const;

interface Tile { label: string; value: string; note?: string; href: string; icon: LucideIcon; tone: string }
interface Dash {
  headcount: number | null; joiners_30d: number | null; leavers_30d: number | null; on_leave_today: number | null; licences_expiring_60d: number | null; contracts_ending_60d: number | null;
  last_payroll: { period: string; status: string; gross: string; net: string; employees: number } | null; headcount_by_department: { department: string; count: number }[] | null;
  pending_approvals: number; unacknowledged_policies: number; open_actions: number;
}
interface News { id: string; title: string; body: string; pinned: boolean; publish_at: string; author_name: string | null }

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
  const { settings } = useSession();
  const q = useQueries({
    queries: [
      { queryKey: ['dash', 'summary'], queryFn: () => get<Dash>('/api/v1/dashboard') },
      { queryKey: ['dash', 'balances'], queryFn: () => get<{ leave_type_code: string; available: number }[]>('/api/v1/me/leave/balances') },
      { queryKey: ['dash', 'news'], queryFn: () => get<News[]>('/api/v1/announcements') },
    ],
  });
  const [summary, balances, news] = q.map((x) => x.data ?? PENDING) as [Awaited<ReturnType<typeof get<Dash>>>, Awaited<ReturnType<typeof get<{ leave_type_code: string; available: number }[]>>>, Awaited<ReturnType<typeof get<News[]>>>];

  const tiles: Tile[] = [];
  const d = summary.ok ? summary.data : null;
  if (d) {
    tiles.push({ label: 'Waiting for my approval', value: String(d.pending_approvals), href: '/approvals', icon: CheckSquare, tone: TONES.purple });
    if (d.unacknowledged_policies) tiles.push({ label: 'Policies to read', value: String(d.unacknowledged_policies), href: '/policies', icon: FileSignature, tone: TONES.orange });
    if (d.open_actions) tiles.push({ label: 'My open meeting actions', value: String(d.open_actions), href: '/meetings', icon: ListTodo, tone: TONES.orange });
  }
  if (balances.ok) {
    const annual = balances.data.find((b) => b.leave_type_code === 'annual');
    if (annual) tiles.push({ label: 'My annual leave left', value: `${annual.available}`, note: 'days', href: '/leave', icon: CalendarDays, tone: TONES.green });
  }
  if (d?.headcount !== null && d) {
    tiles.push({ label: 'Staff', value: String(d.headcount), note: `${d.on_leave_today} on leave today`, href: '/reports', icon: Users, tone: TONES.blue });
    tiles.push({ label: 'Joined in 30 days', value: String(d.joiners_30d), href: '/reports', icon: UserPlus, tone: TONES.green });
    tiles.push({ label: 'Left in 30 days', value: String(d.leavers_30d), href: '/reports', icon: UserMinus, tone: d.leavers_30d ? TONES.orange : TONES.green });
    tiles.push({ label: 'Licences expiring in 60 days', value: String(d.licences_expiring_60d), href: '/reports?r=licence-expiry', icon: BadgeCheck, tone: d.licences_expiring_60d ? TONES.red : TONES.green });
    tiles.push({ label: 'Contracts ending in 60 days', value: String(d.contracts_ending_60d), href: '/reports?r=contract-expiry', icon: FileWarning, tone: d.contracts_ending_60d ? TONES.orange : TONES.green });
  }
  const run = d?.last_payroll;
  if (run) tiles.push({ label: `Payroll ${MONTHS[Number(run.period.slice(5)) - 1]}`, value: formatMoney(run.net), note: `${run.employees} staff · ${run.status.replace('_', ' ')}`, href: '/payroll', icon: Wallet, tone: TONES.blue });
  const depts = d?.headcount_by_department ?? [];
  const max = Math.max(1, ...depts.map((x) => x.count));

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
      <p className="muted mt-1.5 mb-6 text-sm">What needs attention today.</p>
      {news.ok && news.data.length > 0 && (
        <div className="mb-6 space-y-3">
          {news.data.slice(0, 3).map((n) => (
            <Link key={n.id} href="/announcements" className="surface flex gap-3 rounded-xl p-4 hover:shadow-md">
              <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${TONES.purple}`}>{n.pinned ? <Pin size={18} /> : <Megaphone size={18} />}</span>
              <div className="min-w-0"><div className="font-medium">{n.title}</div><div className="muted line-clamp-2 text-sm">{n.body}</div><div className="muted mt-1 text-xs">{formatDate(n.publish_at.slice(0, 10), settings.date_format)}{n.author_name ? ` · ${n.author_name}` : ''}</div></div>
            </Link>
          ))}
        </div>
      )}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {tiles.map((t) => (
          <Link key={t.label} href={t.href} className="surface rounded-xl p-5 shadow-[0_1px_2px_rgba(16,24,40,0.04)] transition-shadow hover:shadow-md">
            <span className={`flex h-10 w-10 items-center justify-center rounded-lg ${t.tone}`}><t.icon size={20} strokeWidth={1.75} /></span>
            <div className="mt-5 text-2xl font-semibold tracking-tight" style={{ color: 'var(--title)' }}>{t.value}</div>
            <div className="mt-1 flex items-center justify-between text-sm"><span className="muted">{t.label}</span>{t.note && <span className="muted text-xs">{t.note}</span>}</div>
          </Link>
        ))}
      </div>
      {depts.length > 0 && (
        <div className="surface mt-6 rounded-xl p-5">
          <h2 className="mb-3 font-semibold">Staff by department</h2>
          <div className="space-y-2">
            {depts.map((x) => (
              <div key={x.department} className="grid grid-cols-[minmax(8rem,14rem)_1fr_2.5rem] items-center gap-3 text-sm">
                <span className="truncate">{x.department}</span>
                <div className="h-2.5 rounded-full bg-[var(--surface-2)]"><div className="h-2.5 rounded-full bg-brand-500" style={{ width: `${(x.count / max) * 100}%` }} /></div>
                <span className="text-right tabular-nums">{x.count}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
