'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ASSIGNEES, formatDate } from '@sil/hr-shared';
import { Badge, Button, Card, Empty, Loading, PageHeader, ProblemBanner } from '@/components/ui';
import { hr, unwrap } from '@/lib/api';
import { useSession } from '@/lib/session';

export default function MyTasksPage() {
  const { settings } = useSession();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['my-tasks'], queryFn: () => unwrap(hr.GET('/api/v1/me/checklist-tasks')) });
  const set = useMutation({ mutationFn: (v: { id: string; status: 'done' | 'not_applicable' }) => unwrap(hr.PUT('/api/v1/checklist-tasks/{id}', { params: { path: { id: v.id } }, body: { status: v.status } })), onSuccess: () => qc.invalidateQueries({ queryKey: ['my-tasks'] }) });
  const today = new Date().toISOString().slice(0, 10);
  const groups = new Map<string, NonNullable<typeof q.data>>();
  for (const t of q.data ?? []) groups.set(`${t.kind}|${t.employee_name}`, [...(groups.get(`${t.kind}|${t.employee_name}`) ?? []), t]);
  return (
    <div className="space-y-4">
      <PageHeader title="My tasks" description="Onboarding and offboarding tasks for your team, the people who report to you, and yourself." />
      <ProblemBanner error={q.error ?? set.error} />
      {!q.data ? <Loading /> : !q.data.length ? <Card><Empty>Nothing to do.</Empty></Card> : [...groups.entries()].map(([k, tasks]) => (
        <Card key={k}>
          <h2 className="mb-2 font-semibold">{tasks[0].employee_name} <span className="muted text-sm font-normal">· {tasks[0].kind}</span></h2>
          <ul className="divide-y divide-[var(--border)]">
            {tasks.map((t) => (
              <li key={t.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                <div>
                  <div className="font-medium">{t.title} {t.blocks_exit && <Badge value="needed before exit" />}</div>
                  <div className={`text-xs ${t.due_date < today ? 'text-red-600' : 'muted'}`}>{ASSIGNEES[t.assignee]} · due {formatDate(t.due_date, settings.date_format)}</div>
                </div>
                <div className="flex gap-2"><Button variant="secondary" onClick={() => set.mutate({ id: t.id, status: 'not_applicable' })}>Not needed</Button><Button onClick={() => set.mutate({ id: t.id, status: 'done' })}>Done</Button></div>
              </li>
            ))}
          </ul>
        </Card>
      ))}
    </div>
  );
}
