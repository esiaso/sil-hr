'use client';

import { useInfiniteQuery, useMutation } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { ATTENDANCE_STATUSES, formatDate, formatDateTime } from '@sil/hr-shared';
import { Badge, Button, Empty, Input, LoadMore, Loading, PageHeader, ProblemBanner, Select } from '@/components/ui';
import { hr, unwrap } from '@/lib/api';
import { useLookups } from '@/lib/lookups';
import { useSession } from '@/lib/session';

const hm = (min: number) => (min ? `${Math.floor(min / 60)}:${String(min % 60).padStart(2, '0')}` : '');

export default function AttendancePage() {
  const { can, settings } = useSession();
  const l = useLookups();
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const [from, setFrom] = useState(yesterday);
  const [to, setTo] = useState(yesterday);
  const [dept, setDept] = useState('');
  const [status, setStatus] = useState('');
  const q = useInfiniteQuery({
    queryKey: ['attendance-days', from, to, dept, status],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => unwrap(hr.GET('/api/v1/attendance/days', { params: { query: { from, to, limit: 200, cursor: pageParam, department_id: dept || undefined, status: (status || undefined) as never } } })),
    getNextPageParam: (p) => p.next_cursor ?? undefined,
  });
  const rows = useMemo(() => q.data?.pages.flatMap((p) => p.data) ?? [], [q.data]);
  const recompute = useMutation({ mutationFn: () => unwrap(hr.POST('/api/v1/attendance/recompute', { body: { from, to, department_id: dept || undefined } })), onSuccess: () => void q.refetch() });
  const t = (iso: string | null) => (iso ? formatDateTime(iso, settings.timezone, settings.date_format).slice(11) : '');
  return (
    <div>
      <PageHeader title="Daily attendance" description="Worked out from device and app punches, the roster (or the department's standing shift), approved leave and the attendance settings. Recalculate after changing a roster or a setting." actions={can('attendance:manage') && <Button variant="secondary" busy={recompute.isPending} onClick={() => recompute.mutate()}>Recalculate</Button>} />
      <div className="mb-3 flex flex-wrap gap-2">
        <Input aria-label="From" type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="max-w-40" />
        <Input aria-label="To" type="date" value={to} onChange={(e) => setTo(e.target.value)} className="max-w-40" />
        <Select aria-label="Department" value={dept} onChange={(e) => setDept(e.target.value)} className="max-w-60"><option value="">All I can see</option>{l.departmentOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</Select>
        <Select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)} className="max-w-40"><option value="">Any status</option>{ATTENDANCE_STATUSES.map((s) => <option key={s}>{s}</option>)}</Select>
      </div>
      <ProblemBanner error={q.error ?? recompute.error} />
      <div className="surface overflow-x-auto rounded-xl">
        {q.isLoading ? <Loading /> : !rows.length ? <Empty>No attendance for these days.</Empty> : (
          <table className="data">
            <thead><tr><th>Day</th><th>Person</th><th>Shift</th><th>In</th><th>Out</th><th>Worked</th><th>Late</th><th>Overtime</th><th>Status</th></tr></thead>
            <tbody>
              {rows.map((d) => (
                <tr key={d.id}>
                  <td className="whitespace-nowrap text-xs">{formatDate(d.work_date, settings.date_format)}</td>
                  <td>{d.employee_name}</td>
                  <td>{d.shift_code}</td>
                  <td className="tabular-nums">{t(d.first_in)}</td>
                  <td className="tabular-nums">{t(d.last_out)}</td>
                  <td className="tabular-nums">{hm(d.worked_minutes)}</td>
                  <td className="tabular-nums">{d.late_minutes || ''}</td>
                  <td className="tabular-nums">{hm(d.overtime_minutes)}{d.overtime_minutes && d.day_type !== 'normal' ? ` (${d.day_type.replace('_', ' ')})` : ''}</td>
                  <td><Badge value={d.status} />{d.regularised && <span className="muted ml-1 text-xs">corrected</span>}</td>
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
