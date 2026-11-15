'use client';

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { formatDate, MANDATORY_STATES } from '@sil/hr-shared';
import { Badge, Card, Empty, Loading, PageHeader, ProblemBanner, Select } from '@/components/ui';
import { hr, unwrap } from '@/lib/api';
import { useSession } from '@/lib/session';

export default function CompliancePage() {
  const { settings } = useSession();
  const q = useQuery({ queryKey: ['mandatory-compliance'], queryFn: () => unwrap(hr.GET('/api/v1/training/compliance')) });
  const [prog, setProg] = useState('');
  const gaps = (q.data?.gaps ?? []).filter((g) => !prog || g.programme_id === prog);
  return (
    <div className="space-y-4">
      <PageHeader title="Mandatory training" description="Who is current on mandatory training, due within 60 days, overdue, or has never done it." />
      <ProblemBanner error={q.error} />
      {!q.data ? <Loading /> : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {q.data.programmes.map((p) => {
              const pct = p.staff ? Math.round((p.current / p.staff) * 100) : 0;
              return (
                <Card key={p.programme_id}>
                  <div className="font-medium">{p.programme_title}</div>
                  <div className="mt-1 text-2xl font-semibold">{pct}% <span className="muted text-sm font-normal">current</span></div>
                  <div className="mt-2 h-2 rounded-full bg-[var(--surface-2)]"><div className="h-2 rounded-full bg-emerald-500" style={{ width: `${pct}%` }} /></div>
                  <div className="muted mt-2 text-xs">{p.staff} staff · {p.due_soon} due soon · {p.overdue} overdue · {p.never} never</div>
                </Card>
              );
            })}
          </div>
          <Card>
            <div className="mb-2 flex items-center justify-between gap-2">
              <h2 className="font-semibold">Gaps</h2>
              <Select aria-label="Programme" className="w-auto" value={prog} onChange={(e) => setProg(e.target.value)}><option value="">All programmes</option>{q.data.programmes.map((p) => <option key={p.programme_id} value={p.programme_id}>{p.programme_title}</option>)}</Select>
            </div>
            {!gaps.length ? <Empty>Everyone is current.</Empty> : (
              <table className="data">
                <thead><tr><th>Name</th><th>Department</th><th>Programme</th><th>Last done</th><th>Due</th><th>State</th></tr></thead>
                <tbody>{gaps.map((g) => (
                  <tr key={`${g.employee_id}-${g.programme_id}`}>
                    <td>{g.employee_name} <span className="muted text-xs">{g.staff_number}</span></td><td>{g.department_name}</td><td>{g.programme_title}</td>
                    <td>{formatDate(g.last_completed, settings.date_format) || '–'}</td><td>{formatDate(g.due_on, settings.date_format) || '–'}</td>
                    <td><Badge value={MANDATORY_STATES[g.state].toLowerCase()} /></td>
                  </tr>
                ))}</tbody>
              </table>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
