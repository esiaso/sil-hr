'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { formatDateTime } from '@sil/hr-shared';
import { Button, Empty, Loading, PageHeader, ProblemBanner } from '@/components/ui';
import { hr, unwrap } from '@/lib/api';
import { useSession } from '@/lib/session';

export default function NotificationsPage() {
  const { settings } = useSession();
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['notifications'], queryFn: () => unwrap(hr.GET('/api/v1/notifications')) });
  const read = useMutation({
    mutationFn: (id: string) => unwrap(hr.POST('/api/v1/notifications/{id}/read', { params: { path: { id } } })),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }),
  });
  return (
    <div>
      <PageHeader title="Notifications" />
      <ProblemBanner error={list.error} />
      {list.isLoading ? (
        <Loading />
      ) : !list.data?.length ? (
        <Empty>No notifications.</Empty>
      ) : (
        <ul className="space-y-2">
          {list.data.map((n) => (
            <li key={n.id} className={`surface rounded-lg p-4 ${n.read_at ? 'opacity-70' : ''}`}>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="font-medium">{n.title}</div>
                  <div className="muted text-xs">{formatDateTime(n.created_at, settings.timezone, settings.date_format)}</div>
                  <p className="mt-2 text-sm whitespace-pre-line">{n.body}</p>
                  {n.link && (
                    <Link className="text-brand-600 text-sm underline" href={n.link}>
                      Open
                    </Link>
                  )}
                </div>
                {!n.read_at && (
                  <Button variant="secondary" onClick={() => read.mutate(n.id)}>
                    Mark read
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
