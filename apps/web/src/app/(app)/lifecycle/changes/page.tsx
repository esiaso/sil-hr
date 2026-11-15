'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { EXIT_KINDS, formatDate, LIFECYCLE_KINDS } from '@sil/hr-shared';
import { EmployeePicker } from '@/components/employee-picker';
import { Badge, Button, Card, Dialog, Empty, Field, Input, Loading, PageHeader, ProblemBanner, Select, Textarea } from '@/components/ui';
import { ApiError, hr, unwrap } from '@/lib/api';
import { useLookups } from '@/lib/lookups';
import { useSession } from '@/lib/session';

type Kind = 'promotion' | 'transfer' | 'confirmation' | 'resignation' | 'termination';

export default function ChangesPage() {
  const { settings } = useSession();
  const [status, setStatus] = useState<'pending' | ''>('');
  const [kind, setKind] = useState<Kind | null>(null);
  const q = useQuery({ queryKey: ['lifecycle-requests', status], queryFn: () => unwrap(hr.GET('/api/v1/lifecycle-requests', { params: { query: { status: status || undefined } } })) });
  return (
    <div className="space-y-4">
      <PageHeader title="Promotions and changes" description="Promotions, transfers, confirmations, resignations and terminations, each approved through its workflow. An approved exit starts the offboarding checklist and exit clearance." actions={<Select aria-label="New" value="" onChange={(e) => setKind(e.target.value as Kind)} className="max-w-56"><option value="">New request…</option>{(['promotion', 'transfer', 'confirmation', 'resignation', 'termination'] as const).map((k) => <option key={k} value={k}>{LIFECYCLE_KINDS[k]}</option>)}</Select>} />
      <Select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value as 'pending')} className="max-w-44"><option value="">All</option><option value="pending">Waiting for approval</option></Select>
      <ProblemBanner error={q.error} />
      <Card>
        {!q.data ? <Loading /> : !q.data.length ? <Empty>No requests.</Empty> : (
          <table className="data">
            <thead><tr><th>Number</th><th>What</th><th>Employee</th><th>Details</th><th>From</th><th>Status</th></tr></thead>
            <tbody>{q.data.map((r) => (
              <tr key={r.id}><td className="font-mono text-xs">{r.number}</td><td>{LIFECYCLE_KINDS[r.kind]}</td><td>{r.employee_name} <span className="muted text-xs">{r.staff_number}</span></td>
                <td className="text-xs">{(r.details.position_title as string) ?? (r.details.exit_kind ? EXIT_KINDS[r.details.exit_kind as keyof typeof EXIT_KINDS] : '')}{r.details.new_basic ? ` · new basic ${r.details.new_basic}` : ''}</td>
                <td>{formatDate(r.effective_date, settings.date_format)}</td><td><Badge value={r.status} />{r.decision_comment && <div className="muted text-xs">{r.decision_comment}</div>}</td></tr>
            ))}</tbody>
          </table>
        )}
      </Card>
      {kind && <RequestDialog kind={kind} onClose={() => setKind(null)} />}
    </div>
  );
}

function RequestDialog({ kind, onClose }: { kind: Kind; onClose: () => void }) {
  const qc = useQueryClient();
  const l = useLookups();
  const [emp, setEmp] = useState<{ id: string; name: string } | null>(null);
  const [v, setV] = useState({ effective_date: '', position_id: '', new_basic: '', reason: '', notice_given_on: new Date().toISOString().slice(0, 10), exit_kind: 'termination', pay_notice_in_lieu: false });
  const save = useMutation({
    mutationFn: () => {
      const base = { employee_id: emp?.id ?? '', effective_date: v.effective_date, reason: v.reason };
      const body = {
        promotion: { kind, ...base, position_id: v.position_id, new_basic: v.new_basic ? Number(v.new_basic).toFixed(2) : null },
        transfer: { kind, ...base, position_id: v.position_id },
        confirmation: { kind, ...base },
        resignation: { kind, ...base, notice_given_on: v.notice_given_on },
        termination: { kind, ...base, exit_kind: v.exit_kind, pay_notice_in_lieu: v.pay_notice_in_lieu },
      }[kind];
      return unwrap(hr.POST('/api/v1/lifecycle-requests', { body: body as never }));
    },
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['lifecycle-requests'] }); onClose(); },
  });
  const fe = save.error instanceof ApiError ? save.error.fieldErrors : {};
  return (
    <Dialog open wide title={LIFECYCLE_KINDS[kind]} onClose={onClose}>
      <ProblemBanner error={save.error} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Employee" htmlFor="lr-e" error={fe.employee_id}><EmployeePicker id="lr-e" value={emp} onChange={setEmp} /></Field>
        <Field label={kind === 'resignation' || kind === 'termination' ? 'Last working day' : 'From'} htmlFor="lr-d" error={fe.effective_date}><Input id="lr-d" type="date" value={v.effective_date} onChange={(e) => setV({ ...v, effective_date: e.target.value })} /></Field>
        {(kind === 'promotion' || kind === 'transfer') && <Field label="New position" htmlFor="lr-p" error={fe.position_id}><Select id="lr-p" value={v.position_id} onChange={(e) => setV({ ...v, position_id: e.target.value })}><option value="">Choose</option>{l.positionOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</Select></Field>}
        {kind === 'promotion' && <Field label="New basic salary (optional)" htmlFor="lr-b"><Input id="lr-b" type="number" value={v.new_basic} onChange={(e) => setV({ ...v, new_basic: e.target.value })} /></Field>}
        {kind === 'resignation' && <Field label="Notice given on" htmlFor="lr-n"><Input id="lr-n" type="date" value={v.notice_given_on} onChange={(e) => setV({ ...v, notice_given_on: e.target.value })} /></Field>}
        {kind === 'termination' && <Field label="Reason for leaving" htmlFor="lr-x"><Select id="lr-x" value={v.exit_kind} onChange={(e) => setV({ ...v, exit_kind: e.target.value })}>{(['termination', 'contract_end', 'retirement', 'death', 'other'] as const).map((k) => <option key={k} value={k}>{EXIT_KINDS[k]}</option>)}</Select></Field>}
      </div>
      {kind === 'termination' && <label className="mt-3 flex items-center gap-1 text-sm"><input type="checkbox" checked={v.pay_notice_in_lieu} onChange={(e) => setV({ ...v, pay_notice_in_lieu: e.target.checked })} />Pay notice in lieu (the notice is not worked)</label>}
      <Field label="Reason" htmlFor="lr-r" error={fe.reason}><Textarea id="lr-r" value={v.reason} onChange={(e) => setV({ ...v, reason: e.target.value })} /></Field>
      <div className="mt-4 flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button busy={save.isPending} disabled={!emp} onClick={() => save.mutate()}>Send for approval</Button></div>
    </Dialog>
  );
}
