'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { formatDateTime, LETTER_FIELDS } from '@sil/hr-shared';
import { EmployeePicker } from '@/components/employee-picker';
import { Button, Card, Dialog, Empty, Field, Input, Loading, PageHeader, ProblemBanner, Select, Textarea } from '@/components/ui';
import { ApiError, hr, unwrap } from '@/lib/api';
import { useSession } from '@/lib/session';

export default function LettersPage() {
  const { can, settings } = useSession();
  const qc = useQueryClient();
  const templates = useQuery({ queryKey: ['letter-templates'], queryFn: () => unwrap(hr.GET('/api/v1/letter-templates')) });
  const issued = useQuery({ queryKey: ['letters'], queryFn: () => unwrap(hr.GET('/api/v1/letters', { params: { query: {} } })) });
  const [emp, setEmp] = useState<{ id: string; name: string } | null>(null);
  const [tid, setTid] = useState('');
  const [format, setFormat] = useState<'pdf' | 'docx'>('pdf');
  const [extra, setExtra] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<NonNullable<typeof templates.data>[number] | 'new' | null>(null);
  const t = templates.data?.find((x) => x.id === (tid || templates.data?.[0]?.id));
  const extras = (t?.fields ?? []).filter((f) => f.startsWith('extra.'));
  const issue = useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/v1/letters', { method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'sil-hr-web' }, body: JSON.stringify({ template_id: t!.id, employee_id: emp!.id, format, extra }) });
      if (!res.ok) throw new ApiError(res.status, await res.json());
      const blob = await res.blob();
      const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? `letter.${format}`;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      a.click();
      URL.revokeObjectURL(a.href);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['letters'] }),
  });
  return (
    <div className="space-y-4">
      <PageHeader title="Letters" description="Letters from templates with the person's details filled in, as PDF or Word. Each letter is numbered and kept on the employee's file." actions={can('letter_template:manage') && <Button variant="secondary" onClick={() => setEditing('new')}>New template</Button>} />
      <ProblemBanner error={issue.error ?? templates.error} />
      <Card>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Employee" htmlFor="lt-e"><EmployeePicker id="lt-e" value={emp} onChange={setEmp} /></Field>
          <Field label="Letter" htmlFor="lt-t"><Select id="lt-t" value={t?.id ?? ''} onChange={(e) => { setTid(e.target.value); setExtra({}); }}>{templates.data?.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select></Field>
          <Field label="Format" htmlFor="lt-f"><Select id="lt-f" value={format} onChange={(e) => setFormat(e.target.value as 'pdf')}><option value="pdf">PDF</option><option value="docx">Word (.docx)</option></Select></Field>
          {extras.map((f) => <Field key={f} label={f.slice(6).replace(/_/g, ' ')} htmlFor={`lt-${f}`}><Input id={`lt-${f}`} value={extra[f] ?? ''} onChange={(e) => setExtra({ ...extra, [f]: e.target.value })} /></Field>)}
        </div>
        <div className="mt-4 flex justify-end gap-2">{t && can('letter_template:manage') && <Button variant="ghost" onClick={() => setEditing(t)}>Edit template</Button>}<Button disabled={!emp || !t} busy={issue.isPending} onClick={() => issue.mutate()}>Create and download</Button></div>
      </Card>
      <Card>
        <h2 className="mb-2 font-semibold">Issued letters</h2>
        {!issued.data ? <Loading /> : !issued.data.length ? <Empty>None yet.</Empty> : (
          <table className="data"><thead><tr><th>Number</th><th>Letter</th><th>Employee</th><th>Format</th><th>Created</th></tr></thead>
            <tbody>{issued.data.map((l) => <tr key={l.id}><td className="font-mono text-xs">{l.number}</td><td>{l.template_name}</td><td>{l.employee_name}</td><td>{l.format.toUpperCase()}</td><td>{formatDateTime(l.created_at, settings.timezone, settings.date_format)}</td></tr>)}</tbody>
          </table>
        )}
      </Card>
      {editing && <TemplateDialog t={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function TemplateDialog({ t, onClose }: { t: { id: string; code: string; name: string; body: string; status: 'active' | 'inactive'; version: number } | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [v, setV] = useState({ code: t?.code ?? '', name: t?.name ?? '', body: t?.body ?? '', status: t?.status ?? 'active' });
  const save = useMutation({ mutationFn: () => (t ? unwrap(hr.PUT('/api/v1/letter-templates/{id}', { params: { path: { id: t.id }, header: { 'If-Match': `"${t.version}"` } as never }, body: v })) : unwrap(hr.POST('/api/v1/letter-templates', { body: v }))), onSuccess: () => { void qc.invalidateQueries({ queryKey: ['letter-templates'] }); onClose(); } });
  const fe = save.error instanceof ApiError ? save.error.fieldErrors : {};
  return (
    <Dialog open wide title={t ? t.name : 'New letter template'} onClose={onClose}>
      <ProblemBanner error={save.error} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Code" htmlFor="tp-c" error={fe.code}><Input id="tp-c" value={v.code} onChange={(e) => setV({ ...v, code: e.target.value.toUpperCase() })} /></Field>
        <Field label="Name" htmlFor="tp-n"><Input id="tp-n" value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} /></Field>
      </div>
      <Field label="Body" htmlFor="tp-b" error={fe.body} hint="A line starting with “# ” is a heading; a blank line starts a paragraph. Fields go in double braces; {{extra.anything}} is asked for when the letter is made."><Textarea id="tp-b" className="min-h-72 font-mono text-xs" value={v.body} onChange={(e) => setV({ ...v, body: e.target.value })} /></Field>
      <details className="mt-2 text-xs"><summary className="cursor-pointer">Available fields</summary><div className="mt-1 grid gap-x-4 sm:grid-cols-2">{Object.entries(LETTER_FIELDS).map(([k, l]) => <div key={k}><code>{`{{${k}}}`}</code> <span className="muted">{l}</span></div>)}</div></details>
      <div className="mt-4 flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button busy={save.isPending} onClick={() => save.mutate()}>Save</Button></div>
    </Dialog>
  );
}
