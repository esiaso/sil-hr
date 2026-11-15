'use client';

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { formatDate, formatMoney } from '@sil/hr-shared';
import { PayslipDialog, periodLabel } from '@/components/payroll';
import { Button, Card, Empty, Loading, PageHeader, ProblemBanner } from '@/components/ui';
import { hr, unwrap } from '@/lib/api';
import { useSession } from '@/lib/session';

export default function MyPayslipsPage() {
  const { me, settings } = useSession();
  const q = useQuery({ queryKey: ['my-payslips'], queryFn: () => unwrap(hr.GET('/api/v1/me/payslips')) });
  const [open, setOpen] = useState<string | null>(null);
  const years = [...new Set((q.data ?? []).map((s) => Number(s.period.slice(0, 4))))];
  if (!me.employee_id) return <div><PageHeader title="My payslips" /><Empty>Your account is not linked to an employee record. Ask HR.</Empty></div>;
  return (
    <div className="max-w-3xl space-y-4">
      <PageHeader title="My payslips" description="Payslips appear here once the month's payroll is approved." />
      <ProblemBanner error={q.error} />
      <Card>
        {!q.data ? <Loading /> : !q.data.length ? <Empty>No payslips yet.</Empty> : (
          <table className="data">
            <thead><tr><th>Month</th><th>Paid on</th><th className="text-right">Gross</th><th className="text-right">Net pay</th><th /></tr></thead>
            <tbody>{q.data.map((s) => (
              <tr key={s.id}>
                <td><button type="button" className="link" onClick={() => setOpen(s.id)}>{periodLabel(s.period)}</button></td>
                <td>{formatDate(s.pay_date, settings.date_format)}</td>
                <td className="text-right tabular-nums">{formatMoney(s.gross)}</td>
                <td className="text-right font-medium tabular-nums">{formatMoney(s.net)}</td>
                <td className="text-right"><a className="link" href={`/api/v1/payroll/payslips/${s.id}/pdf`}>PDF</a></td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </Card>
      {years.length > 0 && (
        <Card>
          <h2 className="mb-1 font-semibold">P9 tax deduction cards</h2>
          <p className="muted mb-2 text-xs">For filing your income tax return on iTax.</p>
          <div className="flex flex-wrap gap-2">{years.map((y) => <a key={y} href={`/api/v1/me/p9?year=${y}`}><Button variant="secondary">P9 {y}</Button></a>)}</div>
        </Card>
      )}
      {open && <PayslipDialog id={open} onClose={() => setOpen(null)} />}
    </div>
  );
}
