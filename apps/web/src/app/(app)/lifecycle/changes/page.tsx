'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { CONTRACT_TYPES, EXIT_KINDS, formatDate, formatDateTime, formatMoney, LIFECYCLE_KINDS } from '@sil/hr-shared';
import { EmployeePicker } from '@/components/employee-picker';
import { Badge, Button, Card, Dialog, Empty, Field, Input, Loading, PageHeader, ProblemBanner, Select, Textarea } from '@/components/ui';
import { ApiError, hr, unwrap } from '@/lib/api';
import { useLookups } from '@/lib/lookups';
import { useSession } from '@/lib/session';

type Kind = 'promotion' | 'transfer' | 'confirmation' | 'contract_renewal' | 'resignation' | 'termination';
type CType = keyof typeof CONTRACT_TYPES;
type Req = NonNullable<Awaited<ReturnType<typeof list>>>[number];
const list = (status: string, kind: string) => unwrap(hr.GET('/api/v1/lifecycle-requests', { params: { query: { status: (status || undefined) as never, kind: (kind || undefined) as never } } }));
const NEW: Kind[] = ['promotion', 'transfer', 'confirmation', 'contract_renewal', 'resignation', 'termination'];
const STATUSES = { pending: 'Waiting for approval', returned: 'Returned for correction', approved: 'Approved', rejected: 'Rejected', cancelled: 'Withdrawn' } as const;

/** One line saying what a request changes. */
function summary(r: Req, l: ReturnType<typeof useLookups>): string {
  const d = r.details as Record<string, string | number | boolean | null | undefined>;
  const pos = (d.position_title as string) ?? (d.position_id ? l.positions.get(d.position_id as string)?.title : undefined);
  const parts: string[] = [];
  if (pos) parts.push(`to ${pos}`);
  if (d.contract_type) parts.push(CONTRACT_TYPES[d.contract_type as CType] ?? String(d.contract_type));
  if (d.end_date) parts.push(`until ${d.end_date}`);
  if (d.exit_kind) parts.push(EXIT_KINDS[d.exit_kind as keyof typeof EXIT_KINDS]);
  if (d.new_basic) parts.push(`basic ${formatMoney(String(d.new_basic))}`);
  if (d.pay_notice_in_lieu) parts.push('notice paid in lieu');
  return parts.join(' · ');
}

