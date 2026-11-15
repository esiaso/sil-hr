'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { CYCLE_KINDS, CYCLE_STATUSES, formatDate, REVIEW_STATUSES } from '@sil/hr-shared';
import { Badge, Button, Card, Dialog, Empty, Field, Input, Loading, PageHeader, ProblemBanner, Select } from '@/components/ui';
import { ReviewTable } from '@/components/performance';
import { hr, unwrap } from '@/lib/api';
import { useLookups } from '@/lib/lookups';
import { useSession } from '@/lib/session';

type Cycle = NonNullable<Awaited<ReturnType<typeof listCycles>>>[number];
type Kind = keyof typeof CYCLE_KINDS;
const listCycles = () => unwrap(hr.GET('/api/v1/performance/cycles'));
const NEXT: Record<string, { to: 'goal_setting' | 'reviewing' | 'closed'; label: string; confirm: string }[]> = {
  draft: [{ to: 'goal_setting', label: 'Launch', confirm: 'Launch the cycle? A review is created for every active member of staff in it, and they and their reviewers are told.' }],
  goal_setting: [{ to: 'reviewing', label: 'Open self-reviews', confirm: 'Open the review phase? Goals lock and staff are asked for their self-reviews.' }, { to: 'closed', label: 'Close', confirm: 'Close the cycle without reviewing?' }],
  reviewing: [{ to: 'closed', label: 'Close cycle', confirm: 'Close the cycle? No new self-reviews or manager assessments can be submitted; approvals and acknowledgements still finish.' }],
  closed: [],
};

export default function CyclesPage() {
  const { can } = useSession();
  const manage = can('performance:manage');
  const cycles = useQuery({ queryKey: ['cycles'], queryFn: listCycles });
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const current = cycles.data?.find((c) => c.id === (selected ?? cycles.data?.[0]?.id));
  return (
    <div className="space-y-4">
      <PageHeader title="Review cycles" description="Appraisal rounds: launch a cycle, track goal setting and reviews, then see how ratings fall across departments." actions={manage && <Button onClick={() => setCreating(true)}>New cycle</Button>} />
      <ProblemBanner error={cycles.error} />
      {!cycles.data ? <Loading /> : !cycles.data.length ? <Card><Empty>No cycles yet.</Empty></Card> : (
        <>
          <div className="flex flex-wrap gap-2">
            {cycles.data.map((c) => (
              <button key={c.id} type="button" onClick={() => setSelected(c.id)} className={`rounded-xl border px-4 py-2 text-left text-sm ${current?.id === c.id ? 'border-brand-500 bg-brand-50 dark:bg-brand-500/10' : 'border-[var(--border)] bg-[var(--surface)] hover:bg-[var(--hover)]'}`}>
                <div className="font-medium">{c.name}</div>
                <div className="muted text-xs">{CYCLE_KINDS[c.kind]} · {CYCLE_STATUSES[c.status]} · {c.counts.reviews} reviews</div>
              </button>
            ))}
          </div>
          {current && <CycleDetail c={current} manage={manage} />}
        </>
      )}
      {creating && <CycleDialog onClose={() => setCreating(false)} />}
    </div>
  );
}

