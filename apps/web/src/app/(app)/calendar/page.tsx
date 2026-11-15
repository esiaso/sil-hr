'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useMemo, useState } from 'react';
import { CALENDAR_KINDS } from '@sil/hr-shared';
import { Button, Card, Loading, PageHeader, ProblemBanner } from '@/components/ui';
import { hr, unwrap } from '@/lib/api';
import { useSession } from '@/lib/session';

const KIND_COLOURS: Record<string, string> = {
  leave: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200',
  team_leave: 'bg-teal-50 text-teal-800 dark:bg-teal-900/30 dark:text-teal-200',
  holiday: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200',
  meeting: 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-200',
  training: 'bg-violet-100 text-violet-800 dark:bg-violet-900/40 dark:text-violet-200',
  interview: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200',
  shift: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300',
};
const iso = (d: Date) => d.toISOString().slice(0, 10);
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export default function CalendarPage() {
  const { settings } = useSession();
  const [month, setMonth] = useState(() => { const d = new Date(); return new Date(Date.UTC(d.getFullYear(), d.getMonth(), 1)); });
  const first = new Date(month);
  first.setUTCDate(1 - ((month.getUTCDay() + 6) % 7));
  const days = Array.from({ length: 42 }, (_, i) => { const d = new Date(first); d.setUTCDate(first.getUTCDate() + i); return d; });
  const from = iso(days[0]);
  const to = iso(days[41]);
  const q = useQuery({ queryKey: ['calendar', from, to], queryFn: () => unwrap(hr.GET('/api/v1/me/calendar', { params: { query: { from, to } } })) });
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const time = (s: string) => new Intl.DateTimeFormat('en-GB', { timeZone: settings.timezone, hour: '2-digit', minute: '2-digit' }).format(new Date(s));
  const localDay = (s: string) => new Intl.DateTimeFormat('en-CA', { timeZone: settings.timezone }).format(new Date(s));
  const byDay = useMemo(() => {
    const map = new Map<string, NonNullable<typeof q.data>>();
    for (const e of q.data ?? []) {
      if (hidden.has(e.kind)) continue;
      const start = e.all_day ? e.start : localDay(e.start);
      const end = e.all_day ? e.end : start;
      for (const d of days) { const k = iso(d); if (k >= start && k <= end) map.set(k, [...(map.get(k) ?? []), e]); }
    }
    return map;
  }, [q.data, hidden]); // eslint-disable-line react-hooks/exhaustive-deps
  const feed = useMutation({ mutationFn: () => unwrap(hr.POST('/api/v1/me/calendar-feed')) });
  const today = iso(new Date());
  return (
    <div className="space-y-4">
      <PageHeader title="My calendar" description="Your leave, shifts, meetings, training and interviews, public holidays, and your team's leave." actions={<Button variant="secondary" busy={feed.isPending} onClick={() => feed.mutate()}>Subscribe in Outlook or Google</Button>} />
      <ProblemBanner error={q.error ?? feed.error} />
      {feed.data && (
        <Card>
          <p className="text-sm">Add this address to your calendar app as a subscription (in Outlook: Add calendar → From internet; in Google: Other calendars → From URL). Keep it private: anyone with it can see your calendar. Getting a new address stops the old one.</p>
          <input readOnly className="input mt-2 font-mono text-xs" value={feed.data.url} onFocus={(e) => e.currentTarget.select()} aria-label="Calendar address" />
        </Card>
      )}
      <Card>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Button variant="ghost" aria-label="Previous month" onClick={() => setMonth(new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() - 1, 1)))}><ChevronLeft size={16} /></Button>
            <h2 className="w-40 text-center font-semibold">{month.toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' })}</h2>
            <Button variant="ghost" aria-label="Next month" onClick={() => setMonth(new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 1)))}><ChevronRight size={16} /></Button>
          </div>
          <div className="flex flex-wrap gap-1 text-xs">{Object.entries(CALENDAR_KINDS).map(([k, l]) => <button key={k} type="button" aria-pressed={!hidden.has(k)} onClick={() => { const n = new Set(hidden); if (n.has(k)) n.delete(k); else n.add(k); setHidden(n); }} className={`rounded-full px-2 py-0.5 ${KIND_COLOURS[k]} ${hidden.has(k) ? 'opacity-40' : ''}`}>{l}</button>)}</div>
        </div>
        {!q.data ? <Loading /> : (
          <div className="grid grid-cols-7 gap-px overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--border)] text-xs">
            {DAYS.map((d) => <div key={d} className="bg-[var(--surface-2)] px-2 py-1 font-medium">{d}</div>)}
            {days.map((d) => {
              const k = iso(d);
              const items = byDay.get(k) ?? [];
              return (
                <div key={k} className={`min-h-24 bg-[var(--surface)] p-1 ${d.getUTCMonth() !== month.getUTCMonth() ? 'opacity-50' : ''}`}>
                  <div className={`mb-1 text-right ${k === today ? 'font-bold text-brand-600' : 'muted'}`}>{d.getUTCDate()}</div>
                  <div className="space-y-0.5">
                    {items.slice(0, 4).map((e) => {
                      const label = `${e.all_day ? '' : `${time(e.start)} `}${e.title}`;
                      const cls = `block truncate rounded px-1 ${KIND_COLOURS[e.kind]}`;
                      return e.link ? <Link key={e.id} href={e.link} title={label} className={cls}>{label}</Link> : <span key={e.id} title={label} className={cls}>{label}</span>;
                    })}
                    {items.length > 4 && <div className="muted px-1">+{items.length - 4} more</div>}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>
    </div>
  );
}
