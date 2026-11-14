'use client';

import { useInfiniteQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { formatDateTime } from '@sil/hr-shared';
import { Badge, Empty, LoadMore, Loading, PageHeader, ProblemBanner, Select } from '@/components/ui';
import { hr, unwrap } from '@/lib/api';
import { useSession } from '@/lib/session';

export default function OutboxPage() {
  const { settings } = useSession();
  const [unpublished, setUnpublished] = useState('');
  const q = useInfiniteQuery({
    queryKey: ['outbox', unpublished],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => unwrap(hr.GET('/api/v1/events/outbox', { params: { query: { limit: 100, cursor: pageParam, unpublished: (unpublished || undefined) as never } } })),
    getNextPageParam: (p) => p.next_cursor ?? undefined,
    refetchInterval: 5000,
  });
  const rows = useMemo(() => q.data?.pages.flatMap((p) => p.data) ?? [], [q.data]);
  return (
    <div>
      <PageHeader title="Event outbox" description="Events are written here in the same transaction as the change, then published by the worker. An event that stays unpublished points at a publishing problem (see last error)." />
      <Select aria-label="Filter" value={unpublished} onChange={(e) => setUnpublished(e.target.value)} className="mb-3 max-w-48">
        <option value="">All events</option>
        <option value="true">Unpublished only</option>
      </Select>
      <ProblemBanner error={q.error} />
      <div className="surface overflow-x-auto rounded-lg">
        {q.isLoading ? <Loading /> : !rows.length ? <Empty>No events.</Empty> : (
          <table className="data">
            <thead><tr><th>#</th><th>When</th><th>Type</th><th>Subject</th><th>Published</th><th>Error</th></tr></thead>
            <tbody>
              {rows.map((e) => (
                <tr key={e.id}>
                  <td>{e.id}</td>
                  <td className="whitespace-nowrap text-xs">{formatDateTime(e.occurred_at, settings.timezone, settings.date_format)}</td>
                  <td className="font-mono text-xs">{e.type}</td>
                  <td className="font-mono text-xs">{e.subject.slice(0, 13)}</td>
                  <td>{e.published_at ? <Badge value="delivered" /> : <Badge value="pending" />}</td>
                  <td className="text-xs text-red-600">{e.last_error}</td>
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
