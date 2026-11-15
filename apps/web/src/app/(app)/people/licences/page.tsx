'use client';

import { useInfiniteQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { LICENCE_STATUSES, formatDate } from '@sil/hr-shared';
import { Badge, Empty, Input, LoadMore, Loading, PageHeader, ProblemBanner, Select } from '@/components/ui';
import { hr, unwrap } from '@/lib/api';
import { useSession } from '@/lib/session';

export default function LicencesPage() {
  const { settings } = useSession();
  const [status, setStatus] = useState('');
  const [within, setWithin] = useState('');
  const [body, setBody] = useState('');
  const q = useInfiniteQuery({
    queryKey: ['licences', status, within, body],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => unwrap(hr.GET('/api/v1/licences', { params: { query: { limit: 100, cursor: pageParam, status: (status || undefined) as never, expiring_within_days: within ? Number(within) : undefined, licensing_body: body || undefined } } })),
    getNextPageParam: (p) => p.next_cursor ?? undefined,
  });
  const rows = useMemo(() => q.data?.pages.flatMap((p) => p.data) ?? [], [q.data]);
  return (
    <div>
      <PageHeader title="Professional licences" description="Every practising licence, soonest expiry first. Status is worked out from the dates, verification and suspension; reminders start before expiry (Settings → licences.reminder_days) and the HMIS is told when one lapses." />
      <div className="mb-3 flex flex-wrap gap-2">
        <Select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)} className="max-w-44"><option value="">Any status</option>{LICENCE_STATUSES.map((s) => <option key={s}>{s}</option>)}</Select>
        <Select aria-label="Expiring within" value={within} onChange={(e) => setWithin(e.target.value)} className="max-w-48"><option value="">Any expiry</option><option value="30">Within 30 days</option><option value="60">Within 60 days</option><option value="90">Within 90 days</option></Select>
        <Input aria-label="Licensing body" placeholder="Licensing body" value={body} onChange={(e) => setBody(e.target.value)} className="max-w-40" />
      </div>
      <ProblemBanner error={q.error} />
      <div className="surface overflow-x-auto rounded-xl">
        {q.isLoading ? <Loading /> : !rows.length ? <Empty>No licences match.</Empty> : (
          <table className="data">
            <thead><tr><th>Employee</th><th>Body</th><th>Number</th><th>Expires</th><th>Status</th></tr></thead>
            <tbody>{rows.map((l) => <tr key={l.id}><td><Link className="text-brand-600 hover:underline" href={`/people/${l.employee_id}?tab=licences`}>Open</Link></td><td>{l.licensing_body}</td><td className="font-mono text-xs">{l.licence_number}</td><td>{formatDate(l.expiry_date, settings.date_format)}</td><td><Badge value={l.status} /></td></tr>)}</tbody>
          </table>
        )}
      </div>
      <LoadMore hasMore={!!q.hasNextPage} busy={q.isFetchingNextPage} onClick={() => q.fetchNextPage()} />
    </div>
  );
}
