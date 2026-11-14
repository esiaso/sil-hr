'use client';

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useMemo, useState } from 'react';
import { formatDateTime } from '@sil/hr-shared';
import { Badge, Button, Card, Dialog, Empty, LoadMore, Loading, PageHeader, ProblemBanner, SecretReveal, Select } from '@/components/ui';
import { hr, unwrap } from '@/lib/api';
import { useSession } from '@/lib/session';

const STATUSES = ['pending', 'retrying', 'delivered', 'dead_lettered'] as const;

export default function WebhookDetail() {
  const { id } = useParams<{ id: string }>();
  const { can, settings } = useSession();
  const qc = useQueryClient();
  const [status, setStatus] = useState('');
  const [detail, setDetail] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const fmt = (t: string | null | undefined) => formatDateTime(t, settings.timezone, settings.date_format);
  const sub = useQuery({ queryKey: ['webhook', id], queryFn: () => unwrap(hr.GET('/api/v1/webhooks/subscriptions/{id}', { params: { path: { id } } })) });
  const deliveries = useInfiniteQuery({
    queryKey: ['deliveries', id, status],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => unwrap(hr.GET('/api/v1/webhooks/subscriptions/{id}/deliveries', { params: { path: { id }, query: { limit: 50, cursor: pageParam, status: (status || undefined) as never } } })),
    getNextPageParam: (p) => p.next_cursor ?? undefined,
    refetchInterval: 10_000,
  });
  const rows = useMemo(() => deliveries.data?.pages.flatMap((p) => p.data) ?? [], [deliveries.data]);
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['webhook', id] }); void qc.invalidateQueries({ queryKey: ['deliveries', id] }); };
  const act = useMutation({
    mutationFn: async (a: { kind: 'status'; value: 'active' | 'paused' | 'disabled' } | { kind: 'test' } | { kind: 'secret' } | { kind: 'replay'; id: string }) => {
      if (a.kind === 'status') await unwrap(hr.PATCH('/api/v1/webhooks/subscriptions/{id}', { params: { path: { id }, header: { 'If-Match': `"${sub.data!.version}"` } }, body: { status: a.value } }));
      if (a.kind === 'test') await unwrap(hr.POST('/api/v1/webhooks/subscriptions/{id}/test', { params: { path: { id } } }));
      if (a.kind === 'secret') setSecret((await unwrap(hr.POST('/api/v1/webhooks/subscriptions/{id}/secret', { params: { path: { id } } }))).secret);
      if (a.kind === 'replay') await unwrap(hr.POST('/api/v1/webhooks/deliveries/{id}/replay', { params: { path: { id: a.id } } }));
    },
    onSuccess: refresh,
  });
  const one = useQuery({ queryKey: ['delivery', detail], enabled: !!detail, queryFn: () => unwrap(hr.GET('/api/v1/webhooks/deliveries/{id}', { params: { path: { id: detail! } } })) });
  if (!sub.data) return sub.error ? <ProblemBanner error={sub.error} /> : <Loading />;
  const s = sub.data;
  const manage = can('webhook:manage');
  return (
    <div>
      <PageHeader title={s.name} description={s.url} actions={manage && (
        <>
          <Button variant="secondary" onClick={() => act.mutate({ kind: 'test' })}>Send test event</Button>
          {s.status === 'active' ? <Button variant="secondary" onClick={() => act.mutate({ kind: 'status', value: 'paused' })}>Pause</Button> : <Button onClick={() => act.mutate({ kind: 'status', value: 'active' })}>Resume</Button>}
          <Button variant="secondary" onClick={() => act.mutate({ kind: 'secret' })}>Rotate secret</Button>
        </>
      )} />
      <ProblemBanner error={act.error} />
      {secret && <div className="mb-4"><SecretReveal label="New signing secret (the old one stopped working)" value={secret} /></div>}
      <Card className="mb-4 text-sm">
        <div className="flex flex-wrap gap-6">
          <div>Status <Badge value={s.status} /></div>
          <div>Secret <code>{s.secret_prefix}…</code></div>
          <div>Events <code className="text-xs">{s.event_types.join(', ')}</code></div>
        </div>
        {s.paused_reason && <p className="mt-2 text-amber-700">{s.paused_reason}</p>}
      </Card>
      <div className="mb-3 flex items-center gap-2">
        <h2 className="font-semibold">Deliveries</h2>
        <Select aria-label="Filter by status" value={status} onChange={(e) => setStatus(e.target.value)} className="max-w-48">
          <option value="">All</option>
          {STATUSES.map((x) => <option key={x} value={x}>{x.replace('_', ' ')}</option>)}
        </Select>
      </div>
      <div className="surface overflow-x-auto rounded-lg">
        {deliveries.isLoading ? <Loading /> : !rows.length ? <Empty>No deliveries yet.</Empty> : (
          <table className="data">
            <thead><tr><th>Created</th><th>Event</th><th>Status</th><th>Attempts</th><th>Last result</th><th>Next attempt</th><th /></tr></thead>
            <tbody>
              {rows.map((d) => (
                <tr key={d.id}>
                  <td className="whitespace-nowrap text-xs">{fmt(d.created_at)}</td>
                  <td className="font-mono text-xs">{d.event_type}</td>
                  <td><Badge value={d.status} /></td>
                  <td>{d.attempt_count}</td>
                  <td className="text-xs">{d.last_status_code ?? ''} {d.last_error}</td>
                  <td className="text-xs">{fmt(d.next_attempt_at)}</td>
                  <td className="whitespace-nowrap">
                    <Button variant="ghost" onClick={() => setDetail(d.id)}>Attempts</Button>
                    {manage && d.status !== 'pending' && <Button variant="ghost" onClick={() => act.mutate({ kind: 'replay', id: d.id })}>Replay</Button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <LoadMore hasMore={!!deliveries.hasNextPage} busy={deliveries.isFetchingNextPage} onClick={() => deliveries.fetchNextPage()} />
      {detail && (
        <Dialog open wide title="Delivery attempts" onClose={() => setDetail(null)}>
          {!one.data ? <Loading /> : (
            <table className="data">
              <thead><tr><th>#</th><th>When</th><th>Took</th><th>HTTP</th><th>Error / response</th></tr></thead>
              <tbody>
                {one.data.attempts?.map((a) => (
                  <tr key={a.attempt_no}><td>{a.attempt_no}</td><td className="text-xs">{fmt(a.started_at)}</td><td>{a.duration_ms} ms</td><td>{a.status_code ?? '—'}</td><td className="text-xs">{a.error ?? a.response_excerpt}</td></tr>
                ))}
              </tbody>
            </table>
          )}
        </Dialog>
      )}
    </div>
  );
}
