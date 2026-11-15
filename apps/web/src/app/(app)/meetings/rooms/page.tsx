'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Badge, Button, Card, Dialog, Empty, Field, Input, Loading, PageHeader, ProblemBanner, Select } from '@/components/ui';
import { hr, unwrap } from '@/lib/api';

type Room = NonNullable<Awaited<ReturnType<typeof list>>>[number];
const list = () => unwrap(hr.GET('/api/v1/meeting-rooms'));

export default function RoomsPage() {
  const q = useQuery({ queryKey: ['rooms'], queryFn: list });
  const [edit, setEdit] = useState<Room | 'new' | null>(null);
  return (
    <div className="space-y-4">
      <PageHeader title="Meeting rooms" description="Rooms staff can book for meetings. A room cannot be booked twice for the same time." actions={<Button onClick={() => setEdit('new')}>New room</Button>} />
      <ProblemBanner error={q.error} />
      <Card>
        {!q.data ? <Loading /> : !q.data.length ? <Empty>No rooms.</Empty> : (
          <table className="data">
            <thead><tr><th>Room</th><th>Where</th><th>Seats</th><th>Facilities</th><th>Status</th><th /></tr></thead>
            <tbody>{q.data.map((r) => <tr key={r.id}><td className="font-medium">{r.name}</td><td>{r.location}</td><td>{r.capacity ?? '–'}</td><td>{r.facilities}</td><td><Badge value={r.status} /></td><td className="text-right"><button type="button" className="link text-sm" onClick={() => setEdit(r)}>Edit</button></td></tr>)}</tbody>
          </table>
        )}
      </Card>
      {edit && <RoomDialog r={edit === 'new' ? null : edit} onClose={() => setEdit(null)} />}
    </div>
  );
}

function RoomDialog({ r, onClose }: { r: Room | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ name: r?.name ?? '', location: r?.location ?? '', capacity: r?.capacity ? String(r.capacity) : '', facilities: r?.facilities ?? '', status: r?.status ?? 'active' });
  const save = useMutation({
    mutationFn: () => {
      const body = { name: f.name, location: f.location || null, capacity: f.capacity ? Number(f.capacity) : null, facilities: f.facilities || null, status: f.status as 'active' };
      return r ? unwrap(hr.PUT('/api/v1/meeting-rooms/{id}', { params: { path: { id: r.id }, header: { 'If-Match': `"${r.version}"` } as never }, body })) : unwrap(hr.POST('/api/v1/meeting-rooms', { body }));
    },
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['rooms'] }); onClose(); },
  });
  const text = (k: 'name' | 'location' | 'capacity' | 'facilities', l: string) => <Field label={l} htmlFor={`rm-${k}`}><Input id={`rm-${k}`} value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} /></Field>;
  return (
    <Dialog open title={r ? `Edit ${r.name}` : 'New room'} onClose={onClose}>
      <ProblemBanner error={save.error} />
      <div className="grid gap-3 sm:grid-cols-2">
        {text('name', 'Name')}{text('location', 'Where')}{text('capacity', 'Seats')}{text('facilities', 'Facilities')}
        <Field label="Status" htmlFor="rm-s"><Select id="rm-s" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value as 'active' })}><option value="active">Active</option><option value="inactive">Inactive</option></Select></Field>
      </div>
      <div className="mt-4 flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button busy={save.isPending} onClick={() => save.mutate()}>Save</Button></div>
    </Dialog>
  );
}
