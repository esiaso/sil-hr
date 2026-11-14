'use client';

import { useInfiniteQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { formatDateTime } from '@sil/hr-shared';
import { Badge, Empty, Input, LoadMore, Loading, PageHeader, ProblemBanner, Select } from '@/components/ui';
import { hr, unwrap } from '@/lib/api';
import { useSession } from '@/lib/session';

export default function LoginHistoryPage() {
  const { settings } = useSession();
  const [search, setSearch] = useState('');
  const [outcome, setOutcome] = useState('');
  const q = useInfiniteQuery({
    queryKey: ['login-history', search, outcome],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => unwrap(hr.GET('/api/v1/login-history', { params: { query: { limit: 100, cursor: pageParam, search: search || undefined, outcome: outcome || undefined } } })),
    getNextPageParam: (p) => p.next_cursor ?? undefined,
  });
  const rows = useMemo(() => q.data?.pages.flatMap((p) => p.data) ?? [], [q.data]);
  return (
    <div>
      <PageHeader title="Login history" description="Every sign-in attempt, successful or not." />
      <div className="mb-3 flex flex-wrap gap-2">
        <Input aria-label="Search" placeholder="Username or IP" value={search} onChange={(e) => setSearch(e.target.value)} className="max-w-xs" />
        <Select aria-label="Outcome" value={outcome} onChange={(e) => setOutcome(e.target.value)} className="max-w-48">
          <option value="">Any outcome</option>
          {['success', 'bad_credentials', 'locked', 'disabled', 'mfa_required', 'mfa_failed', 'ip_blocked'].map((o) => (
            <option key={o}>{o}</option>
          ))}
        </Select>
      </div>
      <ProblemBanner error={q.error} />
      <div className="surface overflow-x-auto rounded-lg">
        {q.isLoading ? <Loading /> : !rows.length ? <Empty>No entries.</Empty> : (
          <table className="data">
            <thead><tr><th>When</th><th>User</th><th>Outcome</th><th>Method</th><th>IP</th><th>Browser</th></tr></thead>
            <tbody>
              {rows.map((h) => (
                <tr key={h.id}>
                  <td className="whitespace-nowrap">{formatDateTime(h.occurred_at, settings.timezone, settings.date_format)}</td>
                  <td>{h.username}</td>
                  <td><Badge value={h.outcome} /></td>
                  <td>{h.method}</td>
                  <td className="font-mono text-xs">{h.ip}</td>
                  <td className="muted max-w-xs truncate text-xs">{h.user_agent}</td>
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
