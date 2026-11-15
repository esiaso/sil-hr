'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { DELIVERY_MODES, formatDateTime, formatMoney, MANDATORY_FOR, PROGRAMME_CATEGORIES, SESSION_STATUSES } from '@sil/hr-shared';
import { Badge, Button, Card, Dialog, Empty, Field, Input, Loading, PageHeader, ProblemBanner, Select, Textarea } from '@/components/ui';
import { hr, unwrap } from '@/lib/api';
import { useSession } from '@/lib/session';
import { listProgrammes, SessionDialog, type Programme } from '@/components/training';


export default function TrainingPage() {
  const { can } = useSession();
  const manage = can('training:manage');
  const [tab, setTab] = useState<'sessions' | 'programmes'>('sessions');
  const [dialog, setDialog] = useState<'session' | Programme | 'programme' | null>(null);
  return (
    <div className="space-y-4">
      <PageHeader
        title="Training"
        description="The training catalogue and its sessions. Attendance with a pass completes the training and credits CPD points."
        actions={manage && <div className="flex gap-2"><Button variant="secondary" onClick={() => setDialog('programme')}>New programme</Button><Button onClick={() => setDialog('session')}>Schedule a session</Button></div>}
      />
      <div className="flex gap-1 border-b border-[var(--border)] text-sm">
        {(['sessions', 'programmes'] as const).map((t) => <button key={t} type="button" onClick={() => setTab(t)} className={`-mb-px border-b-2 px-3 py-2 capitalize ${tab === t ? 'border-brand-500 font-medium' : 'muted border-transparent'}`}>{t}</button>)}
      </div>
      {tab === 'sessions' ? <Sessions /> : <Programmes onEdit={manage ? (p) => setDialog(p) : undefined} />}
      {dialog === 'session' && <SessionDialog onClose={() => setDialog(null)} />}
      {dialog && dialog !== 'session' && <ProgrammeDialog p={dialog === 'programme' ? null : dialog} onClose={() => setDialog(null)} />}
    </div>
  );
}

