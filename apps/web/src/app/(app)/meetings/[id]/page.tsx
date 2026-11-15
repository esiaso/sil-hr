'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { formatDate, formatDateTime } from '@sil/hr-shared';
import { Badge, Button, Card, Empty, Field, Input, Loading, PageHeader, ProblemBanner, Select, Textarea , buttonClass } from '@/components/ui';
import { MeetingDialog } from '@/components/meetings';
import { hr, unwrap } from '@/lib/api';
import { useSession } from '@/lib/session';

type Meeting = Awaited<ReturnType<typeof load>>;
const load = (id: string) => unwrap(hr.GET('/api/v1/meetings/{id}', { params: { path: { id } } }));

export default function MeetingPage() {
  const { id } = useParams<{ id: string }>();
  const { settings, me } = useSession();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['meeting', id], queryFn: () => load(id) });
  const set = (d: Meeting) => { qc.setQueryData(['meeting', id], d); void qc.invalidateQueries({ queryKey: ['my-meetings'] }); };
  const respond = useMutation({ mutationFn: (response: 'accepted' | 'tentative' | 'declined') => unwrap(hr.POST('/api/v1/meetings/{id}/response', { params: { path: { id } }, body: { response } })), onSuccess: set });
  const cancel = useMutation({ mutationFn: () => unwrap(hr.POST('/api/v1/meetings/{id}/cancel', { params: { path: { id } } })), onSuccess: set });
  const [editing, setEditing] = useState(false);
  const m = q.data;
  const when = (iso: string) => formatDateTime(iso, settings.timezone, settings.date_format);
  const started = m && new Date(m.starts_at) <= new Date();
  return (
    <div className="space-y-4">
      <PageHeader
        title={m?.title ?? 'Meeting'}
        description={m ? `${when(m.starts_at)} to ${when(m.ends_at).slice(-5)} · ${m.room_name ?? m.location ?? 'no room'} · organised by ${m.organiser_name}` : undefined}
        actions={m && (
          <div className="flex flex-wrap gap-2">
            <a className={buttonClass('secondary')} href={`/api/v1/meetings/${m.id}/ics`}>Add to my calendar</a>
            {m.can_edit && m.status === 'scheduled' && <><Button variant="secondary" onClick={() => setEditing(true)}>Edit</Button><Button variant="ghost" busy={cancel.isPending} onClick={() => window.confirm('Cancel the meeting? Everyone invited is told.') && cancel.mutate()}>Cancel meeting</Button></>}
          </div>
        )}
      />
      <ProblemBanner error={q.error ?? respond.error ?? cancel.error} />
      {!m ? <Loading /> : (
        <>
          <Card>
            <div className="flex flex-wrap items-center gap-3 text-sm">
              <Badge value={m.status} />
              {m.online_link && <a className="link" href={m.online_link} target="_blank" rel="noreferrer">Join online</a>}
              {!m.can_edit && m.status === 'scheduled' && (
                <div className="ml-auto flex items-center gap-2"><span className="muted">Your answer:</span>
                  {(['accepted', 'tentative', 'declined'] as const).map((r) => <Button key={r} variant={m.my_response === r ? 'primary' : 'secondary'} busy={respond.isPending && respond.variables === r} onClick={() => respond.mutate(r)}>{r === 'accepted' ? 'Accept' : r === 'tentative' ? 'Maybe' : 'Decline'}</Button>)}
                </div>
              )}
            </div>
            {m.agenda && <><h2 className="mt-4 mb-1 font-semibold">Agenda</h2><p className="whitespace-pre-wrap text-sm">{m.agenda}</p></>}
          </Card>
          <Card>
            <h2 className="mb-2 font-semibold">Attendees</h2>
            {!m.attendee_list.length ? <Empty>No one invited.</Empty> : (
              <ul className="grid gap-1 text-sm sm:grid-cols-2">{m.attendee_list.map((a) => <li key={a.user_id} className="flex items-center justify-between rounded-lg px-2 py-1 hover:bg-[var(--hover)]"><span>{a.name}{a.user_id === me.id ? ' (you)' : ''}</span><span className="flex gap-1">{a.attended !== null && <Badge value={a.attended ? 'attended' : 'absent'} />}<Badge value={a.response} /></span></li>)}</ul>
            )}
          </Card>
          {(m.can_edit && started && m.status !== 'cancelled') || m.minutes ? <Minutes m={m} onDone={set} /> : null}
          <Actions m={m} onDone={set} />
        </>
      )}
      {editing && m && <MeetingDialog meeting={m} onClose={() => setEditing(false)} />}
    </div>
  );
}

