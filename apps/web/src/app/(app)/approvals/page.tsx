'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { formatDate, formatDateTime } from '@sil/hr-shared';
import { Badge, Button, Card, Dialog, Empty, Field, Input, Loading, PageHeader, ProblemBanner, Select, Textarea } from '@/components/ui';
import { hr, unwrap } from '@/lib/api';
import { useSession } from '@/lib/session';

const TYPE_LABEL: Record<string, string> = { leave_request: 'Leave', contact_change: 'Contact change' };

function Decision({ taskId, onClose }: { taskId: string; onClose: () => void }) {
  const { settings } = useSession();
  const qc = useQueryClient();
  const [comment, setComment] = useState('');
  const inbox = useQuery({ queryKey: ['inbox'], queryFn: () => unwrap(hr.GET('/api/v1/workflow/inbox')) });
  const task = inbox.data?.find((t) => t.id === taskId);
  const instance = useQuery({ queryKey: ['instance', task?.instance_id], enabled: !!task, queryFn: () => unwrap(hr.GET('/api/v1/workflow/instances/{id}', { params: { path: { id: task!.instance_id } } })) });
  const leave = useQuery({ queryKey: ['leave-request', task?.subject_id], enabled: task?.request_type === 'leave_request', queryFn: () => unwrap(hr.GET('/api/v1/leave/requests/{id}', { params: { path: { id: task!.subject_id } } })) });
  const decide = useMutation({
    mutationFn: (decision: 'approve' | 'reject' | 'return') => unwrap(hr.POST('/api/v1/workflow/tasks/{id}/decision', { params: { path: { id: taskId } }, body: { decision, comment: comment || null } })),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['inbox'] }); onClose(); },
  });
  if (!task) return null;
  return (
    <Dialog open wide title={task.summary} onClose={onClose}>
      <ProblemBanner error={decide.error} />
      {leave.data && (
        <Card className="mb-3 text-sm">
          <div><b>{leave.data.employee_name}</b> · {leave.data.leave_type_name} · {leave.data.days} day(s)</div>
          <div>{formatDate(leave.data.start_date, settings.date_format)}{leave.data.start_half_day ? ' (from midday)' : ''} to {formatDate(leave.data.end_date, settings.date_format)}{leave.data.end_half_day ? ' (until midday)' : ''}</div>
          {leave.data.reason && <div className="muted mt-1">“{leave.data.reason}”</div>}
        </Card>
      )}
      {instance.data && (
        <ol className="mb-3 space-y-1 text-sm">
          {instance.data.tasks.map((t) => (
            <li key={t.id} className="flex flex-wrap items-center gap-2"><span className="muted w-6">{t.step_no}.</span>{t.step_name}<Badge value={t.status} />{t.assignee_name && <span className="muted">{t.assignee_name}</span>}{t.comment && <span className="muted">“{t.comment}”</span>}{t.acted_at && <span className="muted text-xs">{formatDateTime(t.acted_at, settings.timezone, settings.date_format)}</span>}</li>
          ))}
        </ol>
      )}
      {task.on_behalf_of_user_id && <p className="mb-2 text-xs text-amber-700">You are deciding on behalf of someone who delegated this to you.</p>}
      <Field label="Comment" htmlFor="dec-comment" hint="Required to reject or return"><Textarea id="dec-comment" value={comment} onChange={(e) => setComment(e.target.value)} /></Field>
      <div className="mt-3 flex flex-wrap justify-end gap-2">
        <Button variant="secondary" disabled={!comment} onClick={() => decide.mutate('return')}>Return for correction</Button>
        <Button variant="danger" disabled={!comment} onClick={() => decide.mutate('reject')}>Reject</Button>
        <Button busy={decide.isPending} onClick={() => decide.mutate('approve')}>Approve</Button>
      </div>
    </Dialog>
  );
}