function CycleDetail({ c, manage }: { c: Cycle; manage: boolean }) {
  const { settings } = useSession();
  const qc = useQueryClient();
  const [status, setStatus] = useState('');
  const reviews = useQuery({ queryKey: ['cycle-reviews', c.id, status], queryFn: () => unwrap(hr.GET('/api/v1/performance/reviews', { params: { query: { cycle_id: c.id, status: status || undefined } } })) });
  const report = useQuery({ queryKey: ['cycle-report', c.id], queryFn: () => unwrap(hr.GET('/api/v1/performance/cycles/{id}/report', { params: { path: { id: c.id } } })) });
  const move = useMutation({
    mutationFn: (to: 'goal_setting' | 'reviewing' | 'closed') => unwrap(hr.POST('/api/v1/performance/cycles/{id}/status', { params: { path: { id: c.id } }, body: { status: to } })),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['cycles'] }); void qc.invalidateQueries({ queryKey: ['cycle-reviews', c.id] }); },
  });
  const d = (x: string) => formatDate(x, settings.date_format);
  const max = Math.max(1, ...(report.data?.bands.map((b) => b.count) ?? [1]));
  return (
    <div className="space-y-4">
      <Card>
        <ProblemBanner error={move.error} />
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1 text-sm">
            <div><Badge value={CYCLE_STATUSES[c.status].toLowerCase()} /> <span className="muted">{d(c.period_start)} to {d(c.period_end)}{c.department_name ? ` · ${c.department_name} only` : ' · all staff'}</span></div>
            <div className="muted">Goals by {d(c.goals_due)} · self-reviews by {d(c.self_review_due)} · manager reviews by {d(c.manager_review_due)}</div>
          </div>
          {manage && <div className="flex gap-2">{NEXT[c.status].map((n) => <Button key={n.to} variant={n.to === 'closed' ? 'secondary' : 'primary'} busy={move.isPending && move.variables === n.to} onClick={() => window.confirm(n.confirm) && move.mutate(n.to)}>{n.label}</Button>)}</div>}
        </div>
        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-5">
          {([['Reviews', c.counts.reviews], ['Goals agreed', c.counts.goals_agreed], ['Self-reviews', c.counts.self_done], ['Manager reviews', c.counts.manager_done], ['Completed', c.counts.completed]] as const).map(([l, n]) => (
            <div key={l} className="rounded-xl bg-[var(--surface-2)] p-3"><div className="muted text-xs">{l}</div><div className="text-xl font-semibold">{n}</div></div>
          ))}
        </div>
      </Card>
      {report.data && report.data.bands.some((b) => b.count > 0) && (
        <Card>
          <h2 className="mb-3 font-semibold">Final ratings</h2>
          <div className="space-y-2">
            {report.data.bands.map((b) => (
              <div key={b.band} className="grid grid-cols-[11rem_1fr_2rem] items-center gap-2 text-sm">
                <span>{b.band}</span><div className="h-3 rounded-full bg-[var(--surface-2)]"><div className="h-3 rounded-full bg-brand-500" style={{ width: `${(b.count / max) * 100}%` }} /></div><span className="text-right">{b.count}</span>
              </div>
            ))}
          </div>
        </Card>
      )}
      <Card>
        <div className="mb-2 flex items-center justify-between gap-2">
          <h2 className="font-semibold">Reviews</h2>
          <Select aria-label="Filter by status" className="w-auto" value={status} onChange={(e) => setStatus(e.target.value)}><option value="">All statuses</option>{Object.entries(REVIEW_STATUSES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select>
        </div>
        <ProblemBanner error={reviews.error} />
        {!reviews.data ? <Loading /> : <ReviewTable rows={reviews.data} />}
      </Card>
    </div>
  );
}

function CycleDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const { departmentOptions } = useLookups();
  const y = new Date().getFullYear();
  const [f, setF] = useState({ name: `${y} annual appraisal`, kind: 'annual' as Kind, period_start: `${y}-01-01`, period_end: `${y}-12-31`, goals_due: `${y}-02-28`, self_review_due: `${y}-12-05`, manager_review_due: `${y}-12-15`, department_id: '' });
  const save = useMutation({ mutationFn: () => unwrap(hr.POST('/api/v1/performance/cycles', { body: { ...f, department_id: f.department_id || null } })), onSuccess: () => { void qc.invalidateQueries({ queryKey: ['cycles'] }); onClose(); } });
  const date = (k: 'period_start' | 'period_end' | 'goals_due' | 'self_review_due' | 'manager_review_due', l: string) => <Field label={l} htmlFor={`cy-${k}`}><Input id={`cy-${k}`} type="date" value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} /></Field>;
  return (
    <Dialog open title="New review cycle" onClose={onClose}>
      <ProblemBanner error={save.error} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name" htmlFor="cy-n"><Input id="cy-n" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="Kind" htmlFor="cy-k"><Select id="cy-k" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as Kind })}>{Object.entries(CYCLE_KINDS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select></Field>
        {date('period_start', 'Period from')}{date('period_end', 'Period to')}{date('goals_due', 'Goals agreed by')}{date('self_review_due', 'Self-reviews by')}{date('manager_review_due', 'Manager reviews by')}
        <Field label="Who" htmlFor="cy-d" hint="A department includes its sub-departments"><Select id="cy-d" value={f.department_id} onChange={(e) => setF({ ...f, department_id: e.target.value })}><option value="">All active staff</option>{departmentOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</Select></Field>
      </div>
      <p className="muted mt-2 text-xs">The cycle starts as a draft. Launching it creates the reviews.</p>
      <div className="mt-4 flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button busy={save.isPending} onClick={() => save.mutate()}>Create</Button></div>
    </Dialog>
  );
}
