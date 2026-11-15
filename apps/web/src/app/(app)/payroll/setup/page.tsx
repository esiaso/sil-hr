'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { COMPONENT_KINDS, COMPONENT_METHODS, formatDate, PAYMENT_FIELDS, STATUTORY_TABLES, TAX_TREATMENTS, type PayComponent, type StatutoryTable } from '@sil/hr-shared';
import { Badge, Button, Card, Dialog, Field, Input, Loading, PageHeader, ProblemBanner, Select } from '@/components/ui';
import { ApiError, hr, unwrap } from '@/lib/api';
import { useSession } from '@/lib/session';

type Tab = 'components' | 'rates' | 'files' | 'accounts';

export default function PayrollSetupPage() {
  const [tab, setTab] = useState<Tab>('components');
  return (
    <div className="space-y-4">
      <PageHeader title="Payroll setup" description="Pay components, the statutory rate tables, payment file layouts and the account codes for the journal. Everything here is dated or versioned, so past payrolls stay reproducible." />
      <div className="flex flex-wrap gap-1 border-b border-[var(--border)]">
        {([['components', 'Components'], ['rates', 'Statutory rates'], ['files', 'Payment files'], ['accounts', 'Accounts']] as const).map(([t, l]) => (
          <button key={t} type="button" onClick={() => setTab(t)} className={`-mb-px border-b-2 px-3 py-2 text-sm ${tab === t ? 'border-[var(--accent)] font-medium' : 'border-transparent muted'}`}>{l}</button>
        ))}
      </div>
      {tab === 'components' && <Components />}
      {tab === 'rates' && <Rates />}
      {tab === 'files' && <Files />}
      {tab === 'accounts' && <Accounts />}
    </div>
  );
}

