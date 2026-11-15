'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { APPROVER_RULES, REQUEST_TYPES, type StepInput, type WorkflowDefinition } from '@sil/hr-shared';
import { Badge, Button, Card, Dialog, Field, Input, Loading, PageHeader, ProblemBanner, Select, Textarea } from '@/components/ui';
import { ApiError, hr, unwrap } from '@/lib/api';
import { useSession } from '@/lib/session';

const RULE_LABEL: Record<string, string> = {
  line_manager: "The person's line manager",
  manager_level: 'A manager further up (level n)',
  department_head: 'Head of their department',
  role: 'Anyone holding a role (shared queue)',
  user: 'A named person',
};

type Draft = { id?: string; version?: number; code: string; name: string; request_type: string; description: string; priority: number; is_active: boolean; kinds: string; steps: StepInput[] };

function describeStep(s: { approver_rule: string; level?: number | null; min_value?: number | null; escalate_after_hours?: number | null; escalate_to?: string | null; role_id?: string | null }, roles: Map<string, string>) {
  let t = s.approver_rule === 'role' ? `Anyone in "${roles.get(s.role_id ?? '') ?? 'role'}"` : s.approver_rule === 'manager_level' ? `Manager level ${s.level}` : RULE_LABEL[s.approver_rule];
  if (s.min_value) t += `, only from ${s.min_value} days/units`;
  if (s.escalate_after_hours) t += `, escalates after ${s.escalate_after_hours} h to ${s.escalate_to === 'role' ? 'a role' : 'the next manager'}`;
  return t;
}

