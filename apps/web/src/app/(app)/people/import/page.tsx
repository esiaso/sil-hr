'use client';

import { useQuery } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import type { BulkJob } from '@sil/hr-shared';
import { Badge, Button, Card, Field, PageHeader, ProblemBanner, Select } from '@/components/ui';
import { ApiError, hr, unwrap } from '@/lib/api';

function JobStatus({ id, onDownload }: { id: string; onDownload: (docId: string) => void }) {
  const q = useQuery({ queryKey: ['bulk-job', id], queryFn: () => unwrap(hr.GET('/api/v1/bulk-jobs/{id}', { params: { path: { id } } })) as Promise<BulkJob>, refetchInterval: (query) => (query.state.data && ['succeeded', 'failed'].includes(query.state.data.status) ? false : 1500) });
  const j = q.data;
  if (!j) return null;
  return (
    <div className="mt-3 text-sm">
      <div className="flex flex-wrap items-center gap-3">
        <Badge value={j.status} /> {j.dry_run && <Badge value="dry run" />}
        <span>{j.total_rows ?? '…'} rows · {j.created_count} new · {j.updated_count} updated · {j.error_count} errors</span>
        {j.result_document_id && <Button variant="secondary" onClick={() => onDownload(j.result_document_id!)}>Download</Button>}
      </div>
      {j.errors.length > 0 && (
        <table className="data mt-3"><thead><tr><th>Row</th><th>Column</th><th>Problem</th></tr></thead><tbody>{j.errors.map((e, i) => <tr key={i}><td>{e.row || ''}</td><td>{e.column}</td><td>{e.message}</td></tr>)}</tbody></table>
      )}
      {j.status === 'failed' && <p className="mt-2 text-red-600">Nothing was saved. Fix the rows above and upload again.</p>}
    </div>
  );
}

export default function ImportPage() {
  const file = useRef<HTMLInputElement>(null);
  const [importJob, setImportJob] = useState<string | null>(null);
  const [exportJob, setExportJob] = useState<string | null>(null);
  const [format, setFormat] = useState<'csv' | 'xlsx'>('xlsx');
  const [error, setError] = useState<unknown>(null);
  const download = async (docId: string) => window.open((await unwrap(hr.POST('/api/v1/documents/{id}/download-url', { params: { path: { id: docId } } }))).url, '_blank', 'noopener');
  const upload = async (dryRun: boolean) => {
    setError(null);
    const f = file.current?.files?.[0];
    if (!f) return setError(new Error('Choose a .csv or .xlsx file'));
    const body = new FormData();
    body.set('file', f);
    const res = await fetch(`/api/v1/employees/import?dry_run=${dryRun}`, { method: 'POST', body, headers: { 'x-requested-with': 'sil-hr-web' } });
    const json = await res.json();
    if (!res.ok) return setError(new ApiError(res.status, json));
    setImportJob(json.id);
  };
  const template = async () => {
    const t = await unwrap(hr.GET('/api/v1/employees/import/template')) as unknown as { csv: string };
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([t.csv], { type: 'text/csv' }));
    a.download = 'employee-import-template.csv';
    a.click();
  };
  return (
    <div className="max-w-3xl space-y-4">
      <PageHeader title="Import & export" description="Load staff from a spreadsheet, or take a copy out. Imports are checked row by row and saved all at once: one bad row means nothing is saved." />
      <ProblemBanner error={error} />
      <Card>
        <h2 className="mb-2 font-semibold">Import employees</h2>
        <p className="muted mb-3 text-sm">Columns: staff number (blank for a new number; an existing one updates that person), names, national ID, KRA PIN, employment type, hire date (DD/MM/YYYY), position code, manager staff number. <button className="underline" onClick={template}>Download the template</button>.</p>
        <div className="flex flex-wrap items-end gap-2">
          <Field label="File" htmlFor="imp-file"><input id="imp-file" ref={file} type="file" accept=".csv,.xlsx" className="text-sm" /></Field>
          <Button variant="secondary" onClick={() => upload(true)}>Check only</Button>
          <Button onClick={() => upload(false)}>Import</Button>
        </div>
        {importJob && <JobStatus id={importJob} onDownload={download} />}
      </Card>
      <Card>
        <h2 className="mb-2 font-semibold">Export employees</h2>
        <p className="muted mb-3 text-sm">Everyone you can see, without ID numbers or bank details. Exports are recorded in the audit trail.</p>
        <div className="flex items-end gap-2">
          <Field label="Format" htmlFor="exp-format"><Select id="exp-format" value={format} onChange={(e) => setFormat(e.target.value as 'csv' | 'xlsx')}><option value="xlsx">Excel</option><option value="csv">CSV</option></Select></Field>
          <Button onClick={async () => { try { setExportJob((await unwrap(hr.POST('/api/v1/employees/export', { params: { query: { format } as never } }))).id); } catch (e) { setError(e); } }}>Export</Button>
        </div>
        {exportJob && <JobStatus id={exportJob} onDownload={download} />}
      </Card>
    </div>
  );
}