function Minutes({ m, onDone }: { m: Meeting; onDone: (d: Meeting) => void }) {
  const { settings } = useSession();
  const [text, setText] = useState(m.minutes ?? '');
  const [attended, setAttended] = useState<string[]>([]);
  useEffect(() => setAttended(m.attendee_list.filter((a) => a.attended ?? a.response === 'accepted').map((a) => a.user_id)), [m.version]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = useMutation({ mutationFn: () => unwrap(hr.PUT('/api/v1/meetings/{id}/minutes', { params: { path: { id: m.id } }, body: { minutes: text, attended_user_ids: attended } })), onSuccess: onDone });
  return (
    <Card>
      <h2 className="mb-2 font-semibold">Minutes {m.minutes_at && <span className="muted text-xs font-normal">· recorded {formatDateTime(m.minutes_at, settings.timezone, settings.date_format)}</span>}</h2>
      <ProblemBanner error={save.error} />
      {m.can_edit ? (
        <>
          <Textarea aria-label="Minutes" rows={8} value={text} onChange={(e) => setText(e.target.value)} />
          {m.attendee_list.length > 0 && <div className="mt-3 text-sm"><div className="muted mb-1">Who attended</div><div className="flex flex-wrap gap-3">{m.attendee_list.map((a) => <label key={a.user_id} className="flex items-center gap-1"><input type="checkbox" checked={attended.includes(a.user_id)} onChange={(e) => setAttended(e.target.checked ? [...attended, a.user_id] : attended.filter((x) => x !== a.user_id))} />{a.name}</label>)}</div></div>}
          <div className="mt-3 flex justify-end"><Button busy={save.isPending} onClick={() => save.mutate()}>Save minutes</Button></div>
        </>
      ) : <p className="whitespace-pre-wrap text-sm">{m.minutes}</p>}
    </Card>
  );
}

function Actions({ m, onDone }: { m: Meeting; onDone: (d: Meeting) => void }) {
  const { settings, me } = useSession();
  const qc = useQueryClient();
  const [f, setF] = useState({ description: '', owner: '', due: '' });
  const add = useMutation({ mutationFn: () => unwrap(hr.POST('/api/v1/meetings/{id}/actions', { params: { path: { id: m.id } }, body: { description: f.description, owner_user_id: f.owner || null, due_date: f.due || null } })), onSuccess: (d) => { setF({ description: '', owner: '', due: '' }); onDone(d); } });
  const toggle = useMutation({ mutationFn: (v: { id: string; status: 'open' | 'done' }) => unwrap(hr.PUT('/api/v1/meeting-actions/{id}', { params: { path: { id: v.id } }, body: { status: v.status } })), onSuccess: () => { void qc.invalidateQueries({ queryKey: ['meeting', m.id] }); void qc.invalidateQueries({ queryKey: ['my-actions'] }); } });
  const people = [{ user_id: m.organiser_user_id, name: m.organiser_name }, ...m.attendee_list];
  if (!m.can_edit && !m.actions.length) return null;
  return (
    <Card>
      <h2 className="mb-2 font-semibold">Actions</h2>
      <ProblemBanner error={add.error ?? toggle.error} />
      {m.actions.length > 0 && (
        <table className="data mb-3">
          <thead><tr><th>Action</th><th>Owner</th><th>Due</th><th>Status</th><th /></tr></thead>
          <tbody>{m.actions.map((a) => (
            <tr key={a.id}><td>{a.description}</td><td>{a.owner_name ?? '–'}</td><td>{formatDate(a.due_date, settings.date_format) || '–'}</td><td><Badge value={a.status} /></td>
              <td className="text-right">{(m.can_edit || a.owner_user_id === me.id) && <button type="button" className="link text-sm" onClick={() => toggle.mutate({ id: a.id, status: a.status === 'done' ? 'open' : 'done' })}>{a.status === 'done' ? 'Reopen' : 'Mark done'}</button>}</td></tr>
          ))}</tbody>
        </table>
      )}
      {m.can_edit && m.status !== 'cancelled' && (
        <div className="grid items-end gap-2 sm:grid-cols-[1fr_12rem_10rem_auto]">
          <Field label="New action" htmlFor="ac-d"><Input id="ac-d" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
          <Field label="Owner" htmlFor="ac-o"><Select id="ac-o" value={f.owner} onChange={(e) => setF({ ...f, owner: e.target.value })}><option value="">Nobody yet</option>{people.map((p) => <option key={p.user_id} value={p.user_id}>{p.name}</option>)}</Select></Field>
          <Field label="Due" htmlFor="ac-due"><Input id="ac-due" type="date" value={f.due} onChange={(e) => setF({ ...f, due: e.target.value })} /></Field>
          <Button busy={add.isPending} onClick={() => add.mutate()}>Add</Button>
        </div>
      )}
    </Card>
  );
}
