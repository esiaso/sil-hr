'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ASSIGNEES, formatDate } from '@sil/hr-shared';
import { EmployeePicker } from '@/components/employee-picker';
import { Badge, Button, Card, Dialog, Empty, Field, Loading, PageHeader, ProblemBanner, Select } from '@/components/ui';
import { hr, unwrap } from '@/lib/api';
import { useSession } from '@/lib/session';

export default function ChecklistsPage() {
  const { settings } = useSession();
  const qc = useQueryClient();
  const [kind, setKind] = useState<'onboarding' | 'offboarding' | ''>('');
  const [open, setOpen] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const q = useQuery({ queryKey: ['checklists', kind], queryFn: () => unwrap(hr.GET('/api/v1/checklists', { params: { query: { status: 'open', kind: kind || undefined } } })) });
  const templates = useQuery({ queryKey: ['checklist-templates'], queryFn: () => unwrap(hr.GET('/api/v1/checklist-templates')) });
  const set = useMutation({ mutationFn: (v: { id: string; status: 'open' | 'done' | 'not_applicable' }) => unwrap(hr.PUT('/api/v1/checklist-tasks/{id}', { params: { path: { id: v.id } }, body: { status: v.status } })), onSuccess: () => qc.invalidateQueries({ queryKey: ['checklists'] }) });
  const today = new Date().toISOString().slice(0, 10);
  return (
    <div className="space-y-4">
      <PageHeader title="Onboarding and offboarding" description="Checklists start by themselves: onboarding for new hires, offboarding when an exit is approved. Each team sees its own tasks under My tasks." actions={<Button variant="secondary" onClick={() => setStarting(true)}>Start a checklist</Button>} />
      <Select aria-label="Kind" value={kind} onChange={(e) => setKind(e.target.value as 'onboarding')} className="max-w-48"><option value="">Both</option><option value="onboarding">Onboarding</option><option value="offboarding">Offboarding</option></Select>
      <ProblemBanner error={q.error ?? set.error} />
      {!q.data ? <Loading /> : !q.data.length ? <Card><Empty>No open checklists.</Empty></Card> : q.data.map((c) => (
        <Card key={c.id}>
          <button type="button" className="flex w-full items-center justify-between text-left" onClick={() => setOpen(open === c.id ? null : c.id)}>
            <div><div className="font-semibold">{c.employee_name}</div><div className="muted text-xs">{c.kind} · {c.kind === 'onboarding' ? 'started' : 'last day'} {formatDate(c.anchor_date, settings.date_format)}</div></div>
            <div className="flex items-center gap-3 text-sm"><span className="tabular-nums">{c.done} of {c.total}</span>{c.overdue > 0 && <Badge value={`${c.overdue} overdue`} />}<div className="h-2 w-28 overflow-hidden rounded-full bg-[var(--hover)]"><div className="h-full bg-brand-500" style={{ width: `${c.total ? (c.done / c.total) * 100 : 0}%` }} /></div></div>
          </button>
          {open === c.id && (
            <ul className="mt-3 divide-y divide-[var(--border)] border-t border-[var(--border)] text-sm">
              {c.tasks.map((t) => (
                <li key={t.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <div><div className={t.status !== 'open' ? 'muted line-through' : 'font-medium'}>{t.title} {t.blocks_exit && <Badge value="needed before exit" />}</div><div className={`text-xs ${t.status === 'open' && t.due_date < today ? 'text-red-600' : 'muted'}`}>{ASSIGNEES[t.assignee]} · due {formatDate(t.due_date, settings.date_format)}{t.done_by_name ? ` · ${t.status === 'done' ? 'done' : 'not needed'} by ${t.done_by_name}` : ''}</div></div>
                  {t.status === 'open' ? <div className="flex gap-2"><Button variant="ghost" onClick={() => set.mutate({ id: t.id, status: 'not_applicable' })}>Not needed</Button><Button variant="secondary" onClick={() => set.mutate({ id: t.id, status: 'done' })}>Done</Button></div> : <Button variant="ghost" onClick={() => set.mutate({ id: t.id, status: 'open' })}>Reopen</Button>}
                </li>
              ))}
            </ul>
          )}
        </Card>
      ))}
      <Card>
        <h2 className="mb-2 font-semibold">Templates</h2>
        {!templates.data ? <Loading /> : templates.data.map((t) => <details key={t.id} className="border-t border-[var(--border)] py-2 text-sm first:border-t-0"><summary className="cursor-pointer"><b>{t.name}</b> <span className="muted">· {t.kind} · {t.tasks.length} tasks{t.is_default ? ' · default' : ''}</span></summary><ol className="mt-2 list-decimal pl-6">{t.tasks.map((x) => <li key={x.id}>{x.title} <span className="muted text-xs">({ASSIGNEES[x.assignee]}, {x.due_offset_days >= 0 ? `day ${x.due_offset_days}` : `${-x.due_offset_days} days before`}{x.blocks_exit ? ', needed before exit' : ''})</span></li>)}</ol></details>)}
      </Card>
      {starting && <StartDialog onClose={() => setStarting(false)} />}
    </div>
  );
}

function StartDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [emp, setEmp] = useState<{ id: string; name: string } | null>(null);
  const [kind, setKind] = useState<'onboarding' | 'offboarding'>('onboarding');
  const go = useMutation({ mutationFn: () => unwrap(hr.POST('/api/v1/employees/{id}/checklists/{kind}', { params: { path: { id: emp!.id, kind } } })), onSuccess: () => { void qc.invalidateQueries({ queryKey: ['checklists'] }); onClose(); } });
  return (
    <Dialog open title="Start a checklist" onClose={onClose}>
      <ProblemBanner error={go.error} />
      <Field label="Employee" htmlFor="st-e"><EmployeePicker id="st-e" value={emp} onChange={setEmp} /></Field>
      <Field label="Checklist" htmlFor="st-k"><Select id="st-k" value={kind} onChange={(e) => setKind(e.target.value as 'onboarding')}><option value="onboarding">Onboarding</option><option value="offboarding">Offboarding</option></Select></Field>
      <div className="mt-4 flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button disabled={!emp} busy={go.isPending} onClick={() => go.mutate()}>Start</Button></div>
    </Dialog>
  );
}
