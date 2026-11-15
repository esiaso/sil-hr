'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { formatDate, formatMoney, type PayComponent } from '@sil/hr-shared';
import { periodLabel } from '@/components/payroll';
import { Badge, Button, Card, Dialog, Empty, Field, Input, Loading, PageHeader, ProblemBanner, Select } from '@/components/ui';
import { ApiError, hr, unwrap } from '@/lib/api';
import { useSession } from '@/lib/session';

const thisMonth = () => new Date().toISOString().slice(0, 7);

export default function PayPeoplePage() {
  return <Suspense fallback={<Loading />}><PayPeople /></Suspense>;
}

function PayPeople() {
  const params = useSearchParams();
  const router = useRouter();
  const employeeId = params.get('employee');
  const [search, setSearch] = useState('');
  const found = useQuery({ queryKey: ['pay-search', search], enabled: search.length >= 2, queryFn: () => unwrap(hr.GET('/api/v1/employees', { params: { query: { limit: 20, search } } })) });
  const loans = useQuery({ queryKey: ['loans-active'], enabled: !employeeId, queryFn: () => unwrap(hr.GET('/api/v1/payroll/loans', { params: { query: { status: 'active' } } })) });
  return (
    <div className="space-y-4">
      <PageHeader title="Pay and loans" description="Each person's basic salary (dated), allowances and deductions, loans and one-off items such as arrears or a bonus." />
      <div className="relative max-w-md">
        <Input aria-label="Find a person" placeholder="Find a person by name or staff number" value={search} onChange={(e) => setSearch(e.target.value)} />
        {search.length >= 2 && found.data && (
          <ul className="surface absolute z-10 mt-1 max-h-72 w-full overflow-y-auto rounded border border-[var(--border)] text-sm shadow">
            {found.data.data.map((e) => <li key={e.id}><button type="button" className="w-full px-3 py-1.5 text-left hover:bg-[var(--hover,rgba(0,0,0,.05))]" onClick={() => { setSearch(''); router.push(`/payroll/people?employee=${e.id}`); }}>{e.first_name} {e.last_name} <span className="muted">{e.staff_number}</span></button></li>)}
          </ul>
        )}
      </div>
      {employeeId ? <Person id={employeeId} /> : (
        <Card>
          <h2 className="mb-2 font-semibold">Loans being repaid</h2>
          {!loans.data ? <Loading /> : !loans.data.length ? <Empty>No active loans.</Empty> : (
            <table className="data text-sm"><thead><tr><th>Person</th><th>Loan</th><th className="text-right">Amount</th><th className="text-right">Monthly</th><th className="text-right">Left</th><th>From</th></tr></thead>
              <tbody>{loans.data.map((l) => <tr key={l.id} className="cursor-pointer" onClick={() => router.push(`/payroll/people?employee=${l.employee_id}`)}><td>{l.employee_name}</td><td>{l.component_name}{l.reference ? ` (${l.reference})` : ''}</td><td className="text-right tabular-nums">{formatMoney(l.principal, '')}</td><td className="text-right tabular-nums">{formatMoney(l.installment, '')}</td><td className="text-right tabular-nums">{formatMoney(l.balance, '')}</td><td>{periodLabel(l.start_period)}</td></tr>)}</tbody>
            </table>
          )}
        </Card>
      )}
    </div>
  );
}