// ------------------------------------------------------------------ components
function Components() {
  const { can } = useSession();
  const q = useQuery({ queryKey: ['pay-components'], queryFn: () => unwrap(hr.GET('/api/v1/payroll/components')) });
  const [editing, setEditing] = useState<PayComponent | 'new' | null>(null);
  const manage = can('payroll_setup:manage');
  return (
    <Card>
      <div className="mb-2 flex justify-between"><p className="muted text-sm">Built-in items (basic pay, PAYE, NSSF, SHIF, Housing Levy, NITA) are calculated by the payroll.</p>{manage && <Button onClick={() => setEditing('new')}>New component</Button>}</div>
      <ProblemBanner error={q.error} />
      {!q.data ? <Loading /> : (
        <table className="data text-sm">
          <thead><tr><th>Code</th><th>Name</th><th>Kind</th><th>How</th><th>Taxable</th><th>Pensionable</th><th>Tax effect</th><th /></tr></thead>
          <tbody>{q.data.map((c) => (
            <tr key={c.id}>
              <td className="font-mono text-xs">{c.code}</td><td>{c.name} {c.status === 'inactive' && <Badge value="inactive" />}</td><td>{c.kind.replace('_', ' ')}</td>
              <td>{c.is_system ? <span className="muted">calculated</span> : c.method === 'formula' ? <code className="text-xs">{c.formula}</code> : `${COMPONENT_METHODS[c.method]}${c.default_value !== null ? ` (${c.default_value})` : ''}`}</td>
              <td>{c.taxable ? 'yes' : ''}</td><td>{c.pensionable ? 'yes' : ''}</td><td>{c.tax_treatment !== 'none' ? c.tax_treatment.replace(/_/g, ' ') : ''}</td>
              <td>{manage && <Button variant="ghost" onClick={() => setEditing(c)}>Edit</Button>}</td>
            </tr>
          ))}</tbody>
        </table>
      )}
      {editing && <ComponentDialog c={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </Card>
  );
}

function ComponentDialog({ c, onClose }: { c: PayComponent | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [v, setV] = useState({
    code: c?.code ?? '', name: c?.name ?? '', kind: c?.kind ?? 'earning', method: c?.method ?? 'fixed', default_value: c?.default_value ?? null, formula: c?.formula ?? '', taxable: c?.taxable ?? true,
    pensionable: c?.pensionable ?? false, prorate: c?.prorate ?? true, tax_treatment: c?.tax_treatment ?? 'none', sort_order: c?.sort_order ?? 100, status: c?.status ?? 'active',
  });
  const [check, setCheck] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () => {
      const body = { ...v, formula: v.method === 'formula' ? v.formula : null } as never;
      return c ? unwrap(hr.PUT('/api/v1/payroll/components/{id}', { params: { path: { id: c.id }, header: { 'If-Match': `"${c.version}"` } as never }, body })) : unwrap(hr.POST('/api/v1/payroll/components', { body }));
    },
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['pay-components'] }); onClose(); },
  });
  const test = useMutation({ mutationFn: () => unwrap(hr.POST('/api/v1/payroll/components/check-formula', { body: { formula: v.formula, basic: 100000, gross: 120000 } })), onSuccess: (r) => setCheck(r.ok ? `On basic 100,000 and gross 120,000: ${r.value}` : r.message) });
  const fe = save.error instanceof ApiError ? save.error.fieldErrors : {};
  const sys = !!c?.is_system;
  return (
    <Dialog open wide title={c ? c.name : 'New pay component'} onClose={onClose}>
      <ProblemBanner error={save.error} />
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Code" htmlFor="pc-code" error={fe.code}><Input id="pc-code" disabled={sys} value={v.code} onChange={(e) => setV({ ...v, code: e.target.value.toUpperCase() })} /></Field>
        <Field label="Name" htmlFor="pc-name" error={fe.name}><Input id="pc-name" value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} /></Field>
        <Field label="Kind" htmlFor="pc-kind"><Select id="pc-kind" disabled={sys} value={v.kind} onChange={(e) => setV({ ...v, kind: e.target.value as typeof v.kind })}>{Object.entries(COMPONENT_KINDS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select></Field>
        {!sys && <>
          <Field label="How it is worked out" htmlFor="pc-method"><Select id="pc-method" value={v.method} onChange={(e) => setV({ ...v, method: e.target.value as typeof v.method })}>{Object.entries(COMPONENT_METHODS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select></Field>
          {v.method !== 'formula' && <Field label={v.method === 'fixed' ? 'Default amount' : 'Default percentage'} htmlFor="pc-val" hint="Can be set per person"><Input id="pc-val" type="number" step="0.01" value={v.default_value ?? ''} onChange={(e) => setV({ ...v, default_value: e.target.value === '' ? null : Number(e.target.value) })} /></Field>}
          {v.kind === 'deduction' && <Field label="Tax effect" htmlFor="pc-tt"><Select id="pc-tt" value={v.tax_treatment} onChange={(e) => setV({ ...v, tax_treatment: e.target.value as typeof v.tax_treatment })}>{Object.entries(TAX_TREATMENTS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select></Field>}
        </>}
      </div>
      {!sys && v.method === 'formula' && (
        <div className="mt-3">
          <Field label="Formula" htmlFor="pc-f" error={fe.formula} hint="Numbers, + − * /, brackets, min(), max(), round() and: basic, basic_full, gross, days_paid, days_in_period, overtime_hours"><Input id="pc-f" className="font-mono" value={v.formula} onChange={(e) => { setV({ ...v, formula: e.target.value }); setCheck(null); }} /></Field>
          <div className="mt-1 flex items-center gap-2 text-sm"><Button variant="secondary" busy={test.isPending} onClick={() => test.mutate()}>Try it</Button>{check && <span>{check}</span>}</div>
        </div>
      )}
      {!sys && (
        <div className="mt-3 flex flex-wrap gap-4 text-sm">
          {(v.kind === 'earning' || v.kind === 'benefit') && <label className="flex items-center gap-1"><input type="checkbox" checked={v.taxable} onChange={(e) => setV({ ...v, taxable: e.target.checked })} />Taxable</label>}
          {v.kind === 'earning' && <label className="flex items-center gap-1"><input type="checkbox" checked={v.pensionable} onChange={(e) => setV({ ...v, pensionable: e.target.checked })} />Counts for NSSF</label>}
          {v.method === 'fixed' && <label className="flex items-center gap-1"><input type="checkbox" checked={v.prorate} onChange={(e) => setV({ ...v, prorate: e.target.checked })} />Prorated for joiners, leavers and unpaid leave</label>}
          <label className="flex items-center gap-1"><input type="checkbox" checked={v.status === 'active'} onChange={(e) => setV({ ...v, status: e.target.checked ? 'active' : 'inactive' })} />In use</label>
        </div>
      )}
      <div className="mt-4 flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button busy={save.isPending} onClick={() => save.mutate()}>Save</Button></div>
    </Dialog>
  );
}

// ------------------------------------------------------------------ statutory tables
type Rate = { id: string; code: StatutoryTable; effective_from: string; effective_to: string | null; params: Record<string, unknown>; source: string | null; version: number };

function Rates() {
  const { can, settings } = useSession();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['statutory-rates'], queryFn: () => unwrap(hr.GET('/api/v1/payroll/statutory-rates')) as Promise<Rate[]> });
  const [editing, setEditing] = useState<{ base: Rate; isNew: boolean } | null>(null);
  const del = useMutation({ mutationFn: (id: string) => unwrap(hr.DELETE('/api/v1/payroll/statutory-rates/{id}', { params: { path: { id } } })), onSuccess: () => qc.invalidateQueries({ queryKey: ['statutory-rates'] }) });
  const today = new Date().toISOString().slice(0, 10);
  return (
    <div className="space-y-3">
      <p className="muted text-sm">Checked on 15 November 2026 against KRA, the NSSF year 4 notice (February 2026), SHA and the Housing Levy. Rates change most years: add a new table from the date it applies rather than editing an old one. Tables an approved payroll used are locked.</p>
      <ProblemBanner error={q.error ?? del.error} />
      {!q.data ? <Loading /> : (Object.keys(STATUTORY_TABLES) as StatutoryTable[]).map((code) => {
        const rows = q.data.filter((r) => r.code === code);
        return (
          <Card key={code}>
            <div className="mb-2 flex items-center justify-between"><h2 className="font-semibold">{STATUTORY_TABLES[code]}</h2>{can('payroll_setup:manage') && rows[0] && <Button variant="secondary" onClick={() => setEditing({ base: rows[0], isNew: true })}>New table from a date</Button>}</div>
            <table className="data text-sm"><thead><tr><th>From</th><th>To</th><th>Values</th><th>Source</th><th /></tr></thead>
              <tbody>{rows.map((r) => {
                const current = r.effective_from <= today && (!r.effective_to || r.effective_to >= today);
                return (
                  <tr key={r.id}>
                    <td>{formatDate(r.effective_from, settings.date_format)} {current && <Badge value="active" />}</td><td>{r.effective_to ? formatDate(r.effective_to, settings.date_format) : ''}</td>
                    <td className="text-xs"><Summary code={code} p={r.params} /></td><td className="muted text-xs">{r.source}</td>
                    <td className="whitespace-nowrap">{can('payroll_setup:manage') && <><Button variant="ghost" onClick={() => setEditing({ base: r, isNew: false })}>Edit</Button>{!current && <Button variant="ghost" onClick={() => confirm('Delete this table?') && del.mutate(r.id)}>Delete</Button>}</>}</td>
                  </tr>
                );
              })}</tbody>
            </table>
          </Card>
        );
      })}
      {editing && <RateDialog base={editing.base} isNew={editing.isNew} onClose={() => setEditing(null)} />}
    </div>
  );
}

const pct = (x: unknown) => `${Math.round(Number(x) * 100000) / 1000}%`;
const kes = (x: unknown) => Number(x).toLocaleString('en-KE');
function Summary({ code, p }: { code: StatutoryTable; p: Record<string, unknown> }) {
  if (code === 'PAYE') {
    const bands = p.bands as { upto: number | null; rate: number }[];
    return <>{bands.map((b, i) => `${pct(b.rate)} ${b.upto === null ? 'above' : `to ${kes(b.upto)}`}`).join(' · ')}; relief {kes(p.personal_relief)}; insurance relief {pct(p.insurance_relief_rate)} up to {kes(p.insurance_relief_cap)}</>;
  }
  return <>{Object.entries(p).map(([k, v]) => `${k.replace(/_/g, ' ')}: ${typeof v === 'boolean' ? (v ? 'yes' : 'no') : k.includes('rate') ? pct(v) : kes(v)}`).join(' · ')}</>;
}

function RateDialog({ base, isNew, onClose }: { base: Rate; isNew: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const [from, setFrom] = useState(isNew ? '' : base.effective_from);
  const [to, setTo] = useState(isNew ? '' : (base.effective_to ?? ''));
  const [source, setSource] = useState(isNew ? '' : (base.source ?? ''));
  const [p, setP] = useState<Record<string, unknown>>(structuredClone(base.params));
  const save = useMutation({
    mutationFn: () => {
      const body = { code: base.code, effective_from: from, effective_to: to || null, params: p, source: source || null };
      return isNew ? unwrap(hr.POST('/api/v1/payroll/statutory-rates', { body })) : unwrap(hr.PUT('/api/v1/payroll/statutory-rates/{id}', { params: { path: { id: base.id }, header: { 'If-Match': `"${base.version}"` } as never }, body }));
    },
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['statutory-rates'] }); onClose(); },
  });
  const bands = (p.bands as { upto: number | null; rate: number }[] | undefined) ?? null;
  const setBand = (i: number, k: 'upto' | 'rate', val: string) => setP({ ...p, bands: bands!.map((b, j) => (j === i ? { ...b, [k]: val === '' ? null : Number(val) } : b)) });
  return (
    <Dialog open wide title={`${STATUTORY_TABLES[base.code]}${isNew ? ': new table' : ''}`} onClose={onClose}>
      <ProblemBanner error={save.error} />
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="From" htmlFor="rt-from"><Input id="rt-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field label="To (optional)" htmlFor="rt-to"><Input id="rt-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
        <Field label="Source" htmlFor="rt-src" hint="The Act, notice or Finance Act"><Input id="rt-src" value={source} onChange={(e) => setSource(e.target.value)} /></Field>
      </div>
      {bands && (
        <div className="mt-3">
          <div className="mb-1 text-sm font-medium">Monthly bands (rates as fractions: 0.3 = 30%)</div>
          {bands.map((b, i) => (
            <div key={i} className="mb-1 flex items-center gap-2 text-sm">
              <span className="w-28">{i === bands.length - 1 ? 'Above that' : 'Up to KES'}</span>
              {i < bands.length - 1 && <Input aria-label={`Band ${i + 1} upper limit`} type="number" value={b.upto ?? ''} onChange={(e) => setBand(i, 'upto', e.target.value)} className="max-w-36" />}
              <span>at</span><Input aria-label={`Band ${i + 1} rate`} type="number" step="0.005" value={b.rate} onChange={(e) => setBand(i, 'rate', e.target.value)} className="max-w-24" />
            </div>
          ))}
        </div>
      )}
      <div className="mt-3 grid gap-3 sm:grid-cols-3">
        {Object.entries(p).filter(([k]) => k !== 'bands').map(([k, val]) => typeof val === 'boolean'
          ? <label key={k} className="flex items-center gap-1 text-sm"><input type="checkbox" checked={val} onChange={(e) => setP({ ...p, [k]: e.target.checked })} />{k.replace(/_/g, ' ')}</label>
          : <Field key={k} label={k.replace(/_/g, ' ') + (k.includes('rate') ? ' (fraction)' : '')} htmlFor={`rt-${k}`}><Input id={`rt-${k}`} type="number" step="any" value={String(val)} onChange={(e) => setP({ ...p, [k]: Number(e.target.value) })} /></Field>)}
      </div>
      <div className="mt-4 flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button busy={save.isPending} disabled={!from} onClick={() => save.mutate()}>Save</Button></div>
    </Dialog>
  );
}