export default function ChangesPage() {
  const { settings } = useSession();
  const l = useLookups();
  const [status, setStatus] = useState('');
  const [kindFilter, setKindFilter] = useState('');
  const [search, setSearch] = useState('');
  const [kind, setKind] = useState<Kind | null>(null);
  const [open, setOpen] = useState<Req | null>(null);
  const q = useQuery({ queryKey: ['lifecycle-requests', status, kindFilter], queryFn: () => list(status, kindFilter) });
  const rows = useMemo(() => (q.data ?? []).filter((r) => !search || `${r.employee_name} ${r.staff_number} ${r.number}`.toLowerCase().includes(search.toLowerCase())), [q.data, search]);
  return (
    <div className="space-y-4">
      <PageHeader
        title="Promotions and changes"
        description="Promotions, transfers, confirmations, contract renewals, resignations and terminations, each approved through its workflow. Approved changes take effect on their date; an approved exit starts offboarding and exit clearance."
        actions={<Select aria-label="New request" value="" onChange={(e) => setKind(e.target.value as Kind)} className="max-w-56"><option value="">New request…</option>{NEW.map((k) => <option key={k} value={k}>{LIFECYCLE_KINDS[k]}</option>)}</Select>}
      />
      <div className="flex flex-wrap gap-2">
        <Input aria-label="Search" placeholder="Name, staff number or request number" className="max-w-xs" value={search} onChange={(e) => setSearch(e.target.value)} />
        <Select aria-label="Kind" value={kindFilter} onChange={(e) => setKindFilter(e.target.value)} className="max-w-56"><option value="">All kinds</option>{Object.entries(LIFECYCLE_KINDS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>
        <Select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)} className="max-w-56"><option value="">Any status</option>{Object.entries(STATUSES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>
      </div>
      <ProblemBanner error={q.error} />
      <Card>
        {!q.data ? <Loading /> : !rows.length ? <Empty>No requests.</Empty> : (
          <table className="data">
            <thead><tr><th>Number</th><th>What</th><th>Employee</th><th>Change</th><th>From</th><th>Raised</th><th>Status</th></tr></thead>
            <tbody>{rows.map((r) => (
              <tr key={r.id} className="cursor-pointer hover:bg-[var(--hover)]" onClick={() => setOpen(r)}>
                <td className="font-mono text-xs"><button type="button" className="link" onClick={() => setOpen(r)}>{r.number}</button></td>
                <td>{LIFECYCLE_KINDS[r.kind]}</td><td>{r.employee_name} <span className="muted text-xs">{r.staff_number}</span></td>
                <td className="text-xs">{summary(r, l)}</td>
                <td>{formatDate(r.effective_date, settings.date_format)}</td><td className="text-xs">{formatDate(r.created_at.slice(0, 10), settings.date_format)}</td>
                <td><Badge value={r.status === 'cancelled' ? 'withdrawn' : r.status} /></td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </Card>
      {kind && <RequestDialog kind={kind} onClose={() => setKind(null)} />}
      {open && <RequestDetail r={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

function RequestDetail({ r, onClose }: { r: Req; onClose: () => void }) {
  const { settings, can } = useSession();
  const l = useLookups();
  const qc = useQueryClient();
  const trail = useQuery({ queryKey: ['instance', r.workflow_instance_id], enabled: !!r.workflow_instance_id && can('workflow:read'), queryFn: () => unwrap(hr.GET('/api/v1/workflow/instances/{id}', { params: { path: { id: r.workflow_instance_id! } } })) });
  const cancel = useMutation({ mutationFn: () => unwrap(hr.POST('/api/v1/lifecycle-requests/{id}/cancel', { params: { path: { id: r.id } } })), onSuccess: () => { void qc.invalidateQueries({ queryKey: ['lifecycle-requests'] }); onClose(); } });
  const d = r.details as Record<string, unknown>;
  const rows: [string, string][] = [
    ['Employee', `${r.employee_name} (${r.staff_number})`],
    ['Takes effect', formatDate(r.effective_date, settings.date_format)],
    ...(summary(r, l) ? [['Change', summary(r, l)] as [string, string]] : []),
    ...(d.notice_given_on ? [['Notice given on', formatDate(String(d.notice_given_on), settings.date_format)] as [string, string]] : []),
    ['Reason', r.reason ?? '–'],
    ...(r.decision_comment ? [['Approver’s comment', r.decision_comment] as [string, string]] : []),
  ];
  return (
    <Dialog open wide title={`${LIFECYCLE_KINDS[r.kind]} · ${r.number}`} onClose={onClose}>
      <ProblemBanner error={cancel.error ?? trail.error} />
      <div className="mb-3"><Badge value={r.status === 'cancelled' ? 'withdrawn' : r.status} /></div>
      <dl className="grid grid-cols-[10rem_1fr] gap-x-3 gap-y-1 text-sm">{rows.map(([k, v]) => <div key={k} className="contents"><dt className="muted">{k}</dt><dd className="whitespace-pre-wrap">{v}</dd></div>)}</dl>
      {r.result && Object.keys(r.result).length > 0 && (
        <div className="mt-3 rounded-lg bg-[var(--surface-2)] p-3 text-sm"><div className="mb-1 font-medium">Result</div>{Object.entries(r.result).map(([k, v]) => <div key={k}><span className="muted">{k.replace(/_/g, ' ')}:</span> {String(v)}</div>)}</div>
      )}
      {trail.data && (
        <div className="mt-4">
          <div className="mb-1 text-sm font-medium">Approvals</div>
          <ol className="space-y-1 text-sm">
            {trail.data.tasks.map((t) => (
              <li key={t.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[var(--border)] px-3 py-2">
                <span>Step {t.step_no}: {t.step_name}{t.assignee_name ? ` · ${t.assignee_name}` : ''}{t.comment ? <span className="muted"> · {t.comment}</span> : null}</span>
                <span className="flex items-center gap-2"><span className="muted text-xs">{t.acted_at ? formatDateTime(t.acted_at, settings.timezone, settings.date_format) : ''}</span><Badge value={t.status} /></span>
              </li>
            ))}
          </ol>
        </div>
      )}
      <div className="mt-4 flex justify-end gap-2">
        {['pending', 'returned'].includes(r.status) && <Button variant="danger" busy={cancel.isPending} onClick={() => window.confirm('Withdraw this request? The approvers’ tasks are cancelled.') && cancel.mutate()}>Withdraw request</Button>}
        <Button variant="secondary" onClick={onClose}>Close</Button>
      </div>
    </Dialog>
  );
}

function RequestDialog({ kind, onClose }: { kind: Kind; onClose: () => void }) {
  const qc = useQueryClient();
  const l = useLookups();
  const [emp, setEmp] = useState<{ id: string; name: string } | null>(null);
  const [manager, setManager] = useState<{ id: string; name: string } | null>(null);
  const [v, setV] = useState({ effective_date: '', position_id: '', new_basic: '', reason: '', notice_given_on: new Date().toISOString().slice(0, 10), exit_kind: 'termination', pay_notice_in_lieu: false, end_date: '', contract_type: 'fixed_term' as CType, notice_days: '' });
  const contracts = useQuery({ queryKey: ['contracts-of', emp?.id], enabled: !!emp && kind === 'contract_renewal', queryFn: () => unwrap(hr.GET('/api/v1/contracts', { params: { query: { employee_id: emp!.id, status: 'active' } } })) });
  const current = contracts.data?.[0];
  const save = useMutation({
    mutationFn: () => {
      const base = { employee_id: emp?.id ?? '', effective_date: v.effective_date, reason: v.reason };
      const money = (x: string) => (x ? Number(x).toFixed(2) : null);
      const body = {
        promotion: { kind, ...base, position_id: v.position_id, manager_id: manager?.id ?? null, new_basic: money(v.new_basic) },
        transfer: { kind, ...base, position_id: v.position_id, manager_id: manager?.id ?? null },
        confirmation: { kind, ...base },
        contract_renewal: { kind, ...base, end_date: v.end_date || null, contract_type: v.contract_type, new_basic: money(v.new_basic), ...(v.notice_days ? { notice_days: Number(v.notice_days) } : {}) },
        resignation: { kind, ...base, notice_given_on: v.notice_given_on },
        termination: { kind, ...base, exit_kind: v.exit_kind, pay_notice_in_lieu: v.pay_notice_in_lieu },
      }[kind];
      return unwrap(hr.POST('/api/v1/lifecycle-requests', { body: body as never }));
    },
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['lifecycle-requests'] }); onClose(); },
  });
  const fe = save.error instanceof ApiError ? save.error.fieldErrors : {};
  const exit = kind === 'resignation' || kind === 'termination';
  return (
    <Dialog open wide title={LIFECYCLE_KINDS[kind]} onClose={onClose}>
      <ProblemBanner error={save.error} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Employee" htmlFor="lr-e" error={fe.employee_id}><EmployeePicker id="lr-e" value={emp} onChange={setEmp} /></Field>
        <Field label={exit ? 'Last working day' : kind === 'contract_renewal' ? 'New contract from' : 'From'} htmlFor="lr-d" error={fe.effective_date}><Input id="lr-d" type="date" value={v.effective_date} onChange={(e) => setV({ ...v, effective_date: e.target.value })} /></Field>
        {(kind === 'promotion' || kind === 'transfer') && <>
          <Field label="New position" htmlFor="lr-p" error={fe.position_id}><Select id="lr-p" value={v.position_id} onChange={(e) => setV({ ...v, position_id: e.target.value })}><option value="">Choose</option>{l.positionOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</Select></Field>
          <Field label="New line manager (optional)" htmlFor="lr-m" hint="Blank keeps the current one" error={fe.manager_id}><EmployeePicker id="lr-m" value={manager} onChange={setManager} /></Field>
        </>}
        {(kind === 'promotion' || kind === 'contract_renewal') && <Field label="New basic salary (optional)" htmlFor="lr-b"><Input id="lr-b" type="number" value={v.new_basic} onChange={(e) => setV({ ...v, new_basic: e.target.value })} /></Field>}
        {kind === 'contract_renewal' && <>
          <Field label="New contract to" htmlFor="lr-to" hint="Blank for an open-ended contract" error={fe.end_date}><Input id="lr-to" type="date" value={v.end_date} onChange={(e) => setV({ ...v, end_date: e.target.value })} /></Field>
          <Field label="Contract type" htmlFor="lr-ct"><Select id="lr-ct" value={v.contract_type} onChange={(e) => setV({ ...v, contract_type: e.target.value as CType })}>{Object.entries(CONTRACT_TYPES).map(([k, t]) => <option key={k} value={k}>{t}</option>)}</Select></Field>
          <Field label="Notice (days, optional)" htmlFor="lr-nd" hint="Blank keeps the current notice"><Input id="lr-nd" type="number" value={v.notice_days} onChange={(e) => setV({ ...v, notice_days: e.target.value })} /></Field>
        </>}
        {kind === 'resignation' && <Field label="Notice given on" htmlFor="lr-n"><Input id="lr-n" type="date" value={v.notice_given_on} onChange={(e) => setV({ ...v, notice_given_on: e.target.value })} /></Field>}
        {kind === 'termination' && <Field label="Reason for leaving" htmlFor="lr-x"><Select id="lr-x" value={v.exit_kind} onChange={(e) => setV({ ...v, exit_kind: e.target.value })}>{(['termination', 'contract_end', 'retirement', 'death', 'other'] as const).map((k) => <option key={k} value={k}>{EXIT_KINDS[k]}</option>)}</Select></Field>}
      </div>
      {kind === 'contract_renewal' && emp && (
        <p className="muted mt-2 text-xs">{current ? `Current contract ${current.number}: ${CONTRACT_TYPES[current.contract_type]}, ${current.start_date} to ${current.end_date ?? 'open-ended'}${current.basic ? `, basic ${formatMoney(current.basic)}` : ''}. It ends the day before the new one starts.` : 'No contract in force on file; the new one becomes their contract.'}</p>
      )}
      {kind === 'termination' && <label className="mt-3 flex items-center gap-1 text-sm"><input type="checkbox" checked={v.pay_notice_in_lieu} onChange={(e) => setV({ ...v, pay_notice_in_lieu: e.target.checked })} />Pay notice in lieu (the notice is not worked)</label>}
      <Field label="Reason" htmlFor="lr-r" error={fe.reason}><Textarea id="lr-r" value={v.reason} onChange={(e) => setV({ ...v, reason: e.target.value })} /></Field>
      <div className="mt-4 flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button busy={save.isPending} disabled={!emp} onClick={() => save.mutate()}>Send for approval</Button></div>
    </Dialog>
  );
}
