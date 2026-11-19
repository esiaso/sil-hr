'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { formatDate } from '@sil/hr-shared';
import { useSession } from '@/lib/session';
import { useState } from 'react';
import { Badge, Button, Dialog, Field, Input, ProblemBanner } from '@/components/ui';
import { hr, unwrap } from '@/lib/api';

/** Fetch one person's punches from the clocking devices now, for chosen dates (up to 62 days). */
export function PullAttendance({ employeeId, name, onClose }: { employeeId: string; name: string; onClose: () => void }) {
  const today = new Date().toISOString().slice(0, 10);
  const [from, setFrom] = useState(new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10));
  const [to, setTo] = useState(today);
  const pull = useMutation({ mutationFn: () => unwrap(hr.POST('/api/v1/employees/{id}/attendance/pull', { params: { path: { id: employeeId } }, body: { from, to } })) });
  const r = pull.data;
  const { settings } = useSession();
  const days = useQuery({ queryKey: ['pulled-days', employeeId, from, to, r?.accepted], enabled: !!r, queryFn: () => unwrap(hr.GET('/api/v1/attendance/days', { params: { query: { employee_id: employeeId, from, to, limit: 100 } } })) });
  return (
    <Dialog open title={`Pull attendance for ${name}`} onClose={onClose}>
      <p className="muted mb-3 text-sm">Fetches this person’s punches from every clocking device connector now, instead of waiting for the next scheduled pull, and recalculates those days. Punches already received are not duplicated.</p>
      <ProblemBanner error={pull.error} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="From" htmlFor="pa-from"><Input id="pa-from" type="date" max={to} value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field label="To" htmlFor="pa-to"><Input id="pa-to" type="date" min={from} max={today} value={to} onChange={(e) => setTo(e.target.value)} /></Field>
      </div>
      {r && (
        <div className="mt-3 space-y-2 text-sm">
          <p><b>{r.accepted}</b> new punch(es) recorded.</p>
          {!r.connectors.length && <p className="text-amber-700">No device connector that can be pulled from is set up. Add one under Integrations → Device connectors.</p>}
          <ul className="space-y-1">
            {r.connectors.map((c) => (
              <li key={c.connector_id} className="rounded-lg border border-[var(--border)] px-3 py-2">
                <div className="flex items-center justify-between"><span className="font-medium">{c.connector}</span><Badge value={c.status} /></div>
                <div className="muted text-xs">
                  {c.device_user_ids.length ? `Device user ${c.device_user_ids.join(', ')} · ${c.received} received · ${c.accepted} new · ${c.duplicates} already had` : ''}
                  {c.error ? ` ${c.error}` : ''}
                </div>
              </li>
            ))}
          </ul>
          {days.data && days.data.data.length > 0 && (
            <table className="data"><thead><tr><th>Day</th><th>Shift</th><th>In</th><th>Out</th><th>Status</th></tr></thead>
              <tbody>{days.data.data.map((d) => <tr key={d.id}><td>{formatDate(d.work_date, settings.date_format)}</td><td>{d.shift_code ?? '–'}</td><td>{d.first_in ? new Date(d.first_in).toLocaleTimeString('en-GB', { timeZone: settings.timezone, hour: '2-digit', minute: '2-digit' }) : '–'}</td><td>{d.last_out ? new Date(d.last_out).toLocaleTimeString('en-GB', { timeZone: settings.timezone, hour: '2-digit', minute: '2-digit' }) : '–'}</td><td><Badge value={d.status} /></td></tr>)}</tbody>
            </table>
          )}
        </div>
      )}
      <div className="mt-4 flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Close</Button><Button busy={pull.isPending} onClick={() => pull.mutate()}>Pull now</Button></div>
    </Dialog>
  );
}
