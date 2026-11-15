'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { CPD_STATUSES, formatDate } from '@sil/hr-shared';
import { Badge, Button, Card, Empty, Input, Loading, PageHeader, ProblemBanner, Select } from '@/components/ui';
import { hr, unwrap } from '@/lib/api';
import { useSession } from '@/lib/session';

export default function CpdPage() {
  const { can } = useSession();
  const [year, setYear] = useState(new Date().getFullYear());
  return (
    <div className="space-y-4">
      <PageHeader title="Continuing professional development" description="CPD points of licensed staff: credited automatically from training, or claimed for outside activities and verified here." />
      {can('cpd:verify') && <Claims />}
      {can('training:read') && <Compliance year={year} setYear={setYear} />}
      {can('training:read') && <Requirements editable={can('training:manage')} />}
    </div>
  );
}

function Claims() {
  const { settings } = useSession();
  const qc = useQueryClient();
  const [status, setStatus] = useState<'pending' | 'verified' | 'rejected'>('pending');
  const q = useQuery({ queryKey: ['cpd', status], queryFn: () => unwrap(hr.GET('/api/v1/training/cpd', { params: { query: { status } } })) });
  const [reason, setReason] = useState<Record<string, string>>({});
  const decide = useMutation({
    mutationFn: (v: { id: string; decision: 'verify' | 'reject' }) => unwrap(hr.POST('/api/v1/training/cpd/{id}/decision', { params: { path: { id: v.id } }, body: { decision: v.decision, comment: reason[v.id] || null } })),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['cpd'] }); void qc.invalidateQueries({ queryKey: ['cpd-compliance'] }); },
  });
  const rows = (q.data ?? []).filter((c) => c.source === 'external');
  return (
    <Card>
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 className="font-semibold">Claims for outside activities</h2>
        <Select aria-label="Status" className="w-auto" value={status} onChange={(e) => setStatus(e.target.value as 'pending')}>{Object.entries(CPD_STATUSES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select>
      </div>
      <ProblemBanner error={q.error ?? decide.error} />
      {!q.data ? <Loading /> : !rows.length ? <Empty>Nothing here.</Empty> : (
        <table className="data">
          <thead><tr><th>Who</th><th>Activity</th><th>Date</th><th>Points</th><th>Body</th><th>Evidence</th><th>{status === 'pending' ? '' : 'Decision'}</th></tr></thead>
          <tbody>{rows.map((c) => (
            <tr key={c.id}>
              <td>{c.employee_name} <span className="muted text-xs">{c.staff_number}</span></td><td>{c.title}{c.provider && <div className="muted text-xs">{c.provider}</div>}</td>
              <td>{formatDate(c.activity_date, settings.date_format)}</td><td>{c.points}</td><td>{c.licensing_body ?? '–'}</td>
              <td>{c.evidence_document_id ? <a className="link" href={`/api/v1/training/cpd/${c.id}/evidence`}>Open</a> : <span className="text-amber-600">none</span>}</td>
              <td className="whitespace-nowrap">{c.status === 'pending' ? (
                <div className="flex items-center gap-2"><Input aria-label="Reason" placeholder="Reason (to reject)" className="w-44" value={reason[c.id] ?? ''} onChange={(e) => setReason({ ...reason, [c.id]: e.target.value })} /><Button variant="secondary" onClick={() => decide.mutate({ id: c.id, decision: 'reject' })}>Reject</Button><Button onClick={() => decide.mutate({ id: c.id, decision: 'verify' })}>Verify</Button></div>
              ) : <><Badge value={c.status} />{c.decision_comment && <span className="muted ml-1 text-xs">{c.decision_comment}</span>}</>}</td>
            </tr>
          ))}</tbody>
        </table>
      )}
    </Card>
  );
}

function Compliance({ year, setYear }: { year: number; setYear: (y: number) => void }) {
  const { settings } = useSession();
  const [only, setOnly] = useState<'short' | ''>('short');
  const q = useQuery({ queryKey: ['cpd-compliance', year], queryFn: () => unwrap(hr.GET('/api/v1/training/cpd-compliance', { params: { query: { year } } })) });
  const rows = (q.data ?? []).filter((r) => !only || r.status === only);
  const met = q.data?.filter((r) => r.status === 'met').length ?? 0;
  const short = q.data?.filter((r) => r.status === 'short').length ?? 0;
  return (
    <Card>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-semibold">Points for {year} <span className="muted text-sm font-normal">· {met} met · {short} short</span></h2>
        <div className="flex gap-2">
          <Select aria-label="Show" className="w-auto" value={only} onChange={(e) => setOnly(e.target.value as 'short')}><option value="short">Short of points</option><option value="">Everyone licensed</option></Select>
          <Select aria-label="Year" className="w-auto" value={year} onChange={(e) => setYear(Number(e.target.value))}>{[0, 1, 2].map((d) => new Date().getFullYear() - d).map((y) => <option key={y} value={y}>{y}</option>)}</Select>
        </div>
      </div>
      <ProblemBanner error={q.error} />
      {!q.data ? <Loading /> : !rows.length ? <Empty>No one.</Empty> : (
        <table className="data">
          <thead><tr><th>Name</th><th>Department</th><th>Body</th><th>Licence expires</th><th>Required</th><th>Verified</th><th>Pending</th><th>Status</th></tr></thead>
          <tbody>{rows.map((r) => (
            <tr key={r.employee_id}>
              <td>{r.employee_name} <span className="muted text-xs">{r.staff_number}</span></td><td>{r.department_name}</td><td>{r.licensing_body}</td>
              <td>{formatDate(r.licence_expiry, settings.date_format)}</td><td>{r.status === 'no_requirement' ? '–' : r.required}</td><td>{r.earned}</td><td>{Number(r.pending) ? r.pending : ''}</td>
              <td><Badge value={r.status === 'met' ? 'met' : r.status === 'short' ? 'short' : 'not set'} /></td>
            </tr>
          ))}</tbody>
        </table>
      )}
    </Card>
  );
}

function Requirements({ editable }: { editable: boolean }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['cpd-requirements'], queryFn: () => unwrap(hr.GET('/api/v1/training/cpd-requirements')) });
  const [rows, setRows] = useState<{ licensing_body: string; points_per_year: string; description: string }[] | null>(null);
  const list = rows ?? q.data?.map((r) => ({ ...r, description: r.description ?? '' })) ?? [];
  const save = useMutation({ mutationFn: () => unwrap(hr.PUT('/api/v1/training/cpd-requirements', { body: { requirements: list.filter((r) => r.licensing_body).map((r) => ({ ...r, description: r.description || null })) } })), onSuccess: () => { setRows(null); void qc.invalidateQueries({ queryKey: ['cpd-requirements'] }); void qc.invalidateQueries({ queryKey: ['cpd-compliance'] }); } });
  const set = (i: number, k: 'licensing_body' | 'points_per_year' | 'description', v: string) => setRows(list.map((r, j) => (j === i ? { ...r, [k]: v } : r)));
  return (
    <Card>
      <div className="mb-2 flex items-center justify-between"><h2 className="font-semibold">Yearly requirement per licensing body</h2>{editable && <div className="flex gap-2"><Button variant="secondary" onClick={() => setRows([...list, { licensing_body: '', points_per_year: '0', description: '' }])}>Add body</Button>{rows && <Button busy={save.isPending} onClick={() => save.mutate()}>Save</Button>}</div>}</div>
      <ProblemBanner error={q.error ?? save.error} />
      <table className="data">
        <thead><tr><th>Body</th><th>Points a year</th><th>Note</th>{editable && <th />}</tr></thead>
        <tbody>{list.map((r, i) => (
          <tr key={i}>
            <td>{editable ? <Input aria-label="Licensing body" className="w-28" value={r.licensing_body} onChange={(e) => set(i, 'licensing_body', e.target.value)} /> : r.licensing_body}</td>
            <td>{editable ? <Input aria-label="Points a year" className="w-24" value={r.points_per_year} onChange={(e) => set(i, 'points_per_year', e.target.value)} /> : r.points_per_year}</td>
            <td>{editable ? <Input aria-label="Note" value={r.description} onChange={(e) => set(i, 'description', e.target.value)} /> : r.description}</td>
            {editable && <td><button type="button" className="link text-sm" onClick={() => setRows(list.filter((_, j) => j !== i))}>Remove</button></td>}
          </tr>
        ))}</tbody>
      </table>
      <p className="muted mt-2 text-xs">Points count towards a body when the activity is recorded for it. A body with no row here has no requirement.</p>
    </Card>
  );
}
