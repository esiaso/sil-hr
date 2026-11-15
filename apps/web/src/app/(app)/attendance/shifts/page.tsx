'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import type { Shift } from '@sil/hr-shared';
import { Badge, Button, Card, Dialog, Field, Input, Loading, PageHeader, ProblemBanner, Select } from '@/components/ui';
import { ApiError, hr, unwrap } from '@/lib/api';
import { useLookups } from '@/lib/lookups';
import { useSession } from '@/lib/session';

type Draft = { code: string; name: string; start_time: string; end_time: string; break_minutes: number; late_grace_minutes: number | null; early_leave_grace_minutes: number | null; colour: string; status: 'active' | 'inactive' };
const blank: Draft = { code: '', name: '', start_time: '08:00', end_time: '17:00', break_minutes: 60, late_grace_minutes: null, early_leave_grace_minutes: null, colour: '#2563eb', status: 'active' };

function ShiftDialog({ s, onClose }: { s: Shift | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [v, setV] = useState<Draft>(s ? { code: s.code, name: s.name, start_time: s.start_time.slice(0, 5), end_time: s.end_time.slice(0, 5), break_minutes: s.break_minutes, late_grace_minutes: s.late_grace_minutes, early_leave_grace_minutes: s.early_leave_grace_minutes, colour: s.colour ?? '#2563eb', status: s.status } : blank);
  const save = useMutation({
    mutationFn: () => (s ? unwrap(hr.PUT('/api/v1/shifts/{id}', { params: { path: { id: s.id }, header: { 'If-Match': `"${s.version}"` } as never }, body: v })) : unwrap(hr.POST('/api/v1/shifts', { body: v }))),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['shifts'] }); onClose(); },
  });
  const fe = save.error instanceof ApiError ? save.error.fieldErrors : {};
  const num = (x: string) => (x === '' ? null : Number(x));
  return (
    <Dialog open title={s ? `Shift ${s.code}` : 'New shift'} onClose={onClose}>
      <ProblemBanner error={save.error} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Code" htmlFor="sh-code" error={fe.code} hint="Short, used in roster patterns (D, N, OFFICE)"><Input id="sh-code" value={v.code} onChange={(e) => setV({ ...v, code: e.target.value.toUpperCase() })} /></Field>
        <Field label="Name" htmlFor="sh-name" error={fe.name}><Input id="sh-name" value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} /></Field>
        <Field label="Starts" htmlFor="sh-start" error={fe.start_time}><Input id="sh-start" type="time" value={v.start_time} onChange={(e) => setV({ ...v, start_time: e.target.value })} /></Field>
        <Field label="Ends" htmlFor="sh-end" error={fe.end_time} hint={v.end_time <= v.start_time ? 'Ends the next day (night shift)' : undefined}><Input id="sh-end" type="time" value={v.end_time} onChange={(e) => setV({ ...v, end_time: e.target.value })} /></Field>
        <Field label="Unpaid break (minutes)" htmlFor="sh-break" hint="Taken off only when the person works more than 5 hours"><Input id="sh-break" type="number" value={v.break_minutes} onChange={(e) => setV({ ...v, break_minutes: Number(e.target.value) })} /></Field>
        <Field label="Colour" htmlFor="sh-col"><Input id="sh-col" type="color" value={v.colour} onChange={(e) => setV({ ...v, colour: e.target.value })} /></Field>
        <Field label="Late grace (minutes)" htmlFor="sh-grace" hint="Empty uses the organisation setting"><Input id="sh-grace" type="number" value={v.late_grace_minutes ?? ''} onChange={(e) => setV({ ...v, late_grace_minutes: num(e.target.value) })} /></Field>
        <Field label="Early-leave grace (minutes)" htmlFor="sh-egrace" hint="Empty uses the organisation setting"><Input id="sh-egrace" type="number" value={v.early_leave_grace_minutes ?? ''} onChange={(e) => setV({ ...v, early_leave_grace_minutes: num(e.target.value) })} /></Field>
      </div>
      <label className="mt-3 flex items-center gap-1 text-sm"><input type="checkbox" checked={v.status === 'active'} onChange={(e) => setV({ ...v, status: e.target.checked ? 'active' : 'inactive' })} />In use</label>
      <div className="mt-4 flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button busy={save.isPending} onClick={() => save.mutate()}>Save</Button></div>
    </Dialog>
  );
}

