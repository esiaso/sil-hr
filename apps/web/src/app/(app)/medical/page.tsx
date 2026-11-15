'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { formatDate, formatMoney, MEDICAL_APPLICATION_KINDS } from '@sil/hr-shared';
import { CoverGrid, RELATIONSHIP, type Cover } from '@/components/medical';
import { Badge, Button, Card, Dialog, Empty, Field, Input, Loading, PageHeader, ProblemBanner, Select, Textarea } from '@/components/ui';
import { ApiError, hr, unwrap } from '@/lib/api';
import { useSession } from '@/lib/session';

type Kind = 'enrol' | 'add_dependant' | 'remove_dependant' | 'top_up' | 'pre_auth';

/** Uploads one file as a document the member owns; returns its id. */
async function uploadDoc(file: File): Promise<string> {
  const body = new FormData();
  body.set('file', file);
  const res = await fetch(`/api/v1/me/medical/documents?title=${encodeURIComponent(file.name)}`, { method: 'POST', body, headers: { 'x-requested-with': 'sil-hr-web' } });
  const json = await res.json();
  if (!res.ok) throw new ApiError(res.status, json);
  return json.id as string;
}

export default function MyMedicalPage() {
  const { me, settings } = useSession();
  const q = useQuery({ queryKey: ['my-medical'], queryFn: () => unwrap(hr.GET('/api/v1/me/medical')) });
  const schemes = useQuery({ queryKey: ['medical-schemes'], queryFn: () => unwrap(hr.GET('/api/v1/medical/schemes')) });
  const [dialog, setDialog] = useState<{ kind: Kind; cover?: Cover } | null>(null);
  if (!me.employee_id) return <div><PageHeader title="My medical cover" /><Empty>Your account is not linked to an employee record. Ask HR.</Empty></div>;
  const memberships = (q.data?.memberships ?? []) as unknown as Cover[];
  const joinable = (schemes.data ?? []).filter((s) => s.status === 'active' && !memberships.some((m) => m.scheme_name === s.name));
  return (
    <div className="space-y-6">
      <PageHeader title="My medical cover" description="What you and your family are covered for, what is left this scheme year, and your applications. The hospital pays for the cover." actions={joinable.length > 0 && <Button onClick={() => setDialog({ kind: 'enrol' })}>Join a scheme</Button>} />
      <ProblemBanner error={q.error} />
      {!q.data ? <Loading /> : !memberships.length ? <Card><Empty>You are not in a medical scheme yet.{joinable.length > 0 && ' Use “Join a scheme” to apply.'}</Empty></Card> : memberships.map((c) => (
        <section key={c.id} className="space-y-3">
          <div className="flex flex-wrap items-end justify-between gap-2">
            <div>
              <h2 className="text-lg font-semibold">{c.scheme_name}</h2>
              <div className="muted text-sm">Member number <span className="font-mono">{c.member_number}</span> · covered from {formatDate(c.cover_start, settings.date_format)}</div>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" onClick={() => setDialog({ kind: 'add_dependant', cover: c })}>Add a dependant</Button>
              <Button variant="secondary" onClick={() => setDialog({ kind: 'pre_auth', cover: c })}>Pre-authorise a procedure</Button>
              <Button variant="secondary" onClick={() => setDialog({ kind: 'top_up', cover: c })}>Ask for a top-up</Button>
            </div>
          </div>
          <CoverGrid cover={c} dateFormat={settings.date_format} />
          <Card>
            <h3 className="mb-2 font-semibold">Covered people</h3>
            <table className="data">
              <thead><tr><th>Name</th><th>Relationship</th><th>Member number</th><th>Covered from</th><th /></tr></thead>
              <tbody>{c.family.map((f) => (
                <tr key={f.id}><td>{f.name}</td><td>{RELATIONSHIP[f.relationship]}</td><td className="font-mono text-xs">{f.member_number}</td><td>{formatDate(f.cover_start, settings.date_format)}</td>
                  <td className="text-right">{f.relationship !== 'principal' && f.status === 'active' && <Button variant="ghost" onClick={() => setDialog({ kind: 'remove_dependant', cover: { ...c, id: f.id, name: f.name } })}>Remove</Button>}</td></tr>
              ))}</tbody>
            </table>
            {c.holds.length > 0 && <p className="muted mt-3 text-sm">Pre-authorised and held: {c.holds.map((h) => `${formatMoney(h.amount)} (${h.category_code}, until ${formatDate(h.expires_on, settings.date_format)})`).join('; ')}</p>}
          </Card>
        </section>
      ))}
      {q.data && q.data.applications.length > 0 && (
        <Card>
          <h2 className="mb-2 font-semibold">My applications</h2>
          <table className="data">
            <thead><tr><th>Number</th><th>What</th><th>For</th><th className="text-right">Amount</th><th>Sent</th><th>Status</th></tr></thead>
            <tbody>{q.data.applications.map((a) => (
              <tr key={a.id}><td className="font-mono text-xs">{a.number}</td><td>{MEDICAL_APPLICATION_KINDS[a.kind]}</td><td>{a.member_name ?? a.scheme_name}</td><td className="text-right tabular-nums">{a.amount ? formatMoney(a.amount, '') : ''}</td><td>{formatDate(a.created_at.slice(0, 10), settings.date_format)}</td><td><Badge value={a.status} />{a.decision_comment && <div className="muted text-xs">{a.decision_comment}</div>}</td></tr>
            ))}</tbody>
          </table>
        </Card>
      )}
      {dialog && <ApplyDialog kind={dialog.kind} cover={dialog.cover} schemes={joinable} onClose={() => setDialog(null)} />}
    </div>
  );
}

