'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { formatDateTime } from '@sil/hr-shared';
import { Button, Dialog, Field, Input, ProblemBanner, Select, Textarea } from '@/components/ui';
import { hr, unwrap } from '@/lib/api';
import { useSession } from '@/lib/session';

const local = (iso?: string) => (iso ? new Date(new Date(iso).getTime() + 3 * 3_600_000).toISOString().slice(0, 16) : '');
const toIso = (v: string) => new Date(`${v}:00+03:00`).toISOString();

export function UserPicker({ value, onChange }: { value: { id: string; name: string }[]; onChange: (v: { id: string; name: string }[]) => void }) {
  const [q, setQ] = useState('');
  const found = useQuery({ queryKey: ['invitees', q], enabled: q.trim().length >= 2, queryFn: () => unwrap(hr.GET('/api/v1/meetings/invitees', { params: { query: { search: q } } })) });
  return (
    <div>
      <div className="relative">
        <Input aria-label="Invite people" placeholder="Name or staff number" value={q} onChange={(e) => setQ(e.target.value)} autoComplete="off" />
        {q.trim().length >= 2 && found.data && (
          <ul className="surface absolute z-20 mt-1 max-h-60 w-full overflow-y-auto rounded-lg text-sm shadow-lg">
            {!found.data.length && <li className="muted px-3 py-2">No one matches.</li>}
            {found.data.map((u) => <li key={u.id}><button type="button" className="w-full px-3 py-1.5 text-left hover:bg-[var(--hover)]" onClick={() => { if (!value.some((v) => v.id === u.id)) onChange([...value, { id: u.id, name: u.display_name }]); setQ(''); }}>{u.display_name} <span className="muted">{u.department_name}</span></button></li>)}
          </ul>
        )}
      </div>
      {value.length > 0 && <div className="mt-2 flex flex-wrap gap-2">{value.map((p) => <span key={p.id} className="rounded-full bg-[var(--surface-2)] px-3 py-1 text-sm">{p.name} <button type="button" aria-label={`Remove ${p.name}`} className="muted ml-1" onClick={() => onChange(value.filter((x) => x.id !== p.id))}>×</button></span>)}</div>}
    </div>
  );
}

export function MeetingDialog({ onClose, meeting }: { onClose: () => void; meeting?: { id: string; version: number; title: string; room_id: string | null; location: string | null; online_link: string | null; starts_at: string; ends_at: string; agenda: string | null; attendee_list: { user_id: string; name: string }[] } }) {
  const qc = useQueryClient();
  const router = useRouter();
  const rooms = useQuery({ queryKey: ['rooms'], queryFn: () => unwrap(hr.GET('/api/v1/meeting-rooms')) });
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  const [f, setF] = useState({ title: meeting?.title ?? '', room_id: meeting?.room_id ?? '', location: meeting?.location ?? '', online_link: meeting?.online_link ?? '', starts: local(meeting?.starts_at) || `${tomorrow}T10:00`, ends: local(meeting?.ends_at) || `${tomorrow}T11:00`, agenda: meeting?.agenda ?? '' });
  const [people, setPeople] = useState(meeting?.attendee_list.map((a) => ({ id: a.user_id, name: a.name })) ?? []);
  const day = f.starts.slice(0, 10);
  const avail = useQuery({ queryKey: ['availability', day], enabled: !!day, queryFn: () => unwrap(hr.GET('/api/v1/meeting-rooms/availability', { params: { query: { date: day } } })) });
  const busy = avail.data?.find((r) => r.room_id === f.room_id)?.busy.filter((b) => b.starts_at !== meeting?.starts_at) ?? [];
  const save = useMutation({
    mutationFn: () => {
      const body = { title: f.title, room_id: f.room_id || null, location: f.location || null, online_link: f.online_link || null, starts_at: toIso(f.starts), ends_at: toIso(f.ends), agenda: f.agenda || null, attendee_user_ids: people.map((p) => p.id) };
      return meeting ? unwrap(hr.PUT('/api/v1/meetings/{id}', { params: { path: { id: meeting.id }, header: { 'If-Match': `"${meeting.version}"` } as never }, body })) : unwrap(hr.POST('/api/v1/meetings', { body }));
    },
    onSuccess: (m) => { void qc.invalidateQueries({ queryKey: ['my-meetings'] }); void qc.invalidateQueries({ queryKey: ['meeting'] }); onClose(); if (!meeting) router.push(`/meetings/${m.id}`); },
  });
  const { settings } = useSession();
  return (
    <Dialog open wide title={meeting ? 'Edit meeting' : 'New meeting'} onClose={onClose}>
      <ProblemBanner error={save.error} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Title" htmlFor="mt-t"><Input id="mt-t" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
        <Field label="Room" htmlFor="mt-r"><Select id="mt-r" value={f.room_id} onChange={(e) => setF({ ...f, room_id: e.target.value })}><option value="">No room</option>{rooms.data?.filter((r) => r.status === 'active').map((r) => <option key={r.id} value={r.id}>{r.name}{r.capacity ? ` (${r.capacity})` : ''}</option>)}</Select></Field>
        <Field label="Starts" htmlFor="mt-s"><Input id="mt-s" type="datetime-local" value={f.starts} onChange={(e) => setF({ ...f, starts: e.target.value })} /></Field>
        <Field label="Ends" htmlFor="mt-e"><Input id="mt-e" type="datetime-local" value={f.ends} onChange={(e) => setF({ ...f, ends: e.target.value })} /></Field>
        {!f.room_id && <Field label="Location" htmlFor="mt-l"><Input id="mt-l" value={f.location} onChange={(e) => setF({ ...f, location: e.target.value })} /></Field>}
        <Field label="Online link (optional)" htmlFor="mt-o"><Input id="mt-o" value={f.online_link} onChange={(e) => setF({ ...f, online_link: e.target.value })} /></Field>
      </div>
      {f.room_id && busy.length > 0 && <p className="mb-2 text-sm text-amber-700">Already booked that day: {busy.map((b) => `${formatDateTime(b.starts_at, settings.timezone, settings.date_format).slice(-5)}–${formatDateTime(b.ends_at, settings.timezone, settings.date_format).slice(-5)} (${b.title})`).join(', ')}</p>}
      <Field label="Invite" htmlFor="none"><UserPicker value={people} onChange={setPeople} /></Field>
      <Field label="Agenda" htmlFor="mt-a"><Textarea id="mt-a" rows={5} value={f.agenda} onChange={(e) => setF({ ...f, agenda: e.target.value })} /></Field>
      <div className="mt-4 flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button busy={save.isPending} onClick={() => save.mutate()}>{meeting ? 'Save' : 'Send invitations'}</Button></div>
    </Dialog>
  );
}
