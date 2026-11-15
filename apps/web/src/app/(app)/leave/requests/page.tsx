'use client';

import { useInfiniteQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { LEAVE_REQUEST_STATUSES, formatDate } from '@sil/hr-shared';
import { Badge, Empty, LoadMore, Loading, PageHeader, ProblemBanner, Select } from '@/components/ui';
import { hr, unwrap } from '@/lib/api';
import { useLookups } from '@/lib/lookups';
import { useSession } from '@/lib/session';

export default function LeaveRequestsPage() {
  const { settings } = useSession();
  const l = useLookups();
  const [status, setStatus] = useState('');
  const [dept, setDept] = useState('');
  const q = useInfiniteQuery({
    queryKey: ['leave-requests', status, dept],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => unwrap(hr.GET('/api/v1/leave/requests', { params: { query: { limit: 50, cursor: pageParam, status: (status || undefined) as never, department_id: dept || undefined } } })),
    getNextPageParam: (p) => p.next_cursor ?? undefined,
  });
  const rows = useMemo(() => q.data?.pages.flatMap((p) => p.data) ?? [], [q.data]);
  const df = (d: string) => formatDate(d, settings.date_format);
  return (
    <div>
      <PageHeader title="Leave requests" description="Every request within your scope. Decisions are made in Approvals." />
      <div className="mb-3 flex flex-wrap gap-2">
        <Select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)} className="max-w-40"><option value="">Any status</option>{LEAVE_REQUEST_STATUSES.map((s) => <option key={s}>{s}</option>)}</Select>
        <Select aria-label="Department" value={dept} onChange={(e) => setDept(e.target.value)} className="max-w-64"><option value="">Any department</option>{l.departmentOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</Select>
      </div>
      <ProblemBanner error={q.error} />
      <div className="surface overflow-x-auto rounded-xl">
        {q.isLoading ? <Loading /> : !rows.length ? <Empty>No requests.</Empty> : (
          <table className="data">
            <thead><tr><th>Number</th><th>Employee</th><th>Type</th><th>Dates</th><th>Days</th><th>Status</th></tr></thead>
            <tbody>{rows.map((r) => <tr key={r.id}><td className="font-mono text-xs">{r.number}</td><td>{r.employee_name}</td><td>{r.leave_type_name}</td><td className="text-xs">{df(r.start_date)} to {df(r.end_date)}</td><td>{r.days}</td><td><Badge value={r.status} /></td></tr>)}</tbody>
          </table>
        )}
      </div>
      <LoadMore hasMore={!!q.hasNextPage} busy={q.isFetchingNextPage} onClick={() => q.fetchNextPage()} />
    </div>
  );
}
