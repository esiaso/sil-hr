'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { formatDate, formatMoney } from '@sil/hr-shared';
import { Badge, Button, Card, Dialog, Empty, Field, Input, Loading, PageHeader, ProblemBanner } from '@/components/ui';
import { ApiError, hr, unwrap } from '@/lib/api';
import { periodLabel } from '@/components/payroll';
import { useSession } from '@/lib/session';


export default function PayrollRunsPage() {
  const { can, settings } = useSession();
  const runs = useQuery({ queryKey: ['payroll-runs'], queryFn: () => unwrap(hr.GET('/api/v1/payroll/runs')) });
  const [creating, setCreating] = useState(false);
  return (
    <div>
      <PageHeader title="Payroll" description="One run per month. Calculate as often as needed; submitting sends it for approval (HR manager, then finance), which locks it." actions={can('payroll:prepare') && <Button onClick={() => setCreating(true)}>New payroll</Button>} />
      <ProblemBanner error={runs.error} />
      <Card>
        {!runs.data ? <Loading /> : !runs.data.length ? <Empty>No payrolls yet.</Empty> : (
          <table className="data">
            <thead><tr><th>Month</th><th>Status</th><th>Staff</th><th className="text-right">Gross</th><th className="text-right">Net</th><th className="text-right">PAYE</th><th>Pay date</th><th>Warnings</th></tr></thead>
            <tbody>{runs.data.map((r) => (
              <tr key={r.id}>
                <td><Link className="link" href={`/payroll/runs/${r.id}`}>{periodLabel(r.period)}</Link></td>
                <td><Badge value={r.status} /></td>
                <td>{r.employees || ''}</td>
                <td className="text-right tabular-nums">{r.calculated_at ? formatMoney(r.gross, '') : ''}</td>
                <td className="text-right tabular-nums">{r.calculated_at ? formatMoney(r.net, '') : ''}</td>
                <td className="text-right tabular-nums">{r.calculated_at ? formatMoney(r.paye, '') : ''}</td>
                <td>{formatDate(r.pay_date, settings.date_format)}</td>
                <td>{r.warnings.length || ''}</td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </Card>
      {creating && <NewRun onClose={() => setCreating(false)} />}
    </div>
  );
}

function NewRun({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const router = useRouter();
  const now = new Date();
  const [v, setV] = useState({ period: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`, pay_date: '' });
  const save = useMutation({
    mutationFn: () => unwrap(hr.POST('/api/v1/payroll/runs', { body: { period: v.period, ...(v.pay_date ? { pay_date: v.pay_date } : {}) } })),
    onSuccess: (r) => { void qc.invalidateQueries({ queryKey: ['payroll-runs'] }); router.push(`/payroll/runs/${r.id}`); },
  });
  const fe = save.error instanceof ApiError ? save.error.fieldErrors : {};
  return (
    <Dialog open title="New payroll" onClose={onClose}>
      <ProblemBanner error={save.error} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Month" htmlFor="pr-period" error={fe.period}><Input id="pr-period" type="month" value={v.period} onChange={(e) => setV({ ...v, period: e.target.value })} /></Field>
        <Field label="Pay date" htmlFor="pr-pay" hint="Empty: the pay day setting (last working day)"><Input id="pr-pay" type="date" value={v.pay_date} onChange={(e) => setV({ ...v, pay_date: e.target.value })} /></Field>
      </div>
      <div className="mt-4 flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button busy={save.isPending} onClick={() => save.mutate()}>Create</Button></div>
    </Dialog>
  );
}
