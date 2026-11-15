'use client';

import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Badge, Button, Empty, Loading, PageHeader, ProblemBanner, Select } from '@/components/ui';
import { hr, unwrap } from '@/lib/api';
import { useLookups } from '@/lib/lookups';

const iso = (d: Date) => d.toISOString().slice(0, 10);

/** Who is away when, as a grid of people by day (four weeks at a time). */
export default function TeamCalendarPage() {
  const l = useLookups();
  const [start, setStart] = useState(() => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    return iso(d);
  });
  const [dept, setDept] = useState('');
  const days = useMemo(() => Array.from({ length: 28 }, (_, i) => iso(new Date(Date.parse(`${start}T00:00:00Z`) + i * 86_400_000))), [start]);
  const q = useQuery({ queryKey: ['leave-calendar', start, dept], queryFn: () => unwrap(hr.GET('/api/v1/leave/calendar', { params: { query: { from: days[0], to: days[27], department_id: dept || undefined } } })) });
  const people = useMemo(() => {
    const m = new Map<string, { name: string; entries: NonNullable<typeof q.data> }>();
    for (const e of q.data ?? []) m.set(e.employee_id, { name: e.employee_name, entries: [...(m.get(e.employee_id)?.entries ?? []), e] });
    return [...m.entries()].sort((a, b) => a[1].name.localeCompare(b[1].name));
  }, [q.data]);
  const shift = (n: number) => setStart(iso(new Date(Date.parse(`${start}T00:00:00Z`) + n * 86_400_000)));
  return (
    <div>
      <PageHeader title="Team calendar" description="Approved and pending leave for the people you can see, so cover can be planned." />
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Button variant="secondary" onClick={() => shift(-28)}>← Earlier</Button>
        <Button variant="secondary" onClick={() => shift(28)}>Later →</Button>
        <Select aria-label="Department" value={dept} onChange={(e) => setDept(e.target.value)} className="max-w-64"><option value="">All I can see</option>{l.departmentOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</Select>
        <span className="muted text-xs"><Badge value="approved" /> solid · <Badge value="pending" /> striped</span>
      </div>
      <ProblemBanner error={q.error} />
      {q.isLoading ? <Loading /> : !people.length ? <Empty>No leave in these four weeks.</Empty> : (
        <div className="surface overflow-x-auto rounded-lg">
          <table className="text-xs">
            <thead>
              <tr>
                <th className="sticky left-0 bg-[var(--surface)] p-2 text-left">Person</th>
                {days.map((d) => { const wd = new Date(`${d}T00:00:00Z`).getUTCDay(); return <th key={d} className={`w-7 p-1 text-center font-normal ${wd === 0 || wd === 6 ? 'muted' : ''}`}>{d.slice(8)}<div className="muted">{'SMTWTFS'[wd]}</div></th>; })}
              </tr>
            </thead>
            <tbody>
              {people.map(([id, p]) => (
                <tr key={id} className="border-t border-[var(--border)]">
                  <td className="sticky left-0 max-w-44 truncate bg-[var(--surface)] p-2">{p.name}</td>
                  {days.map((d) => {
                    const e = p.entries.find((x) => x.start_date <= d && x.end_date >= d);
                    return (
                      <td key={d} className="p-0.5">
                        {e && <div title={`${e.leave_type_name} (${e.status})`} className="h-5 rounded-sm" style={{ background: e.status === 'approved' ? (e.colour ?? '#1f7a6d') : `repeating-linear-gradient(45deg, ${e.colour ?? '#1f7a6d'}, ${e.colour ?? '#1f7a6d'} 3px, transparent 3px, transparent 6px)` }} />}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
