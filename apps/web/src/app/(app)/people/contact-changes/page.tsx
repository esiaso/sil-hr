'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { formatDateTime } from '@sil/hr-shared';
import { Button, Empty, Loading, PageHeader, ProblemBanner } from '@/components/ui';
import { hr, unwrap } from '@/lib/api';
import { useSession } from '@/lib/session';

export default function ContactChangesPage() {
  const { settings } = useSession();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['contact-changes'], queryFn: () => unwrap(hr.GET('/api/v1/contact-change-requests')) });
  const decide = useMutation({
    mutationFn: (v: { id: string; decision: 'approved' | 'rejected' }) => unwrap(hr.POST('/api/v1/contact-change-requests/{id}/decision', { params: { path: { id: v.id } }, body: { decision: v.decision, note: v.decision === 'rejected' ? (window.prompt('Reason for rejecting (shown to the employee)') ?? undefined) : undefined } })),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['contact-changes'] }),
  });
  return (
    <div>
      <PageHeader title="Contact changes" description="Changes employees asked for in self-service. Approving applies them and tells other systems (hr.employee.updated.v1)." />
      <ProblemBanner error={q.error ?? decide.error} />
      {!q.data ? <Loading /> : !q.data.length ? <Empty>Nothing waiting.</Empty> : (
        <ul className="space-y-2">
          {q.data.map((r) => (
            <li key={r.id} className="surface flex flex-wrap items-start justify-between gap-3 rounded-lg p-4">
              <div className="text-sm">
                <Link className="text-brand-600 font-medium hover:underline" href={`/people/${r.employee_id}`}>Employee record</Link>
                <span className="muted ml-2 text-xs">{formatDateTime(r.submitted_at, settings.timezone, settings.date_format)}</span>
                <ul className="mt-2">{Object.entries(r.changes).map(([k, v]) => <li key={k}><b>{k.replace(/_/g, ' ')}</b>: {String(v ?? '(clear)')}</li>)}</ul>
              </div>
              <div className="flex gap-2"><Button onClick={() => decide.mutate({ id: r.id, decision: 'approved' })}>Approve</Button><Button variant="secondary" onClick={() => decide.mutate({ id: r.id, decision: 'rejected' })}>Reject</Button></div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
