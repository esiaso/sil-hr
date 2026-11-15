'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Button, Card, Dialog, Empty, Field, Input, Loading, PageHeader, ProblemBanner, Select } from '@/components/ui';
import { ApiError, hr, unwrap } from '@/lib/api';
import { useLookups } from '@/lib/lookups';
import { useSession } from '@/lib/session';

const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const monday = () => { const d = new Date(); const day = (d.getUTCDay() + 6) % 7; return addDays(d.toISOString().slice(0, 10), -day); };
const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** One cell's value: '' (nothing planned), 'OFF', or shift ids joined by '+' (a split shift). */
type Cell = string;

export default function RostersPage() {
  const { can } = useSession();
  const l = useLookups();
  const qc = useQueryClient();
  const [dept, setDept] = useState('');
  const [from, setFrom] = useState(monday());
  const [days, setDays] = useState(14);
  const to = addDays(from, days - 1);
  const dates = useMemo(() => Array.from({ length: days }, (_, i) => addDays(from, i)), [from, days]);
  const shifts = useQuery({ queryKey: ['shifts'], queryFn: () => unwrap(hr.GET('/api/v1/shifts')) });
  const people = useQuery({ queryKey: ['roster-people', dept], enabled: !!dept, queryFn: () => unwrap(hr.GET('/api/v1/employees', { params: { query: { limit: 200, department_id: dept, include_sub_departments: 'true', status: 'active' as never } } })) });
  const roster = useQuery({ queryKey: ['roster', dept, from, to], enabled: !!dept, queryFn: () => unwrap(hr.GET('/api/v1/rosters', { params: { query: { from, to, department_id: dept } } })) });
  const [edits, setEdits] = useState<Record<string, Cell>>({});
  const [pattern, setPattern] = useState(false);
  const saved = useMemo(() => {
    const m: Record<string, Cell> = {};
    for (const r of roster.data ?? []) {
      const k = `${r.employee_id}|${r.work_date}`;
      m[k] = r.kind === 'off' ? 'OFF' : m[k] && m[k] !== 'OFF' ? `${m[k]}+${r.shift_id}` : r.shift_id!;
    }
    return m;
  }, [roster.data]);
  const byId = new Map((shifts.data ?? []).map((s) => [s.id, s]));
  const active = (shifts.data ?? []).filter((s) => s.status === 'active');
  const save = useMutation({
    mutationFn: () => unwrap(hr.PUT('/api/v1/rosters', { body: { entries: Object.entries(edits).map(([k, v]) => { const [employee_id, work_date] = k.split('|'); return { employee_id, work_date, kind: v === 'OFF' ? 'off' as const : 'shift' as const, shift_ids: v && v !== 'OFF' ? v.split('+') : [] }; }) } })),
    onSuccess: () => { setEdits({}); void qc.invalidateQueries({ queryKey: ['roster'] }); },
  });
  const manage = can('roster:manage');
  const label = (v: Cell) => (v === 'OFF' ? 'OFF' : v ? v.split('+').map((id) => byId.get(id)?.code ?? '?').join('+') : '');
  const pending = Object.keys(edits).length;
  return (
    <div>
      <PageHeader title="Rosters" description="Plan shifts for rostered departments. Standing departments (one fixed shift) do not need a roster. A day left empty falls back to the department's standing shift, if it has one." actions={manage && dept && <><Button variant="secondary" onClick={() => setPattern(true)}>Fill with a pattern</Button><Button disabled={!pending} busy={save.isPending} onClick={() => save.mutate()}>Save {pending ? `(${pending})` : ''}</Button></>} />
      <div className="mb-3 flex flex-wrap gap-2">
        <Select aria-label="Department" value={dept} onChange={(e) => { setDept(e.target.value); setEdits({}); }} className="max-w-72"><option value="">Choose a department</option>{l.departmentOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</Select>
        <Input aria-label="From" type="date" value={from} onChange={(e) => { setFrom(e.target.value); setEdits({}); }} className="max-w-40" />
        <Select aria-label="Days" value={days} onChange={(e) => { setDays(Number(e.target.value)); setEdits({}); }} className="max-w-32"><option value={7}>1 week</option><option value={14}>2 weeks</option><option value={28}>4 weeks</option></Select>
      </div>
      <ProblemBanner error={roster.error ?? people.error ?? save.error} />
      {!dept ? <Empty>Choose a department to see its roster.</Empty> : roster.isLoading || people.isLoading ? <Loading /> : !people.data?.data.length ? <Empty>No active staff in this department.</Empty> : (
        <div className="surface overflow-x-auto rounded-lg">
          <table className="data text-xs">
            <thead><tr><th className="sticky left-0 bg-[var(--surface)]">Person</th>{dates.map((d) => { const dow = DOW[(new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7]; return <th key={d} className={dow === 'Sat' || dow === 'Sun' ? 'bg-[var(--muted-bg,transparent)]' : ''}>{dow}<br />{d.slice(8)}</th>; })}</tr></thead>
            <tbody>{people.data.data.map((p) => (
              <tr key={p.id}>
                <td className="sticky left-0 whitespace-nowrap bg-[var(--surface)]">{p.first_name} {p.last_name}</td>
                {dates.map((d) => {
                  const k = `${p.id}|${d}`;
                  const v = edits[k] ?? saved[k] ?? '';
                  const s = v && v !== 'OFF' ? byId.get(v.split('+')[0]) : undefined;
                  const options = new Set(['', 'OFF', ...active.map((x) => x.id), ...(v ? [v] : [])]);
                  return (
                    <td key={d} className="p-0.5" style={{ background: s?.colour ? `${s.colour}22` : undefined }}>
                      {manage ? (
                        <select aria-label={`${p.first_name} ${d}`} value={v} onChange={(e) => setEdits({ ...edits, [k]: e.target.value })} className={`w-14 rounded border bg-transparent px-0.5 py-0.5 ${k in edits ? 'border-amber-500' : 'border-transparent'}`}>
                          {[...options].map((o) => <option key={o} value={o}>{label(o) || '·'}</option>)}
                        </select>
                      ) : <span className="px-1">{label(v)}</span>}
                    </td>
                  );
                })}
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
      {pattern && people.data && <PatternDialog people={people.data.data} from={from} to={to} codes={active.map((s) => s.code)} onClose={() => { setPattern(false); void qc.invalidateQueries({ queryKey: ['roster'] }); }} />}
    </div>
  );
}

function PatternDialog({ people, from, to, codes, onClose }: { people: { id: string; first_name: string; last_name: string }[]; from: string; to: string; codes: string[]; onClose: () => void }) {
  const [v, setV] = useState({ pattern: 'D,D,N,N,OFF,OFF', from, to, stagger: true, ids: people.map((p) => p.id) });
  const run = useMutation({ mutationFn: () => unwrap(hr.POST('/api/v1/rosters/pattern', { body: { employee_ids: v.ids, from: v.from, to: v.to, stagger: v.stagger, pattern: v.pattern.split(/[\s,]+/).filter(Boolean) } })), onSuccess: onClose });
  const fe = run.error instanceof ApiError ? run.error.fieldErrors : {};
  return (
    <Dialog open wide title="Fill with a pattern" onClose={onClose}>
      <ProblemBanner error={run.error} />
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Pattern" htmlFor="pt-p" error={fe.pattern} hint={`Shift codes and OFF, repeated day by day. Codes: ${codes.join(', ')}`}><Input id="pt-p" value={v.pattern} onChange={(e) => setV({ ...v, pattern: e.target.value })} /></Field>
        <Field label="From" htmlFor="pt-from"><Input id="pt-from" type="date" value={v.from} onChange={(e) => setV({ ...v, from: e.target.value })} /></Field>
        <Field label="To" htmlFor="pt-to"><Input id="pt-to" type="date" value={v.to} onChange={(e) => setV({ ...v, to: e.target.value })} /></Field>
      </div>
      <label className="mt-3 flex items-center gap-1 text-sm"><input type="checkbox" checked={v.stagger} onChange={(e) => setV({ ...v, stagger: e.target.checked })} />Stagger: each person starts the pattern one day after the previous, so the ward is always covered</label>
      <div className="mt-3 max-h-56 overflow-y-auto rounded border border-[var(--border)] p-2 text-sm">
        {people.map((p) => <label key={p.id} className="flex items-center gap-1"><input type="checkbox" checked={v.ids.includes(p.id)} onChange={(e) => setV({ ...v, ids: e.target.checked ? [...v.ids, p.id] : v.ids.filter((x) => x !== p.id) })} />{p.first_name} {p.last_name}</label>)}
      </div>
      <p className="muted mt-2 text-xs">This replaces whatever is planned for these people on these days.</p>
      <div className="mt-4 flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button busy={run.isPending} disabled={!v.ids.length} onClick={() => run.mutate()}>Apply</Button></div>
    </Dialog>
  );
}