function Person({ id }: { id: string }) {
  const { can, settings } = useSession();
  const qc = useQueryClient();
  const emp = useQuery({ queryKey: ['employee', id], queryFn: () => unwrap(hr.GET('/api/v1/employees/{id}', { params: { path: { id } } })) });
  const pay = useQuery({ queryKey: ['pay', id], queryFn: () => unwrap(hr.GET('/api/v1/employees/{id}/pay', { params: { path: { id } } })) });
  const comps = useQuery({ queryKey: ['pay-components'], queryFn: () => unwrap(hr.GET('/api/v1/payroll/components')) });
  const [dialog, setDialog] = useState<null | 'salary' | 'item' | 'loan' | 'oneoff'>(null);
  const refresh = () => void qc.invalidateQueries({ queryKey: ['pay', id] });
  const removeItem = useMutation({ mutationFn: (itemId: string) => unwrap(hr.DELETE('/api/v1/employees/{id}/pay-items/{itemId}', { params: { path: { id, itemId } } })), onSuccess: refresh });
  const removeOneOff = useMutation({ mutationFn: (oid: string) => unwrap(hr.DELETE('/api/v1/payroll/one-offs/{id}', { params: { path: { id: oid } } })), onSuccess: refresh });
  const manage = can('salary:manage');
  if (!pay.data || !emp.data) return <Card><ProblemBanner error={pay.error ?? emp.error} /><Loading /></Card>;
  const p = pay.data;
  const current = p.salaries.find((s) => !s.effective_to) ?? p.salaries[0];
  const d = (x: string | null) => (x ? formatDate(x, settings.date_format) : '');
  return (
    <div className="space-y-4">
      <ProblemBanner error={removeItem.error ?? removeOneOff.error} />
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div><div className="text-lg font-semibold">{emp.data.first_name} {emp.data.last_name}</div><div className="muted text-sm">{emp.data.staff_number} · hired {d(emp.data.hire_date)}</div></div>
          <div className="text-right"><div className="muted text-xs">Basic salary</div><div className="text-xl font-semibold tabular-nums">{current ? formatMoney(current.basic) : 'Not set'}</div>{manage && <Button variant="secondary" onClick={() => setDialog('salary')}>Change salary</Button>}</div>
        </div>
        {p.salaries.length > 0 && <table className="data mt-3 text-sm"><thead><tr><th>From</th><th>To</th><th className="text-right">Basic</th><th>Reason</th></tr></thead><tbody>{p.salaries.map((s) => <tr key={s.id}><td>{d(s.effective_from)}</td><td>{d(s.effective_to)}</td><td className="text-right tabular-nums">{formatMoney(s.basic, '')}</td><td className="muted">{s.reason}</td></tr>)}</tbody></table>}
      </Card>
      <Card>
        <div className="mb-2 flex items-center justify-between"><h2 className="font-semibold">Allowances and deductions</h2>{manage && <Button variant="secondary" onClick={() => setDialog('item')}>Add</Button>}</div>
        {!p.items.length ? <Empty>None.</Empty> : <table className="data text-sm"><thead><tr><th>Item</th><th>Kind</th><th className="text-right">Amount</th><th>From</th><th>To</th><th /></tr></thead>
          <tbody>{p.items.map((i) => <tr key={i.id}><td>{i.component_name}</td><td><Badge value={i.kind} /></td><td className="text-right tabular-nums">{i.formula ?? (i.value === null ? 'default' : i.method === 'fixed' ? formatMoney(i.value.toFixed(2), '') : `${i.value}%`)}</td><td>{d(i.effective_from)}</td><td>{d(i.effective_to)}</td><td>{manage && <Button variant="ghost" onClick={() => removeItem.mutate(i.id)}>Remove</Button>}</td></tr>)}</tbody></table>}
      </Card>
      <Card>
        <div className="mb-2 flex items-center justify-between"><h2 className="font-semibold">Loans and advances</h2>{manage && <Button variant="secondary" onClick={() => setDialog('loan')}>New loan</Button>}</div>
        {!p.loans.length ? <Empty>None.</Empty> : <table className="data text-sm"><thead><tr><th>Loan</th><th className="text-right">Amount</th><th className="text-right">Monthly</th><th className="text-right">Repaid</th><th className="text-right">Left</th><th>From</th><th /></tr></thead>
          <tbody>{p.loans.map((l) => <tr key={l.id}><td>{l.component_name}{l.reference ? ` (${l.reference})` : ''}</td><td className="text-right tabular-nums">{formatMoney(l.principal, '')}</td><td className="text-right tabular-nums">{formatMoney(l.installment, '')}</td><td className="text-right tabular-nums">{formatMoney(l.repaid, '')}</td><td className="text-right tabular-nums">{formatMoney(l.balance, '')}</td><td>{periodLabel(l.start_period)}</td><td><Badge value={l.status} /></td></tr>)}</tbody></table>}
      </Card>
      <Card>
        <div className="mb-2 flex items-center justify-between"><h2 className="font-semibold">One-off items</h2>{manage && <Button variant="secondary" onClick={() => setDialog('oneoff')}>Add</Button>}</div>
        {!p.one_offs.length ? <Empty>None.</Empty> : <table className="data text-sm"><thead><tr><th>Month</th><th>Item</th><th className="text-right">Amount</th><th>Note</th><th /></tr></thead>
          <tbody>{p.one_offs.map((o) => <tr key={o.id}><td>{periodLabel(o.period)}</td><td>{o.component_name}</td><td className="text-right tabular-nums">{formatMoney(o.amount, '')}</td><td className="muted">{o.note}</td><td>{manage && <Button variant="ghost" onClick={() => removeOneOff.mutate(o.id)}>Remove</Button>}</td></tr>)}</tbody></table>}
      </Card>
      {dialog === 'salary' && <SalaryDialog id={id} onClose={() => { setDialog(null); refresh(); }} />}
      {dialog === 'item' && comps.data && <ItemDialog id={id} comps={comps.data.filter((c) => !c.is_system && c.status === 'active')} onClose={() => { setDialog(null); refresh(); }} />}
      {dialog === 'loan' && comps.data && <LoanDialog id={id} comps={comps.data.filter((c) => c.kind === 'deduction' && !c.is_system && c.status === 'active')} onClose={() => { setDialog(null); refresh(); }} />}
      {dialog === 'oneoff' && comps.data && <OneOffDialog id={id} comps={comps.data.filter((c) => !c.is_system && c.status === 'active' && c.kind !== 'employer_contribution')} onClose={() => { setDialog(null); refresh(); }} />}
    </div>
  );
}

