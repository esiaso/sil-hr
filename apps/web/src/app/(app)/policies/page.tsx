'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { formatDate, formatDateTime, POLICY_CATEGORIES } from '@sil/hr-shared';
import { Badge, Button, Card, Dialog, Empty, Field, Input, Loading, PageHeader, ProblemBanner, Select, Textarea } from '@/components/ui';
import { ApiError, hr, unwrap } from '@/lib/api';
import { useLookups } from '@/lib/lookups';
import { useSession } from '@/lib/session';

type Policy = NonNullable<Awaited<ReturnType<typeof listAll>>>[number];
const listAll = () => unwrap(hr.GET('/api/v1/policies'));

export default function PoliciesPage() {
  const { can } = useSession();
  const admin = can('policy:read') || can('policy:manage');
  return (
    <div className="space-y-4">
      <PageHeader title="Policies" description="Hospital policies that apply to you. Open each one and confirm you have read it." />
      <Mine />
      {admin && <AllPolicies manage={can('policy:manage')} />}
    </div>
  );
}

function Mine() {
  const { settings } = useSession();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['my-policies'], queryFn: () => unwrap(hr.GET('/api/v1/me/policies')) });
  const ack = useMutation({ mutationFn: (id: string) => unwrap(hr.POST('/api/v1/policies/{id}/acknowledge', { params: { path: { id } } })), onSuccess: () => { void qc.invalidateQueries({ queryKey: ['my-policies'] }); void qc.invalidateQueries({ queryKey: ['policies'] }); void qc.invalidateQueries({ queryKey: ['dash'] }); } });
  return (
    <Card>
      <h2 className="mb-2 font-semibold">My policies</h2>
      <ProblemBanner error={q.error ?? ack.error} />
      {!q.data ? <Loading /> : !q.data.length ? <Empty>No policies apply to you yet.</Empty> : (
        <table className="data">
          <thead><tr><th>Policy</th><th>Category</th><th>Version</th><th>In force from</th><th>Read</th><th /></tr></thead>
          <tbody>{q.data.map((p) => (
            <tr key={p.id}>
              <td><a className="link" href={`/api/v1/policies/${p.id}/document`}>{p.title}</a> <span className="muted text-xs">{p.code}</span></td>
              <td>{POLICY_CATEGORIES[p.category]}</td><td>{p.version_no}</td><td>{formatDate(p.effective_from, settings.date_format)}</td>
              <td>{p.acknowledged_at ? formatDateTime(p.acknowledged_at, settings.timezone, settings.date_format) : p.requires_ack ? <span className="text-amber-600">Not yet</span> : '–'}</td>
              <td className="text-right">{p.requires_ack && !p.acknowledged_at && <Button busy={ack.isPending && ack.variables === p.id} onClick={() => ack.mutate(p.id)}>I have read it</Button>}</td>
            </tr>
          ))}</tbody>
        </table>
      )}
    </Card>
  );
}

