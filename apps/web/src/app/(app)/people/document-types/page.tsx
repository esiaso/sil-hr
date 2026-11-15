'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { EMPLOYMENT_TYPES } from '@sil/hr-shared';
import { Badge, Button, Card, Field, Input, Loading, PageHeader, ProblemBanner } from '@/components/ui';
import { hr, unwrap } from '@/lib/api';

export default function DocumentTypesPage() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['document-types'], queryFn: () => unwrap(hr.GET('/api/v1/document-types')) });
  const [v, setV] = useState({ code: '', name: '', required_for: [] as string[], has_expiry: false, is_sensitive: false });
  const save = useMutation({ mutationFn: () => unwrap(hr.POST('/api/v1/document-types', { body: v as never })), onSuccess: () => { setV({ code: '', name: '', required_for: [], has_expiry: false, is_sensitive: false }); void qc.invalidateQueries({ queryKey: ['document-types'] }); } });
  return (
    <div className="max-w-4xl">
      <PageHeader title="Document types" description="What goes in each employee's file, and which documents are required for which kinds of employment." />
      <ProblemBanner error={q.error ?? save.error} />
      <Card className="mb-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Code" htmlFor="dt-code"><Input id="dt-code" value={v.code} onChange={(e) => setV({ ...v, code: e.target.value })} /></Field>
          <Field label="Name" htmlFor="dt-name"><Input id="dt-name" value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} /></Field>
        </div>
        <fieldset className="mt-3 flex flex-wrap gap-3 text-sm"><legend className="mb-1 font-medium">Required for</legend>{EMPLOYMENT_TYPES.map((t) => <label key={t} className="flex items-center gap-1"><input type="checkbox" checked={v.required_for.includes(t)} onChange={(e) => setV({ ...v, required_for: e.target.checked ? [...v.required_for, t] : v.required_for.filter((x) => x !== t) })} />{t}</label>)}</fieldset>
        <div className="mt-3 flex flex-wrap gap-4 text-sm"><label className="flex items-center gap-1"><input type="checkbox" checked={v.has_expiry} onChange={(e) => setV({ ...v, has_expiry: e.target.checked })} />Has an expiry date</label><label className="flex items-center gap-1"><input type="checkbox" checked={v.is_sensitive} onChange={(e) => setV({ ...v, is_sensitive: e.target.checked })} />Sensitive (downloads audited)</label></div>
        <div className="mt-3"><Button busy={save.isPending} onClick={() => save.mutate()}>Add type</Button></div>
      </Card>
      {!q.data ? <Loading /> : (
        <div className="surface overflow-x-auto rounded-lg"><table className="data"><thead><tr><th>Type</th><th>Required for</th><th>Expiry</th><th>Sensitive</th><th>Status</th></tr></thead><tbody>{q.data.map((t) => <tr key={t.id}><td>{t.name}<div className="muted font-mono text-xs">{t.code}</div></td><td className="text-xs">{t.required_for.join(', ')}</td><td>{t.has_expiry ? 'Yes' : ''}</td><td>{t.is_sensitive ? 'Yes' : ''}</td><td><Badge value={t.status} /></td></tr>)}</tbody></table></div>
      )}
    </div>
  );
}