function DepartmentShifts({ shifts }: { shifts: Shift[] }) {
  const l = useLookups();
  const qc = useQueryClient();
  const [dept, setDept] = useState('');
  const cur = useQuery({ queryKey: ['dept-shifts', dept], enabled: !!dept, queryFn: () => unwrap(hr.GET('/api/v1/departments/{id}/shifts', { params: { path: { id: dept } } })) });
  const [v, setV] = useState<{ mode: 'standing' | 'rostered'; standing_shift_id: string | null; shift_ids: string[] }>({ mode: 'standing', standing_shift_id: null, shift_ids: [] });
  useEffect(() => { if (cur.data) setV({ mode: cur.data.mode, standing_shift_id: cur.data.standing_shift_id, shift_ids: cur.data.shift_ids }); }, [cur.data]);
  const save = useMutation({ mutationFn: () => unwrap(hr.PUT('/api/v1/departments/{id}/shifts', { params: { path: { id: dept } }, body: { ...v, shift_ids: v.mode === 'standing' && v.standing_shift_id && !v.shift_ids.includes(v.standing_shift_id) ? [...v.shift_ids, v.standing_shift_id] : v.shift_ids } })), onSuccess: () => qc.invalidateQueries({ queryKey: ['dept-shifts'] }) });
  const fe = save.error instanceof ApiError ? save.error.fieldErrors : {};
  const active = shifts.filter((s) => s.status === 'active');
  const inheritedName = cur.data?.inherited_from && cur.data.inherited_from !== dept ? l.departments.get(cur.data.inherited_from)?.name : null;
  return (
    <Card>
      <h2 className="mb-1 font-semibold">Shifts by department</h2>
      <p className="muted mb-3 text-xs">A standing department (Finance, 08:00 to 17:00) needs no roster: everyone works the standing shift on working days. A rostered department (wards running day and night, or three shifts) plans each person day by day. Sub-departments follow their parent unless set here.</p>
      <Select aria-label="Department" value={dept} onChange={(e) => setDept(e.target.value)} className="mb-3 max-w-80"><option value="">Choose a department</option>{l.departmentOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</Select>
      <ProblemBanner error={cur.error ?? save.error} />
      {dept && (cur.isLoading ? <Loading /> : (
        <div className="space-y-3">
          {inheritedName && <p className="text-sm">Currently follows <b>{inheritedName}</b>. Saving here gives this department its own setting.</p>}
          <div className="flex gap-4 text-sm">
            <label className="flex items-center gap-1"><input type="radio" checked={v.mode === 'standing'} onChange={() => setV({ ...v, mode: 'standing' })} />Standing shift</label>
            <label className="flex items-center gap-1"><input type="radio" checked={v.mode === 'rostered'} onChange={() => setV({ ...v, mode: 'rostered' })} />Rostered</label>
          </div>
          {v.mode === 'standing' && <Field label="Standing shift" htmlFor="ds-stand" error={fe.standing_shift_id}><Select id="ds-stand" value={v.standing_shift_id ?? ''} onChange={(e) => setV({ ...v, standing_shift_id: e.target.value || null })}><option value="">Choose</option>{active.map((s) => <option key={s.id} value={s.id}>{s.code} · {s.name} ({s.start_time.slice(0, 5)}–{s.end_time.slice(0, 5)})</option>)}</Select></Field>}
          <div>
            <div className="mb-1 text-sm font-medium">{v.mode === 'rostered' ? 'Shifts this department runs' : 'Other shifts people here may be rostered on'}</div>
            <div className="flex flex-wrap gap-3 text-sm">{active.map((s) => <label key={s.id} className="flex items-center gap-1"><input type="checkbox" checked={v.shift_ids.includes(s.id)} onChange={(e) => setV({ ...v, shift_ids: e.target.checked ? [...v.shift_ids, s.id] : v.shift_ids.filter((x) => x !== s.id) })} />{s.code} ({s.start_time.slice(0, 5)}–{s.end_time.slice(0, 5)})</label>)}</div>
            {fe.shift_ids && <p className="mt-1 text-xs text-red-600">{fe.shift_ids}</p>}
          </div>
          <Button busy={save.isPending} onClick={() => save.mutate()}>Save</Button>
        </div>
      ))}
    </Card>
  );
}

export default function ShiftsPage() {
  const { can } = useSession();
  const q = useQuery({ queryKey: ['shifts'], queryFn: () => unwrap(hr.GET('/api/v1/shifts')) });
  const [editing, setEditing] = useState<Shift | 'new' | null>(null);
  const manage = can('shift:manage');
  return (
    <div className="space-y-4">
      <PageHeader title="Shifts" description="Shift times, and which shifts each department runs. Lateness grace is 30 minutes by default (Administration → Settings, attendance.late_grace_minutes); a shift can set its own." actions={manage && <Button onClick={() => setEditing('new')}>New shift</Button>} />
      <ProblemBanner error={q.error} />
      <Card>
        {!q.data ? <Loading /> : (
          <table className="data">
            <thead><tr><th>Code</th><th>Name</th><th>Time</th><th>Paid</th><th>Break</th><th>Late grace</th><th /></tr></thead>
            <tbody>{q.data.map((s) => (
              <tr key={s.id}>
                <td><span className="mr-2 inline-block h-3 w-3 rounded-full align-middle" style={{ background: s.colour ?? '#888' }} />{s.code}</td>
                <td>{s.name} {s.status === 'inactive' && <Badge value="inactive" />}</td>
                <td className="tabular-nums">{s.start_time.slice(0, 5)}–{s.end_time.slice(0, 5)}{s.crosses_midnight && <span className="muted text-xs"> next day</span>}</td>
                <td>{Math.floor(s.paid_minutes / 60)}h{s.paid_minutes % 60 ? ` ${s.paid_minutes % 60}m` : ''}</td>
                <td>{s.break_minutes ? `${s.break_minutes}m` : ''}</td>
                <td>{s.late_grace_minutes ?? <span className="muted">default</span>}</td>
                <td>{manage && <Button variant="ghost" onClick={() => setEditing(s)}>Edit</Button>}</td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </Card>
      {q.data && manage && <DepartmentShifts shifts={q.data} />}
      {editing && <ShiftDialog s={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </div>
  );
}
