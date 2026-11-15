'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { formatDate, formatMoney } from '@sil/hr-shared';
import { CoverGrid, RELATIONSHIP, type Cover } from '@/components/medical';
import { Badge, Button, Card, Dialog, Empty, Field, Input, Loading, PageHeader, ProblemBanner, Select } from '@/components/ui';
import { ApiError, hr, newIdempotencyKey, unwrap } from '@/lib/api';
import { useSession } from '@/lib/session';

/**
 * The billing desk: find a member, see their cover and what is left, record claims and
 * holds, reverse mistakes. Shows no pay or HR records; every lookup is audited.
 */
export default function BillingPage() {
  const { can, settings } = useSession();
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const found = useQuery({ queryKey: ['med-lookup', q], enabled: q.trim().length >= 2, queryFn: () => unwrap(hr.GET('/api/v1/medical/lookup', { params: { query: { q } } })) });
  return (
    <div className="space-y-5">
      <PageHeader title="Billing desk" description="Look up a member by staff number, member number or name (staff or dependant). You see cover and limits only. Every lookup and entry is recorded." />
      <form className="flex max-w-xl gap-2" onSubmit={(e) => { e.preventDefault(); }}>
        <Input aria-label="Search members" placeholder="Staff number, member number or name" value={q} onChange={(e) => { setQ(e.target.value); setSelected(null); }} />
      </form>
      <ProblemBanner error={found.error} />
      {!selected && q.trim().length >= 2 && (
        <Card>
          {!found.data ? <Loading /> : !found.data.length ? <Empty>No member matches.</Empty> : (
            <table className="data">
              <thead><tr><th>Member number</th><th>Name</th><th>Relationship</th><th>Staff number</th><th>Scheme</th><th>Status</th></tr></thead>
              <tbody>{found.data.map((m) => (
                <tr key={m.id} className="cursor-pointer" onClick={() => setSelected(m.id)}>
                  <td className="font-mono text-xs">{m.member_number}</td><td className="font-medium">{m.name}</td><td>{RELATIONSHIP[m.relationship]}</td><td>{m.staff_number}</td><td>{m.scheme_name}</td><td><Badge value={m.status} /></td>
                </tr>
              ))}</tbody>
            </table>
          )}
        </Card>
      )}
      {selected && <MemberDesk id={selected} onPick={setSelected} canWrite={can('medical_claim:write')} dateFormat={settings.date_format} />}
    </div>
  );
}

