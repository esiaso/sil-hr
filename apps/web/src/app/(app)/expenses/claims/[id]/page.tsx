'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { EXPENSE_CATEGORIES, formatDate, formatMoney } from '@sil/hr-shared';
import { Badge, Button, Card, Empty, Field, Input, Loading, PageHeader, ProblemBanner, Select } from '@/components/ui';
import { ApiError, hr, unwrap } from '@/lib/api';
import { useSession } from '@/lib/session';

type Claim = Awaited<ReturnType<typeof load>>;
const load = (id: string) => unwrap(hr.GET('/api/v1/expense-claims/{id}', { params: { path: { id } } }));

export default function ClaimPage() {
  const { id } = useParams<{ id: string }>();
  const { settings, me } = useSession();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['claim', id], queryFn: () => load(id) });
  const set = (c: Claim) => { qc.setQueryData(['claim', id], c); void qc.invalidateQueries({ queryKey: ['my-claims'] }); };
  const submit = useMutation({ mutationFn: () => unwrap(hr.POST('/api/v1/expense-claims/{id}/submit', { params: { path: { id } } })), onSuccess: set });
  const cancel = useMutation({ mutationFn: () => unwrap(hr.POST('/api/v1/expense-claims/{id}/cancel', { params: { path: { id } } })), onSuccess: set });
  const remove = useMutation({ mutationFn: (itemId: string) => unwrap(hr.DELETE('/api/v1/expense-claims/{id}/items/{itemId}', { params: { path: { id, itemId } } })), onSuccess: set });
  const c = q.data;
  const mine = c && c.employee_id === me.employee_id;
  const editable = mine && ['draft', 'returned'].includes(c.status);
  return (
    <div className="space-y-4">
      <PageHeader title={c ? c.title : 'Expense claim'} description={c ? `${c.number} · ${c.employee_name}${c.travel_number ? ` · trip ${c.travel_number}` : ''}` : undefined}
        actions={c && mine && (
          <div className="flex gap-2">
            {editable && <Button busy={submit.isPending} disabled={!c.items.length} onClick={() => submit.mutate()}>Submit for approval</Button>}
            {['draft', 'returned', 'pending'].includes(c.status) && <Button variant="ghost" busy={cancel.isPending} onClick={() => window.confirm('Cancel this claim?') && cancel.mutate()}>Cancel claim</Button>}
          </div>
        )}
      />
      <ProblemBanner error={q.error ?? submit.error ?? cancel.error ?? remove.error} />
      {!c ? <Loading /> : (
        <>
          <Card>
            <div className="flex flex-wrap gap-6 text-sm">
              <div><div className="muted text-xs">Status</div><Badge value={c.status} /></div>
              <div><div className="muted text-xs">Total</div><div className="text-lg font-semibold">{formatMoney(c.total)}</div></div>
              {Number(c.advance_offset) > 0 && <div><div className="muted text-xs">Less advance</div><div className="text-lg font-semibold">{formatMoney(c.advance_offset)}</div></div>}
              <div><div className="muted text-xs">{Number(c.net) < 0 ? 'To be recovered' : 'To be paid'}</div><div className="text-lg font-semibold">{formatMoney(String(Math.abs(Number(c.net))))}{c.paid_period && <span className="muted text-xs font-normal"> in {c.paid_period}</span>}</div></div>
            </div>
            {c.decision_comment && <p className="mt-3 text-sm"><b>Approver’s note:</b> {c.decision_comment}</p>}
          </Card>
          <Card>
            <h2 className="mb-2 font-semibold">Items</h2>
            {!c.items.length ? <Empty>No items yet.</Empty> : (
              <table className="data">
                <thead><tr><th>Date</th><th>Category</th><th>Description</th><th className="text-right">Amount</th><th>Receipt</th>{editable && <th />}</tr></thead>
                <tbody>{c.items.map((i) => (
                  <tr key={i.id}><td>{formatDate(i.spent_on, settings.date_format)}</td><td>{EXPENSE_CATEGORIES[i.category]}</td><td>{i.description}</td><td className="text-right">{formatMoney(i.amount)}</td>
                    <td>{i.receipt_document_id ? <a className="link" href={`/api/v1/expense-items/${i.id}/receipt`}>Open</a> : '–'}</td>
                    {editable && <td className="text-right"><button type="button" className="link text-sm" onClick={() => remove.mutate(i.id)}>Remove</button></td>}</tr>
                ))}</tbody>
              </table>
            )}
            {editable && <AddItem claimId={c.id} onDone={set} />}
          </Card>
        </>
      )}
    </div>
  );
}

function AddItem({ claimId, onDone }: { claimId: string; onDone: (c: Claim) => void }) {
  const [f, setF] = useState({ spent_on: new Date().toISOString().slice(0, 10), category: 'transport', description: '', amount: '' });
  const [file, setFile] = useState<File | null>(null);
  const [key, setKey] = useState(0);
  const save = useMutation({
    mutationFn: async () => {
      const body = new FormData();
      for (const [k, v] of Object.entries(f)) body.append(k, v);
      if (file) body.append('receipt', file);
      const res = await fetch(`/api/v1/expense-claims/${claimId}/items`, { method: 'POST', body, headers: { 'x-requested-with': 'sil-hr-web' } });
      const json = await res.json();
      if (!res.ok) throw new ApiError(res.status, json);
      return json as Claim;
    },
    onSuccess: (c) => { setF({ ...f, description: '', amount: '' }); setFile(null); setKey(key + 1); onDone(c); },
  });
  return (
    <div className="mt-4 rounded-xl border border-[var(--border)] p-3">
      <ProblemBanner error={save.error} />
      <div className="grid items-end gap-2 sm:grid-cols-[9rem_10rem_1fr_8rem]">
        <Field label="Date" htmlFor="it-d"><Input id="it-d" type="date" value={f.spent_on} onChange={(e) => setF({ ...f, spent_on: e.target.value })} /></Field>
        <Field label="Category" htmlFor="it-c"><Select id="it-c" value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>{Object.entries(EXPENSE_CATEGORIES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select></Field>
        <Field label="Description" htmlFor="it-de"><Input id="it-de" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
        <Field label="Amount (KES)" htmlFor="it-a"><Input id="it-a" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></Field>
      </div>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
        <label className="text-sm">Receipt (PDF or photo) <input key={key} type="file" accept="application/pdf,image/png,image/jpeg" className="ml-2 text-sm" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></label>
        <Button busy={save.isPending} onClick={() => save.mutate()}>Add item</Button>
      </div>
    </div>
  );
}
