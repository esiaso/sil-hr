'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { formatDate } from '@sil/hr-shared';
import { Button, Card, Dialog, Empty, Field, Input, Loading, PageHeader, ProblemBanner, Select } from '@/components/ui';
import { ApiError, hr, unwrap } from '@/lib/api';
import { useSession } from '@/lib/session';

type DayType = 'normal' | 'rest_day' | 'public_holiday';
type Rule = { id: string; day_type: DayType; multiplier: number | null; min_minutes: number; requires_approval: boolean; effective_from: string; effective_to: string | null };
const LABEL: Record<DayType, string> = { normal: 'Working day', rest_day: 'Rest day', public_holiday: 'Public holiday' };

function RuleDialog({ r, onClose }: { r: Rule | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [v, setV] = useState({ day_type: r?.day_type ?? ('normal' as DayType), multiplier: r?.multiplier ?? null, min_minutes: r?.min_minutes ?? 30, requires_approval: r?.requires_approval ?? false, effective_from: r?.effective_from ?? new Date().toISOString().slice(0, 10), effective_to: r?.effective_to ?? null });
  const save = useMutation({
    mutationFn: () => (r ? unwrap(hr.PUT('/api/v1/attendance/overtime-rules/{id}', { params: { path: { id: r.id } }, body: v })) : unwrap(hr.POST('/api/v1/attendance/overtime-rules', { body: v }))),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['ot-rules'] }); onClose(); },
  });
  const fe = save.error instanceof ApiError ? save.error.fieldErrors : {};
  return (
    <Dialog open title={r ? 'Overtime rule' : 'New overtime rule'} onClose={onClose}>
      <ProblemBanner error={save.error} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Applies on" htmlFor="ot-day"><Select id="ot-day" value={v.day_type} onChange={(e) => setV({ ...v, day_type: e.target.value as DayType })}>{Object.entries(LABEL).map(([k, x]) => <option key={k} value={k}>{x}</option>)}</Select></Field>
        <Field label="Pay multiplier" htmlFor="ot-mult" error={fe.multiplier} hint="1.5 is time and a half; empty records overtime without a rate"><Input id="ot-mult" type="number" step="0.25" value={v.multiplier ?? ''} onChange={(e) => setV({ ...v, multiplier: e.target.value === '' ? null : Number(e.target.value) })} /></Field>
        <Field label="Counts after (minutes past the shift)" htmlFor="ot-min" error={fe.min_minutes}><Input id="ot-min" type="number" value={v.min_minutes} onChange={(e) => setV({ ...v, min_minutes: Number(e.target.value) })} /></Field>
        <div />
        <Field label="From" htmlFor="ot-from" error={fe.effective_from}><Input id="ot-from" type="date" value={v.effective_from} onChange={(e) => setV({ ...v, effective_from: e.target.value })} /></Field>
        <Field label="Until" htmlFor="ot-to" error={fe.effective_to}><Input id="ot-to" type="date" value={v.effective_to ?? ''} onChange={(e) => setV({ ...v, effective_to: e.target.value || null })} /></Field>
      </div>
      <label className="mt-3 flex items-center gap-1 text-sm"><input type="checkbox" checked={v.requires_approval} onChange={(e) => setV({ ...v, requires_approval: e.target.checked })} />Count only when a manager approves it</label>
      <div className="mt-4 flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button busy={save.isPending} onClick={() => save.mutate()}>Save</Button></div>
    </Dialog>
  );
}

export default function OvertimePage() {
  const { can, settings } = useSession();
  const q = useQuery({ queryKey: ['ot-rules'], queryFn: () => unwrap(hr.GET('/api/v1/attendance/overtime-rules')) as Promise<Rule[]> });
  const [editing, setEditing] = useState<Rule | 'new' | null>(null);
  return (
    <div className="space-y-4">
      <PageHeader title="Overtime rules" description="The hospital has no overtime rates yet. Without a rule, time worked past the shift is recorded but not counted as overtime. Add a rule for each kind of day when rates are agreed; payroll (slice 5) reads them." actions={can('attendance:manage') && <Button onClick={() => setEditing('new')}>New rule</Button>} />
      <ProblemBanner error={q.error} />
      <Card>
        {!q.data ? <Loading /> : !q.data.length ? <Empty>No overtime rules. Overtime is not being counted.</Empty> : (
          <table className="data">
            <thead><tr><th>Applies on</th><th>Rate</th><th>Counts after</th><th>Approval</th><th>Effective</th><th /></tr></thead>
            <tbody>{q.data.map((r) => <tr key={r.id}><td>{LABEL[r.day_type]}</td><td>{r.multiplier ? `× ${r.multiplier}` : <span className="muted">not set</span>}</td><td>{r.min_minutes} min</td><td>{r.requires_approval ? 'needed' : ''}</td><td>{formatDate(r.effective_from, settings.date_format)}{r.effective_to ? ` to ${formatDate(r.effective_to, settings.date_format)}` : ' onwards'}</td><td>{can('attendance:manage') && <Button variant="ghost" onClick={() => setEditing(r)}>Edit</Button>}</td></tr>)}</tbody>
          </table>
        )}
      </Card>
      {editing && <RuleDialog r={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </div>
  );
}
