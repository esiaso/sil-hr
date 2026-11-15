'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { CASE_KINDS, formatDate, formatDateTime } from '@sil/hr-shared';
import { EmployeePicker } from '@/components/employee-picker';
import { Badge, Button, Card, Dialog, Empty, Field, Input, Loading, PageHeader, ProblemBanner, Select, Textarea } from '@/components/ui';
import { ApiError, hr, unwrap } from '@/lib/api';
import { useSession } from '@/lib/session';

type Kind = keyof typeof CASE_KINDS;

/**
 * One page for everyone: staff see their own warnings, plans, awards and the complaints
 * they raised; HR sees cases in scope; restricted cases appear only to the people named.
 */
export default function RelationsPage() {
  const { can, settings, me } = useSession();
  const [kind, setKind] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [dialog, setDialog] = useState<'new' | 'complaint' | null>(null);
  const q = useQuery({ queryKey: ['relations', kind], queryFn: () => unwrap(hr.GET('/api/v1/relations-cases', { params: { query: { kind: kind || undefined } } })) });
  return (
    <div className="space-y-4">
      <PageHeader
        title={can('relations:read') ? 'Employee relations' : 'My HR file'}
        description={can('relations:read') ? 'Warnings, improvement plans, awards and disciplinary cases in your scope, and complaints you are named on. Complaints are visible only to the people named on them.' : 'Warnings, improvement plans and awards on your file, and any complaint you have raised. A complaint is seen only by the HR managers and the people they ask to look into it.'}
        actions={<>{me.employee_id && <Button variant="secondary" onClick={() => setDialog('complaint')}>Raise a complaint</Button>}{can('relations:manage') && <Button onClick={() => setDialog('new')}>New case</Button>}</>}
      />
      {can('relations:read') && <Select aria-label="Kind" value={kind} onChange={(e) => setKind(e.target.value)} className="max-w-60"><option value="">All kinds</option>{Object.entries(CASE_KINDS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select>}
      <ProblemBanner error={q.error} />
      <Card>
        {!q.data ? <Loading /> : !q.data.length ? <Empty>Nothing on file.</Empty> : (
          <table className="data">
            <thead><tr><th>Number</th><th>Kind</th><th>About</th><th>Subject</th><th>Opened</th><th>Status</th></tr></thead>
            <tbody>{q.data.map((c) => (
              <tr key={c.id} className="cursor-pointer" onClick={() => setOpen(c.id)}>
                <td className="font-mono text-xs">{c.number}</td><td>{CASE_KINDS[c.kind]}{c.severity ? ` (${c.severity})` : ''} {c.restricted && <Badge value="restricted" />}</td><td>{c.employee_name ?? ''}</td><td>{c.subject}</td>
                <td>{formatDate(c.opened_on, settings.date_format)}</td><td><Badge value={c.status} />{c.employee_id === me.employee_id && !c.acknowledged_at && c.kind !== 'complaint' && <span className="ml-1 text-xs text-amber-600">to acknowledge</span>}</td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </Card>
      {open && <CaseDialog id={open} onClose={() => setOpen(null)} />}
      {dialog === 'new' && <NewCase onClose={() => setDialog(null)} />}
      {dialog === 'complaint' && <Complaint onClose={() => setDialog(null)} />}
    </div>
  );
}

function CaseDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const { settings, me } = useSession();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['relations-case', id], queryFn: () => unwrap(hr.GET('/api/v1/relations-cases/{id}', { params: { path: { id } } })) });
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['relations-case', id] }); void qc.invalidateQueries({ queryKey: ['relations'] }); };
  const [note, setNote] = useState({ body: '', visible: false });
  const [outcome, setOutcome] = useState('');
  const addNote = useMutation({ mutationFn: () => unwrap(hr.POST('/api/v1/relations-cases/{id}/notes', { params: { path: { id } }, body: { body: note.body, visible_to_employee: note.visible } })), onSuccess: () => { setNote({ body: '', visible: false }); refresh(); } });
  const ack = useMutation({ mutationFn: () => unwrap(hr.POST('/api/v1/relations-cases/{id}/acknowledge', { params: { path: { id } } })), onSuccess: refresh });
  const closeCase = useMutation({ mutationFn: () => unwrap(hr.PUT('/api/v1/relations-cases/{id}', { params: { path: { id } }, body: { status: 'closed', outcome } })), onSuccess: refresh });
  const c = q.data;
  const full = !!c && (c.access.length > 0 || (c.employee_id !== me.employee_id && c.kind !== 'complaint'));
  return (
    <Dialog open wide title={c ? `${c.number} · ${c.subject}` : 'Case'} onClose={onClose}>
      <ProblemBanner error={q.error ?? addNote.error ?? ack.error ?? closeCase.error} />
      {!c ? <Loading /> : (
        <div className="space-y-4 text-sm">
          <div className="flex flex-wrap gap-2"><Badge value={c.status} />{c.restricted && <Badge value="restricted" />}<span className="muted">{CASE_KINDS[c.kind]}{c.severity ? `, ${c.severity} warning` : ''} · opened {formatDate(c.opened_on, settings.date_format)}{c.expires_on ? ` · on file until ${formatDate(c.expires_on, settings.date_format)}` : ''}</span></div>
          {c.employee_name && <div><span className="muted">About:</span> {c.employee_name}</div>}
          {c.complainant_name && <div><span className="muted">Raised by:</span> {c.complainant_name}</div>}
          {c.details && <p className="whitespace-pre-wrap">{c.details}</p>}
          {c.objectives.length > 0 && (
            <div><div className="mb-1 font-medium">Objectives</div>
              <table className="data"><thead><tr><th>Objective</th><th>Measure</th><th>By</th><th>Status</th></tr></thead><tbody>{c.objectives.map((o) => <tr key={o.id}><td>{o.objective}</td><td>{o.measure}</td><td>{o.due_date ? formatDate(o.due_date, settings.date_format) : ''}</td><td><Badge value={o.status} /></td></tr>)}</tbody></table>
            </div>
          )}
          {c.outcome && <div><span className="font-medium">Outcome:</span> {c.outcome}</div>}
          <div>
            <div className="mb-1 font-medium">Notes</div>
            {!c.notes.length ? <p className="muted">None.</p> : <ul className="space-y-2">{c.notes.map((n) => <li key={n.id} className="rounded-lg bg-[var(--surface-2)] px-3 py-2"><div className="muted text-xs">{n.author_name} · {formatDateTime(n.created_at, settings.timezone, settings.date_format)}{full && n.visible_to_employee ? ' · shared with the employee' : ''}</div><div className="whitespace-pre-wrap">{n.body}</div></li>)}</ul>}
          </div>
          {full && c.access.length > 0 && <div className="muted text-xs">Can see this case: {c.access.map((a) => `${a.name} (${a.role})`).join(', ')}</div>}
          {full && c.status === 'open' && (
            <div className="space-y-2 border-t border-[var(--border)] pt-3">
              <Textarea aria-label="New note" placeholder="Add a note" value={note.body} onChange={(e) => setNote({ ...note, body: e.target.value })} />
              <div className="flex flex-wrap items-center justify-between gap-2">
                {c.employee_id && !c.restricted ? <label className="flex items-center gap-1 text-xs"><input type="checkbox" checked={note.visible} onChange={(e) => setNote({ ...note, visible: e.target.checked })} />Share with the employee</label> : <span />}
                <Button variant="secondary" disabled={!note.body.trim()} busy={addNote.isPending} onClick={() => addNote.mutate()}>Add note</Button>
              </div>
              <div className="flex gap-2"><Input aria-label="Outcome" placeholder="Outcome (to close the case)" value={outcome} onChange={(e) => setOutcome(e.target.value)} /><Button disabled={outcome.length < 3} busy={closeCase.isPending} onClick={() => closeCase.mutate()}>Close case</Button></div>
            </div>
          )}
          {c.employee_id === me.employee_id && c.kind !== 'complaint' && !c.acknowledged_at && <div className="flex justify-end"><Button busy={ack.isPending} onClick={() => ack.mutate()}>I have read this</Button></div>}
          {c.acknowledged_at && <p className="muted text-xs">Acknowledged {formatDateTime(c.acknowledged_at, settings.timezone, settings.date_format)}</p>}
        </div>
      )}
    </Dialog>
  );
}

function NewCase({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [emp, setEmp] = useState<{ id: string; name: string } | null>(null);
  const [v, setV] = useState({ kind: 'warning' as Kind, subject: '', details: '', severity: 'first', expires_on: '', review_date: '' });
  const [objectives, setObjectives] = useState<string[]>(['']);
  const save = useMutation({
    mutationFn: () => unwrap(hr.POST('/api/v1/relations-cases', { body: {
      kind: v.kind, employee_id: emp?.id ?? null, subject: v.subject, details: v.details || null, severity: v.kind === 'warning' ? (v.severity as 'first') : null,
      expires_on: v.expires_on || null, review_date: v.review_date || null, objectives: v.kind === 'improvement_plan' ? objectives.filter((o) => o.trim().length >= 3).map((objective) => ({ objective, status: 'open' as const })) : [], investigator_user_ids: [], document_ids: [],
    } })),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['relations'] }); onClose(); },
  });
  const fe = save.error instanceof ApiError ? save.error.fieldErrors : {};
  return (
    <Dialog open wide title="New case" onClose={onClose}>
      <ProblemBanner error={save.error} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Kind" htmlFor="rc-k"><Select id="rc-k" value={v.kind} onChange={(e) => setV({ ...v, kind: e.target.value as Kind })}>{Object.entries(CASE_KINDS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select></Field>
        <Field label={v.kind === 'complaint' ? 'About (optional)' : 'Employee'} htmlFor="rc-e" error={fe.employee_id}><EmployeePicker id="rc-e" value={emp} onChange={setEmp} /></Field>
        {v.kind === 'warning' && <Field label="Level" htmlFor="rc-s"><Select id="rc-s" value={v.severity} onChange={(e) => setV({ ...v, severity: e.target.value })}><option value="verbal">Verbal (recorded)</option><option value="first">First written</option><option value="final">Final written</option></Select></Field>}
        {(v.kind === 'warning' || v.kind === 'disciplinary') && <Field label="On file until" htmlFor="rc-x"><Input id="rc-x" type="date" value={v.expires_on} onChange={(e) => setV({ ...v, expires_on: e.target.value })} /></Field>}
        {v.kind === 'improvement_plan' && <Field label="Review date" htmlFor="rc-r"><Input id="rc-r" type="date" value={v.review_date} onChange={(e) => setV({ ...v, review_date: e.target.value })} /></Field>}
      </div>
      <Field label="Subject" htmlFor="rc-sub" error={fe.subject}><Input id="rc-sub" value={v.subject} onChange={(e) => setV({ ...v, subject: e.target.value })} /></Field>
      <Field label="Details" htmlFor="rc-d"><Textarea id="rc-d" value={v.details} onChange={(e) => setV({ ...v, details: e.target.value })} /></Field>
      {v.kind === 'improvement_plan' && (
        <div className="mt-2 space-y-2"><div className="text-sm font-medium">Objectives</div>
          {objectives.map((o, i) => <Input key={i} aria-label={`Objective ${i + 1}`} value={o} onChange={(e) => setObjectives(objectives.map((x, j) => (j === i ? e.target.value : x)))} />)}
          <Button variant="secondary" onClick={() => setObjectives([...objectives, ''])}>Add objective</Button>
        </div>
      )}
      {v.kind === 'complaint' && <p className="muted mt-2 text-xs">Complaints are restricted: only you and the people you add can see it.</p>}
      <div className="mt-4 flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button busy={save.isPending} onClick={() => save.mutate()}>Save</Button></div>
    </Dialog>
  );
}

