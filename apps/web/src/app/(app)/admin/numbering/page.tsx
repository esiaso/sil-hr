'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { NumberingScheme } from '@sil/hr-shared';
import { Button, Dialog, Field, Input, Loading, PageHeader, ProblemBanner, Select } from '@/components/ui';
import { hr, unwrap } from '@/lib/api';
import { useSession } from '@/lib/session';

function Edit({ s, onClose }: { s: NumberingScheme; onClose: () => void }) {
  const qc = useQueryClient();
  const [v, setV] = useState({ prefix: s.prefix, format: s.format, padding: s.padding, reset: s.reset });
  const save = useMutation({
    mutationFn: () => unwrap(hr.PATCH('/api/v1/numbering-schemes/{id}', { params: { path: { id: s.id }, header: { 'If-Match': `"${s.version}"` } }, body: v })),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['numbering'] }); onClose(); },
  });
  return (
    <Dialog open title={s.name} onClose={onClose}>
      <ProblemBanner error={save.error} />
      <div className="space-y-3">
        <Field label="Prefix" htmlFor="n-prefix"><Input id="n-prefix" value={v.prefix} onChange={(e) => setV({ ...v, prefix: e.target.value })} /></Field>
        <Field label="Format" htmlFor="n-format" hint="Tokens: {PREFIX} {YYYY} {YY} {MM} {BRANCH} {SEQ}"><Input id="n-format" value={v.format} onChange={(e) => setV({ ...v, format: e.target.value })} /></Field>
        <Field label="Digits in the sequence" htmlFor="n-pad"><Input id="n-pad" type="number" value={v.padding} onChange={(e) => setV({ ...v, padding: Number(e.target.value) })} /></Field>
        <Field label="Restart numbering" htmlFor="n-reset"><Select id="n-reset" value={v.reset} onChange={(e) => setV({ ...v, reset: e.target.value as 'never' | 'yearly' })}><option value="never">Never</option><option value="yearly">Every year</option></Select></Field>
        <div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button busy={save.isPending} onClick={() => save.mutate()}>Save</Button></div>
      </div>
    </Dialog>
  );
}

export default function NumberingPage() {
  const { can } = useSession();
  const q = useQuery({ queryKey: ['numbering'], queryFn: () => unwrap(hr.GET('/api/v1/numbering-schemes')) });
  const [open, setOpen] = useState<NumberingScheme | null>(null);
  return (
    <div>
      <PageHeader title="Numbering" description="How human-readable numbers are made: staff numbers, contracts, payslips, requisitions. Numbers are allocated gap-free inside the transaction that uses them." />
      <ProblemBanner error={q.error} />
      {!q.data ? <Loading /> : (
        <div className="surface overflow-x-auto rounded-xl">
          <table className="data">
            <thead><tr><th>Document</th><th>Format</th><th>Restart</th><th>Next</th><th /></tr></thead>
            <tbody>
              {q.data.map((s) => (
                <tr key={s.id}>
                  <td>{s.name}<div className="muted font-mono text-xs">{s.document_type}</div></td>
                  <td className="font-mono text-xs">{s.format}</td><td>{s.reset}</td><td className="font-mono">{s.next_preview}</td>
                  <td>{can('numbering:manage') && <Button variant="ghost" onClick={() => setOpen(s)}>Edit</Button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {open && <Edit s={open} onClose={() => setOpen(null)} />}
    </div>
  );
}
