'use client';

import { useInfiniteQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { Badge, Empty, Input, LoadMore, Loading, PageHeader, ProblemBanner, Select } from '@/components/ui';
import { hr, unwrap } from '@/lib/api';
import { useLookups } from '@/lib/lookups';

/** The same lean directory other systems read through /api/v1/directory/staff. */
export default function DirectoryPage() {
  const l = useLookups();
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [dept, setDept] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebounced(search), 250);
    return () => clearTimeout(t);
  }, [search]);
  const q = useInfiniteQuery({
    queryKey: ['directory', debounced, dept],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => unwrap(hr.GET('/api/v1/directory/staff', { params: { query: { limit: 60, cursor: pageParam, search: debounced || undefined, department_id: dept || undefined, include_sub_departments: dept ? 'true' : undefined } } })),
    getNextPageParam: (p) => p.next_cursor ?? undefined,
  });
  const rows = useMemo(() => (q.data?.pages.flatMap((p) => p.data) ?? []).filter((r) => 'staff_number' in r), [q.data]);
  return (
    <div>
      <PageHeader title="Staff directory" description="Who works where, and how to reach them at work." />
      <div className="mb-3 flex flex-wrap gap-2">
        <Input aria-label="Search" placeholder="Name, staff number or email" value={search} onChange={(e) => setSearch(e.target.value)} className="max-w-xs" />
        <Select aria-label="Department" value={dept} onChange={(e) => setDept(e.target.value)} className="max-w-60"><option value="">All departments</option>{l.departmentOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</Select>
      </div>
      <ProblemBanner error={q.error} />
      {q.isLoading ? <Loading /> : !rows.length ? <Empty>No one matches.</Empty> : (
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {rows.map((p) => 'staff_number' in p && (
            <li key={p.id} className="surface rounded-xl p-4 text-sm">
              <div className="font-medium">{p.display_name}</div>
              <div className="muted text-xs">{p.position_title} · {p.department_name}</div>
              <div className="mt-2 space-y-0.5">
                {p.work_email && <a className="block text-brand-600 hover:underline" href={`mailto:${p.work_email}`}>{p.work_email}</a>}
                {p.work_phone && <a className="block hover:underline" href={`tel:${p.work_phone.replace(/\s/g, '')}`}>{p.work_phone}</a>}
              </div>
              {p.is_clinical && p.licence_status && <div className="mt-2"><Badge value={`licence ${p.licence_status}`} /></div>}
            </li>
          ))}
        </ul>
      )}
      <LoadMore hasMore={!!q.hasNextPage} busy={q.isFetchingNextPage} onClick={() => q.fetchNextPage()} />
    </div>
  );
}
