'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { EMPLOYMENT_TYPES, formatDate, formatMoney, MEDICAL_CATEGORY_SUGGESTIONS } from '@sil/hr-shared';
import { Badge, Button, Card, Dialog, Empty, Field, Input, Loading, PageHeader, ProblemBanner, Select } from '@/components/ui';
import { ApiError, hr, unwrap } from '@/lib/api';
import { useLookups } from '@/lib/lookups';
import { useSession } from '@/lib/session';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
type Detail = Awaited<ReturnType<typeof getScheme>>;
const getScheme = (id: string) => unwrap(hr.GET('/api/v1/medical/schemes/{id}', { params: { path: { id } } }));

export default function MedicalSetupPage() {
  const schemes = useQuery({ queryKey: ['medical-schemes'], queryFn: () => unwrap(hr.GET('/api/v1/medical/schemes')) });
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<Detail | 'new' | null>(null);
  const id = selected ?? schemes.data?.[0]?.id ?? null;
  return (
    <div className="space-y-4">
      <PageHeader title="Medical scheme setup" description="Schemes, cover categories, limits by grade and employment type, and staff contributions. Limits and rates are dated: a change takes effect from a date and the old values stay on record." actions={<Button onClick={() => setEditing('new')}>New scheme</Button>} />
      <ProblemBanner error={schemes.error} />
      {!schemes.data ? <Loading /> : !schemes.data.length ? <Card><Empty>No schemes yet.</Empty></Card> : (
        <>
          {schemes.data.length > 1 && <Select aria-label="Scheme" value={id ?? ''} onChange={(e) => setSelected(e.target.value)} className="max-w-sm">{schemes.data.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select>}
          {id && <SchemeView id={id} onEdit={setEditing} />}
        </>
      )}
      {editing && <SchemeDialog s={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function SchemeView({ id, onEdit }: { id: string; onEdit: (d: Detail) => void }) {
  const { settings } = useSession();
  const l = useLookups();
  const q = useQuery({ queryKey: ['medical-scheme', id], queryFn: () => getScheme(id) });
  const [dialog, setDialog] = useState<null | { kind: 'category'; c?: Detail['categories'][number] } | { kind: 'limit'; categoryId?: string } | { kind: 'rate' }>(null);
  if (!q.data) return <Card><ProblemBanner error={q.error} /><Loading /></Card>;
  const s = q.data;
  const grade = (gid: string | null) => (gid ? l.gradeOptions.find((g) => g.value === gid)?.label ?? 'grade' : 'All grades');
  const today = new Date().toISOString().slice(0, 10);
  const live = (r: { effective_from: string; effective_to: string | null }) => r.effective_from <= today && (!r.effective_to || r.effective_to >= today);
  return (
    <div className="space-y-4">
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h2 className="text-lg font-semibold">{s.name} <span className="muted font-mono text-sm">{s.code}</span> {s.status === 'inactive' && <Badge value="inactive" />}</h2>
            <p className="muted mt-1 text-sm">{s.description}</p>
          </div>
          <Button variant="secondary" onClick={() => onEdit(s)}>Edit scheme</Button>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-3 text-sm sm:grid-cols-5">
          <div><div className="muted text-xs">Scheme year starts</div>{MONTHS[s.year_start_month - 1]}</div>
          <div><div className="muted text-xs">Unused limits</div>{s.unused_limit_policy === 'reset' ? 'Reset each year' : `Carry over (up to ${s.carry_over_max_pct}%)`}</div>
          <div><div className="muted text-xs">Dependants</div>Up to {s.max_dependants}</div>
          <div><div className="muted text-xs">Over the limit</div>{s.over_limit_action === 'block' ? 'Refused' : 'Needs approval'}</div>
          <div><div className="muted text-xs">Staff contributions</div>{s.contributions_enabled ? 'On (payroll deduction)' : 'Off: the hospital pays'}</div>
        </div>
      </Card>
      <Card>
        <div className="mb-2 flex items-center justify-between"><h3 className="font-semibold">Cover categories and limits</h3><div className="flex gap-2"><Button variant="secondary" onClick={() => setDialog({ kind: 'category' })}>Add category</Button><Button variant="secondary" onClick={() => setDialog({ kind: 'limit' })}>New limit from a date</Button></div></div>
        {!s.categories.length ? <Empty>No categories yet.</Empty> : s.categories.map((c) => (
          <div key={c.id} className="border-t border-[var(--border)] py-3 first:border-t-0">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div><span className="font-medium">{c.name}</span> <span className="muted text-xs">{c.sharing === 'shared' ? 'shared by the family' : 'each person'}{c.co_pay_pct ? ` · ${c.co_pay_pct}% co-pay` : ''}{c.per_visit_cap ? ` · up to ${formatMoney(c.per_visit_cap, '')} a visit` : ''}{c.waiting_days ? ` · ${c.waiting_days}-day waiting period` : ''}{c.principal_and_spouse_only ? ' · staff and spouse only' : ''}</span> {c.status === 'inactive' && <Badge value="inactive" />}</div>
              <Button variant="ghost" onClick={() => setDialog({ kind: 'category', c })}>Edit</Button>
            </div>
            <table className="data mt-2 text-sm"><thead><tr><th>Applies to</th><th className="text-right">Limit a year</th><th className="text-right">Each dependant</th><th>From</th><th>To</th></tr></thead>
              <tbody>{s.limit_rules.filter((r) => r.category_id === c.id).map((r) => <tr key={r.id} className={live(r) ? '' : 'opacity-60'}><td>{grade(r.job_grade_id)}{r.employment_type ? `, ${r.employment_type}` : ''}</td><td className="text-right tabular-nums">{formatMoney(r.annual_limit, '')}</td><td className="text-right tabular-nums">{r.dependant_limit ? formatMoney(r.dependant_limit, '') : ''}</td><td>{formatDate(r.effective_from, settings.date_format)}</td><td>{r.effective_to ? formatDate(r.effective_to, settings.date_format) : ''}</td></tr>)}</tbody>
            </table>
          </div>
        ))}
      </Card>
      <Card>
        <div className="mb-2 flex items-center justify-between"><h3 className="font-semibold">Staff contributions</h3><Button variant="secondary" onClick={() => setDialog({ kind: 'rate' })}>New rate from a date</Button></div>
        {!s.contributions_enabled && <p className="muted mb-2 text-sm">Contributions are off for this scheme: nothing is deducted. Rates below apply only when they are switched on.</p>}
        {!s.contribution_rates.length ? <Empty>No rates.</Empty> : (
          <table className="data text-sm"><thead><tr><th>Applies to</th><th>Amount</th><th className="text-right">Per dependant</th><th>From</th><th>To</th></tr></thead>
            <tbody>{s.contribution_rates.map((r) => <tr key={r.id} className={live(r) ? '' : 'opacity-60'}><td>{grade(r.job_grade_id)}{r.employment_type ? `, ${r.employment_type}` : ''}</td><td>{r.method === 'fixed' ? `KES ${formatMoney(r.value.toFixed(2), '')} a month` : `${r.value}% of basic pay`}</td><td className="text-right tabular-nums">{formatMoney(r.per_dependant, '')}</td><td>{formatDate(r.effective_from, settings.date_format)}</td><td>{r.effective_to ? formatDate(r.effective_to, settings.date_format) : ''}</td></tr>)}</tbody>
          </table>
        )}
      </Card>
      {dialog?.kind === 'category' && <CategoryDialog schemeId={id} c={dialog.c} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'limit' && <LimitDialog scheme={s} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'rate' && <RateDialog schemeId={id} onClose={() => setDialog(null)} />}
    </div>
  );
}

function useSaved(onClose: () => void) {
  const qc = useQueryClient();
  return () => { void qc.invalidateQueries({ queryKey: ['medical-scheme'] }); void qc.invalidateQueries({ queryKey: ['medical-schemes'] }); onClose(); };
}
const Footer = ({ busy, onClose, onSave }: { busy: boolean; onClose: () => void; onSave: () => void }) => <div className="mt-4 flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button busy={busy} onClick={onSave}>Save</Button></div>;

function SchemeDialog({ s, onClose }: { s: Detail | null; onClose: () => void }) {
  const done = useSaved(onClose);
  const [v, setV] = useState({ code: s?.code ?? '', name: s?.name ?? '', description: s?.description ?? '', year_start_month: s?.year_start_month ?? 1, unused_limit_policy: s?.unused_limit_policy ?? 'reset', carry_over_max_pct: s?.carry_over_max_pct ?? 100, max_dependants: s?.max_dependants ?? 5, over_limit_action: s?.over_limit_action ?? 'approval', contributions_enabled: s?.contributions_enabled ?? false, status: s?.status ?? 'active' });
  const save = useMutation({ mutationFn: () => (s ? unwrap(hr.PUT('/api/v1/medical/schemes/{id}', { params: { path: { id: s.id }, header: { 'If-Match': `"${s.version}"` } as never }, body: v })) : unwrap(hr.POST('/api/v1/medical/schemes', { body: v }))), onSuccess: done });
  const fe = save.error instanceof ApiError ? save.error.fieldErrors : {};
  return (
    <Dialog open wide title={s ? s.name : 'New scheme'} onClose={onClose}>
      <ProblemBanner error={save.error} />
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Code" htmlFor="sc-code" error={fe.code}><Input id="sc-code" value={v.code} onChange={(e) => setV({ ...v, code: e.target.value.toUpperCase() })} /></Field>
        <Field label="Name" htmlFor="sc-name" error={fe.name}><Input id="sc-name" value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} /></Field>
        <Field label="Scheme year starts in" htmlFor="sc-ys"><Select id="sc-ys" value={v.year_start_month} onChange={(e) => setV({ ...v, year_start_month: Number(e.target.value) })}>{MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}</Select></Field>
        <Field label="Unused limits at year end" htmlFor="sc-u"><Select id="sc-u" value={v.unused_limit_policy} onChange={(e) => setV({ ...v, unused_limit_policy: e.target.value as 'reset' })}><option value="reset">Reset</option><option value="carry_over">Carry over</option></Select></Field>
        {v.unused_limit_policy === 'carry_over' && <Field label="Carry over at most (% of the limit)" htmlFor="sc-cp"><Input id="sc-cp" type="number" value={v.carry_over_max_pct} onChange={(e) => setV({ ...v, carry_over_max_pct: Number(e.target.value) })} /></Field>}
        <Field label="Most dependants" htmlFor="sc-md"><Input id="sc-md" type="number" value={v.max_dependants} onChange={(e) => setV({ ...v, max_dependants: Number(e.target.value) })} /></Field>
        <Field label="Claims over the limit" htmlFor="sc-ol"><Select id="sc-ol" value={v.over_limit_action} onChange={(e) => setV({ ...v, over_limit_action: e.target.value as 'approval' })}><option value="approval">Send for approval</option><option value="block">Refuse</option></Select></Field>
      </div>
      <Field label="Description" htmlFor="sc-d"><Input id="sc-d" value={v.description} onChange={(e) => setV({ ...v, description: e.target.value })} /></Field>
      <div className="mt-3 flex flex-wrap gap-4 text-sm">
        <label className="flex items-center gap-1"><input type="checkbox" checked={v.contributions_enabled} onChange={(e) => setV({ ...v, contributions_enabled: e.target.checked })} />Staff contribute through payroll</label>
        <label className="flex items-center gap-1"><input type="checkbox" checked={v.status === 'active'} onChange={(e) => setV({ ...v, status: e.target.checked ? 'active' : 'inactive' })} />Open</label>
      </div>
      <Footer busy={save.isPending} onClose={onClose} onSave={() => save.mutate()} />
    </Dialog>
  );
}

function CategoryDialog({ schemeId, c, onClose }: { schemeId: string; c?: Detail['categories'][number]; onClose: () => void }) {
  const done = useSaved(onClose);
  const [v, setV] = useState({ code: c?.code ?? '', name: c?.name ?? '', sharing: c?.sharing ?? 'shared', co_pay_pct: c?.co_pay_pct ?? 0, per_visit_cap: c?.per_visit_cap ?? '', waiting_days: c?.waiting_days ?? 0, principal_and_spouse_only: c?.principal_and_spouse_only ?? false, sort_order: c?.sort_order ?? 100, status: c?.status ?? 'active' });
  const body = () => ({ ...v, per_visit_cap: v.per_visit_cap ? Number(v.per_visit_cap).toFixed(2) : null });
  const save = useMutation({ mutationFn: () => (c ? unwrap(hr.PUT('/api/v1/medical/schemes/{id}/categories/{cid}', { params: { path: { id: schemeId, cid: c.id }, header: { 'If-Match': `"${c.version}"` } as never }, body: body() })) : unwrap(hr.POST('/api/v1/medical/schemes/{id}/categories', { params: { path: { id: schemeId } }, body: body() }))), onSuccess: done });
  const fe = save.error instanceof ApiError ? save.error.fieldErrors : {};
  return (
    <Dialog open wide title={c ? c.name : 'New cover category'} onClose={onClose}>
      <ProblemBanner error={save.error} />
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Code" htmlFor="ct-code" error={fe.code} hint={`e.g. ${MEDICAL_CATEGORY_SUGGESTIONS.join(', ')}`}><Input id="ct-code" list="ct-sugg" value={v.code} onChange={(e) => setV({ ...v, code: e.target.value.toLowerCase() })} /><datalist id="ct-sugg">{MEDICAL_CATEGORY_SUGGESTIONS.map((s) => <option key={s} value={s} />)}</datalist></Field>
        <Field label="Name" htmlFor="ct-name"><Input id="ct-name" value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} /></Field>
        <Field label="Limit" htmlFor="ct-sh"><Select id="ct-sh" value={v.sharing} onChange={(e) => setV({ ...v, sharing: e.target.value as 'shared' })}><option value="shared">Shared by the family</option><option value="per_person">Each person has their own</option></Select></Field>
        <Field label="Co-payment (%)" htmlFor="ct-cp"><Input id="ct-cp" type="number" value={v.co_pay_pct} onChange={(e) => setV({ ...v, co_pay_pct: Number(e.target.value) })} /></Field>
        <Field label="Most per visit (KES, optional)" htmlFor="ct-cap"><Input id="ct-cap" type="number" value={v.per_visit_cap} onChange={(e) => setV({ ...v, per_visit_cap: e.target.value })} /></Field>
        <Field label="Waiting period (days)" htmlFor="ct-w"><Input id="ct-w" type="number" value={v.waiting_days} onChange={(e) => setV({ ...v, waiting_days: Number(e.target.value) })} /></Field>
      </div>
      <div className="mt-3 flex flex-wrap gap-4 text-sm">
        <label className="flex items-center gap-1"><input type="checkbox" checked={v.principal_and_spouse_only} onChange={(e) => setV({ ...v, principal_and_spouse_only: e.target.checked })} />Staff member and spouse only (e.g. maternity)</label>
        <label className="flex items-center gap-1"><input type="checkbox" checked={v.status === 'active'} onChange={(e) => setV({ ...v, status: e.target.checked ? 'active' : 'inactive' })} />In use</label>
      </div>
      <Footer busy={save.isPending} onClose={onClose} onSave={() => save.mutate()} />
    </Dialog>
  );
}

function LimitDialog({ scheme, onClose }: { scheme: Detail; onClose: () => void }) {
  const done = useSaved(onClose);
  const l = useLookups();
  const [v, setV] = useState({ category_id: scheme.categories[0]?.id ?? '', job_grade_id: '', employment_type: '', annual_limit: '', dependant_limit: '', effective_from: new Date().toISOString().slice(0, 10) });
  const cat = scheme.categories.find((c) => c.id === v.category_id);
  const save = useMutation({ mutationFn: () => unwrap(hr.POST('/api/v1/medical/schemes/{id}/limit-rules', { params: { path: { id: scheme.id } }, body: { category_id: v.category_id, job_grade_id: v.job_grade_id || null, employment_type: (v.employment_type || null) as never, annual_limit: Number(v.annual_limit).toFixed(2), dependant_limit: v.dependant_limit ? Number(v.dependant_limit).toFixed(2) : null, effective_from: v.effective_from } })), onSuccess: done });
  return (
    <Dialog open wide title="New limit from a date" onClose={onClose}>
      <ProblemBanner error={save.error} />
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Category" htmlFor="lm-c"><Select id="lm-c" value={v.category_id} onChange={(e) => setV({ ...v, category_id: e.target.value })}>{scheme.categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select></Field>
        <Field label="Grade" htmlFor="lm-g"><Select id="lm-g" value={v.job_grade_id} onChange={(e) => setV({ ...v, job_grade_id: e.target.value })}><option value="">All grades</option>{l.gradeOptions.map((g) => <option key={g.value} value={g.value}>{g.label}</option>)}</Select></Field>
        <Field label="Employment type" htmlFor="lm-t"><Select id="lm-t" value={v.employment_type} onChange={(e) => setV({ ...v, employment_type: e.target.value })}><option value="">All types</option>{EMPLOYMENT_TYPES.map((t) => <option key={t}>{t}</option>)}</Select></Field>
        <Field label={cat?.sharing === 'shared' ? 'Family limit a year (KES)' : 'Staff member’s limit a year (KES)'} htmlFor="lm-a"><Input id="lm-a" type="number" value={v.annual_limit} onChange={(e) => setV({ ...v, annual_limit: e.target.value })} /></Field>
        {cat?.sharing === 'per_person' && <Field label="Each dependant (KES)" htmlFor="lm-d" hint="Empty: same as the staff member"><Input id="lm-d" type="number" value={v.dependant_limit} onChange={(e) => setV({ ...v, dependant_limit: e.target.value })} /></Field>}
        <Field label="From" htmlFor="lm-f"><Input id="lm-f" type="date" value={v.effective_from} onChange={(e) => setV({ ...v, effective_from: e.target.value })} /></Field>
      </div>
      <p className="muted mt-2 text-xs">The most specific limit applies: grade and type, then grade, then type, then the general one. The limit in force for the same grade and type ends the day before this one starts.</p>
      <Footer busy={save.isPending} onClose={onClose} onSave={() => save.mutate()} />
    </Dialog>
  );
}

function RateDialog({ schemeId, onClose }: { schemeId: string; onClose: () => void }) {
  const done = useSaved(onClose);
  const l = useLookups();
  const [v, setV] = useState({ job_grade_id: '', employment_type: '', method: 'fixed' as 'fixed' | 'percent_basic', value: '', per_dependant: '0', effective_from: new Date().toISOString().slice(0, 10) });
  const save = useMutation({ mutationFn: () => unwrap(hr.POST('/api/v1/medical/schemes/{id}/contribution-rates', { params: { path: { id: schemeId } }, body: { job_grade_id: v.job_grade_id || null, employment_type: (v.employment_type || null) as never, method: v.method, value: Number(v.value), per_dependant: Number(v.per_dependant || 0).toFixed(2), effective_from: v.effective_from } })), onSuccess: done });
  return (
    <Dialog open wide title="New contribution rate from a date" onClose={onClose}>
      <ProblemBanner error={save.error} />
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Grade" htmlFor="rt-g"><Select id="rt-g" value={v.job_grade_id} onChange={(e) => setV({ ...v, job_grade_id: e.target.value })}><option value="">All grades</option>{l.gradeOptions.map((g) => <option key={g.value} value={g.value}>{g.label}</option>)}</Select></Field>
        <Field label="Employment type" htmlFor="rt-t"><Select id="rt-t" value={v.employment_type} onChange={(e) => setV({ ...v, employment_type: e.target.value })}><option value="">All types</option>{EMPLOYMENT_TYPES.map((t) => <option key={t}>{t}</option>)}</Select></Field>
        <Field label="How" htmlFor="rt-m"><Select id="rt-m" value={v.method} onChange={(e) => setV({ ...v, method: e.target.value as 'fixed' })}><option value="fixed">Fixed amount a month</option><option value="percent_basic">Percentage of basic pay</option></Select></Field>
        <Field label={v.method === 'fixed' ? 'KES a month' : '% of basic'} htmlFor="rt-v"><Input id="rt-v" type="number" step="0.01" value={v.value} onChange={(e) => setV({ ...v, value: e.target.value })} /></Field>
        <Field label="Extra for each dependant (KES)" htmlFor="rt-d"><Input id="rt-d" type="number" value={v.per_dependant} onChange={(e) => setV({ ...v, per_dependant: e.target.value })} /></Field>
        <Field label="From" htmlFor="rt-f"><Input id="rt-f" type="date" value={v.effective_from} onChange={(e) => setV({ ...v, effective_from: e.target.value })} /></Field>
      </div>
      <Footer busy={save.isPending} onClose={onClose} onSave={() => save.mutate()} />
    </Dialog>
  );
}
