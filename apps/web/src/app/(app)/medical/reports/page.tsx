'use client';

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { formatMoney } from '@sil/hr-shared';
import { Card, Empty, Input, Loading, PageHeader, ProblemBanner, Select } from '@/components/ui';
import { hr, unwrap } from '@/lib/api';

const k = (x: string) => formatMoney(x, '');

export default function MedicalReportsPage() {
  const year = new Date().getFullYear();
  const [tab, setTab] = useState<'utilisation' | 'near_limit' | 'facilities' | 'funding'>('utilisation');
  const [from, setFrom] = useState(`${year}-01-01`);
  const [to, setTo] = useState(new Date().toISOString().slice(0, 10));
  const [threshold, setThreshold] = useState(80);
  const util = useQuery({ queryKey: ['med-util'], enabled: tab === 'utilisation', queryFn: () => unwrap(hr.GET('/api/v1/medical/reports/utilisation', { params: { query: {} as never } })) });
  const near = useQuery({ queryKey: ['med-near', threshold], enabled: tab === 'near_limit', queryFn: () => unwrap(hr.GET('/api/v1/medical/reports/near-limit', { params: { query: { threshold } } })) });
  const fac = useQuery({ queryKey: ['med-fac', from, to], enabled: tab === 'facilities', queryFn: () => unwrap(hr.GET('/api/v1/medical/reports/facilities', { params: { query: { from, to } } })) });
  const fund = useQuery({ queryKey: ['med-fund', from, to], enabled: tab === 'funding', queryFn: () => unwrap(hr.GET('/api/v1/medical/reports/funding', { params: { query: { from: from.slice(0, 7), to: to.slice(0, 7) } } })) });
  const exportHref = `/api/v1/medical/reports/export?${new URLSearchParams({ report: tab, from, to })}`;
  return (
    <div className="space-y-4">
      <PageHeader title="Medical scheme reports" description="Utilisation of limits this scheme year, members near their limit, claims by facility, and what the hospital and staff paid each month." actions={<a href={exportHref} className="inline-flex items-center rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3.5 py-2 text-sm font-medium shadow-sm hover:bg-[var(--hover)]">Export to Excel</a>} />
      <div className="flex flex-wrap gap-1 border-b border-[var(--border)]">
        {([['utilisation', 'Utilisation'], ['near_limit', 'Near the limit'], ['facilities', 'By facility'], ['funding', 'Hospital and staff share']] as const).map(([t, l]) => <button key={t} type="button" onClick={() => setTab(t)} className={`-mb-px border-b-2 px-3 py-2 text-sm ${tab === t ? 'border-[var(--accent)] font-medium' : 'border-transparent muted'}`}>{l}</button>)}
      </div>
      {(tab === 'facilities' || tab === 'funding') && <div className="flex flex-wrap gap-2"><Input aria-label="From" type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="max-w-44" /><Input aria-label="To" type="date" value={to} onChange={(e) => setTo(e.target.value)} className="max-w-44" /></div>}
      {tab === 'near_limit' && <Select aria-label="Threshold" value={threshold} onChange={(e) => setThreshold(Number(e.target.value))} className="max-w-44"><option value={80}>80% or more</option><option value={100}>Used up</option><option value={50}>50% or more</option></Select>}
      <ProblemBanner error={util.error ?? near.error ?? fac.error ?? fund.error} />
      <Card>
        {tab === 'utilisation' && (!util.data ? <Loading /> : !util.data.length ? <Empty>No members yet.</Empty> : (
          <table className="data"><thead><tr><th>Scheme</th><th>Cover</th><th>Department</th><th className="text-right">Limits</th><th className="text-right">Total limit</th><th className="text-right">Used</th><th className="text-right">Held</th><th className="text-right">%</th></tr></thead>
            <tbody>{util.data.map((r, i) => <tr key={i}><td>{r.scheme}</td><td>{r.category}</td><td>{r.department}</td><td className="text-right">{r.members}</td><td className="text-right tabular-nums">{k(r.limit)}</td><td className="text-right tabular-nums">{k(r.used)}</td><td className="text-right tabular-nums">{k(r.held)}</td><td className="text-right tabular-nums">{r.utilisation_pct}</td></tr>)}</tbody></table>
        ))}
        {tab === 'near_limit' && (!near.data ? <Loading /> : !near.data.length ? <Empty>No one is near their limit.</Empty> : (
          <table className="data"><thead><tr><th>Member</th><th>Staff</th><th>Department</th><th>Cover</th><th className="text-right">Limit</th><th className="text-right">Left</th><th className="text-right">%</th></tr></thead>
            <tbody>{near.data.map((r, i) => <tr key={i}><td>{r.name} <span className="muted font-mono text-xs">{r.member_number}</span></td><td>{r.staff_number}</td><td>{r.department}</td><td>{r.category}</td><td className="text-right tabular-nums">{k(r.limit)}</td><td className="text-right tabular-nums">{k(r.remaining)}</td><td className="text-right tabular-nums">{r.utilisation_pct}</td></tr>)}</tbody></table>
        ))}
        {tab === 'facilities' && (!fac.data ? <Loading /> : !fac.data.length ? <Empty>No claims in these dates.</Empty> : (
          <table className="data"><thead><tr><th>Facility</th><th className="text-right">Claims</th><th className="text-right">Invoiced</th><th className="text-right">Paid by the scheme</th><th className="text-right">Paid by members</th></tr></thead>
            <tbody>{fac.data.map((r) => <tr key={r.facility}><td>{r.facility}</td><td className="text-right">{r.claims}</td><td className="text-right tabular-nums">{k(r.invoiced)}</td><td className="text-right tabular-nums">{k(r.scheme_paid)}</td><td className="text-right tabular-nums">{k(r.member_paid)}</td></tr>)}</tbody></table>
        ))}
        {tab === 'funding' && (!fund.data ? <Loading /> : !fund.data.length ? <Empty>Nothing in these months.</Empty> : (
          <table className="data"><thead><tr><th>Month</th><th className="text-right">Claims</th><th className="text-right">Hospital share</th><th className="text-right">Staff contributions</th></tr></thead>
            <tbody>{fund.data.map((r) => <tr key={r.period}><td>{r.period}</td><td className="text-right">{r.claims}</td><td className="text-right tabular-nums">{k(r.hospital_share)}</td><td className="text-right tabular-nums">{k(r.staff_contributions)}</td></tr>)}</tbody></table>
        ))}
      </Card>
    </div>
  );
}