function Editor({ draft, roles, onClose }: { draft: Draft; roles: { id: string; name: string }[]; onClose: () => void }) {
  const qc = useQueryClient();
  const [d, setD] = useState<Draft>(draft);
  const kinds = useQuery({ queryKey: ['leave-types'], queryFn: () => unwrap(hr.GET('/api/v1/leave/types')) });
  const setStep = (i: number, patch: Partial<StepInput>) => setD({ ...d, steps: d.steps.map((s, j) => (j === i ? { ...s, ...patch } : s)) });
  const move = (i: number, dir: -1 | 1) => {
    const steps = [...d.steps];
    [steps[i], steps[i + dir]] = [steps[i + dir], steps[i]];
    setD({ ...d, steps });
  };
  const save = useMutation({
    mutationFn: () => {
      const body = {
        code: d.code, name: d.name, request_type: d.request_type as never, description: d.description || null, priority: d.priority, is_active: d.is_active,
        conditions: d.kinds.trim() ? { kinds: d.kinds.split(',').map((k) => k.trim()).filter(Boolean) } : {},
        steps: d.steps.map((s) => Object.fromEntries(Object.entries(s).filter(([, v]) => v !== '' && v !== undefined))) as StepInput[],
      };
      return d.id ? unwrap(hr.PUT('/api/v1/workflow/definitions/{id}', { params: { path: { id: d.id }, header: { 'If-Match': `"${d.version}"` } }, body })) : unwrap(hr.POST('/api/v1/workflow/definitions', { body }));
    },
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['workflows'] }); onClose(); },
  });
  const fe = save.error instanceof ApiError ? save.error.fieldErrors : {};
  return (
    <Dialog open wide title={d.id ? `Edit ${d.name}` : 'New approval workflow'} onClose={onClose}>
      <ProblemBanner error={save.error} />
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Code" htmlFor="wf-code" error={fe.code}><Input id="wf-code" value={d.code} onChange={(e) => setD({ ...d, code: e.target.value })} /></Field>
        <Field label="Name" htmlFor="wf-name"><Input id="wf-name" value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} /></Field>
        <Field label="For" htmlFor="wf-type"><Select id="wf-type" value={d.request_type} onChange={(e) => setD({ ...d, request_type: e.target.value })}>{Object.entries(REQUEST_TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select></Field>
      </div>
      <div className="mt-3 grid gap-3 sm:grid-cols-3">
        <Field label="Only these kinds" htmlFor="wf-kinds" hint={d.request_type === 'leave_request' ? `Leave type codes, comma-separated: ${(kinds.data ?? []).map((k) => k.code).join(', ')}. Empty = all.` : 'Empty = all'}><Input id="wf-kinds" value={d.kinds} onChange={(e) => setD({ ...d, kinds: e.target.value })} /></Field>
        <Field label="Priority" htmlFor="wf-prio" hint="When several match, the highest wins"><Input id="wf-prio" type="number" value={d.priority} onChange={(e) => setD({ ...d, priority: Number(e.target.value) })} /></Field>
        <label className="mt-6 flex items-center gap-2 text-sm"><input type="checkbox" checked={d.is_active} onChange={(e) => setD({ ...d, is_active: e.target.checked })} />In use</label>
      </div>
      <Field label="Description" htmlFor="wf-desc"><Textarea id="wf-desc" value={d.description} onChange={(e) => setD({ ...d, description: e.target.value })} /></Field>

      <h3 className="mt-4 mb-2 font-semibold">Steps, in order</h3>
      <ol className="space-y-3">
        {d.steps.map((s, i) => (
          <li key={i} className="rounded-md border border-[var(--border)] p-3">
            <div className="mb-2 flex items-center justify-between"><b>Step {i + 1}</b><span className="flex gap-1">{i > 0 && <Button variant="ghost" onClick={() => move(i, -1)} aria-label="Move up">↑</Button>}{i < d.steps.length - 1 && <Button variant="ghost" onClick={() => move(i, 1)} aria-label="Move down">↓</Button>}<Button variant="ghost" onClick={() => setD({ ...d, steps: d.steps.filter((_, j) => j !== i) })}>Remove</Button></span></div>
            <div className="grid gap-2 sm:grid-cols-3">
              <Field label="Name" htmlFor={`st-name-${i}`}><Input id={`st-name-${i}`} value={s.name} onChange={(e) => setStep(i, { name: e.target.value })} /></Field>
              <Field label="Who approves" htmlFor={`st-rule-${i}`} error={fe[`steps.${i}.role_id`] ?? fe[`steps.${i}.level`]}>
                <Select id={`st-rule-${i}`} value={s.approver_rule} onChange={(e) => setStep(i, { approver_rule: e.target.value as StepInput['approver_rule'] })}>{APPROVER_RULES.map((r) => <option key={r} value={r}>{RULE_LABEL[r]}</option>)}</Select>
              </Field>
              {s.approver_rule === 'role' && <Field label="Role" htmlFor={`st-role-${i}`}><Select id={`st-role-${i}`} value={s.role_id ?? ''} onChange={(e) => setStep(i, { role_id: e.target.value })}><option value="">Choose…</option>{roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</Select></Field>}
              {s.approver_rule === 'manager_level' && <Field label="Level" htmlFor={`st-level-${i}`}><Input id={`st-level-${i}`} type="number" min={1} value={s.level ?? 2} onChange={(e) => setStep(i, { level: Number(e.target.value) })} /></Field>}
              {s.approver_rule === 'user' && <Field label="User id" htmlFor={`st-user-${i}`}><Input id={`st-user-${i}`} value={s.user_id ?? ''} onChange={(e) => setStep(i, { user_id: e.target.value })} /></Field>}
              <Field label="Only from (days/units)" htmlFor={`st-min-${i}`} hint="Blank = always"><Input id={`st-min-${i}`} type="number" value={s.min_value ?? ''} onChange={(e) => setStep(i, { min_value: e.target.value === '' ? null : Number(e.target.value) })} /></Field>
              <Field label="Escalate after (hours)" htmlFor={`st-esc-${i}`}><Input id={`st-esc-${i}`} type="number" value={s.escalate_after_hours ?? ''} onChange={(e) => setStep(i, { escalate_after_hours: e.target.value === '' ? null : Number(e.target.value), escalate_to: s.escalate_to ?? 'next_manager' })} /></Field>
              {s.escalate_after_hours ? (
                <Field label="Escalate to" htmlFor={`st-escto-${i}`}><Select id={`st-escto-${i}`} value={s.escalate_to ?? 'next_manager'} onChange={(e) => setStep(i, { escalate_to: e.target.value as 'next_manager' | 'role' })}><option value="next_manager">The approver&apos;s manager</option><option value="role">A role</option></Select></Field>
              ) : null}
              {s.escalate_to === 'role' && s.escalate_after_hours ? <Field label="Escalation role" htmlFor={`st-escrole-${i}`}><Select id={`st-escrole-${i}`} value={s.escalate_role_id ?? ''} onChange={(e) => setStep(i, { escalate_role_id: e.target.value })}><option value="">Choose…</option>{roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</Select></Field> : null}
            </div>
          </li>
        ))}
      </ol>
      <Button variant="secondary" className="mt-3" onClick={() => setD({ ...d, steps: [...d.steps, { name: `Step ${d.steps.length + 1}`, approver_rule: 'line_manager' }] })}>Add step</Button>
      <p className="muted mt-3 text-xs">Requesters never approve their own request, and one person signs once per request: if the natural approver already approved, is the requester, or is away without a delegate, the step goes to their manager. A step nobody can take goes to workflow administrators.</p>
      <div className="mt-4 flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button busy={save.isPending} onClick={() => save.mutate()}>Save</Button></div>
    </Dialog>
  );
}

export default function WorkflowsPage() {
  const { can } = useSession();
  const defs = useQuery({ queryKey: ['workflows'], queryFn: () => unwrap(hr.GET('/api/v1/workflow/definitions')) });
  const roles = useQuery({ queryKey: ['roles'], queryFn: () => unwrap(hr.GET('/api/v1/roles')), retry: false });
  const roleMap = new Map((roles.data ?? []).map((r) => [r.id, r.name]));
  const [editing, setEditing] = useState<Draft | null>(null);
  const toDraft = (w: WorkflowDefinition): Draft => ({
    id: w.id, version: w.version, code: w.code, name: w.name, request_type: w.request_type, description: w.description ?? '', priority: w.priority, is_active: w.is_active, kinds: (w.conditions.kinds ?? []).join(', '),
    steps: w.steps.map((s) => ({ name: s.name, approver_rule: s.approver_rule, level: s.level, role_id: s.role_id, user_id: s.user_id, min_value: s.min_value, escalate_after_hours: s.escalate_after_hours, escalate_to: s.escalate_to, escalate_role_id: s.escalate_role_id })),
  });
  return (
    <div>
      <PageHeader title="Approval workflows" description="Who approves what, in which order. Each kind of request picks the highest-priority workflow whose conditions match. Changes apply to new requests; ones already in progress keep their chain." actions={can('workflow:manage') && <Button onClick={() => setEditing({ code: '', name: '', request_type: 'leave_request', description: '', priority: 100, is_active: true, kinds: '', steps: [{ name: 'Line manager', approver_rule: 'line_manager' }] })}>New workflow</Button>} />
      <ProblemBanner error={defs.error} />
      {!defs.data ? <Loading /> : (
        <div className="space-y-3">
          {defs.data.map((w) => (
            <Card key={w.id}>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <div className="font-semibold">{w.name} <span className="muted font-mono text-xs">{w.code}</span></div>
                  <div className="muted text-xs">{REQUEST_TYPES[w.request_type as keyof typeof REQUEST_TYPES] ?? w.request_type} · priority {w.priority}{w.conditions.kinds?.length ? ` · only ${w.conditions.kinds.join(', ')}` : ''}</div>
                  {w.description && <p className="mt-1 text-sm">{w.description}</p>}
                </div>
                <div className="flex items-center gap-2"><Badge value={w.is_active ? 'active' : 'inactive'} />{can('workflow:manage') && <Button variant="secondary" onClick={() => setEditing(toDraft(w))}>Edit</Button>}</div>
              </div>
              <ol className="mt-3 list-decimal pl-5 text-sm">{w.steps.map((s) => <li key={s.id}><b>{s.name}</b>: {describeStep(s, roleMap)}</li>)}</ol>
            </Card>
          ))}
        </div>
      )}
      {editing && <Editor draft={editing} roles={roles.data ?? []} onClose={() => setEditing(null)} />}
    </div>
  );
}
