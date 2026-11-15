'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Button, Dialog, Field, Input, ProblemBanner, Select } from '@/components/ui';
import { hr, unwrap } from '@/lib/api';

export type Programme = NonNullable<Awaited<ReturnType<typeof listProgrammes>>>[number];
export const listProgrammes = () => unwrap(hr.GET('/api/v1/training/programmes', { params: { query: {} } }));

/** datetime-local value → ISO with the organisation's offset (Nairobi, UTC+3, no daylight saving). */
const toIso = (local: string) => (local ? new Date(`${local}:00+03:00`).toISOString() : '');

export function SessionDialog({ onClose, session }: { onClose: () => void; session?: { id: string; version: number; programme_id: string; starts_at: string; ends_at: string; venue: string | null; trainer: string | null; capacity: number | null; cost_per_person: string | null; open_for_requests: boolean } }) {
  const qc = useQueryClient();
  const progs = useQuery({ queryKey: ['programmes'], queryFn: listProgrammes });
  const local = (iso?: string) => (iso ? new Date(new Date(iso).getTime() + 3 * 3_600_000).toISOString().slice(0, 16) : '');
  const [f, setF] = useState({ programme_id: session?.programme_id ?? '', starts: local(session?.starts_at), ends: local(session?.ends_at), venue: session?.venue ?? '', trainer: session?.trainer ?? '', capacity: session?.capacity ? String(session.capacity) : '', cost: session?.cost_per_person ?? '', open: session?.open_for_requests ?? true });
  const save = useMutation({
    mutationFn: () => {
      const body = { programme_id: f.programme_id, starts_at: toIso(f.starts), ends_at: toIso(f.ends), venue: f.venue || null, trainer: f.trainer || null, capacity: f.capacity ? Number(f.capacity) : null, cost_per_person: f.cost || null, open_for_requests: f.open };
      return session ? unwrap(hr.PUT('/api/v1/training/sessions/{id}', { params: { path: { id: session.id }, header: { 'If-Match': `"${session.version}"` } as never }, body })) : unwrap(hr.POST('/api/v1/training/sessions', { body }));
    },
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['sessions'] }); void qc.invalidateQueries({ queryKey: ['session'] }); onClose(); },
  });
  return (
    <Dialog open title={session ? 'Edit session' : 'Schedule a session'} onClose={onClose}>
      <ProblemBanner error={save.error} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Programme" htmlFor="ss-p"><Select id="ss-p" value={f.programme_id} onChange={(e) => setF({ ...f, programme_id: e.target.value })}><option value="">Choose…</option>{progs.data?.filter((p) => p.status === 'active').map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}</Select></Field>
        <Field label="Venue" htmlFor="ss-v"><Input id="ss-v" value={f.venue} onChange={(e) => setF({ ...f, venue: e.target.value })} /></Field>
        <Field label="Starts" htmlFor="ss-s"><Input id="ss-s" type="datetime-local" value={f.starts} onChange={(e) => setF({ ...f, starts: e.target.value })} /></Field>
        <Field label="Ends" htmlFor="ss-e"><Input id="ss-e" type="datetime-local" value={f.ends} onChange={(e) => setF({ ...f, ends: e.target.value })} /></Field>
        <Field label="Trainer" htmlFor="ss-t"><Input id="ss-t" value={f.trainer} onChange={(e) => setF({ ...f, trainer: e.target.value })} /></Field>
        <Field label="Places" htmlFor="ss-c"><Input id="ss-c" type="number" min={1} value={f.capacity} onChange={(e) => setF({ ...f, capacity: e.target.value })} /></Field>
        <Field label="Cost per person (KES)" htmlFor="ss-k" hint="Requests for a paid session also go to the HR manager"><Input id="ss-k" value={f.cost} onChange={(e) => setF({ ...f, cost: e.target.value })} /></Field>
        <label className="flex items-center gap-2 self-end pb-2 text-sm"><input type="checkbox" checked={f.open} onChange={(e) => setF({ ...f, open: e.target.checked })} /> Staff can ask for a place</label>
      </div>
      <div className="mt-4 flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button busy={save.isPending} onClick={() => save.mutate()}>Save</Button></div>
    </Dialog>
  );
}
