'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { EXIT_KINDS, formatDate, formatDateTime, formatMoney } from '@sil/hr-shared';
import { Badge, Button, Card, Empty, Field, Input, Loading, PageHeader, ProblemBanner } from '@/components/ui';
import { hr, unwrap } from '@/lib/api';
import { useSession } from '@/lib/session';

export default function ExitsPage() {
  const { settings } = useSession();
  const [open, setOpen] = useState<string | null>(null);
  const q = useQuery({ queryKey: ['exits'], queryFn: () => unwrap(hr.GET('/api/v1/exit-clearances', { params: { query: { open: 'true' } } })) });
  return (
    <div className="space-y-4">
      <PageHeader title="Exits" description="People leaving: what procurement says they still hold, blocking checklist tasks, final dues and completion. Completing an exit ends their access at once." />
      <ProblemBanner error={q.error} />
      {!q.data ? <Loading /> : !q.data.length ? <Card><Empty>No exits in progress.</Empty></Card> : (
        <Card>
          <table className="data">
            <thead><tr><th>Employee</th><th>Last day</th><th>Reason</th><th>Procurement</th><th>Blocking tasks</th><th>Final dues</th><th /></tr></thead>
            <tbody>{q.data.map((x) => (
              <tr key={x.id} className="cursor-pointer" onClick={() => setOpen(x.employee_id)}>
                <td>{x.employee_name} <span className="muted text-xs">{x.staff_number}</span></td><td>{formatDate(x.exit_date, settings.date_format)}</td><td>{EXIT_KINDS[x.exit_kind]}</td>
                <td>{x.procurement.cleared === true ? <Badge value="cleared" /> : x.procurement.cleared === false ? <Badge value="items held" /> : <span className="muted text-xs">not checked</span>}</td>
                <td>{x.checklist_open_blocking || ''}</td><td><Badge value={x.final_dues_status} /></td><td className="text-right"><Button variant="ghost">Open</Button></td>
              </tr>
            ))}</tbody>
          </table>
        </Card>
      )}
      {open && <ExitDetail employeeId={open} />}
    </div>
  );
}

function ExitDetail({ employeeId }: { employeeId: string }) {
  const { settings } = useSession();
  const qc = useQueryClient();
  const [override, setOverride] = useState('');
  const q = useQuery({ queryKey: ['exit', employeeId], queryFn: () => unwrap(hr.GET('/api/v1/employees/{id}/exit-clearance', { params: { path: { id: employeeId } } })) });
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['exit', employeeId] }); void qc.invalidateQueries({ queryKey: ['exits'] }); };
  const check = useMutation({ mutationFn: () => unwrap(hr.POST('/api/v1/employees/{id}/exit-clearance/procurement-check', { params: { path: { id: employeeId } } })), onSuccess: refresh });
  const dues = useMutation({ mutationFn: () => unwrap(hr.POST('/api/v1/employees/{id}/exit-clearance/final-dues', { params: { path: { id: employeeId } } })), onSuccess: refresh });
  const complete = useMutation({ mutationFn: () => unwrap(hr.POST('/api/v1/employees/{id}/exit-clearance/complete', { params: { path: { id: employeeId } }, body: { override_reason: override || null } })), onSuccess: refresh });
  if (!q.data) return <Card><ProblemBanner error={q.error} /><Loading /></Card>;
  const x = q.data;
  const p = x.procurement;
  return (
    <Card className="space-y-4">
      <ProblemBanner error={check.error ?? dues.error ?? complete.error} />
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div><h2 className="text-lg font-semibold">{x.employee_name}</h2><div className="muted text-sm">{EXIT_KINDS[x.exit_kind]} · last day {formatDate(x.exit_date, settings.date_format)} · notice {x.notice_days} days, {x.notice_served_days} served</div></div>
        {x.completed_at ? <Badge value="exited" /> : x.ready ? <Badge value="ready" /> : <Badge value="not cleared" />}
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <div className="rounded-xl border border-[var(--border)] p-4">
          <div className="mb-2 flex items-center justify-between"><h3 className="font-semibold">Procurement</h3><Button variant="secondary" busy={check.isPending} onClick={() => check.mutate()}>Check now</Button></div>
          {p.error && <p className="mb-2 text-sm text-amber-700 dark:text-amber-300">{p.error}</p>}
          {p.cleared === true && <p className="text-sm text-emerald-700 dark:text-emerald-300">Nothing to return, retire or hand over.</p>}
          {p.assets.length > 0 && <div className="text-sm"><div className="font-medium">Assets held</div><ul className="list-disc pl-5">{p.assets.map((a) => <li key={a.tagNo}><span className="font-mono text-xs">{a.tagNo}</span> {a.description}{a.location ? ` (${a.location})` : ''}</li>)}</ul></div>}
          {p.outstanding_advances.length > 0 && <div className="mt-2 text-sm"><div className="font-medium">Advances not retired</div><ul className="list-disc pl-5">{p.outstanding_advances.map((a) => <li key={a.number}>{a.number}: KES {a.amount}{a.overdue ? ' (overdue)' : ''}</li>)}</ul></div>}
          {p.petty_cash_floats.length > 0 && <div className="mt-2 text-sm"><div className="font-medium">Petty cash floats</div><ul className="list-disc pl-5">{p.petty_cash_floats.map((f) => <li key={f.code}>{f.code} {f.name}</li>)}</ul></div>}
          {p.checked_at && <p className="muted mt-2 text-xs">Checked {formatDateTime(p.checked_at, settings.timezone, settings.date_format)}</p>}
        </div>
        <div className="rounded-xl border border-[var(--border)] p-4 text-sm">
          <h3 className="mb-2 font-semibold">Final dues</h3>
          <table className="w-full"><tbody>
            <tr><td className="py-1">Unused annual leave</td><td className="text-right">{x.leave_days} days</td><td className="text-right tabular-nums">{formatMoney(x.leave_pay)}</td></tr>
            <tr><td className="py-1">Notice pay in lieu</td><td /><td className="text-right tabular-nums">{formatMoney(x.notice_pay)}</td></tr>
            <tr><td className="py-1">Loans to recover from the last pay</td><td /><td className="text-right tabular-nums">{formatMoney(x.loans_outstanding)}</td></tr>
          </tbody></table>
          <p className="muted mt-2 text-xs">Approved dues go to the payroll for {x.exit_date.slice(0, 7)} with the prorated salary; leave is encashed and loans are recovered from that payslip.</p>
          <div className="mt-3 flex items-center justify-between"><Badge value={x.final_dues_status} />{x.final_dues_status === 'draft' && <Button busy={dues.isPending} onClick={() => dues.mutate()}>Send for approval</Button>}</div>
        </div>
      </div>
      {x.checklist_open_blocking > 0 && <p className="text-sm text-amber-700 dark:text-amber-300">{x.checklist_open_blocking} offboarding task(s) needed before exit are still open (see Onboarding and offboarding).</p>}
      {!x.completed_at && (
        <div className="flex flex-wrap items-end gap-2 border-t border-[var(--border)] pt-4">
          {(!x.ready || x.final_dues_status !== 'posted') && <div className="min-w-64 flex-1"><Field label="Complete anyway because (only if not cleared)" htmlFor="ex-o"><Input id="ex-o" value={override} onChange={(e) => setOverride(e.target.value)} /></Field></div>}
          <Button variant="danger" busy={complete.isPending} onClick={() => confirm('Complete the exit? Their access ends now.') && complete.mutate()}>Complete exit</Button>
        </div>
      )}
    </Card>
  );
}