function Footer({ busy, onClose, onSave, disabled }: { busy: boolean; onClose: () => void; onSave: () => void; disabled?: boolean }) {
  return <div className="mt-4 flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button busy={busy} disabled={disabled} onClick={onSave}>Save</Button></div>;
}

function SalaryDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const [v, setV] = useState({ basic: '', effective_from: `${thisMonth()}-01`, reason: '' });
  const save = useMutation({ mutationFn: () => unwrap(hr.PUT('/api/v1/employees/{id}/salary', { params: { path: { id } }, body: { ...v, basic: Number(v.basic).toFixed(2), reason: v.reason || null } })), onSuccess: onClose });
  const fe = save.error instanceof ApiError ? save.error.fieldErrors : {};
  return (
    <Dialog open title="Change salary" onClose={onClose}>
      <ProblemBanner error={save.error} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="New basic salary (KES a month)" htmlFor="sl-basic" error={fe.basic}><Input id="sl-basic" type="number" step="0.01" value={v.basic} onChange={(e) => setV({ ...v, basic: e.target.value })} /></Field>
        <Field label="From" htmlFor="sl-from" error={fe.effective_from}><Input id="sl-from" type="date" value={v.effective_from} onChange={(e) => setV({ ...v, effective_from: e.target.value })} /></Field>
      </div>
      <Field label="Reason" htmlFor="sl-why"><Input id="sl-why" value={v.reason} onChange={(e) => setV({ ...v, reason: e.target.value })} /></Field>
      <p className="muted mt-2 text-xs">An approved payroll cannot change. For a backdated raise, start it after the last approved month and add the difference as Salary arrears.</p>
      <Footer busy={save.isPending} disabled={!v.basic} onClose={onClose} onSave={() => save.mutate()} />
    </Dialog>
  );
}

function ItemDialog({ id, comps, onClose }: { id: string; comps: PayComponent[]; onClose: () => void }) {
  const [v, setV] = useState({ component_id: comps[0]?.id ?? '', value: '', effective_from: `${thisMonth()}-01`, effective_to: '' });
  const c = comps.find((x) => x.id === v.component_id);
  const save = useMutation({ mutationFn: () => unwrap(hr.POST('/api/v1/employees/{id}/pay-items', { params: { path: { id } }, body: { component_id: v.component_id, value: v.value === '' ? null : Number(v.value), effective_from: v.effective_from, effective_to: v.effective_to || null } })), onSuccess: onClose });
  return (
    <Dialog open title="Add an allowance or deduction" onClose={onClose}>
      <ProblemBanner error={save.error} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Item" htmlFor="it-c"><Select id="it-c" value={v.component_id} onChange={(e) => setV({ ...v, component_id: e.target.value })}>{comps.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select></Field>
        <Field label={c?.method === 'fixed' ? 'Amount a month' : c?.method === 'formula' ? 'Uses the formula' : 'Percentage'} htmlFor="it-v" hint={c?.default_value !== null && c?.default_value !== undefined ? `Empty uses the default (${c.default_value})` : undefined}><Input id="it-v" type="number" step="0.01" disabled={c?.method === 'formula'} value={v.value} onChange={(e) => setV({ ...v, value: e.target.value })} /></Field>
        <Field label="From" htmlFor="it-from"><Input id="it-from" type="date" value={v.effective_from} onChange={(e) => setV({ ...v, effective_from: e.target.value })} /></Field>
        <Field label="Until (optional)" htmlFor="it-to"><Input id="it-to" type="date" value={v.effective_to} onChange={(e) => setV({ ...v, effective_to: e.target.value })} /></Field>
      </div>
      <Footer busy={save.isPending} onClose={onClose} onSave={() => save.mutate()} />
    </Dialog>
  );
}

