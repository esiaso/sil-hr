'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { formatDate, formatDateTime } from '@sil/hr-shared';
import { Badge, Button, Card, Empty, Loading, PageHeader, ProblemBanner } from '@/components/ui';
import { hr, unwrap } from '@/lib/api';
import { useSession } from '@/lib/session';
import { MeetingDialog } from '@/components/meetings';

export default function MeetingsPage() {
  const { settings } = useSession();
  const qc = useQueryClient();
  const [past, setPast] = useState(false);
  const [creating, setCreating] = useState(false);
  const today = new Date().toISOString().slice(0, 10);
  const q = useQuery({ queryKey: ['my-meetings', past], queryFn: () => unwrap(hr.GET('/api/v1/me/meetings', { params: { query: past ? { to: today } : { from: today } } })) });
  const actions = useQuery({ queryKey: ['my-actions'], queryFn: () => unwrap(hr.GET('/api/v1/me/actions')) });
  const done = useMutation({ mutationFn: (v: { id: string; status: 'open' | 'done' }) => unwrap(hr.PUT('/api/v1/meeting-actions/{id}', { params: { path: { id: v.id } }, body: { status: v.status } })), onSuccess: () => void qc.invalidateQueries({ queryKey: ['my-actions'] }) });
  const rows = past ? [...(q.data ?? [])].reverse() : q.data;
  return (
    <div className="space-y-4">
      <PageHeader title="Meetings" description="Meetings you organise or are invited to, with agendas, minutes and actions." actions={<Button onClick={() => setCreating(true)}>New meeting</Button>} />
      <ProblemBanner error={q.error ?? actions.error ?? done.error} />
      <Card>
        <div className="mb-2 flex items-center justify-between"><h2 className="font-semibold">{past ? 'Past meetings' : 'Coming up'}</h2><button type="button" className="link text-sm" onClick={() => setPast(!past)}>{past ? 'Show upcoming' : 'Show past'}</button></div>
        {!rows ? <Loading /> : !rows.length ? <Empty>No meetings.</Empty> : (
          <table className="data">
            <thead><tr><th>When</th><th>Meeting</th><th>Where</th><th>Organiser</th><th>Invited</th><th>Status</th></tr></thead>
            <tbody>{rows.map((mt) => (
              <tr key={mt.id}>
                <td className="whitespace-nowrap">{formatDateTime(mt.starts_at, settings.timezone, settings.date_format)}</td>
                <td><Link className="link" href={`/meetings/${mt.id}`}>{mt.title}</Link>{mt.open_actions > 0 && <span className="muted ml-1 text-xs">{mt.open_actions} open action(s)</span>}</td>
                <td>{mt.room_name ?? mt.location ?? (mt.online_link ? 'Online' : '–')}</td><td>{mt.organiser_name}</td><td>{mt.attendees}</td>
                <td><Badge value={mt.status === 'scheduled' && mt.my_response ? mt.my_response : mt.status} /></td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </Card>
      <Card>
        <h2 className="mb-2 font-semibold">My actions</h2>
        {!actions.data ? <Loading /> : !actions.data.length ? <Empty>No actions assigned to you.</Empty> : (
          <table className="data">
            <thead><tr><th>Action</th><th>From</th><th>Due</th><th /></tr></thead>
            <tbody>{actions.data.map((a) => (
              <tr key={a.id} className={a.status === 'done' ? 'opacity-60' : ''}>
                <td className={a.status === 'done' ? 'line-through' : ''}>{a.description}</td><td><Link className="link" href={`/meetings/${a.meeting_id}`}>{a.meeting_title}</Link></td>
                <td>{formatDate(a.due_date, settings.date_format) || '–'}</td>
                <td className="text-right"><Button variant={a.status === 'done' ? 'ghost' : 'secondary'} onClick={() => done.mutate({ id: a.id, status: a.status === 'done' ? 'open' : 'done' })}>{a.status === 'done' ? 'Reopen' : 'Done'}</Button></td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </Card>
      {creating && <MeetingDialog onClose={() => setCreating(false)} />}
    </div>
  );
}