function Complaint({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [emp, setEmp] = useState<{ id: string; name: string } | null>(null);
  const [v, setV] = useState({ subject: '', details: '' });
  const save = useMutation({ mutationFn: () => unwrap(hr.POST('/api/v1/me/complaints', { body: { subject: v.subject, details: v.details, about_employee_id: emp?.id ?? null, document_ids: [] } })), onSuccess: () => { void qc.invalidateQueries({ queryKey: ['relations'] }); onClose(); } });
  const fe = save.error instanceof ApiError ? save.error.fieldErrors : {};
  return (
    <Dialog open title="Raise a complaint" onClose={onClose}>
      <ProblemBanner error={save.error} />
      <p className="muted mb-3 text-sm">Only the HR managers see this, and the people they ask to look into it. The person it is about is not told who raised it.</p>
      <Field label="Subject" htmlFor="cp-s" error={fe.subject}><Input id="cp-s" value={v.subject} onChange={(e) => setV({ ...v, subject: e.target.value })} /></Field>
      <Field label="What happened" htmlFor="cp-d" error={fe.details}><Textarea id="cp-d" className="min-h-32" value={v.details} onChange={(e) => setV({ ...v, details: e.target.value })} /></Field>
      <Field label="About someone? (optional)" htmlFor="cp-e"><EmployeePicker id="cp-e" value={emp} onChange={setEmp} /></Field>
      <div className="mt-4 flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button busy={save.isPending} onClick={() => save.mutate()}>Send</Button></div>
    </Dialog>
  );
}