function ApplyDialog({ kind, cover, schemes, onClose }: { kind: Kind; cover?: Cover; schemes: { id: string; name: string; max_dependants: number }[]; onClose: () => void }) {
  const qc = useQueryClient();
  const allSchemes = useQuery({ queryKey: ['medical-schemes'], queryFn: () => unwrap(hr.GET('/api/v1/medical/schemes')) });
  const schemeId = kind === 'enrol' ? undefined : allSchemes.data?.find((s) => s.name === cover?.scheme_name)?.id;
  const [v, setV] = useState({ scheme_id: schemes[0]?.id ?? '', member_id: cover?.id ?? '', category_id: cover?.balances[0]?.category_id ?? '', amount: '', planned_date: '', facility: '', procedure: '', reason: '', effective_date: '' });
  const [deps, setDeps] = useState<{ name: string; relationship: 'spouse' | 'child' | 'other'; date_of_birth: string }[]>(kind === 'add_dependant' ? [{ name: '', relationship: 'child', date_of_birth: '' }] : []);
  const files = useRef<HTMLInputElement>(null);
  const send = useMutation({
    mutationFn: async () => {
      const document_ids = await Promise.all([...(files.current?.files ?? [])].map(uploadDoc));
      const sid = kind === 'enrol' ? v.scheme_id : schemeId!;
      const body = {
        enrol: { kind, scheme_id: sid, dependants: deps, document_ids, reason: v.reason || null, ...(v.effective_date ? { effective_date: v.effective_date } : {}) },
        add_dependant: { kind, scheme_id: sid, dependant: deps[0], document_ids, reason: v.reason || null },
        remove_dependant: { kind, scheme_id: sid, member_id: v.member_id, reason: v.reason },
        top_up: { kind, scheme_id: sid, member_id: v.member_id, category_id: v.category_id, amount: Number(v.amount).toFixed(2), document_ids, reason: v.reason },
        pre_auth: { kind, scheme_id: sid, member_id: v.member_id, category_id: v.category_id, amount: Number(v.amount).toFixed(2), planned_date: v.planned_date, facility: v.facility, procedure: v.procedure, document_ids, reason: v.reason || null },
      }[kind];
      return unwrap(hr.POST('/api/v1/me/medical/applications', { body: body as never }));
    },
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['my-medical'] }); onClose(); },
  });
  const fe = send.error instanceof ApiError ? send.error.fieldErrors : {};
  const people = cover ? cover.family.filter((f) => f.status === 'active') : [];
  const depRows = (max: number) => (
    <div className="space-y-2">
      {deps.map((d, i) => (
        <div key={i} className="grid grid-cols-1 gap-2 sm:grid-cols-[2fr_1fr_1fr_auto]">
          <Input aria-label={`Dependant ${i + 1} name`} placeholder="Full name" value={d.name} onChange={(e) => setDeps(deps.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
          <Select aria-label={`Dependant ${i + 1} relationship`} value={d.relationship} onChange={(e) => setDeps(deps.map((x, j) => (j === i ? { ...x, relationship: e.target.value as 'child' } : x)))}><option value="spouse">Spouse</option><option value="child">Child</option><option value="other">Other</option></Select>
          <Input aria-label={`Dependant ${i + 1} date of birth`} type="date" value={d.date_of_birth} onChange={(e) => setDeps(deps.map((x, j) => (j === i ? { ...x, date_of_birth: e.target.value } : x)))} />
          {kind === 'enrol' && <Button variant="ghost" onClick={() => setDeps(deps.filter((_, j) => j !== i))}>Remove</Button>}
        </div>
      ))}
      {kind === 'enrol' && deps.length < max && <Button variant="secondary" onClick={() => setDeps([...deps, { name: '', relationship: 'child', date_of_birth: '' }])}>Add a dependant</Button>}
    </div>
  );
  return (
    <Dialog open wide title={MEDICAL_APPLICATION_KINDS[kind]} onClose={onClose}>
      <ProblemBanner error={send.error} />
      <div className="space-y-3">
        {kind === 'enrol' && <>
          <Field label="Scheme" htmlFor="ap-s"><Select id="ap-s" value={v.scheme_id} onChange={(e) => setV({ ...v, scheme_id: e.target.value })}>{schemes.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select></Field>
          <div className="text-sm font-medium">Dependants to cover (spouse and children)</div>
          {depRows(schemes.find((s) => s.id === v.scheme_id)?.max_dependants ?? 5)}
          <Field label="Start from (optional)" htmlFor="ap-eff"><Input id="ap-eff" type="date" value={v.effective_date} onChange={(e) => setV({ ...v, effective_date: e.target.value })} className="max-w-48" /></Field>
        </>}
        {kind === 'add_dependant' && depRows(1)}
        {kind === 'remove_dependant' && <p className="text-sm">Cover for <b>{cover?.name}</b> will end once HR approves.</p>}
        {(kind === 'top_up' || kind === 'pre_auth') && (
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="For" htmlFor="ap-m"><Select id="ap-m" value={v.member_id} onChange={(e) => setV({ ...v, member_id: e.target.value })}>{people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select></Field>
            <Field label="Cover" htmlFor="ap-c"><Select id="ap-c" value={v.category_id} onChange={(e) => setV({ ...v, category_id: e.target.value })}>{cover?.balances.map((b) => <option key={b.category_id} value={b.category_id}>{b.category_name}</option>)}</Select></Field>
            <Field label="Amount (KES)" htmlFor="ap-a" error={fe.amount}><Input id="ap-a" type="number" step="0.01" value={v.amount} onChange={(e) => setV({ ...v, amount: e.target.value })} /></Field>
          </div>
        )}
        {kind === 'pre_auth' && (
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Planned date" htmlFor="ap-d"><Input id="ap-d" type="date" value={v.planned_date} onChange={(e) => setV({ ...v, planned_date: e.target.value })} /></Field>
            <Field label="Facility" htmlFor="ap-f"><Input id="ap-f" value={v.facility} onChange={(e) => setV({ ...v, facility: e.target.value })} /></Field>
            <Field label="Procedure" htmlFor="ap-p"><Input id="ap-p" value={v.procedure} onChange={(e) => setV({ ...v, procedure: e.target.value })} /></Field>
          </div>
        )}
        {kind !== 'remove_dependant' && <Field label={kind === 'add_dependant' ? 'Birth or marriage certificate' : 'Supporting documents (optional)'} htmlFor="ap-files" hint="PDF or a photo"><input id="ap-files" ref={files} type="file" multiple accept="application/pdf,image/png,image/jpeg" className="text-sm" /></Field>}
        <Field label={kind === 'remove_dependant' || kind === 'top_up' ? 'Reason' : 'Anything HR should know (optional)'} htmlFor="ap-r" error={fe.reason}><Textarea id="ap-r" value={v.reason} onChange={(e) => setV({ ...v, reason: e.target.value })} /></Field>
        <p className="muted text-xs">An HR officer checks it, then the HR manager approves. You will be notified.</p>
        <div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button busy={send.isPending} onClick={() => send.mutate()}>Send</Button></div>
      </div>
    </Dialog>
  );
}
