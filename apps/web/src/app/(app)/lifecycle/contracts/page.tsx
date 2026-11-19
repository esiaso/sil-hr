'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { CONTRACT_TYPES, formatDate, formatMoney, type Contract } from '@sil/hr-shared';
import { EmployeePicker } from '@/components/employee-picker';
import { Badge, Button, Card, Dialog, Empty, Field, Input, Loading, PageHeader, ProblemBanner, Select, Textarea } from '@/components/ui';
import { ApiError, hr, unwrap } from '@/lib/api';
import { useMemo } from 'react';
import { useSession } from '@/lib/session';

type CType = keyof typeof CONTRACT_TYPES;

export default function ContractsPage() {
  const { can, settings } = useSession();
  const [expiring, setExpiring] = useState<number | ''>(60);
  const [dialog, setDialog] = useState<'new' | Contract | null>(null);
  const [open, setOpen] = useState<Contract | null>(null);
  const [status, setStatus] = useState<'' | 'active' | 'ended' | 'renewed' | 'terminated'>('');
  const [type, setType] = useState('');
  const [search, setSearch] = useState('');
  const q = useQuery({ queryKey: ['contracts', expiring, status], queryFn: () => unwrap(hr.GET('/api/v1/contracts', { params: { query: { expiring_within_days: expiring === '' ? undefined : expiring, status: expiring !== '' ? 'active' : status || undefined } } })) });
  const rows = useMemo(() => (q.data ?? []).filter((c) => (!type || c.contract_type === type) && (!search || `${c.employee_name} ${c.staff_number} ${c.number}`.toLowerCase().includes(search.toLowerCase()))), [q.data, type, search]);
  return (
    <div className="space-y-4">
      <PageHeader title="Contracts" description="Employment contracts and their end dates. HR is reminded before a fixed-term contract ends (Settings, contracts.reminder_days); renewals go through approval." actions={can('contract:manage') && <Button onClick={() => setDialog('new')}>New contract</Button>} />
      <Select aria-label="Show" value={expiring} onChange={(e) => setExpiring(e.target.value === '' ? '' : Number(e.target.value))} className="max-w-60"><option value={30}>Ending within 30 days</option><option value={60}>Ending within 60 days</option><option value={180}>Ending within 6 months</option><option value="">All contracts</option></Select>
      <div className="flex flex-wrap gap-2">
        <Input aria-label="Search" placeholder="Name, staff number or contract number" className="max-w-xs" value={search} onChange={(e) => setSearch(e.target.value)} />
        <Select aria-label="Type" className="max-w-48" value={type} onChange={(e) => setType(e.target.value)}><option value="">All types</option>{Object.entries(CONTRACT_TYPES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select>
        {expiring === '' && <Select aria-label="Status" className="max-w-48" value={status} onChange={(e) => setStatus(e.target.value as 'active')}><option value="">Any status</option><option value="active">In force</option><option value="renewed">Renewed</option><option value="ended">Ended</option><option value="terminated">Terminated</option></Select>}
      </div>
      <ProblemBanner error={q.error} />
      <Card>
        {!q.data ? <Loading /> : !rows.length ? <Empty>No contracts here.</Empty> : (
          <table className="data">
            <thead><tr><th>Number</th><th>Employee</th><th>Type</th><th>Position</th><th>From</th><th>To</th><th>Notice</th><th>Status</th><th /></tr></thead>
            <tbody>{rows.map((c) => (
              <tr key={c.id}>
                <td className="font-mono text-xs"><button type="button" className="link" onClick={() => setOpen(c)}>{c.number}</button>{c.document_id && <span className="muted ml-1" title="Signed copy on file">✓</span>}</td><td>{c.employee_name} <span className="muted text-xs">{c.staff_number}</span></td><td>{CONTRACT_TYPES[c.contract_type]}</td><td>{c.position_title}</td>
                <td>{formatDate(c.start_date, settings.date_format)}</td><td>{c.end_date ? formatDate(c.end_date, settings.date_format) : ''}{c.days_left !== null && c.days_left <= 60 && <span className={`ml-1 text-xs ${c.days_left < 30 ? 'text-red-600' : 'text-amber-600'}`}>{c.days_left} days</span>}</td>
                <td>{c.notice_days} days</td><td><Badge value={c.status} /></td>
                <td className="text-right">{c.status === 'active' && can('lifecycle:request') && <Button variant="ghost" onClick={() => setDialog(c)}>Renew</Button>}</td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </Card>
      {dialog === 'new' && <NewContract onClose={() => setDialog(null)} />}
      {open && <ContractDetail c={open} all={q.data ?? []} onClose={() => setOpen(null)} onRenew={() => { setDialog(open); setOpen(null); }} />}
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

function ContractDetail({ c, all, onClose, onRenew }: { c: Contract; all: Contract[]; onClose: () => void; onRenew: () => void }) {
  const { can, settings } = useSession();
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [v, setV] = useState({ end_date: c.end_date ?? '', probation_months: c.probation_months === null ? '' : String(c.probation_months), notice_days: String(c.notice_days), basic: c.basic ?? '', terms: c.terms ?? '' });
  const history = useQuery({ queryKey: ['contracts-of', c.employee_id], queryFn: () => unwrap(hr.GET('/api/v1/contracts', { params: { query: { employee_id: c.employee_id } } })) });
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['contracts'] }); void qc.invalidateQueries({ queryKey: ['contracts-of', c.employee_id] }); };
  const save = useMutation({
    mutationFn: () => unwrap(hr.PUT('/api/v1/contracts/{id}', { params: { path: { id: c.id }, header: { 'If-Match': `"${c.version}"` } as never }, body: { end_date: v.end_date || null, probation_months: v.probation_months === '' ? null : Number(v.probation_months), notice_days: Number(v.notice_days), basic: v.basic ? Number(v.basic).toFixed(2) : null, terms: v.terms || null } })),
    onSuccess: () => { refresh(); onClose(); },
  });
  const upload = useMutation({
    mutationFn: async (file: File) => {
      const body = new FormData();
      body.append('file', file);
      const res = await fetch(`/api/v1/contracts/${c.id}/document`, { method: 'POST', body, headers: { 'x-requested-with': 'sil-hr-web' } });
      const json = await res.json();
      if (!res.ok) throw new ApiError(res.status, json);
      return json as Contract;
    },
    onSuccess: () => { refresh(); onClose(); },
  });
  const fe = save.error instanceof ApiError ? save.error.fieldErrors : {};
  const d = (x: string | null) => (x ? formatDate(x, settings.date_format) : 'open-ended');
  const others = (history.data ?? all.filter((x) => x.employee_id === c.employee_id)).filter((x) => x.id !== c.id);
  const manage = can('contract:manage') && c.status === 'active';
  return (
    <Dialog open wide title={`${c.number} · ${c.employee_name ?? ''}`} onClose={onClose}>
      <ProblemBanner error={save.error ?? upload.error} />
      {!editing ? (
        <dl className="grid grid-cols-[11rem_1fr] gap-x-3 gap-y-1 text-sm">
          <dt className="muted">Status</dt><dd><Badge value={c.status} /></dd>
          <dt className="muted">Type</dt><dd>{CONTRACT_TYPES[c.contract_type]}</dd>
          <dt className="muted">Position</dt><dd>{c.position_title ?? '–'}</dd>
          <dt className="muted">Period</dt><dd>{d(c.start_date)} to {d(c.end_date)}{c.days_left !== null ? ` (${c.days_left} days left)` : ''}</dd>
          <dt className="muted">Probation</dt><dd>{c.probation_months ? `${c.probation_months} months` : '–'}</dd>
          <dt className="muted">Notice</dt><dd>{c.notice_days} days</dd>
          <dt className="muted">Basic salary</dt><dd>{c.basic ? formatMoney(c.basic) : '–'}</dd>
          <dt className="muted">Special terms</dt><dd className="whitespace-pre-wrap">{c.terms ?? '–'}</dd>
          <dt className="muted">Signed copy</dt><dd>{c.document_id ? <a className="link" href={`/api/v1/contracts/${c.id}/document`}>Download</a> : <span className="text-amber-700">Not on file</span>}</dd>
        </dl>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Ends" htmlFor="cd-end" hint="Blank for open-ended" error={fe.end_date}><Input id="cd-end" type="date" value={v.end_date} onChange={(e) => setV({ ...v, end_date: e.target.value })} /></Field>
          <Field label="Notice (days)" htmlFor="cd-n" error={fe.notice_days}><Input id="cd-n" type="number" value={v.notice_days} onChange={(e) => setV({ ...v, notice_days: e.target.value })} /></Field>
          <Field label="Probation (months)" htmlFor="cd-p"><Input id="cd-p" type="number" value={v.probation_months} onChange={(e) => setV({ ...v, probation_months: e.target.value })} /></Field>
          <Field label="Basic salary (for the letter)" htmlFor="cd-b"><Input id="cd-b" type="number" value={v.basic} onChange={(e) => setV({ ...v, basic: e.target.value })} /></Field>
          <div className="sm:col-span-2"><Field label="Special terms" htmlFor="cd-t"><Textarea id="cd-t" value={v.terms} onChange={(e) => setV({ ...v, terms: e.target.value })} /></Field></div>
          <p className="muted text-xs sm:col-span-2">For a different type or start date, renew the contract instead (it goes for approval). Pay itself is set under Payroll → Pay and loans. Changes are kept in the audit trail.</p>
        </div>
      )}
      {others.length > 0 && !editing && (
        <div className="mt-4">
          <div className="mb-1 text-sm font-medium">Other contracts for this person</div>
          <ul className="text-sm">{others.map((o) => <li key={o.id} className="flex justify-between border-t border-[var(--border)] py-1"><span>{o.number} · {CONTRACT_TYPES[o.contract_type]} · {d(o.start_date)} to {d(o.end_date)}</span><Badge value={o.status} /></li>)}</ul>
        </div>
      )}
      <div className="mt-4 flex flex-wrap justify-end gap-2">
        {manage && !editing && <label className="inline-flex cursor-pointer items-center rounded-lg border border-[var(--border)] px-3.5 py-2 text-sm font-medium hover:bg-[var(--hover)]">{upload.isPending ? 'Uploading…' : c.document_id ? 'Replace signed copy' : 'Upload signed copy'}<input type="file" accept="application/pdf,image/png,image/jpeg" className="hidden" onChange={(e) => e.target.files?.[0] && upload.mutate(e.target.files[0])} /></label>}
        {manage && !editing && <Button variant="secondary" onClick={() => setEditing(true)}>Edit terms</Button>}
        {c.status === 'active' && can('lifecycle:request') && !editing && <Button variant="secondary" onClick={onRenew}>Renew</Button>}
        {editing ? <><Button variant="secondary" onClick={() => setEditing(false)}>Cancel</Button><Button busy={save.isPending} onClick={() => save.mutate()}>Save</Button></> : <Button variant="secondary" onClick={onClose}>Close</Button>}
      </div>
    </Dialog>
  );
}