function MemberDesk({ id, onPick, canWrite, dateFormat }: { id: string; onPick: (id: string) => void; canWrite: boolean; dateFormat: string }) {
  const qc = useQueryClient();
  const cover = useQuery({ queryKey: ['med-cover', id], queryFn: () => unwrap(hr.GET('/api/v1/medical/members/{id}/cover', { params: { path: { id } } })) as Promise<Cover> });
  const ledger = useQuery({ queryKey: ['med-ledger', id], queryFn: () => unwrap(hr.GET('/api/v1/medical/members/{id}/ledger', { params: { path: { id } } })) });
  const [dialog, setDialog] = useState<'claim' | 'hold' | { reverse: string } | { release: string } | null>(null);
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['med-cover'] }); void qc.invalidateQueries({ queryKey: ['med-ledger'] }); };
  if (!cover.data) return <Card><ProblemBanner error={cover.error} /><Loading /></Card>;
  const c = cover.data;
  return (
    <div className="space-y-4">
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="text-xl font-semibold" style={{ color: 'var(--title)' }}>{c.name}</div>
            <div className="muted text-sm">{RELATIONSHIP[c.relationship]} · <span className="font-mono">{c.member_number}</span> · {c.scheme_name} · staff {c.staff_number}{c.department ? ` · ${c.department}` : ''}</div>
            <div className="mt-1 text-sm">{c.status === 'active' ? <>Covered from {formatDate(c.cover_start, dateFormat)}</> : <span className="text-red-600">Cover ended {formatDate(c.cover_end, dateFormat)}</span>}</div>
          </div>
          {canWrite && c.status === 'active' && <div className="flex gap-2"><Button onClick={() => setDialog('claim')}>Record a claim</Button><Button variant="secondary" onClick={() => setDialog('hold')}>Hold an amount</Button></div>}
        </div>
        {c.family.length > 1 && (
          <div className="mt-3 flex flex-wrap gap-2 text-sm">
            {c.family.map((f) => <button key={f.id} type="button" onClick={() => onPick(f.id)} className={`rounded-full border px-3 py-1 ${f.id === c.id ? 'border-brand-500 bg-brand-50 text-brand-700 dark:bg-brand-500/15 dark:text-brand-200' : 'border-[var(--border)] hover:bg-[var(--hover)]'}`}>{f.name} <span className="muted text-xs">{RELATIONSHIP[f.relationship]}</span></button>)}
          </div>
        )}
      </Card>
      <CoverGrid cover={c} dateFormat={dateFormat} />
      {c.holds.length > 0 && (
        <Card>
          <h3 className="mb-2 font-semibold">Holds and pre-authorisations</h3>
          <table className="data"><thead><tr><th>Cover</th><th>For</th><th className="text-right">Amount</th><th>Until</th><th>Reference</th><th /></tr></thead>
            <tbody>{c.holds.map((h) => <tr key={h.id}><td>{h.category_code}</td><td>{c.family.find((f) => f.id === h.member_id)?.name}</td><td className="text-right tabular-nums">{formatMoney(h.amount, '')}</td><td>{formatDate(h.expires_on, dateFormat)}</td><td className="font-mono text-xs">{h.reference}</td><td className="text-right">{canWrite && <Button variant="ghost" onClick={() => setDialog({ release: h.id })}>Release</Button>}</td></tr>)}</tbody>
          </table>
        </Card>
      )}
      <Card>
        <h3 className="mb-2 font-semibold">Usage this family</h3>
        {!ledger.data ? <Loading /> : !ledger.data.length ? <Empty>Nothing yet.</Empty> : (
          <div className="overflow-x-auto">
            <table className="data text-sm">
              <thead><tr><th>Date</th><th>Who</th><th>Entry</th><th>Cover</th><th>Facility</th><th>Invoice</th><th className="text-right">Scheme</th><th className="text-right">Member paid</th><th /></tr></thead>
              <tbody>{ledger.data.map((l) => (
                <tr key={l.id} className={l.reversed ? 'opacity-50' : ''}>
                  <td className="whitespace-nowrap">{formatDate(l.occurred_on, dateFormat)}</td><td>{l.member_name}</td><td><Badge value={l.entry_type} />{l.reversed && <span className="muted ml-1 text-xs">reversed</span>}</td><td>{l.category_code}</td><td>{l.facility}</td><td className="font-mono text-xs">{l.invoice_ref}</td>
                  <td className="text-right tabular-nums">{formatMoney(l.amount, '')}</td><td className="text-right tabular-nums">{l.member_share ? formatMoney(l.member_share, '') : ''}</td>
                  <td className="text-right">{canWrite && l.entry_type === 'claim' && !l.reversed && <Button variant="ghost" onClick={() => setDialog({ reverse: l.id })}>Reverse</Button>}{l.reason && <div className="muted max-w-48 text-xs">{l.reason}</div>}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </Card>
      {dialog === 'claim' && <ClaimDialog cover={c} onClose={() => { setDialog(null); refresh(); }} />}
      {dialog === 'hold' && <HoldDialog cover={c} onClose={() => { setDialog(null); refresh(); }} />}
      {dialog && typeof dialog === 'object' && <ReasonDialog title={'reverse' in dialog ? 'Reverse this claim' : 'Release this hold'} onClose={() => { setDialog(null); refresh(); }} send={(reason) => ('reverse' in dialog ? unwrap(hr.POST('/api/v1/medical/claims/{id}/reverse', { params: { path: { id: dialog.reverse } }, body: { reason } })) : unwrap(hr.POST('/api/v1/medical/holds/{id}/release', { params: { path: { id: dialog.release } }, body: { reason } })))} />}
    </div>
  );
}

function ClaimDialog({ cover, onClose }: { cover: Cover; onClose: () => void }) {
  const today = new Date().toISOString().slice(0, 10);
  const [v, setV] = useState({ category_code: cover.balances.find((b) => b.eligible)?.category_code ?? '', occurred_on: today, invoice_amount: '', facility: '', department: '', invoice_ref: '', hold_id: '' });
  const [key] = useState(newIdempotencyKey);
  const file = useRef<HTMLInputElement>(null);
  const [result, setResult] = useState<{ status: string; remaining: string; message: string | null } | null>(null);
  const b = cover.balances.find((x) => x.category_code === v.category_code);
  const inv = Number(v.invoice_amount || 0);
  const scheme = b ? Math.min(inv * (1 - b.co_pay_pct / 100), b.per_visit_cap ? Number(b.per_visit_cap) : Infinity) : 0;
  const send = useMutation({
    mutationFn: async () => {
      let document_id: string | undefined;
      const f = file.current?.files?.[0];
      if (f) {
        const body = new FormData();
        body.set('file', f);
        const res = await fetch(`/api/v1/medical/documents?title=${encodeURIComponent(`Invoice ${v.invoice_ref}`)}`, { method: 'POST', body, headers: { 'x-requested-with': 'sil-hr-web' } });
        const json = await res.json();
        if (!res.ok) throw new ApiError(res.status, json);
        document_id = json.id;
      }
      return unwrap(hr.POST('/api/v1/medical/claims', { params: { header: { 'Idempotency-Key': key } as never }, body: { member_id: cover.id, category_code: v.category_code, occurred_on: v.occurred_on, invoice_amount: inv.toFixed(2), facility: v.facility, department: v.department || null, invoice_ref: v.invoice_ref, ...(v.hold_id ? { hold_id: v.hold_id } : {}), ...(document_id ? { document_id } : {}) } }));
    },
    onSuccess: (r) => setResult({ status: r.status, remaining: r.remaining, message: r.message }),
  });
  const fe = send.error instanceof ApiError ? send.error.fieldErrors : {};
  if (result) return (
    <Dialog open title={result.status === 'posted' ? 'Claim recorded' : 'Sent for approval'} onClose={onClose}>
      <p className="text-sm">{result.status === 'posted' ? <>Recorded. <b>{formatMoney(result.remaining)}</b> is left on this cover.</> : <>{result.message}. HR will approve or reject it; the member is not charged to the limit until then.</>}</p>
      <div className="mt-4 flex justify-end"><Button onClick={onClose}>Done</Button></div>
    </Dialog>
  );
  return (
    <Dialog open wide title={`Claim for ${cover.name}`} onClose={onClose}>
      <ProblemBanner error={send.error} />
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Cover" htmlFor="cl-c"><Select id="cl-c" value={v.category_code} onChange={(e) => setV({ ...v, category_code: e.target.value })}>{cover.balances.map((x) => <option key={x.category_code} value={x.category_code} disabled={!x.eligible}>{x.category_name}{!x.eligible ? ' (not covered)' : ''}</option>)}</Select></Field>
        <Field label="Date of service" htmlFor="cl-d"><Input id="cl-d" type="date" value={v.occurred_on} onChange={(e) => setV({ ...v, occurred_on: e.target.value })} /></Field>
        <Field label="Invoice total (KES)" htmlFor="cl-a" error={fe.invoice_amount}><Input id="cl-a" type="number" step="0.01" value={v.invoice_amount} onChange={(e) => setV({ ...v, invoice_amount: e.target.value })} /></Field>
        <Field label="Facility" htmlFor="cl-f" error={fe.facility}><Input id="cl-f" value={v.facility} onChange={(e) => setV({ ...v, facility: e.target.value })} /></Field>
        <Field label="Department (optional)" htmlFor="cl-dep"><Input id="cl-dep" value={v.department} onChange={(e) => setV({ ...v, department: e.target.value })} /></Field>
        <Field label="Invoice number" htmlFor="cl-ref" error={fe.invoice_ref}><Input id="cl-ref" value={v.invoice_ref} onChange={(e) => setV({ ...v, invoice_ref: e.target.value })} /></Field>
        {cover.holds.length > 0 && <Field label="Settles a hold (optional)" htmlFor="cl-h"><Select id="cl-h" value={v.hold_id} onChange={(e) => setV({ ...v, hold_id: e.target.value })}><option value="">None</option>{cover.holds.map((h) => <option key={h.id} value={h.id}>{h.category_code} · {formatMoney(h.amount, '')}{h.reference ? ` · ${h.reference}` : ''}</option>)}</Select></Field>}
        <Field label="Invoice copy (optional)" htmlFor="cl-file"><input id="cl-file" ref={file} type="file" accept="application/pdf,image/png,image/jpeg" className="text-sm" /></Field>
      </div>
      {b && inv > 0 && <p className="mt-3 rounded-lg bg-[var(--surface-2)] px-3 py-2 text-sm">The scheme pays <b>{formatMoney(scheme.toFixed(2))}</b>{inv - scheme > 0 ? <>; the member pays {formatMoney((inv - scheme).toFixed(2))} at the counter</> : ''}. {formatMoney(b.remaining)} is left on {b.category_name}.</p>}
      <div className="mt-4 flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button busy={send.isPending} disabled={!v.invoice_amount || !v.facility || !v.invoice_ref} onClick={() => send.mutate()}>Record</Button></div>
    </Dialog>
  );
}

function HoldDialog({ cover, onClose }: { cover: Cover; onClose: () => void }) {
  const [v, setV] = useState({ category_code: cover.balances.find((b) => b.eligible)?.category_code ?? '', amount: '', expires_on: new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10), external_ref: '', reason: '' });
  const send = useMutation({ mutationFn: () => unwrap(hr.POST('/api/v1/medical/holds', { body: { member_id: cover.id, category_code: v.category_code, amount: Number(v.amount).toFixed(2), expires_on: v.expires_on, ...(v.external_ref ? { external_ref: v.external_ref } : {}), reason: v.reason || null } })), onSuccess: onClose });
  return (
    <Dialog open title={`Hold an amount for ${cover.name}`} onClose={onClose}>
      <ProblemBanner error={send.error} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Cover" htmlFor="h-c"><Select id="h-c" value={v.category_code} onChange={(e) => setV({ ...v, category_code: e.target.value })}>{cover.balances.filter((b) => b.eligible).map((b) => <option key={b.category_code} value={b.category_code}>{b.category_name} ({formatMoney(b.remaining, '')} left)</option>)}</Select></Field>
        <Field label="Amount (KES)" htmlFor="h-a"><Input id="h-a" type="number" step="0.01" value={v.amount} onChange={(e) => setV({ ...v, amount: e.target.value })} /></Field>
        <Field label="Hold until" htmlFor="h-e"><Input id="h-e" type="date" value={v.expires_on} onChange={(e) => setV({ ...v, expires_on: e.target.value })} /></Field>
        <Field label="Reference (e.g. admission number)" htmlFor="h-r"><Input id="h-r" value={v.external_ref} onChange={(e) => setV({ ...v, external_ref: e.target.value })} /></Field>
      </div>
      <p className="muted mt-2 text-xs">The amount is reserved so it cannot be spent twice. It is released when claimed, when you release it, or on the date above.</p>
      <div className="mt-4 flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button busy={send.isPending} disabled={!v.amount} onClick={() => send.mutate()}>Hold</Button></div>
    </Dialog>
  );
}

function ReasonDialog({ title, send, onClose }: { title: string; send: (reason: string) => Promise<unknown>; onClose: () => void }) {
  const [reason, setReason] = useState('');
  const m = useMutation({ mutationFn: () => send(reason), onSuccess: onClose });
  return (
    <Dialog open title={title} onClose={onClose}>
      <ProblemBanner error={m.error} />
      <Field label="Reason" htmlFor="rs"><Input id="rs" value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      <p className="muted mt-2 text-xs">Entries are never edited or deleted: a reversal is recorded next to the original.</p>
      <div className="mt-4 flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button busy={m.isPending} disabled={reason.length < 3} onClick={() => m.mutate()}>Confirm</Button></div>
    </Dialog>
  );
}
