'use client';

import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { formatDate, formatMoney, REPORTS, type ReportCode } from '@sil/hr-shared';
import { Button, Card, Empty, Field, Input, Loading, PageHeader, ProblemBanner, Select , buttonClass } from '@/components/ui';
import { ApiError } from '@/lib/api';
import { useSession } from '@/lib/session';

type Row = Record<string, string | number | boolean | null>;
interface Col { key: string; label: string; kind?: 'money' | 'date' | 'bool' }

const COLUMNS: Record<ReportCode, Col[]> = {
  headcount: [{ key: 'group', label: 'Group' }, { key: 'active', label: 'Active' }, { key: 'probation', label: 'Probation' }, { key: 'on_notice', label: 'On notice' }, { key: 'suspended', label: 'Suspended' }, { key: 'female', label: 'Female' }, { key: 'male', label: 'Male' }, { key: 'total', label: 'Total' }],
  turnover: [{ key: 'department', label: 'Department' }, { key: 'opening', label: 'Opening' }, { key: 'joiners', label: 'Joiners' }, { key: 'leavers', label: 'Leavers' }, { key: 'voluntary', label: 'Resigned' }, { key: 'closing', label: 'Closing' }, { key: 'average', label: 'Average' }, { key: 'turnover_pct', label: 'Turnover %' }],
  'leave-liability': [{ key: 'staff_number', label: 'Staff no.' }, { key: 'employee_name', label: 'Name' }, { key: 'department', label: 'Department' }, { key: 'days', label: 'Days' }, { key: 'daily_rate', label: 'Daily rate', kind: 'money' }, { key: 'liability', label: 'Liability', kind: 'money' }],
  'overtime-cost': [{ key: 'period', label: 'Month' }, { key: 'department', label: 'Department' }, { key: 'hours_recorded', label: 'Hours recorded' }, { key: 'hours_paid', label: 'Hours paid' }, { key: 'amount_paid', label: 'Paid', kind: 'money' }],
  'payroll-cost': [{ key: 'period', label: 'Month' }, { key: 'department', label: 'Department' }, { key: 'cost_centre', label: 'Cost centre' }, { key: 'employees', label: 'Staff' }, { key: 'gross', label: 'Gross', kind: 'money' }, { key: 'employer_contributions', label: 'Employer contributions', kind: 'money' }, { key: 'total_cost', label: 'Total cost', kind: 'money' }, { key: 'net', label: 'Net', kind: 'money' }],
  'licence-expiry': [{ key: 'staff_number', label: 'Staff no.' }, { key: 'employee_name', label: 'Name' }, { key: 'department', label: 'Department' }, { key: 'licensing_body', label: 'Body' }, { key: 'licence_number', label: 'Licence' }, { key: 'expiry_date', label: 'Expires', kind: 'date' }, { key: 'days_left', label: 'Days left' }, { key: 'verified', label: 'Verified', kind: 'bool' }],
  'contract-expiry': [{ key: 'staff_number', label: 'Staff no.' }, { key: 'employee_name', label: 'Name' }, { key: 'department', label: 'Department' }, { key: 'contract_number', label: 'Contract' }, { key: 'contract_type', label: 'Type' }, { key: 'end_date', label: 'Ends', kind: 'date' }, { key: 'days_left', label: 'Days left' }],
};
const SUMMED = new Set(['active', 'probation', 'on_notice', 'suspended', 'female', 'male', 'total', 'days', 'liability', 'hours_recorded', 'hours_paid', 'amount_paid', 'employees', 'gross', 'employer_contributions', 'total_cost', 'net']);

export default function ReportsPage() {
  return <Suspense fallback={<Loading />}><Reports /></Suspense>;
}

