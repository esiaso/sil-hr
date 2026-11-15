'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pin } from 'lucide-react';
import { useState } from 'react';
import { formatDateTime } from '@sil/hr-shared';
import { Badge, Button, Card, Dialog, Empty, Field, Input, Loading, PageHeader, ProblemBanner, Select, Textarea } from '@/components/ui';
import { hr, unwrap } from '@/lib/api';
import { useLookups } from '@/lib/lookups';
import { useSession } from '@/lib/session';

type Item = NonNullable<Awaited<ReturnType<typeof list>>>[number];
const list = (all: boolean) => unwrap(hr.GET('/api/v1/announcements', { params: { query: { all: all ? 'true' : undefined } } }));

export default function AnnouncementsPage() {
  const { can, settings } = useSession();
  const manage = can('announcement:manage');
  const [all, setAll] = useState(false);
  const [edit, setEdit] = useState<Item | 'new' | null>(null);
  const q = useQuery({ queryKey: ['announcements', all], queryFn: () => list(all) });
  return (
    <div className="space-y-4">
      <PageHeader title="Announcements" description="News for staff. Announcements can go to everyone or to particular branches and departments." actions={manage && <div className="flex gap-2"><Button variant="secondary" onClick={() => setAll(!all)}>{all ? 'Show live only' : 'Show all, including drafts'}</Button><Button onClick={() => setEdit('new')}>New announcement</Button></div>} />
      <ProblemBanner error={q.error} />
      {!q.data ? <Loading /> : !q.data.length ? <Card><Empty>No announcements.</Empty></Card> : q.data.map((a) => (
        <Card key={a.id}>
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <h2 className="flex items-center gap-2 font-semibold">{a.pinned && <Pin size={16} aria-label="Pinned" />}{a.title}</h2>
              <div className="muted text-xs">{formatDateTime(a.publish_at, settings.timezone, settings.date_format)}{a.author_name ? ` · ${a.author_name}` : ''} · {a.audience}{a.expires_at ? ` · until ${formatDateTime(a.expires_at, settings.timezone, settings.date_format)}` : ''}</div>
            </div>
            {manage && <div className="flex items-center gap-2">{all && <Badge value={a.status} />}<button type="button" className="link text-sm" onClick={() => setEdit(a)}>Edit</button></div>}
          </div>
          <p className="reading mt-3 whitespace-pre-wrap text-sm">{a.body}</p>
        </Card>
      ))}
      {edit && <AnnouncementDialog a={edit === 'new' ? null : edit} onClose={() => setEdit(null)} />}
    </div>
  );
}

const local = (iso?: string | null) => (iso ? new Date(new Date(iso).getTime() + 3 * 3_600_000).toISOString().slice(0, 16) : '');
const toIso = (v: string) => (v ? new Date(`${v}:00+03:00`).toISOString() : null);

function AnnouncementDialog({ a, onClose }: { a: Item | null; onClose: () => void }) {
  const qc = useQueryClient();
  const { branchOptions, departmentOptions } = useLookups();
  const [f, setF] = useState({ title: a?.title ?? '', body: a?.body ?? '', branch_ids: a?.branch_ids ?? [], department_ids: a?.department_ids ?? [], publish_at: local(a?.publish_at), expires_at: local(a?.expires_at), pinned: a?.pinned ?? false, status: a?.status ?? 'published' });
  const save = useMutation({
    mutationFn: () => {
      const body = { ...f, publish_at: toIso(f.publish_at), expires_at: toIso(f.expires_at) };
      return a ? unwrap(hr.PUT('/api/v1/announcements/{id}', { params: { path: { id: a.id }, header: { 'If-Match': `"${a.version}"` } as never }, body })) : unwrap(hr.POST('/api/v1/announcements', { body }));
    },
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['announcements'] }); void qc.invalidateQueries({ queryKey: ['dash'] }); onClose(); },
  });
  const multi = (k: 'branch_ids' | 'department_ids', opts: { value: string; label: string }[], label: string) => (
    <Field label={label} htmlFor={`an-${k}`} hint="Hold Ctrl or ⌘ to choose several; none = everyone">
      <select id={`an-${k}`} multiple className="input h-28" value={f[k]} onChange={(e) => setF({ ...f, [k]: [...e.target.selectedOptions].map((o) => o.value) })}>{opts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select>
    </Field>
  );
  return (
    <Dialog open wide title={a ? 'Edit announcement' : 'New announcement'} onClose={onClose}>
      <ProblemBanner error={save.error} />
      <Field label="Title" htmlFor="an-t"><Input id="an-t" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
      <Field label="Message" htmlFor="an-b"><Textarea id="an-b" rows={6} value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} /></Field>
      <div className="grid gap-3 sm:grid-cols-2">
        {multi('branch_ids', branchOptions, 'Branches')}{multi('department_ids', departmentOptions, 'Departments')}
        <Field label="Publish at" htmlFor="an-p" hint="Empty = now"><Input id="an-p" type="datetime-local" value={f.publish_at} onChange={(e) => setF({ ...f, publish_at: e.target.value })} /></Field>
        <Field label="Expires at (optional)" htmlFor="an-x"><Input id="an-x" type="datetime-local" value={f.expires_at} onChange={(e) => setF({ ...f, expires_at: e.target.value })} /></Field>
        <Field label="Status" htmlFor="an-s"><Select id="an-s" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value as 'published' })}><option value="published">Published</option><option value="draft">Draft</option><option value="withdrawn">Withdrawn</option></Select></Field>
        <label className="flex items-center gap-2 self-end pb-2 text-sm"><input type="checkbox" checked={f.pinned} onChange={(e) => setF({ ...f, pinned: e.target.checked })} /> Pin to the top</label>
      </div>
      <div className="mt-4 flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button busy={save.isPending} onClick={() => save.mutate()}>Save</Button></div>
    </Dialog>
  );
}