function AllPolicies({ manage }: { manage: boolean }) {
  const q = useQuery({ queryKey: ['policies'], queryFn: listAll });
  const [dialog, setDialog] = useState<{ kind: 'new' } | { kind: 'version' | 'edit' | 'acks'; p: Policy } | null>(null);
  return (
    <Card>
      <div className="mb-2 flex items-center justify-between"><h2 className="font-semibold">All policies</h2>{manage && <Button onClick={() => setDialog({ kind: 'new' })}>Publish a policy</Button>}</div>
      <ProblemBanner error={q.error} />
      {!q.data ? <Loading /> : !q.data.length ? <Empty>No policies.</Empty> : (
        <table className="data">
          <thead><tr><th>Policy</th><th>Audience</th><th>Version</th><th>Read</th><th>Status</th><th /></tr></thead>
          <tbody>{q.data.map((p) => (
            <tr key={p.id}>
              <td><div className="font-medium">{p.title}</div><div className="muted text-xs">{p.code} · {POLICY_CATEGORIES[p.category]}</div></td>
              <td>{p.audience}</td><td>{p.current_version?.version_no ?? '–'}</td>
              <td>{p.requires_ack ? <button type="button" className="link" onClick={() => setDialog({ kind: 'acks', p })}>{p.acknowledged} of {p.audience_size}</button> : 'Not required'}</td>
              <td><Badge value={p.status} /></td>
              <td className="whitespace-nowrap text-right">{manage && <><button type="button" className="link mr-3 text-sm" onClick={() => setDialog({ kind: 'version', p })}>New version</button><button type="button" className="link text-sm" onClick={() => setDialog({ kind: 'edit', p })}>Edit</button></>}</td>
            </tr>
          ))}</tbody>
        </table>
      )}
      {dialog?.kind === 'new' && <UploadDialog onClose={() => setDialog(null)} />}
      {dialog?.kind === 'version' && <UploadDialog p={dialog.p} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'edit' && <EditDialog p={dialog.p} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'acks' && <AcksDialog p={dialog.p} onClose={() => setDialog(null)} />}
    </Card>
  );
}

function UploadDialog({ p, onClose }: { p?: Policy; onClose: () => void }) {
  const qc = useQueryClient();
  const { departmentOptions } = useLookups();
  const [f, setF] = useState({ code: '', title: '', category: 'hr', description: '', department_ids: [] as string[], requires_ack: true, effective_from: new Date().toISOString().slice(0, 10), changes: '' });
  const [file, setFile] = useState<File | null>(null);
  const save = useMutation({
    mutationFn: async () => {
      const body = new FormData();
      if (p) { body.append('effective_from', f.effective_from); if (f.changes) body.append('changes', f.changes); }
      else for (const [k, v] of Object.entries({ code: f.code, title: f.title, category: f.category, description: f.description, department_ids: f.department_ids.join(','), requires_ack: String(f.requires_ack), effective_from: f.effective_from })) if (v) body.append(k, v);
      if (file) body.append('file', file);
      const res = await fetch(p ? `/api/v1/policies/${p.id}/versions` : '/api/v1/policies', { method: 'POST', body, headers: { 'x-requested-with': 'sil-hr-web' } });
      const json = await res.json();
      if (!res.ok) throw new ApiError(res.status, json);
      return json;
    },
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['policies'] }); void qc.invalidateQueries({ queryKey: ['my-policies'] }); onClose(); },
  });
  return (
    <Dialog open title={p ? `New version: ${p.title}` : 'Publish a policy'} onClose={onClose}>
      <ProblemBanner error={save.error} />
      <div className="grid gap-3 sm:grid-cols-2">
        {!p && <>
          <Field label="Code" htmlFor="po-c"><Input id="po-c" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} /></Field>
          <Field label="Title" htmlFor="po-t"><Input id="po-t" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
          <Field label="Category" htmlFor="po-k"><Select id="po-k" value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>{Object.entries(POLICY_CATEGORIES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select></Field>
          <Field label="Who it applies to" htmlFor="po-d" hint="None selected = all staff"><select id="po-d" multiple className="input h-24" value={f.department_ids} onChange={(e) => setF({ ...f, department_ids: [...e.target.selectedOptions].map((o) => o.value) })}>{departmentOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select></Field>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.requires_ack} onChange={(e) => setF({ ...f, requires_ack: e.target.checked })} /> Staff must confirm they have read it</label>
        </>}
        <Field label="In force from" htmlFor="po-e"><Input id="po-e" type="date" value={f.effective_from} onChange={(e) => setF({ ...f, effective_from: e.target.value })} /></Field>
        <Field label="Document (PDF)" htmlFor="po-f"><input id="po-f" type="file" accept="application/pdf" className="text-sm" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></Field>
      </div>
      {p ? <Field label="What changed" htmlFor="po-ch"><Textarea id="po-ch" value={f.changes} onChange={(e) => setF({ ...f, changes: e.target.value })} /></Field> : <Field label="Summary" htmlFor="po-s"><Textarea id="po-s" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>}
      {p && <p className="muted text-xs">Everyone in the audience will be asked to read and confirm the new version.</p>}
      <div className="mt-4 flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button busy={save.isPending} disabled={!file} onClick={() => save.mutate()}>Publish</Button></div>
    </Dialog>
  );
}