function Delegations() {
  const { settings } = useSession();
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['delegations'], queryFn: () => unwrap(hr.GET('/api/v1/workflow/delegations')) });
  const [search, setSearch] = useState('');
  const people = useQuery({ queryKey: ['delegate-search', search], enabled: search.length > 1, queryFn: () => unwrap(hr.GET('/api/v1/directory/staff', { params: { query: { search, limit: 8 } } })), retry: false });
  const [form, setForm] = useState({ to_employee_id: '', starts_on: '', ends_on: '' });
  const add = useMutation({ mutationFn: () => unwrap(hr.POST('/api/v1/workflow/delegations', { body: { ...form, request_types: [] } })), onSuccess: () => { setForm({ to_employee_id: '', starts_on: '', ends_on: '' }); void qc.invalidateQueries({ queryKey: ['delegations'] }); } });
  const remove = useMutation({ mutationFn: (id: string) => unwrap(hr.DELETE('/api/v1/workflow/delegations/{id}', { params: { path: { id } } })), onSuccess: () => qc.invalidateQueries({ queryKey: ['delegations'] }) });
  return (
    <Card>
      <h2 className="mb-1 font-semibold">Delegations</h2>
      <p className="muted mb-3 text-sm">While you are away, someone else can approve in your place. If you are on approved leave without a delegate, your approvals go to your own manager.</p>
      <ProblemBanner error={add.error ?? remove.error} />
      {list.data && list.data.length > 0 && (
        <ul className="mb-3 text-sm">{list.data.map((d) => <li key={d.id} className="flex items-center justify-between border-b border-[var(--border)] py-1"><span>{d.from_name} → {d.to_name}, {formatDate(d.starts_on, settings.date_format)} to {formatDate(d.ends_on, settings.date_format)}</span><Button variant="ghost" onClick={() => remove.mutate(d.id)}>Remove</Button></li>)}</ul>
      )}
      <div className="grid gap-2 sm:grid-cols-4 sm:items-end">
        <Field label="Delegate to" htmlFor="dl-search">
          <Input id="dl-search" placeholder="Search by name" value={search} onChange={(e) => setSearch(e.target.value)} />
          {people.data && <Select aria-label="Choose person" value={form.to_employee_id} onChange={(e) => setForm({ ...form, to_employee_id: e.target.value })}><option value="">Choose…</option>{people.data.data.map((u) => 'staff_number' in u && <option key={u.id} value={u.id}>{u.display_name} ({u.position_title})</option>)}</Select>}
        </Field>
        <Field label="From" htmlFor="dl-from"><Input id="dl-from" type="date" value={form.starts_on} onChange={(e) => setForm({ ...form, starts_on: e.target.value })} /></Field>
        <Field label="To" htmlFor="dl-to"><Input id="dl-to" type="date" value={form.ends_on} onChange={(e) => setForm({ ...form, ends_on: e.target.value })} /></Field>
        <Button disabled={!form.to_employee_id || !form.starts_on || !form.ends_on} onClick={() => add.mutate()}>Delegate</Button>
      </div>
    </Card>
  );
}

function Inbox() {
  const { settings } = useSession();
  const pre = useSearchParams().get('task');
  const [open, setOpen] = useState<string | null>(pre);
  const inbox = useQuery({ queryKey: ['inbox'], queryFn: () => unwrap(hr.GET('/api/v1/workflow/inbox')), refetchInterval: 60_000 });
  return (
    <div className="space-y-4">
      <PageHeader title="Approvals" description="Requests waiting for you, including those sent to a team you belong to (anyone in it can act)." />
      <ProblemBanner error={inbox.error} />
      {!inbox.data ? <Loading /> : !inbox.data.length ? <Empty>Nothing is waiting for you.</Empty> : (
        <ul className="space-y-2">
          {inbox.data.map((t) => (
            <li key={t.id}>
              <button className="surface flex w-full flex-wrap items-center justify-between gap-2 rounded-lg p-4 text-left hover:shadow-sm" onClick={() => setOpen(t.id)}>
                <div>
                  <div className="font-medium">{t.summary}</div>
                  <div className="muted text-xs">{TYPE_LABEL[t.request_type] ?? t.request_type} · step {t.step_no}: {t.step_name} · sent {formatDateTime(t.submitted_at, settings.timezone, settings.date_format)}{t.due_at ? ` · escalates ${formatDateTime(t.due_at, settings.timezone, settings.date_format)}` : ''}</div>
                </div>
                {!t.assignee_user_id && <Badge value="team" />}
              </button>
            </li>
          ))}
        </ul>
      )}
      <Delegations />
      {open && <Decision taskId={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

export default function ApprovalsPage() {
  return (
    <Suspense fallback={<Loading />}>
      <Inbox />
    </Suspense>
  );
}
