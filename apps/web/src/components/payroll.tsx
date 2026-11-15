'use client';

import { useQuery } from '@tanstack/react-query';
import { formatMoney, type Payslip } from '@sil/hr-shared';
import { Dialog, Loading, ProblemBanner } from '@/components/ui';
import { hr, unwrap } from '@/lib/api';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const periodLabel = (p: string) => `${MONTHS[Number(p.slice(5)) - 1]} ${p.slice(0, 4)}`;
const k = (x: string | null | undefined) => formatMoney(x, '');

/** One payslip with its lines; payroll staff and the employee (once approved) can open it. */
export function PayslipDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const q = useQuery({ queryKey: ['payslip', id], queryFn: () => unwrap(hr.GET('/api/v1/payroll/payslips/{id}', { params: { path: { id } } })) });
  const s = q.data as Payslip | undefined;
  return (
    <Dialog open wide title={s ? `${s.employee_name} · ${periodLabel(s.period)}` : 'Payslip'} onClose={onClose}>
      <ProblemBanner error={q.error} />
      {!s ? <Loading /> : (
        <div className="space-y-3 text-sm">
          <div className="muted">{s.staff_number} · {s.department_name}{s.number ? ` · ${s.number}` : ''}</div>
          {s.warnings.length > 0 && <ul className="rounded bg-amber-50 px-3 py-2 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">{s.warnings.map((w) => <li key={w}>{w}</li>)}</ul>}
          {(['earning', 'benefit', 'deduction', 'employer_contribution'] as const).map((kind) => {
            const ls = (s.lines ?? []).filter((l) => l.kind === kind);
            if (!ls.length) return null;
            return (
              <div key={kind}>
                <div className="font-medium">{{ earning: 'Earnings', benefit: 'Non-cash benefits (taxed, not paid)', deduction: 'Deductions', employer_contribution: 'Paid by the hospital' }[kind]}</div>
                <table className="w-full"><tbody>{ls.map((l, i) => <tr key={i} className="border-b border-[var(--border)]"><td className="py-0.5">{l.name}{l.detail && <span className="muted text-xs"> ({l.detail})</span>}</td><td className="text-right tabular-nums">{k(l.amount)}</td></tr>)}</tbody></table>
              </div>
            );
          })}
          <div className="flex justify-between rounded bg-[var(--surface-2,transparent)] py-1 text-base font-semibold"><span>Net pay</span><span className="tabular-nums">{formatMoney(s.net)}</span></div>
          <p className="muted text-xs">Taxable pay {k(s.taxable_pay)} after {k(String(s.tax.allowable))} allowable; tax {k(String(s.tax.tax_before_relief))} less relief {k(String(s.tax.personal_relief + s.tax.insurance_relief))}.</p>
          <div className="flex justify-end"><a className="link" href={`/api/v1/payroll/payslips/${s.id}/pdf`}>Download PDF</a></div>
        </div>
      )}
    </Dialog>
  );
}