function Reports() {
  const { settings } = useSession();
  const sp = useSearchParams();
  const now = new Date();
  const y = now.getFullYear();
  const ym = now.toISOString().slice(0, 7);
  const [code, setCode] = useState<ReportCode>((sp.get('r') as ReportCode) in REPORTS ? (sp.get('r') as ReportCode) : 'headcount');
  const [p, setP] = useState({ as_at: '', group_by: 'department', from: `${y}-01-01`, to: now.toISOString().slice(0, 10), from_m: `${y}-01`, to_m: ym, within_days: '90', include_expired: 'true' });
  const params = (): Record<string, string> => {
    switch (code) {
      case 'headcount': return { group_by: p.group_by, ...(p.as_at ? { as_at: p.as_at } : {}) };
      case 'turnover': return { from: p.from, to: p.to };
      case 'leave-liability': return p.as_at ? { as_at: p.as_at } : {};
      case 'overtime-cost': case 'payroll-cost': return { from: p.from_m, to: p.to_m };
      default: return { within_days: p.within_days, include_expired: p.include_expired };
    }
  };
  const qs = new URLSearchParams(params()).toString();
  const q = useQuery({
    queryKey: ['report', code, qs],
    queryFn: async () => {
      const res = await fetch(`/api/v1/reports/${code}?${qs}`, { cache: 'no-store' });
      const json = await res.json();
      if (!res.ok) throw new ApiError(res.status, json);
      return json as Row[];
    },
  });
  const cols = COLUMNS[code];
  const show = (c: Col, v: Row[string]) => (v === null || v === undefined ? '–' : c.kind === 'money' ? formatMoney(String(v)) : c.kind === 'date' ? formatDate(String(v), settings.date_format) : c.kind === 'bool' ? (v ? 'Yes' : 'No') : String(v));
  const sums = code !== 'turnover' && q.data && q.data.length > 1 ? Object.fromEntries(cols.filter((c) => SUMMED.has(c.key)).map((c) => [c.key, q.data!.reduce((s, r) => s + Number(r[c.key] ?? 0), 0)])) : null;
  const field = (k: keyof typeof p, l: string, type = 'text') => <Field label={l} htmlFor={`rp-${k}`}><Input id={`rp-${k}`} type={type} value={p[k]} onChange={(e) => setP({ ...p, [k]: e.target.value })} /></Field>;
  return (
    <div className="space-y-4">
      <PageHeader title="Reports" description="Figures for the staff in your area. Every report downloads as CSV or Excel; downloads are recorded in the audit trail." />
      <Card>
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Report" htmlFor="rp-code"><Select id="rp-code" value={code} onChange={(e) => setCode(e.target.value as ReportCode)}>{Object.entries(REPORTS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select></Field>
          {code === 'headcount' && <><Field label="Group by" htmlFor="rp-g"><Select id="rp-g" value={p.group_by} onChange={(e) => setP({ ...p, group_by: e.target.value })}><option value="department">Department</option><option value="branch">Branch</option><option value="employment_type">Employment type</option><option value="grade">Grade</option><option value="gender">Gender</option></Select></Field>{field('as_at', 'As at', 'date')}</>}
          {code === 'leave-liability' && field('as_at', 'As at', 'date')}
          {code === 'turnover' && <>{field('from', 'From', 'date')}{field('to', 'To', 'date')}</>}
          {(code === 'overtime-cost' || code === 'payroll-cost') && <>{field('from_m', 'From month', 'month')}{field('to_m', 'To month', 'month')}</>}
          {(code === 'licence-expiry' || code === 'contract-expiry') && <>{field('within_days', 'Within days', 'number')}<label className="flex items-center gap-2 pb-2 text-sm"><input type="checkbox" checked={p.include_expired === 'true'} onChange={(e) => setP({ ...p, include_expired: String(e.target.checked) })} /> Include already expired</label></>}
          <div className="ml-auto flex gap-2 pb-0.5"><a className={buttonClass('secondary')} href={`/api/v1/reports/${code}?${qs}&format=csv`}>CSV</a><a className={buttonClass('secondary')} href={`/api/v1/reports/${code}?${qs}&format=xlsx`}>Excel</a><Button variant="ghost" onClick={() => void q.refetch()}>Refresh</Button></div>
        </div>
      </Card>
      <ProblemBanner error={q.error} />
      <Card>
        {q.isLoading ? <Loading /> : !q.data?.length ? <Empty>Nothing to show.</Empty> : (
          <div className="overflow-x-auto">
            <table className="data">
              <thead><tr>{cols.map((c) => <th key={c.key} className={SUMMED.has(c.key) || c.kind === 'money' ? 'text-right' : ''}>{c.label}</th>)}</tr></thead>
              <tbody>{q.data.map((r, i) => <tr key={i} className={r.department === 'All' ? 'font-semibold' : ''}>{cols.map((c) => <td key={c.key} className={SUMMED.has(c.key) || c.kind === 'money' ? 'text-right tabular-nums' : ''}>{show(c, r[c.key])}</td>)}</tr>)}</tbody>
              {sums && <tfoot><tr className="font-semibold">{cols.map((c, i) => <td key={c.key} className={SUMMED.has(c.key) || c.kind === 'money' ? 'text-right tabular-nums' : ''}>{i === 0 ? 'Total' : c.key in sums ? (c.kind === 'money' ? formatMoney(sums[c.key].toFixed(2)) : Math.round(sums[c.key] * 10) / 10) : ''}</td>)}</tr></tfoot>}
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
