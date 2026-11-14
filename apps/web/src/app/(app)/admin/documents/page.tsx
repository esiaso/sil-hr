'use client';

import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useMemo, useRef, useState } from 'react';
import { formatDateTime } from '@sil/hr-shared';
import { Badge, Button, Card, Empty, Field, Input, LoadMore, Loading, PageHeader, ProblemBanner } from '@/components/ui';
import { ApiError, hr, unwrap } from '@/lib/api';
import { useSession } from '@/lib/session';

/** Document store. Employee documents, contracts and letters will attach here in later slices. */
export default function DocumentsPage() {
  const { can, settings } = useSession();
  const qc = useQueryClient();
  const file = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState('');
  const [ownerType, setOwnerType] = useState('policy');
  const [sensitive, setSensitive] = useState(false);
  const q = useInfiniteQuery({
    queryKey: ['documents'],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => unwrap(hr.GET('/api/v1/documents', { params: { query: { limit: 50, cursor: pageParam } } })),
    getNextPageParam: (p) => p.next_cursor ?? undefined,
  });
  const rows = useMemo(() => q.data?.pages.flatMap((p) => p.data) ?? [], [q.data]);
  const upload = useMutation({
    mutationFn: async () => {
      const f = file.current?.files?.[0];
      if (!f) throw new Error('Choose a file');
      const body = new FormData();
      body.set('owner_type', ownerType);
      body.set('title', title || f.name);
      body.set('is_sensitive', String(sensitive));
      body.set('file', f);
      const res = await fetch('/api/v1/documents', { method: 'POST', body, headers: { 'x-requested-with': 'sil-hr-web' } });
      if (!res.ok) throw new ApiError(res.status, await res.json());
    },
    onSuccess: () => { setTitle(''); if (file.current) file.current.value = ''; void qc.invalidateQueries({ queryKey: ['documents'] }); },
  });
  const download = async (id: string) => {
    const r = await unwrap(hr.POST('/api/v1/documents/{id}/download-url', { params: { path: { id } } }));
    window.open(r.url, '_blank', 'noopener');
  };
  return (
    <div>
      <PageHeader title="Documents" description="Files live in object storage; the database keeps keys, checksums and versions. Downloads are short-lived signed links, and sensitive files are audited on every download." />
      {can('document:write') && (
        <Card className="mb-4">
          <ProblemBanner error={upload.error} />
          <div className="grid gap-3 sm:grid-cols-[1fr_1fr_1fr_auto_auto] sm:items-end">
            <Field label="File" htmlFor="d-file"><input id="d-file" ref={file} type="file" className="text-sm" /></Field>
            <Field label="Title" htmlFor="d-title"><Input id="d-title" value={title} onChange={(e) => setTitle(e.target.value)} /></Field>
            <Field label="Kind" htmlFor="d-kind"><Input id="d-kind" value={ownerType} onChange={(e) => setOwnerType(e.target.value)} /></Field>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={sensitive} onChange={(e) => setSensitive(e.target.checked)} /> Sensitive</label>
            <Button busy={upload.isPending} onClick={() => upload.mutate()}>Upload</Button>
          </div>
        </Card>
      )}
      <ProblemBanner error={q.error} />
      <div className="surface overflow-x-auto rounded-lg">
        {q.isLoading ? <Loading /> : !rows.length ? <Empty>No documents.</Empty> : (
          <table className="data">
            <thead><tr><th>Title</th><th>Kind</th><th>Version</th><th>File</th><th>Uploaded</th><th /></tr></thead>
            <tbody>
              {rows.map((d) => (
                <tr key={d.id}>
                  <td>{d.title} {d.is_sensitive && <Badge value="sensitive" />}</td>
                  <td>{d.owner_type}</td>
                  <td>{d.current_version?.version_no}</td>
                  <td className="text-xs">{d.current_version?.file_name} · {Math.ceil((d.current_version?.size_bytes ?? 0) / 1024)} KB</td>
                  <td className="text-xs">{formatDateTime(d.current_version?.uploaded_at, settings.timezone, settings.date_format)}</td>
                  <td><Button variant="ghost" onClick={() => download(d.id)}>Download</Button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <LoadMore hasMore={!!q.hasNextPage} busy={q.isFetchingNextPage} onClick={() => q.fetchNextPage()} />
    </div>
  );
}