function Sessions() {
  const { settings } = useSession();
  const [status, setStatus] = useState<'scheduled' | 'completed' | 'cancelled' | ''>('scheduled');
  const q = useQuery({ queryKey: ['sessions', status], queryFn: () => unwrap(hr.GET('/api/v1/training/sessions', { params: { query: { status: status || undefined } } })) });
  const rows = status === 'scheduled' ? [...(q.data ?? [])].reverse() : q.data;
  return (
    <Card>
      <div className="mb-2 flex justify-end"><Select aria-label="Status" className="w-auto" value={status} onChange={(e) => setStatus(e.target.value as 'scheduled')}><option value="">All</option>{Object.entries(SESSION_STATUSES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select></div>
      <ProblemBanner error={q.error} />
      {!rows ? <Loading /> : !rows.length ? <Empty>No sessions.</Empty> : (
        <table className="data">
          <thead><tr><th>Number</th><th>Programme</th><th>When</th><th>Venue</th><th>Places</th><th>Requests</th><th>Cost</th><th>Status</th></tr></thead>
          <tbody>{rows.map((s) => (
            <tr key={s.id}>
              <td><Link className="link" href={`/training/sessions/${s.id}`}>{s.number}</Link></td><td>{s.programme_title}</td>
              <td className="whitespace-nowrap">{formatDateTime(s.starts_at, settings.timezone, settings.date_format)}</td><td>{s.venue}</td>
              <td>{s.enrolled}{s.capacity ? ` / ${s.capacity}` : ''}{s.status === 'completed' ? ` (${s.attended} attended)` : ''}</td><td>{s.requested || ''}</td>
              <td>{s.cost_per_person ? formatMoney(s.cost_per_person) : ''}</td><td><Badge value={s.status} /></td>
            </tr>
          ))}</tbody>
        </table>
      )}
    </Card>
  );
}

function Programmes({ onEdit }: { onEdit?: (p: Programme) => void }) {
  const q = useQuery({ queryKey: ['programmes'], queryFn: listProgrammes });
  return (
    <Card>
      <ProblemBanner error={q.error} />
      {!q.data ? <Loading /> : !q.data.length ? <Empty>No programmes.</Empty> : (
        <table className="data">
          <thead><tr><th>Code</th><th>Programme</th><th>Category</th><th>Delivery</th><th>Hours</th><th>CPD</th><th>Mandatory</th><th>Pass mark</th><th>Status</th>{onEdit && <th />}</tr></thead>
          <tbody>{q.data.map((p) => (
            <tr key={p.id}>
              <td className="font-mono text-xs">{p.code}</td><td><div className="font-medium">{p.title}</div>{p.provider && <div className="muted text-xs">{p.provider}</div>}</td>
              <td>{PROGRAMME_CATEGORIES[p.category]}</td><td>{DELIVERY_MODES[p.delivery]}</td><td>{Number(p.duration_hours)}</td>
              <td>{Number(p.cpd_points) ? `${p.cpd_points}${p.cpd_bodies.length ? ` (${p.cpd_bodies.join(', ')})` : ''}` : '–'}</td>
              <td>{p.mandatory_for === 'none' ? '–' : `${MANDATORY_FOR[p.mandatory_for]}${p.refresh_months ? `, every ${p.refresh_months} months` : ''}`}</td>
              <td>{p.pass_mark ? `${p.pass_mark}%` : '–'}</td><td><Badge value={p.status} /></td>
              {onEdit && <td className="text-right"><button type="button" className="link text-sm" onClick={() => onEdit(p)}>Edit</button></td>}
            </tr>
          ))}</tbody>
        </table>
      )}
    </Card>
  );
}

function ProgrammeDialog({ p, onClose }: { p: Programme | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({
    code: p?.code ?? '', title: p?.title ?? '', description: p?.description ?? '', category: p?.category ?? 'clinical', delivery: p?.delivery ?? 'classroom', provider: p?.provider ?? '', duration_hours: p ? String(Number(p.duration_hours)) : '4',
    cpd_points: p ? String(Number(p.cpd_points)) : '0', cpd_bodies: p?.cpd_bodies.join(', ') ?? '', mandatory_for: p?.mandatory_for ?? 'none', refresh_months: p?.refresh_months ? String(p.refresh_months) : '', pass_mark: p?.pass_mark ? String(p.pass_mark) : '', status: p?.status ?? 'active',
  });
  const save = useMutation({
    mutationFn: () => {
      const body = {
        ...f, description: f.description || null, provider: f.provider || null, category: f.category as 'clinical', delivery: f.delivery as 'classroom', mandatory_for: f.mandatory_for as 'none', status: f.status as 'active',
        cpd_bodies: f.cpd_bodies.split(',').map((x) => x.trim()).filter(Boolean), refresh_months: f.refresh_months ? Number(f.refresh_months) : null, pass_mark: f.pass_mark ? Number(f.pass_mark) : null,
      };
      return p ? unwrap(hr.PUT('/api/v1/training/programmes/{id}', { params: { path: { id: p.id }, header: { 'If-Match': `"${p.version}"` } as never }, body })) : unwrap(hr.POST('/api/v1/training/programmes', { body }));
    },
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['programmes'] }); onClose(); },
  });
  const text = (k: 'code' | 'title' | 'provider' | 'duration_hours' | 'cpd_points' | 'cpd_bodies' | 'refresh_months' | 'pass_mark', l: string, hint?: string) => <Field label={l} hint={hint} htmlFor={`pg-${k}`}><Input id={`pg-${k}`} value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} /></Field>;
  return (
    <Dialog open wide title={p ? `Edit ${p.code}` : 'New programme'} onClose={onClose}>
      <ProblemBanner error={save.error} />
      <div className="grid gap-3 sm:grid-cols-3">
        {text('code', 'Code')}{text('title', 'Title')}{text('provider', 'Provider')}
        <Field label="Category" htmlFor="pg-cat"><Select id="pg-cat" value={f.category} onChange={(e) => setF({ ...f, category: e.target.value as 'clinical' })}>{Object.entries(PROGRAMME_CATEGORIES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select></Field>
        <Field label="Delivery" htmlFor="pg-del"><Select id="pg-del" value={f.delivery} onChange={(e) => setF({ ...f, delivery: e.target.value as 'classroom' })}>{Object.entries(DELIVERY_MODES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select></Field>
        {text('duration_hours', 'Hours')}
        {text('cpd_points', 'CPD points')}{text('cpd_bodies', 'Recognised by', 'e.g. NCK, KMPDC; empty = any')}{text('pass_mark', 'Pass mark (%)', 'Empty = attendance only')}
        <Field label="Mandatory for" htmlFor="pg-mf"><Select id="pg-mf" value={f.mandatory_for} onChange={(e) => setF({ ...f, mandatory_for: e.target.value as 'none' })}>{Object.entries(MANDATORY_FOR).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select></Field>
        {text('refresh_months', 'Repeat every (months)', 'Mandatory training only')}
        <Field label="Status" htmlFor="pg-s"><Select id="pg-s" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value as 'active' })}><option value="active">Active</option><option value="inactive">Inactive</option></Select></Field>
      </div>
      <Field label="Description" htmlFor="pg-d"><Textarea id="pg-d" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
      <div className="mt-4 flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button busy={save.isPending} onClick={() => save.mutate()}>Save</Button></div>
    </Dialog>
  );
}
