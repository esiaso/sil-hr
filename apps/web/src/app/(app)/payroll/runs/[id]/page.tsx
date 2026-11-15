'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams, useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { formatDate, formatDateTime, formatMoney, PAYROLL_EXPORTS } from '@sil/hr-shared';
import { Badge, Button, Card, Empty, Input, Loading, PageHeader, ProblemBanner } from '@/components/ui';
import { hr, unwrap } from '@/lib/api';
import { useSession } from '@/lib/session';
import { PayslipDialog, periodLabel } from '@/components/payroll';

const k = (x: string | null | undefined) => formatMoney(x, '');

export default function PayrollRunPage() {
  const { id } = useParams<{ id: string }>();
  const { can, settings } = useSession();
  const qc = useQueryClient();
  const router = useRouter();
  const run = useQuery({ queryKey: ['payroll-run', id], queryFn: () => unwrap(hr.GET('/api/v1/payroll/runs/{id}', { params: { path: { id } } })) });
  const slips = useQuery({ queryKey: ['payroll-slips', id, run.data?.calculated_at], enabled: !!run.data?.calculated_at, queryFn: () => unwrap(hr.GET('/api/v1/payroll/runs/{id}/payslips', { params: { path: { id } } })) });
  const [tab, setTab] = useState<'payslips' | 'variance' | 'warnings' | 'journal' | 'files'>('payslips');
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['payroll-run', id] }); void qc.invalidateQueries({ queryKey: ['payroll-runs'] }); };
  const act = useMutation({
    mutationFn: async (a: 'calculate' | 'submit' | 'mark-paid' | 'close' | 'delete') => {
      if (a === 'delete') { await unwrap(hr.DELETE('/api/v1/payroll/runs/{id}', { params: { path: { id } } })); return null; }
      const path = { calculate: '/api/v1/payroll/runs/{id}/calculate', submit: '/api/v1/payroll/runs/{id}/submit', 'mark-paid': '/api/v1/payroll/runs/{id}/mark-paid', close: '/api/v1/payroll/runs/{id}/close' }[a];
      return unwrap(hr.POST(path as '/api/v1/payroll/runs/{id}/calculate', { params: { path: { id } }, body: (a === 'submit' ? {} : undefined) as never }));
    },
    onSuccess: (_r, a) => { if (a === 'delete') router.push('/payroll'); else refresh(); },
  });
  const rows = useMemo(() => (slips.data ?? []).filter((s) => !search || `${s.employee_name} ${s.staff_number} ${s.department_name ?? ''}`.toLowerCase().includes(search.toLowerCase())), [slips.data, search]);
  if (!run.data) return <div><ProblemBanner error={run.error} /><Loading /></div>;
  const r = run.data;
  const editable = r.status === 'draft' || r.status === 'calculated';
  const locked = ['approved', 'paid', 'closed'].includes(r.status);
  return (
    <div className="space-y-4">
      <PageHeader
        title={`Payroll ${periodLabel(r.period)}`}
        description={`${r.number} · pay date ${formatDate(r.pay_date, settings.date_format)}${r.calculated_at ? ` · calculated ${formatDateTime(r.calculated_at, settings.timezone, settings.date_format)}` : ''}`}
        actions={<>
          {editable && can('payroll:prepare') && <Button variant={r.status === 'draft' ? 'primary' : 'secondary'} busy={act.isPending && act.variables === 'calculate'} onClick={() => act.mutate('calculate')}>{r.status === 'draft' ? 'Calculate' : 'Recalculate'}</Button>}
          {r.status === 'calculated' && can('payroll:prepare') && <Button busy={act.isPending && act.variables === 'submit'} onClick={() => act.mutate('submit')}>Submit for approval</Button>}
          {r.status === 'approved' && can('payroll:pay') && <Button busy={act.isPending} onClick={() => act.mutate('mark-paid')}>Mark paid</Button>}
          {r.status === 'paid' && can('payroll:pay') && <Button variant="secondary" busy={act.isPending} onClick={() => act.mutate('close')}>Close</Button>}
          {editable && can('payroll:prepare') && <Button variant="ghost" onClick={() => confirm('Delete this payroll?') && act.mutate('delete')}>Delete</Button>}
        </>}
      />
      <ProblemBanner error={act.error} />
      <div className="flex flex-wrap items-center gap-2"><Badge value={r.status} />{r.status === 'under_review' && <span className="muted text-sm">Waiting for approval (see Approvals).</span>}{r.decision_comment && <span className="text-sm text-amber-700 dark:text-amber-300">Sent back: {r.decision_comment}</span>}</div>
      {r.calculated_at && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          {([['Staff', String(r.employees)], ['Gross', k(r.gross)], ['Deductions', k(r.total_deductions)], ['Net pay', k(r.net)], ['Cost to the hospital', k(r.employer_cost)]] as const).map(([l, v]) => <Card key={l}><div className="muted text-xs">{l}</div><div className="text-lg font-semibold tabular-nums">{v}</div></Card>)}
        </div>
      )}
      {!r.calculated_at ? <Card><Empty>Calculate the payroll to see payslips. It uses each person&rsquo;s salary, pay items, loans, one-off items, unpaid leave and overtime for the month, with the rate tables in force on {formatDate(r.period_end, settings.date_format)}.</Empty></Card> : (
        <>
          <div className="flex flex-wrap gap-1 border-b border-[var(--border)]">
            {(['payslips', 'variance', 'warnings', ...(can('payroll.journal:read') ? ['journal'] as const : []), ...(locked && can('payroll:prepare') ? ['files'] as const : [])] as const).map((t) => (
              <button key={t} type="button" onClick={() => setTab(t)} className={`-mb-px border-b-2 px-3 py-2 text-sm capitalize ${tab === t ? 'border-[var(--accent)] font-medium' : 'border-transparent muted'}`}>{t}{t === 'warnings' && r.warnings.length ? ` (${r.warnings.length})` : ''}</button>
            ))}
          </div>
          {tab === 'payslips' && (
            <Card>
              <Input aria-label="Search payslips" placeholder="Search name, staff number or department" value={search} onChange={(e) => setSearch(e.target.value)} className="mb-3 max-w-sm" />
              {!slips.data ? <Loading /> : (
                <div className="overflow-x-auto">
                  <table className="data text-sm">
                    <thead><tr><th>Staff no.</th><th>Name</th><th>Department</th><th className="text-right">Gross</th><th className="text-right">PAYE</th><th className="text-right">NSSF</th><th className="text-right">SHIF</th><th className="text-right">Housing</th><th className="text-right">Net</th><th /></tr></thead>
                    <tbody>{rows.map((s) => (
                      <tr key={s.id} className="cursor-pointer" onClick={() => setOpen(s.id)}>
                        <td>{s.staff_number}</td><td>{s.employee_name}</td><td className="muted">{s.department_name}</td>
                        <td className="text-right tabular-nums">{k(s.gross)}</td><td className="text-right tabular-nums">{k(s.paye)}</td><td className="text-right tabular-nums">{k(s.nssf)}</td><td className="text-right tabular-nums">{k(s.shif)}</td><td className="text-right tabular-nums">{k(s.housing_levy)}</td>
                        <td className="text-right font-medium tabular-nums">{k(s.net)}</td><td>{s.warnings.length > 0 && <span title={s.warnings.join('\n')} className="text-amber-600">⚠ {s.warnings.length}</span>}</td>
                      </tr>
                    ))}</tbody>
                  </table>
                </div>
              )}
            </Card>
          )}
          {tab === 'variance' && <Variance id={id} />}
          {tab === 'warnings' && <Card>{!r.warnings.length ? <Empty>No warnings.</Empty> : <ul className="text-sm">{r.warnings.map((w, i) => <li key={i} className="border-b border-[var(--border)] py-1"><b>{w.name ?? 'Run'}</b>: {w.message}</li>)}</ul>}</Card>}
          {tab === 'journal' && <Journal id={id} />}
          {tab === 'files' && <Files id={id} />}
        </>
      )}
      {open && <PayslipDialog id={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

function Variance({ id }: { id: string }) {
  const v = useQuery({ queryKey: ['payroll-variance', id], queryFn: () => unwrap(hr.GET('/api/v1/payroll/runs/{id}/variance', { params: { path: { id } } })) });
  const [all, setAll] = useState(false);
  if (!v.data) return <Card><ProblemBanner error={v.error} /><Loading /></Card>;
  const rows = all ? v.data.rows : v.data.rows.filter((r) => r.flag !== 'unchanged');
  return (
    <Card>
      <div className="mb-2 flex items-center justify-between text-sm">
        <span>{v.data.previous_period ? <>Compared with {periodLabel(v.data.previous_period)}; net pay changes above {v.data.threshold_pct}% are flagged.</> : 'No earlier approved payroll to compare with.'}</span>
        <label className="flex items-center gap-1"><input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} />Show unchanged</label>
      </div>
      {!rows.length ? <Empty>No one is new, has left, or changed by more than the threshold.</Empty> : (
        <table className="data text-sm">
          <thead><tr><th>Name</th><th /><th className="text-right">Previous net</th><th className="text-right">This month</th><th className="text-right">Change</th><th className="text-right">%</th></tr></thead>
          <tbody>{rows.map((r) => <tr key={r.employee_id}><td>{r.employee_name} <span className="muted">{r.staff_number}</span></td><td><Badge value={r.flag} /></td><td className="text-right tabular-nums">{k(r.previous_net)}</td><td className="text-right tabular-nums">{k(r.current_net)}</td><td className="text-right tabular-nums">{k(r.change)}</td><td className="text-right tabular-nums">{r.change_pct ?? ''}</td></tr>)}</tbody>
        </table>
      )}
    </Card>
  );
}

function Journal({ id }: { id: string }) {
  const j = useQuery({ queryKey: ['payroll-journal', id], queryFn: () => unwrap(hr.GET('/api/v1/payroll/runs/{id}/journal', { params: { path: { id } } })) });
  if (!j.data) return <Card><ProblemBanner error={j.error} /><Loading /></Card>;
  return (
    <Card>
      {j.data.unmapped.length > 0 && <p className="mb-2 rounded bg-amber-50 px-2 py-1 text-sm text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">Placeholder accounts in use for {j.data.unmapped.join(', ')}. Set the real account codes under Payroll setup → Accounts once the chart of accounts is updated.</p>}
      <table className="data text-sm">
        <thead><tr><th>Account</th><th>Cost centre</th><th>Description</th><th className="text-right">Debit</th><th className="text-right">Credit</th></tr></thead>
        <tbody>
          {j.data.lines.map((l, i) => <tr key={i}><td className="font-mono text-xs">{l.account}</td><td>{l.cost_centre_code}</td><td>{l.description}</td><td className="text-right tabular-nums">{l.debit !== '0.00' ? k(l.debit) : ''}</td><td className="text-right tabular-nums">{l.credit !== '0.00' ? k(l.credit) : ''}</td></tr>)}
          <tr className="font-semibold"><td colSpan={3}>Total</td><td className="text-right tabular-nums">{k(j.data.total_debit)}</td><td className="text-right tabular-nums">{k(j.data.total_credit)}</td></tr>
        </tbody>
      </table>
    </Card>
  );
}

function Files({ id }: { id: string }) {
  const href = (q: Record<string, string>) => `/api/v1/payroll/runs/${id}/export?${new URLSearchParams(q)}`;
  const files: [string, string, Record<string, string>][] = [
    ['Bank transfer file (Excel)', 'Net pay for everyone paid by bank, in the bank file layout', { file: 'payments', channel: 'bank' }],
    ['M-Pesa bulk file', 'Net pay for everyone paid by M-Pesa', { file: 'payments', channel: 'mobile_money' }],
    [PAYROLL_EXPORTS.p10, 'Employee details for the iTax P10 return', { file: 'p10' }],
    [PAYROLL_EXPORTS.nssf, 'For the NSSF employer portal', { file: 'nssf' }],
    [PAYROLL_EXPORTS.shif, 'For the SHA employer portal', { file: 'shif' }],
    [PAYROLL_EXPORTS.housing_levy, 'For the Housing Levy return on iTax', { file: 'housing_levy' }],
    [PAYROLL_EXPORTS.journal, 'For finance', { file: 'journal' }],
    [PAYROLL_EXPORTS.register, 'Every payslip in one sheet', { file: 'register' }],
  ];
  return (
    <Card>
      <p className="muted mb-3 text-xs">Files with ID numbers, PINs or account numbers are recorded in the audit trail when downloaded. Layouts are editable under Payroll setup.</p>
      <ul className="divide-y divide-[var(--border)]">{files.map(([t, d, q]) => <li key={t} className="flex items-center justify-between py-2 text-sm"><div><div className="font-medium">{t}</div><div className="muted text-xs">{d}</div></div><a className="link" href={href(q)}>Download</a></li>)}</ul>
    </Card>
  );
}
