'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { formatDate, formatMoney } from '@sil/hr-shared';
import { Badge, Button, Card, Dialog, Empty, Field, Input, Loading, PageHeader, ProblemBanner, Select, Textarea } from '@/components/ui';
import { hr, unwrap } from '@/lib/api';
import { useSession } from '@/lib/session';

export default function ExpensesPage() {
  const { settings } = useSession();
  const qc = useQueryClient();
  const router = useRouter();
  const trips = useQuery({ queryKey: ['my-trips'], queryFn: () => unwrap(hr.GET('/api/v1/me/travel-requests')) });
  const claims = useQuery({ queryKey: ['my-claims'], queryFn: () => unwrap(hr.GET('/api/v1/me/expense-claims')) });
  const [dialog, setDialog] = useState<'trip' | 'claim' | null>(null);
  const cancelTrip = useMutation({ mutationFn: (id: string) => unwrap(hr.POST('/api/v1/travel-requests/{id}/cancel', { params: { path: { id } } })), onSuccess: () => void qc.invalidateQueries({ queryKey: ['my-trips'] }) });
  const claimFor = useMutation({ mutationFn: (t: { id: string; destination: string }) => unwrap(hr.POST('/api/v1/expense-claims', { body: { title: `Trip to ${t.destination}`, travel_request_id: t.id } })), onSuccess: (c) => router.push(`/expenses/claims/${c.id}`) });
  const d = (x: string) => formatDate(x, settings.date_format);
  return (
    <div className="space-y-4">
      <PageHeader title="Travel and expenses" description="Ask before you travel (with an advance if you need one), then claim what you spent with receipts. Approved claims are paid with your salary." actions={<div className="flex gap-2"><Button variant="secondary" onClick={() => setDialog('trip')}>Plan a trip</Button><Button onClick={() => setDialog('claim')}>New expense claim</Button></div>} />
      <ProblemBanner error={trips.error ?? claims.error ?? cancelTrip.error ?? claimFor.error} />
      <Card>
        <h2 className="mb-2 font-semibold">My trips</h2>
        {!trips.data ? <Loading /> : !trips.data.length ? <Empty>No trips.</Empty> : (
          <table className="data">
            <thead><tr><th>Trip</th><th>Dates</th><th>Estimate</th><th>Advance</th><th>Status</th><th /></tr></thead>
            <tbody>{trips.data.map((t) => (
              <tr key={t.id}>
                <td><div className="font-medium">{t.destination}</div><div className="muted text-xs">{t.number} · {t.purpose}</div></td>
                <td className="whitespace-nowrap">{d(t.depart_on)} – {d(t.return_on)}</td><td>{formatMoney(t.estimated_cost)}</td>
                <td>{Number(t.advance) ? <>{formatMoney(t.advance)}{t.advance_period && <div className="muted text-xs">paid {t.advance_period}</div>}</> : '–'}</td>
                <td><Badge value={t.status} />{t.decision_comment && <div className="muted text-xs">{t.decision_comment}</div>}</td>
                <td className="whitespace-nowrap text-right">
                  {['pending', 'returned'].includes(t.status) && <button type="button" className="link text-sm" onClick={() => cancelTrip.mutate(t.id)}>Cancel</button>}
                  {t.status === 'approved' && (t.claim_id ? <Link className="link text-sm" href={`/expenses/claims/${t.claim_id}`}>Open claim</Link> : <button type="button" className="link text-sm" onClick={() => claimFor.mutate(t)}>Claim expenses</button>)}
                </td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </Card>
      <Card>
        <h2 className="mb-2 font-semibold">My expense claims</h2>
        {!claims.data ? <Loading /> : !claims.data.length ? <Empty>No claims.</Empty> : <ClaimTable rows={claims.data} />}
      </Card>
      {dialog === 'trip' && <TripDialog onClose={() => setDialog(null)} />}
      {dialog === 'claim' && <ClaimDialog onClose={() => setDialog(null)} />}
    </div>
  );
}

function ClaimTable({ rows }: { rows: { id: string; number: string; title: string; total: string; net: string; status: string; paid_period: string | null; travel_number: string | null; decision_comment: string | null }[] }) {
  return (
    <table className="data">
      <thead><tr><th>Claim</th><th>Total</th><th>Paid with salary</th><th>Status</th></tr></thead>
      <tbody>{rows.map((c) => (
        <tr key={c.id}>
          <td><Link className="link" href={`/expenses/claims/${c.id}`}>{c.title}</Link><div className="muted text-xs">{c.number}{c.travel_number ? ` · ${c.travel_number}` : ''}</div></td>
          <td>{formatMoney(c.total)}</td>
          <td>{c.status === 'approved' ? `${Number(c.net) < 0 ? `${formatMoney(String(-Number(c.net)))} recovered` : formatMoney(c.net)} in ${c.paid_period}` : '–'}</td>
          <td><Badge value={c.status} />{c.decision_comment && <div className="muted text-xs">{c.decision_comment}</div>}</td>
        </tr>
      ))}</tbody>
    </table>
  );
}

function TripDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ purpose: '', destination: '', depart_on: '', return_on: '', estimated_cost: '', advance: '' });
  const save = useMutation({ mutationFn: () => unwrap(hr.POST('/api/v1/travel-requests', { body: { ...f, estimated_cost: f.estimated_cost || '0', advance: f.advance || '0' } })), onSuccess: () => { void qc.invalidateQueries({ queryKey: ['my-trips'] }); onClose(); } });
  const text = (k: keyof typeof f, l: string, type = 'text', hint?: string) => <Field label={l} hint={hint} htmlFor={`tr-${k}`}><Input id={`tr-${k}`} type={type} value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} /></Field>;
  return (
    <Dialog open title="Plan a trip" onClose={onClose}>
      <ProblemBanner error={save.error} />
      <div className="grid gap-3 sm:grid-cols-2">
        {text('destination', 'Destination')}{text('estimated_cost', 'Estimated cost (KES)')}
        {text('depart_on', 'Leaving', 'date')}{text('return_on', 'Returning', 'date')}
        {text('advance', 'Advance needed (KES)', 'text', 'Paid with your next salary; finance approves it too')}
      </div>
      <Field label="Purpose" htmlFor="tr-p"><Textarea id="tr-p" value={f.purpose} onChange={(e) => setF({ ...f, purpose: e.target.value })} /></Field>
      <div className="mt-4 flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button busy={save.isPending} onClick={() => save.mutate()}>Send for approval</Button></div>
    </Dialog>
  );
}

function ClaimDialog({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const trips = useQuery({ queryKey: ['my-trips'], queryFn: () => unwrap(hr.GET('/api/v1/me/travel-requests')) });
  const [f, setF] = useState({ title: '', travel_request_id: '' });
  const save = useMutation({ mutationFn: () => unwrap(hr.POST('/api/v1/expense-claims', { body: { title: f.title, travel_request_id: f.travel_request_id || null } })), onSuccess: (c) => router.push(`/expenses/claims/${c.id}`) });
  return (
    <Dialog open title="New expense claim" onClose={onClose}>
      <ProblemBanner error={save.error} />
      <Field label="What is it for" htmlFor="cl-t"><Input id="cl-t" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
      <Field label="Trip (optional)" htmlFor="cl-tr" hint="A trip's advance is taken off the claim"><Select id="cl-tr" value={f.travel_request_id} onChange={(e) => setF({ ...f, travel_request_id: e.target.value })}><option value="">Not for a trip</option>{trips.data?.filter((t) => t.status === 'approved' && !t.claim_id).map((t) => <option key={t.id} value={t.id}>{t.destination} ({t.number})</option>)}</Select></Field>
      <div className="mt-4 flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button busy={save.isPending} onClick={() => save.mutate()}>Start the claim</Button></div>
    </Dialog>
  );
}