// ------------------------------------------------------------------ payment files
type Format = { id: string; code: string; name: string; channel: 'bank' | 'mobile_money'; file_type: 'xlsx' | 'csv'; columns: { header: string; field: keyof typeof PAYMENT_FIELDS; value?: string }[]; is_default: boolean; note: string | null; version: number };

function Files() {
  const { can } = useSession();
  const q = useQuery({ queryKey: ['payment-formats'], queryFn: () => unwrap(hr.GET('/api/v1/payroll/payment-formats')) as Promise<Format[]> });
  const [editing, setEditing] = useState<Format | null>(null);
  return (
    <Card>
      <p className="muted mb-2 text-sm">The bank file is Excel. Match the columns to the bank&rsquo;s template; the M-Pesa layout waits on the hospital&rsquo;s bulk payment method.</p>
      <ProblemBanner error={q.error} />
      {!q.data ? <Loading /> : (
        <table className="data text-sm"><thead><tr><th>Name</th><th>For</th><th>File</th><th>Columns</th><th /></tr></thead>
          <tbody>{q.data.map((f) => <tr key={f.id}><td>{f.name} {f.is_default && <Badge value="default" />}<div className="muted text-xs">{f.note}</div></td><td>{f.channel === 'bank' ? 'Bank' : 'M-Pesa'}</td><td>{f.file_type}</td><td className="text-xs">{f.columns.map((c) => c.header).join(', ')}</td><td>{can('payroll_setup:manage') && <Button variant="ghost" onClick={() => setEditing(f)}>Edit</Button>}</td></tr>)}</tbody>
        </table>
      )}
      {editing && <FormatDialog f={editing} onClose={() => setEditing(null)} />}
    </Card>
  );
}