function EditDialog({ p, onClose }: { p: Policy; onClose: () => void }) {
  const qc = useQueryClient();
  const { departmentOptions } = useLookups();
  const [f, setF] = useState({ title: p.title, category: p.category, description: p.description ?? '', department_ids: p.department_ids, requires_ack: p.requires_ack, status: p.status });
  const save = useMutation({ mutationFn: () => unwrap(hr.PUT('/api/v1/policies/{id}', { params: { path: { id: p.id }, header: { 'If-Match': `"${p.version}"` } as never }, body: { ...f, description: f.description || null } })), onSuccess: () => { void qc.invalidateQueries({ queryKey: ['policies'] }); onClose(); } });
  return (
    <Dialog open title={`Edit ${p.code}`} onClose={onClose}>
      <ProblemBanner error={save.error} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Title" htmlFor="pe-t"><Input id="pe-t" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
        <Field label="Category" htmlFor="pe-k"><Select id="pe-k" value={f.category} onChange={(e) => setF({ ...f, category: e.target.value as 'hr' })}>{Object.entries(POLICY_CATEGORIES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select></Field>
        <Field label="Who it applies to" htmlFor="pe-d" hint="None = all staff"><select id="pe-d" multiple className="input h-24" value={f.department_ids} onChange={(e) => setF({ ...f, department_ids: [...e.target.selectedOptions].map((o) => o.value) })}>{departmentOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select></Field>
        <Field label="Status" htmlFor="pe-s"><Select id="pe-s" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value as 'active' })}><option value="active">Active</option><option value="retired">Retired</option></Select></Field>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.requires_ack} onChange={(e) => setF({ ...f, requires_ack: e.target.checked })} /> Staff must confirm they have read it</label>
      </div>
      <Field label="Summary" htmlFor="pe-de"><Textarea id="pe-de" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
      <div className="mt-4 flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button busy={save.isPending} onClick={() => save.mutate()}>Save</Button></div>
    </Dialog>
  );
}

function AcksDialog({ p, onClose }: { p: Policy; onClose: () => void }) {
  const { settings } = useSession();
  const [pending, setPending] = useState(true);
  const q = useQuery({ queryKey: ['policy-acks', p.id, pending], queryFn: () => unwrap(hr.GET('/api/v1/policies/{id}/acknowledgements', { params: { path: { id: p.id }, query: { pending: pending ? 'true' : undefined } } })) });
  return (
    <Dialog open wide title={`${p.title}: who has read version ${p.current_version?.version_no ?? ''}`} onClose={onClose}>
      <label className="mb-2 flex items-center gap-2 text-sm"><input type="checkbox" checked={pending} onChange={(e) => setPending(e.target.checked)} /> Only those who have not read it</label>
      <ProblemBanner error={q.error} />
      {!q.data ? <Loading /> : !q.data.length ? <Empty>Everyone has read it.</Empty> : (
        <div className="max-h-96 overflow-y-auto">
          <table className="data"><thead><tr><th>Name</th><th>Department</th><th>Read</th></tr></thead>
            <tbody>{q.data.map((r) => <tr key={r.employee_id}><td>{r.employee_name} <span className="muted text-xs">{r.staff_number}</span></td><td>{r.department_name}</td><td>{r.acknowledged_at ? formatDateTime(r.acknowledged_at, settings.timezone, settings.date_format) : <span className="text-amber-600">Not yet</span>}</td></tr>)}</tbody>
          </table>
        </div>
      )}
    </Dialog>
  );
}
