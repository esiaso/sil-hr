'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { formatDate, type LeaveRequest } from '@sil/hr-shared';
import { Badge, Button, Card, Dialog, Empty, Field, Input, Loading, PageHeader, ProblemBanner, Select, Textarea } from '@/components/ui';
import { ApiError, hr, unwrap } from '@/lib/api';
import { useSession } from '@/lib/session';

type Form = { leave_type_id: string; start_date: string; end_date: string; start_half_day: boolean; end_half_day: boolean; reason: string };

/** Self-service leave: balances, apply with a live day count, and my requests. Works on a phone. */
export default function MyLeavePage() {
  const { settings } = useSession();
  const qc = useQueryClient();
  const df = (d: string) => formatDate(d, settings.date_format);
  const balances = useQuery({ queryKey: ['my-leave', 'balances'], queryFn: () => unwrap(hr.GET('/api/v1/me/leave/balances')), retry: false });
  const requests = useQuery({ queryKey: ['my-leave', 'requests'], queryFn: () => unwrap(hr.GET('/api/v1/me/leave/requests', { params: { query: { limit: 50 } } })), retry: false });
  const types = useQuery({ queryKey: ['leave-types'], queryFn: () => unwrap(hr.GET('/api/v1/leave/types')) });
  const [applying, setApplying] = useState<LeaveRequest | true | null>(null);
  const cancel = useMutation({
    mutationFn: (id: string) => unwrap(hr.POST('/api/v1/leave/requests/{id}/cancel', { params: { path: { id } }, body: {} })),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['my-leave'] }),
  });

  if (balances.error instanceof ApiError && balances.error.status === 404) return <div><PageHeader title="My leave" /><Empty>Your account is not linked to an employee record. Ask HR.</Empty></div>;
  return (
    <div className="space-y-4">
      <PageHeader title="My leave" description="What you have left this leave year, and your requests." actions={<Button onClick={() => setApplying(true)}>Apply for leave</Button>} />
      <ProblemBanner error={balances.error ?? cancel.error} />
      {!balances.data ? <Loading /> : (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {balances.data.filter((b) => b.entitled + b.carried_forward + b.adjustments > 0 || b.taken > 0).map((b) => (
            <Card key={b.leave_type_id}>
              <div className="muted text-xs">{b.leave_type_name}</div>
              <div className="mt-1 text-2xl font-semibold">{b.available}</div>
              <div className="muted text-xs">available · {b.taken} taken{b.reserved ? ` · ${b.reserved} pending` : ''}{b.carried_forward ? ` · ${b.carried_forward} carried over` : ''}</div>
            </Card>
          ))}
        </div>
      )}
      <Card>
        <h2 className="mb-2 font-semibold">My requests</h2>
        {!requests.data ? <Loading /> : !requests.data.data.length ? <Empty>No leave requests yet.</Empty> : (
          <ul className="divide-y divide-[var(--border)]">
            {requests.data.data.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                <div>
                  <div className="font-medium">{r.leave_type_name} · {r.days} day(s)</div>
                  <div className="muted text-xs">{df(r.start_date)}{r.start_half_day ? ' (afternoon)' : ''} to {df(r.end_date)}{r.end_half_day ? ' (morning)' : ''} · {r.number}</div>
                  {r.decision_comment && <div className="text-xs">“{r.decision_comment}”</div>}
                </div>
                <div className="flex items-center gap-2">
                  <Badge value={r.status} />
                  {r.status === 'returned' && <Button variant="secondary" onClick={() => setApplying(r)}>Fix and resubmit</Button>}
                  {['pending', 'approved', 'returned', 'draft'].includes(r.status) && r.start_date > new Date().toISOString().slice(0, 10) && <Button variant="ghost" onClick={() => cancel.mutate(r.id)}>Cancel</Button>}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
      {applying && <ApplyDialog types={types.data ?? []} existing={applying === true ? null : applying} onClose={() => { setApplying(null); void qc.invalidateQueries({ queryKey: ['my-leave'] }); }} />}
    </div>
  );
}

function ApplyDialog({ types, existing, onClose }: { types: { id: string; name: string; allow_half_day: boolean; requires_document_over_days: number | null }[]; existing: LeaveRequest | null; onClose: () => void }) {
  const [f, setF] = useState<Form>({
    leave_type_id: existing?.leave_type_id ?? types[0]?.id ?? '', start_date: existing?.start_date ?? '', end_date: existing?.end_date ?? '',
    start_half_day: existing?.start_half_day ?? false, end_half_day: existing?.end_half_day ?? false, reason: existing?.reason ?? '',
  });
  const type = types.find((t) => t.id === f.leave_type_id);
  const ready = f.leave_type_id && f.start_date && f.end_date && f.end_date >= f.start_date;
  const [quoteKey, setQuoteKey] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setQuoteKey(JSON.stringify(f)), 300);
    return () => clearTimeout(t);
  }, [f]);
  const quote = useQuery({
    queryKey: ['leave-quote', quoteKey],
    enabled: !!ready && !existing,
    retry: false,
    queryFn: () => unwrap(hr.POST('/api/v1/leave/quote', { body: { ...f, reason: f.reason || null, submit: false } })),
  });
  const save = useMutation({
    mutationFn: () =>
      existing
        ? unwrap(hr.POST('/api/v1/leave/requests/{id}/submit', { params: { path: { id: existing.id } }, body: { start_date: f.start_date, end_date: f.end_date, start_half_day: f.start_half_day, end_half_day: f.end_half_day, reason: f.reason || null } }))
        : unwrap(hr.POST('/api/v1/leave/requests', { body: { ...f, reason: f.reason || null, submit: true } })),
    onSuccess: onClose,
  });
  const fe = save.error instanceof ApiError ? save.error.fieldErrors : {};
  return (
    <Dialog open title={existing ? 'Fix and resubmit' : 'Apply for leave'} onClose={onClose}>
      <ProblemBanner error={save.error} />
      <div className="space-y-3">
        <Field label="Type" htmlFor="lv-type">
          <Select id="lv-type" value={f.leave_type_id} disabled={!!existing} onChange={(e) => setF({ ...f, leave_type_id: e.target.value })}>
            {types.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </Select>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="From" htmlFor="lv-start" error={fe.start_date}><Input id="lv-start" type="date" value={f.start_date} onChange={(e) => setF({ ...f, start_date: e.target.value, end_date: f.end_date && f.end_date >= e.target.value ? f.end_date : e.target.value })} /></Field>
          <Field label="To" htmlFor="lv-end" error={fe.end_date}><Input id="lv-end" type="date" value={f.end_date} min={f.start_date} onChange={(e) => setF({ ...f, end_date: e.target.value })} /></Field>
        </div>
        {type?.allow_half_day && (
          <div className="flex flex-wrap gap-4 text-sm">
            <label className="flex items-center gap-2"><input type="checkbox" checked={f.start_half_day} onChange={(e) => setF({ ...f, start_half_day: e.target.checked })} />Start after midday</label>
            <label className="flex items-center gap-2"><input type="checkbox" checked={f.end_half_day} onChange={(e) => setF({ ...f, end_half_day: e.target.checked })} />Back after midday on the last day</label>
          </div>
        )}
        <Field label="Reason (optional)" htmlFor="lv-reason"><Textarea id="lv-reason" value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} /></Field>
        {quote.data && (
          <div className="rounded-md bg-black/5 p-3 text-sm dark:bg-white/5">
            <b>{quote.data.days}</b> day(s) from your {quote.data.leave_year} balance of <b>{quote.data.available}</b>.
            {quote.data.excluded.filter((x) => x.why !== 'Rest day').length > 0 && <div className="muted text-xs">Not counted: {quote.data.excluded.filter((x) => x.why !== 'Rest day').map((x) => x.why).join(', ')}</div>}
            {quote.data.days > quote.data.available && <div className="text-red-600">That is more than you have.</div>}
          </div>
        )}
        {quote.error instanceof ApiError && <p className="text-sm text-red-600">{quote.error.message}</p>}
        {type?.requires_document_over_days !== null && type?.requires_document_over_days !== undefined && <p className="muted text-xs">More than {type.requires_document_over_days} day(s) needs a supporting document: HR can attach it to your request.</p>}
        <div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button busy={save.isPending} disabled={!ready} onClick={() => save.mutate()}>{existing ? 'Resubmit' : 'Send for approval'}</Button></div>
      </div>
    </Dialog>
  );
}
