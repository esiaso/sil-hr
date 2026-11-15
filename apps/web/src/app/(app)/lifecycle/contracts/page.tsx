'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { CONTRACT_TYPES, formatDate, formatMoney, type Contract } from '@sil/hr-shared';
import { EmployeePicker } from '@/components/employee-picker';
import { Badge, Button, Card, Dialog, Empty, Field, Input, Loading, PageHeader, ProblemBanner, Select, Textarea } from '@/components/ui';
import { ApiError, hr, unwrap } from '@/lib/api';
import { useSession } from '@/lib/session';

type CType = keyof typeof CONTRACT_TYPES;

export default function ContractsPage() {
  const { can, settings } = useSession();
  const [expiring, setExpiring] = useState<number | ''>(60);
  const [dialog, setDialog] = useState<'new' | Contract | null>(null);
  const q = useQuery({ queryKey: ['contracts', expiring], queryFn: () => unwrap(hr.GET('/api/v1/contracts', { params: { query: { expiring_within_days: expiring === '' ? undefined : expiring, status: expiring === '' ? undefined : 'active' } } })) });
  return (
    <div className="space-y-4">
      <PageHeader title="Contracts" description="Employment contracts and their end dates. HR is reminded before a fixed-term contract ends (Settings, contracts.reminder_days); renewals go through approval." actions={can('contract:manage') && <Button onClick={() => setDialog('new')}>New contract</Button>} />
      <Select aria-label="Show" value={expiring} onChange={(e) => setExpiring(e.target.value === '' ? '' : Number(e.target.value))} className="max-w-60"><option value={30}>Ending within 30 days</option><option value={60}>Ending within 60 days</option><option value={180}>Ending within 6 months</option><option value="">All contracts</option></Select>
      <ProblemBanner error={q.error} />
      <Card>
        {!q.data ? <Loading /> : !q.data.length ? <Empty>No contracts here.</Empty> : (
          <table className="data">
            <thead><tr><th>Number</th><th>Employee</th><th>Type</th><th>Position</th><th>From</th><th>To</th><th>Notice</th><th>Status</th><th /></tr></thead>
            <tbody>{q.data.map((c) => (
              <tr key={c.id}>
                <td className="font-mono text-xs">{c.number}</td><td>{c.employee_name} <span className="muted text-xs">{c.staff_number}</span></td><td>{CONTRACT_TYPES[c.contract_type]}</td><td>{c.position_title}</td>
                <td>{formatDate(c.start_date, settings.date_format)}</td><td>{c.end_date ? formatDate(c.end_date, settings.date_format) : ''}{c.days_left !== null && c.days_left <= 60 && <span className={`ml-1 text-xs ${c.days_left < 30 ? 'text-red-600' : 'text-amber-600'}`}>{c.days_left} days</span>}</td>
                <td>{c.notice_days} days</td><td><Badge value={c.status} /></td>
                <td className="text-right">{c.status === 'active' && can('lifecycle:request') && <Button variant="ghost" onClick={() => setDialog(c)}>Renew</Button>}</td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </Card>
      {dialog === 'new' && <NewContract onClose={() => setDialog(null)} />}
      {dialog && dialog !== 'new' && <Renew c={dialog} onClose={() => setDialog(null)} />}
    </div>
  );
}

function NewContract({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [emp, setEmp] = useState<{ id: string; name: string } | null>(null);
  const [v, setV] = useState({ contract_type: 'fixed_term' as CType, start_date: '', end_date: '', probation_months: '6', notice_days: '30', basic: '', terms: '' });
  const save = useMutation({ mutationFn: () => unwrap(hr.POST('/api/v1/contracts', { body: { employee_id: emp?.id ?? '', contract_type: v.contract_type, start_date: v.start_date, end_date: v.end_date || null, probation_months: v.probation_months ? Number(v.probation_months) : null, notice_days: Number(v.notice_days), basic: v.basic ? Number(v.basic).toFixed(2) : null, terms: v.terms || null } })), onSuccess: () => { void qc.invalidateQueries({ queryKey: ['contracts'] }); onClose(); } });
  const fe = save.error instanceof ApiError ? save.error.fieldErrors : {};
  return (
    <Dialog open wide title="New contract" onClose={onClose}>
      <ProblemBanner error={save.error} />
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="sm:col-span-2"><Field label="Employee" htmlFor="ct-e" error={fe.employee_id}><EmployeePicker id="ct-e" value={emp} onChange={setEmp} /></Field></div>
        <Field label="Type" htmlFor="ct-t"><Select id="ct-t" value={v.contract_type} onChange={(e) => setV({ ...v, contract_type: e.target.value as CType })}>{Object.entries(CONTRACT_TYPES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select></Field>
        <Field label="From" htmlFor="ct-s" error={fe.start_date}><Input id="ct-s" type="date" value={v.start_date} onChange={(e) => setV({ ...v, start_date: e.target.value })} /></Field>
        <Field label="To" htmlFor="ct-en" error={fe.end_date}><Input id="ct-en" type="date" value={v.end_date} onChange={(e) => setV({ ...v, end_date: e.target.value })} /></Field>
        <Field label="Notice (days)" htmlFor="ct-n"><Input id="ct-n" type="number" value={v.notice_days} onChange={(e) => setV({ ...v, notice_days: e.target.value })} /></Field>
        <Field label="Probation (months)" htmlFor="ct-p"><Input id="ct-p" type="number" value={v.probation_months} onChange={(e) => setV({ ...v, probation_months: e.target.value })} /></Field>
        <Field label="Basic salary (for the letter)" htmlFor="ct-b"><Input id="ct-b" type="number" value={v.basic} onChange={(e) => setV({ ...v, basic: e.target.value })} /></Field>
      </div>
      <Field label="Special terms (optional)" htmlFor="ct-terms"><Textarea id="ct-terms" value={v.terms} onChange={(e) => setV({ ...v, terms: e.target.value })} /></Field>
      <p className="muted mt-2 text-xs">The contract in force ends the day before this one starts. Pay itself is set under Payroll → Pay and loans.</p>
      <div className="mt-4 flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button busy={save.isPending} disabled={!emp} onClick={() => save.mutate()}>Save</Button></div>
    </Dialog>
  );
}

function Renew({ c, onClose }: { c: Contract; onClose: () => void }) {
  const qc = useQueryClient();
  const next = c.end_date ? new Date(Date.parse(`${c.end_date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10) : '';
  const [v, setV] = useState({ effective_date: next, end_date: '', contract_type: c.contract_type as CType, new_basic: '', reason: '' });
  const save = useMutation({ mutationFn: () => unwrap(hr.POST('/api/v1/lifecycle-requests', { body: { kind: 'contract_renewal', employee_id: c.employee_id, effective_date: v.effective_date, end_date: v.end_date || null, contract_type: v.contract_type, new_basic: v.new_basic ? Number(v.new_basic).toFixed(2) : null, reason: v.reason } })), onSuccess: () => { void qc.invalidateQueries({ queryKey: ['contracts'] }); onClose(); } });
  const fe = save.error instanceof ApiError ? save.error.fieldErrors : {};
  return (
    <Dialog open title={`Renew ${c.employee_name}'s contract`} onClose={onClose}>
      <ProblemBanner error={save.error} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="New contract from" htmlFor="rn-f"><Input id="rn-f" type="date" value={v.effective_date} onChange={(e) => setV({ ...v, effective_date: e.target.value })} /></Field>
        <Field label="To" htmlFor="rn-t"><Input id="rn-t" type="date" value={v.end_date} onChange={(e) => setV({ ...v, end_date: e.target.value })} /></Field>
        <Field label="Type" htmlFor="rn-ty"><Select id="rn-ty" value={v.contract_type} onChange={(e) => setV({ ...v, contract_type: e.target.value as CType })}>{Object.entries(CONTRACT_TYPES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select></Field>
        <Field label="New basic salary (optional)" htmlFor="rn-b"><Input id="rn-b" type="number" value={v.new_basic} onChange={(e) => setV({ ...v, new_basic: e.target.value })} /></Field>
      </div>
      <Field label="Why" htmlFor="rn-r" error={fe.reason}><Textarea id="rn-r" value={v.reason} onChange={(e) => setV({ ...v, reason: e.target.value })} /></Field>
      {c.basic && <p className="muted mt-2 text-xs">Current contract basic: {formatMoney(c.basic)}</p>}
      <div className="mt-4 flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button busy={save.isPending} onClick={() => save.mutate()}>Send for approval</Button></div>
    </Dialog>
  );
}
