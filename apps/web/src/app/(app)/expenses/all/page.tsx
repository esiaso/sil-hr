'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { formatDate, formatMoney } from '@sil/hr-shared';
import { Badge, Card, Empty, Loading, PageHeader, ProblemBanner, Select } from '@/components/ui';
import { hr, unwrap } from '@/lib/api';
import { useSession } from '@/lib/session';

export default function AllExpensesPage() {
  const { settings } = useSession();
  const [status, setStatus] = useState('pending');
  const claims = useQuery({ queryKey: ['all-claims', status], queryFn: () => unwrap(hr.GET('/api/v1/expense-claims', { params: { query: { status: status || undefined } } })) });
  const trips = useQuery({ queryKey: ['all-trips', status], queryFn: () => unwrap(hr.GET('/api/v1/travel-requests', { params: { query: { status: status || undefined } } })) });
  return (
    <div className="space-y-4">
      <PageHeader title="Travel and expense claims" description="Trips and claims of staff in your area. Approve them from Approvals." actions={<Select aria-label="Status" className="w-auto" value={status} onChange={(e) => setStatus(e.target.value)}><option value="">All</option><option value="pending">Waiting for approval</option><option value="approved">Approved</option><option value="returned">Returned</option><option value="rejected">Rejected</option></Select>} />
      <ProblemBanner error={claims.error ?? trips.error} />
      <Card>
        <h2 className="mb-2 font-semibold">Expense claims</h2>
        {!claims.data ? <Loading /> : !claims.data.length ? <Empty>None.</Empty> : (
          <table className="data">
            <thead><tr><th>Claim</th><th>Who</th><th>Items</th><th>Total</th><th>Net to pay</th><th>Status</th></tr></thead>
            <tbody>{claims.data.map((c) => <tr key={c.id}><td><Link className="link" href={`/expenses/claims/${c.id}`}>{c.title}</Link><div className="muted text-xs">{c.number}</div></td><td>{c.employee_name}<div className="muted text-xs">{c.department_name}</div></td><td>{c.items.length}</td><td>{formatMoney(c.total)}</td><td>{formatMoney(c.net)}</td><td><Badge value={c.status} />{c.paid_period && <div className="muted text-xs">{c.paid_period}</div>}</td></tr>)}</tbody>
          </table>
        )}
      </Card>
      <Card>
        <h2 className="mb-2 font-semibold">Trips</h2>
        {!trips.data ? <Loading /> : !trips.data.length ? <Empty>None.</Empty> : (
          <table className="data">
            <thead><tr><th>Trip</th><th>Who</th><th>Dates</th><th>Estimate</th><th>Advance</th><th>Status</th></tr></thead>
            <tbody>{trips.data.map((t) => <tr key={t.id}><td>{t.destination}<div className="muted text-xs">{t.number} · {t.purpose}</div></td><td>{t.employee_name}</td><td className="whitespace-nowrap">{formatDate(t.depart_on, settings.date_format)} – {formatDate(t.return_on, settings.date_format)}</td><td>{formatMoney(t.estimated_cost)}</td><td>{Number(t.advance) ? formatMoney(t.advance) : '–'}</td><td><Badge value={t.status} /></td></tr>)}</tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