function FormatDialog({ f, onClose }: { f: Format; onClose: () => void }) {
  const qc = useQueryClient();
  const [cols, setCols] = useState(f.columns);
  const [type, setType] = useState(f.file_type);
  const save = useMutation({
    mutationFn: () => unwrap(hr.PUT('/api/v1/payroll/payment-formats/{id}', { params: { path: { id: f.id }, header: { 'If-Match': `"${f.version}"` } as never }, body: { code: f.code, name: f.name, channel: f.channel, file_type: type, columns: cols, is_default: f.is_default, note: f.note } })),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['payment-formats'] }); onClose(); },
  });
  const set = (i: number, patch: Partial<Format['columns'][number]>) => setCols(cols.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  return (
    <Dialog open wide title={f.name} onClose={onClose}>
      <ProblemBanner error={save.error} />
      <Field label="File type" htmlFor="ff-type"><Select id="ff-type" value={type} onChange={(e) => setType(e.target.value as 'xlsx' | 'csv')} className="max-w-40"><option value="xlsx">Excel (.xlsx)</option><option value="csv">CSV</option></Select></Field>
      <div className="mt-3 space-y-1">
        {cols.map((c, i) => (
          <div key={i} className="flex flex-wrap items-center gap-2">
            <Input aria-label={`Column ${i + 1} heading`} value={c.header} onChange={(e) => set(i, { header: e.target.value })} className="max-w-48" />
            <Select aria-label={`Column ${i + 1} value`} value={c.field} onChange={(e) => set(i, { field: e.target.value as Format['columns'][number]['field'] })} className="max-w-56">{Object.entries(PAYMENT_FIELDS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select>
            {c.field === 'fixed' && <Input aria-label={`Column ${i + 1} fixed text`} value={c.value ?? ''} onChange={(e) => set(i, { value: e.target.value })} className="max-w-40" />}
            <Button variant="ghost" disabled={i === 0} onClick={() => { const n = [...cols]; [n[i - 1], n[i]] = [n[i], n[i - 1]]; setCols(n); }}>↑</Button>
            <Button variant="ghost" onClick={() => setCols(cols.filter((_, j) => j !== i))}>Remove</Button>
          </div>
        ))}
        <Button variant="secondary" onClick={() => setCols([...cols, { header: 'New column', field: 'staff_number' }])}>Add column</Button>
      </div>
      <div className="mt-4 flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button busy={save.isPending} disabled={!cols.length} onClick={() => save.mutate()}>Save</Button></div>
    </Dialog>
  );
}

// ------------------------------------------------------------------ accounts
function Accounts() {
  const { can } = useSession();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['account-map'], queryFn: () => unwrap(hr.GET('/api/v1/payroll/account-map')) });
  const [rows, setRows] = useState<{ key: string; description: string | null; debit_account: string | null; credit_account: string | null }[]>([]);
  useEffect(() => { if (q.data) setRows(q.data.map(({ key, description, debit_account, credit_account }) => ({ key, description, debit_account, credit_account }))); }, [q.data]);
  const save = useMutation({ mutationFn: () => unwrap(hr.PUT('/api/v1/payroll/account-map', { body: { rows } })), onSuccess: () => qc.invalidateQueries({ queryKey: ['account-map'] }) });
  const manage = can('payroll_setup:manage');
  const set = (i: number, k: 'debit_account' | 'credit_account', v: string) => setRows(rows.map((r, j) => (j === i ? { ...r, [k]: v || null } : r)));
  return (
    <Card>
      <p className="muted mb-2 text-sm">Accounts starting TBD are placeholders until the chart of accounts is updated; the journal lists them. A component without its own row uses EARNINGS, DEDUCTIONS or EMPLOYER. Add a row whose key is a component code to give it its own account.</p>
      <ProblemBanner error={q.error ?? save.error} />
      {!q.data ? <Loading /> : (
        <>
          <table className="data text-sm"><thead><tr><th>Key</th><th>Description</th><th>Debit account</th><th>Credit account</th></tr></thead>
            <tbody>{rows.map((r, i) => <tr key={r.key}><td className="font-mono text-xs">{r.key}</td><td>{r.description}</td><td><Input aria-label={`${r.key} debit`} disabled={!manage} value={r.debit_account ?? ''} onChange={(e) => set(i, 'debit_account', e.target.value)} className="max-w-36 font-mono" /></td><td><Input aria-label={`${r.key} credit`} disabled={!manage} value={r.credit_account ?? ''} onChange={(e) => set(i, 'credit_account', e.target.value)} className="max-w-36 font-mono" /></td></tr>)}</tbody>
          </table>
          {manage && <div className="mt-3 flex gap-2"><Button variant="secondary" onClick={() => { const key = prompt('Component code or key (e.g. HOUSE)')?.trim().toUpperCase(); if (key && !rows.some((r) => r.key === key)) setRows([...rows, { key, description: null, debit_account: null, credit_account: null }]); }}>Add row</Button><Button busy={save.isPending} onClick={() => save.mutate()}>Save</Button></div>}
        </>
      )}
    </Card>
  );
}