function LoanDialog({ id, comps, onClose }: { id: string; comps: PayComponent[]; onClose: () => void }) {
  const [v, setV] = useState({ component_id: comps.find((c) => c.code === 'LOAN')?.id ?? comps[0]?.id ?? '', reference: '', principal: '', installment: '', start_period: thisMonth() });
  const save = useMutation({ mutationFn: () => unwrap(hr.POST('/api/v1/payroll/loans', { body: { employee_id: id, component_id: v.component_id, reference: v.reference || null, principal: Number(v.principal).toFixed(2), installment: Number(v.installment).toFixed(2), start_period: v.start_period, status: 'active' } })), onSuccess: onClose });
  const fe = save.error instanceof ApiError ? save.error.fieldErrors : {};
  return (
    <Dialog open title="New loan or advance" onClose={onClose}>
      <ProblemBanner error={save.error} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Kind" htmlFor="ln-c"><Select id="ln-c" value={v.component_id} onChange={(e) => setV({ ...v, component_id: e.target.value })}>{comps.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select></Field>
        <Field label="Reference" htmlFor="ln-ref"><Input id="ln-ref" value={v.reference} onChange={(e) => setV({ ...v, reference: e.target.value })} /></Field>
        <Field label="Amount" htmlFor="ln-p" error={fe.principal}><Input id="ln-p" type="number" step="0.01" value={v.principal} onChange={(e) => setV({ ...v, principal: e.target.value })} /></Field>
        <Field label="Monthly instalment" htmlFor="ln-i" error={fe.installment}><Input id="ln-i" type="number" step="0.01" value={v.installment} onChange={(e) => setV({ ...v, installment: e.target.value })} /></Field>
        <Field label="First deduction" htmlFor="ln-s"><Input id="ln-s" type="month" value={v.start_period} onChange={(e) => setV({ ...v, start_period: e.target.value })} /></Field>
      </div>
      <Footer busy={save.isPending} disabled={!v.principal || !v.installment} onClose={onClose} onSave={() => save.mutate()} />
    </Dialog>
  );
}

function OneOffDialog({ id, comps, onClose }: { id: string; comps: PayComponent[]; onClose: () => void }) {
  const [v, setV] = useState({ component_id: comps.find((c) => c.code === 'ARREARS')?.id ?? comps[0]?.id ?? '', period: thisMonth(), amount: '', note: '' });
  const save = useMutation({ mutationFn: () => unwrap(hr.POST('/api/v1/payroll/one-offs', { body: { employee_id: id, component_id: v.component_id, period: v.period, amount: Number(v.amount).toFixed(2), note: v.note || null } })), onSuccess: onClose });
  return (
    <Dialog open title="One-off item" onClose={onClose}>
      <ProblemBanner error={save.error} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Item" htmlFor="oo-c"><Select id="oo-c" value={v.component_id} onChange={(e) => setV({ ...v, component_id: e.target.value })}>{comps.map((x) => <option key={x.id} value={x.id}>{x.name} ({x.kind})</option>)}</Select></Field>
        <Field label="Month" htmlFor="oo-p"><Input id="oo-p" type="month" value={v.period} onChange={(e) => setV({ ...v, period: e.target.value })} /></Field>
        <Field label="Amount" htmlFor="oo-a"><Input id="oo-a" type="number" step="0.01" value={v.amount} onChange={(e) => setV({ ...v, amount: e.target.value })} /></Field>
        <Field label="Note" htmlFor="oo-n"><Input id="oo-n" value={v.note} onChange={(e) => setV({ ...v, note: e.target.value })} /></Field>
      </div>
      <Footer busy={save.isPending} disabled={!v.amount} onClose={onClose} onSave={() => save.mutate()} />
    </Dialog>
  );
}
