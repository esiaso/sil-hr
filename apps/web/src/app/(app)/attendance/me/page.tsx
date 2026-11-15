'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { formatDate, formatDateTime } from '@sil/hr-shared';
import { Badge, Button, Card, Dialog, Empty, Field, Input, Loading, PageHeader, ProblemBanner, Textarea } from '@/components/ui';
import { ApiError, hr, unwrap } from '@/lib/api';
import { useSession } from '@/lib/session';

const hm = (min: number) => `${Math.floor(min / 60)}h ${String(min % 60).padStart(2, '0')}m`;

/** Clock in and out from a phone or the desk, see recent days, and ask to correct a missed punch. */
export default function MyAttendancePage() {
  const { me, settings } = useSession();
  const qc = useQueryClient();
  const today = useQuery({ queryKey: ['me-attendance'], queryFn: () => unwrap(hr.GET('/api/v1/me/attendance')), refetchInterval: 60_000, retry: false });
  const from = new Date(Date.now() - 14 * 86_400_000).toISOString().slice(0, 10);
  const to = new Date().toISOString().slice(0, 10);
  const sheet = useQuery({ queryKey: ['me-timesheet'], enabled: !!me.employee_id, queryFn: () => unwrap(hr.GET('/api/v1/attendance/timesheets/{id}', { params: { path: { id: me.employee_id! }, query: { from, to } } })) });
  const regs = useQuery({ queryKey: ['me-regs'], queryFn: () => unwrap(hr.GET('/api/v1/attendance/regularisations')) });
  const [fixing, setFixing] = useState(false);
  const clock = useMutation({
    mutationFn: async (direction: 'in' | 'out') => {
      const pos = await new Promise<GeolocationPosition | null>((r) => (navigator.geolocation ? navigator.geolocation.getCurrentPosition(r, () => r(null), { timeout: 4000 }) : r(null)));
      return unwrap(hr.POST('/api/v1/me/clock', { body: { direction, ...(pos ? { latitude: pos.coords.latitude, longitude: pos.coords.longitude } : {}) } }));
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['me-attendance'] }),
  });
  if (!me.employee_id) return <div><PageHeader title="My attendance" /><Empty>Your account is not linked to an employee record. Ask HR.</Empty></div>;
  const punches = (today.data as { punches?: { at: string; direction: string; source: string }[] } | undefined)?.punches ?? [];
  const last = punches.at(-1);
  return (
    <div className="max-w-2xl space-y-4">
      <PageHeader title="My attendance" description="Clock in when you arrive and out when you leave. Device punches appear here too." />
      <ProblemBanner error={clock.error ?? today.error} />
      <Card>
        <div className="flex flex-col items-center gap-3 py-2 sm:flex-row sm:justify-between">
          <div className="text-center sm:text-left">
            <div className="text-3xl font-semibold tabular-nums">{new Intl.DateTimeFormat('en-GB', { timeZone: settings.timezone, hour: '2-digit', minute: '2-digit' }).format(new Date())}</div>
            <div className="muted text-sm">{last ? `Last: ${last.direction === 'unknown' ? 'punch' : last.direction} at ${formatDateTime(last.at, settings.timezone, settings.date_format)}` : 'No punches in the last day and a half'}</div>
          </div>
          <div className="flex w-full gap-3 sm:w-auto">
            <Button className="flex-1 justify-center py-4 text-base sm:flex-none" busy={clock.isPending && clock.variables === 'in'} onClick={() => clock.mutate('in')}>Clock in</Button>
            <Button variant="secondary" className="flex-1 justify-center py-4 text-base sm:flex-none" busy={clock.isPending && clock.variables === 'out'} onClick={() => clock.mutate('out')}>Clock out</Button>
          </div>
        </div>
      </Card>
      <Card>
        <div className="mb-2 flex items-center justify-between"><h2 className="font-semibold">Last two weeks</h2><Button variant="secondary" onClick={() => setFixing(true)}>Correct a day</Button></div>
        {!sheet.data ? <Loading /> : (
          <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
            <div><div className="muted text-xs">Present</div><b>{sheet.data.present_days}</b> / {sheet.data.scheduled_days}</div>
            <div><div className="muted text-xs">Late</div><b>{sheet.data.late_days}</b></div>
            <div><div className="muted text-xs">Absent</div><b>{sheet.data.absent_days}</b></div>
            <div><div className="muted text-xs">Worked</div><b>{hm(sheet.data.worked_minutes)}</b></div>
          </div>
        )}
        {regs.data && regs.data.length > 0 && (
          <ul className="mt-3 text-sm">{regs.data.slice(0, 5).map((r) => <li key={r.id} className="flex justify-between border-t border-[var(--border)] py-1"><span>Correction for {formatDate(r.work_date, settings.date_format)}</span><Badge value={r.status} /></li>)}</ul>
        )}
      </Card>
      {fixing && <FixDialog onClose={() => { setFixing(false); void qc.invalidateQueries({ queryKey: ['me-regs'] }); }} />}
    </div>
  );
}

function FixDialog({ onClose }: { onClose: () => void }) {
  const { settings } = useSession();
  const [v, setV] = useState({ work_date: '', in: '', out: '', reason: '' });
  // Wall-clock HH:MM on the chosen date, in the organisation's timezone (+03:00 for Nairobi).
  const toIso = (date: string, hm: string) => {
    if (!date || !hm) return null;
    const probe = new Date(`${date}T12:00:00Z`);
    const local = new Date(probe.toLocaleString('en-US', { timeZone: settings.timezone }));
    const offsetMin = Math.round((local.getTime() - new Date(probe.toLocaleString('en-US', { timeZone: 'UTC' })).getTime()) / 60_000);
    return new Date(Date.parse(`${date}T${hm}:00Z`) - offsetMin * 60_000).toISOString();
  };
  const save = useMutation({ mutationFn: () => unwrap(hr.POST('/api/v1/attendance/regularisations', { body: { work_date: v.work_date, clock_in: toIso(v.work_date, v.in), clock_out: toIso(v.work_date, v.out), reason: v.reason } })), onSuccess: onClose });
  const fe = save.error instanceof ApiError ? save.error.fieldErrors : {};
  return (
    <Dialog open title="Correct a day" onClose={onClose}>
      <ProblemBanner error={save.error} />
      <div className="space-y-3">
        <Field label="Day" htmlFor="fx-date"><Input id="fx-date" type="date" value={v.work_date} onChange={(e) => setV({ ...v, work_date: e.target.value })} /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Arrived" htmlFor="fx-in"><Input id="fx-in" type="time" value={v.in} onChange={(e) => setV({ ...v, in: e.target.value })} /></Field>
          <Field label="Left" htmlFor="fx-out" error={fe.clock_out}><Input id="fx-out" type="time" value={v.out} onChange={(e) => setV({ ...v, out: e.target.value })} /></Field>
        </div>
        <Field label="What happened" htmlFor="fx-why" error={fe.reason}><Textarea id="fx-why" value={v.reason} onChange={(e) => setV({ ...v, reason: e.target.value })} /></Field>
        <p className="muted text-xs">Your manager confirms corrections. For a night shift, enter the day the shift started.</p>
        <div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button busy={save.isPending} disabled={!v.work_date || (!v.in && !v.out) || v.reason.length < 5} onClick={() => save.mutate()}>Send</Button></div>
      </div>
    </Dialog>
  );
}
