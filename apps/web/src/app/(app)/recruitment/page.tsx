'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { EMPLOYMENT_TYPES, formatDate, formatMoney, REQUISITION_REASONS } from '@sil/hr-shared';
import { EmployeePicker } from '@/components/employee-picker';
import { Badge, Button, Card, Dialog, Empty, Field, Input, Loading, PageHeader, ProblemBanner, Select, Textarea } from '@/components/ui';
import { ApiError, hr, unwrap } from '@/lib/api';
import { useLookups } from '@/lib/lookups';
import { useSession } from '@/lib/session';

export default function RequisitionsPage() {
  const { can, settings } = useSession();
  const qc = useQueryClient();
  const [status, setStatus] = useState('');
  const [creating, setCreating] = useState(false);
  const q = useQuery({ queryKey: ['requisitions', status], queryFn: () => unwrap(hr.GET('/api/v1/requisitions', { params: { query: { status: status || undefined } } })) });
  const cancel = useMutation({ mutationFn: (id: string) => unwrap(hr.POST('/api/v1/requisitions/{id}/cancel', { params: { path: { id } } })), onSuccess: () => qc.invalidateQueries({ queryKey: ['requisitions'] }) });
  return (
    <div className="space-y-4">
      <PageHeader title="Requisitions" description="Requests to fill a post. Each goes through approval (department head, HR manager, finance); an approved requisition can be advertised." actions={can('requisition:request') && <Button onClick={() => setCreating(true)}>Ask to fill a post</Button>} />
      <Select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)} className="max-w-48"><option value="">All</option>{['pending', 'approved', 'filled', 'rejected', 'cancelled'].map((s) => <option key={s} value={s}>{s}</option>)}</Select>
      <ProblemBanner error={q.error ?? cancel.error} />
      <Card>
        {!q.data ? <Loading /> : !q.data.length ? <Empty>No requisitions.</Empty> : (
          <table className="data">
            <thead><tr><th>Number</th><th>Post</th><th>Department</th><th>How many</th><th>Why</th><th>Salary range</th><th>Needed by</th><th>Status</th><th /></tr></thead>
            <tbody>{q.data.map((r) => (
              <tr key={r.id}>
                <td className="font-mono text-xs">{r.number}</td><td>{r.position_title}<div className="muted text-xs">{r.employment_type}</div></td><td>{r.department_name}</td><td>{r.hired} of {r.headcount}</td>
                <td>{REQUISITION_REASONS[r.reason]}{r.replaces_employee_name ? `: ${r.replaces_employee_name}` : ''}</td>
                <td className="tabular-nums text-xs">{r.salary_min || r.salary_max ? `${formatMoney(r.salary_min, '')} – ${formatMoney(r.salary_max, '')}` : ''}</td>
                <td>{r.needed_by ? formatDate(r.needed_by, settings.date_format) : ''}</td><td><Badge value={r.status} />{r.decision_comment && <div className="muted text-xs">{r.decision_comment}</div>}</td>
                <td className="text-right">{can('recruitment:manage') && ['pending', 'approved'].includes(r.status) && <Button variant="ghost" onClick={() => confirm('Cancel this requisition and close its adverts?') && cancel.mutate(r.id)}>Cancel</Button>}</td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </Card>
      {creating && <NewRequisition onClose={() => setCreating(false)} />}
    </div>
  );
}

function NewRequisition({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const l = useLookups();
  const [replaces, setReplaces] = useState<{ id: string; name: string } | null>(null);
  const [v, setV] = useState({ position_id: '', headcount: '1', employment_type: 'permanent', reason: 'new', salary_min: '', salary_max: '', needed_by: '', justification: '' });
  const save = useMutation({
    mutationFn: () => unwrap(hr.POST('/api/v1/requisitions', { body: { position_id: v.position_id, headcount: Number(v.headcount), employment_type: v.employment_type as 'permanent', reason: v.reason as 'new', replaces_employee_id: replaces?.id ?? null, salary_min: v.salary_min ? Number(v.salary_min).toFixed(2) : null, salary_max: v.salary_max ? Number(v.salary_max).toFixed(2) : null, needed_by: v.needed_by || null, justification: v.justification } })),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['requisitions'] }); onClose(); },
  });
  const fe = save.error instanceof ApiError ? save.error.fieldErrors : {};
  return (
    <Dialog open wide title="Ask to fill a post" onClose={onClose}>
      <ProblemBanner error={save.error} />
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="sm:col-span-2"><Field label="Position" htmlFor="rq-p" error={fe.position_id}><Select id="rq-p" value={v.position_id} onChange={(e) => setV({ ...v, position_id: e.target.value })}><option value="">Choose</option>{l.positionOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</Select></Field></div>
        <Field label="How many" htmlFor="rq-h"><Input id="rq-h" type="number" min={1} value={v.headcount} onChange={(e) => setV({ ...v, headcount: e.target.value })} /></Field>
        <Field label="Employment type" htmlFor="rq-t"><Select id="rq-t" value={v.employment_type} onChange={(e) => setV({ ...v, employment_type: e.target.value })}>{EMPLOYMENT_TYPES.map((t) => <option key={t}>{t}</option>)}</Select></Field>
        <Field label="Why" htmlFor="rq-r"><Select id="rq-r" value={v.reason} onChange={(e) => setV({ ...v, reason: e.target.value })}>{Object.entries(REQUISITION_REASONS).map(([k, x]) => <option key={k} value={k}>{x}</option>)}</Select></Field>
        <Field label="Needed by" htmlFor="rq-n"><Input id="rq-n" type="date" value={v.needed_by} onChange={(e) => setV({ ...v, needed_by: e.target.value })} /></Field>
        {v.reason === 'replacement' && <div className="sm:col-span-3"><Field label="Replacing" htmlFor="rq-rep" error={fe.replaces_employee_id}><EmployeePicker id="rq-rep" value={replaces} onChange={setReplaces} /></Field></div>}
        <Field label="Salary from (KES a month)" htmlFor="rq-s1"><Input id="rq-s1" type="number" value={v.salary_min} onChange={(e) => setV({ ...v, salary_min: e.target.value })} /></Field>
        <Field label="Salary to" htmlFor="rq-s2"><Input id="rq-s2" type="number" value={v.salary_max} onChange={(e) => setV({ ...v, salary_max: e.target.value })} /></Field>
      </div>
      <Field label="Why the post is needed" htmlFor="rq-j" error={fe.justification}><Textarea id="rq-j" value={v.justification} onChange={(e) => setV({ ...v, justification: e.target.value })} /></Field>
      <div className="mt-4 flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button busy={save.isPending} onClick={() => save.mutate()}>Send for approval</Button></div>
    </Dialog>
  );
}
