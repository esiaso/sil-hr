'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { formatDateTime, INTERVIEW_CRITERIA, RECOMMENDATIONS } from '@sil/hr-shared';
import { Badge, Button, Card, Dialog, Empty, Field, Loading, PageHeader, ProblemBanner, Select, Textarea } from '@/components/ui';
import { hr, unwrap } from '@/lib/api';
import { useSession } from '@/lib/session';

type Rec = keyof typeof RECOMMENDATIONS;

export default function MyInterviewsPage() {
  const { settings } = useSession();
  const q = useQuery({ queryKey: ['my-interviews'], queryFn: () => unwrap(hr.GET('/api/v1/me/interviews')) });
  const [open, setOpen] = useState<{ id: string; name: string } | null>(null);
  return (
    <div className="space-y-4">
      <PageHeader title="My interviews" description="Interviews you sit on. Open the CV, then give your scores and recommendation; the recruiter sees every panel member's view." />
      <ProblemBanner error={q.error} />
      <Card>
        {!q.data ? <Loading /> : !q.data.length ? <Empty>No interviews.</Empty> : (
          <table className="data">
            <thead><tr><th>When</th><th>Candidate</th><th>Job</th><th>Where</th><th>Status</th><th /></tr></thead>
            <tbody>{q.data.map((i) => (
              <tr key={i.id}>
                <td className="whitespace-nowrap">{formatDateTime(i.scheduled_at, settings.timezone, settings.date_format)}</td><td>{i.candidate_name}</td><td>{i.posting_title}</td><td>{i.location}</td>
                <td><Badge value={i.status} />{i.my_feedback && <span className="muted ml-1 text-xs">feedback given</span>}</td>
                <td className="whitespace-nowrap text-right">{i.cv_document_id && <a className="link mr-3 text-sm" href={`/api/v1/interviews/${i.id}/cv`}>CV</a>}<Button variant={i.my_feedback ? 'ghost' : 'primary'} onClick={() => setOpen({ id: i.id, name: i.candidate_name })}>{i.my_feedback ? 'Change feedback' : 'Give feedback'}</Button></td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </Card>
      {open && <FeedbackDialog interview={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

function FeedbackDialog({ interview, onClose }: { interview: { id: string; name: string }; onClose: () => void }) {
  const qc = useQueryClient();
  const [scores, setScores] = useState<Record<string, number>>({});
  const [rec, setRec] = useState<Rec>('yes');
  const [comment, setComment] = useState('');
  const save = useMutation({ mutationFn: () => unwrap(hr.PUT('/api/v1/interviews/{id}/feedback', { params: { path: { id: interview.id } }, body: { recommendation: rec, scores, comment: comment || null } })), onSuccess: () => { void qc.invalidateQueries({ queryKey: ['my-interviews'] }); onClose(); } });
  return (
    <Dialog open title={`Feedback: ${interview.name}`} onClose={onClose}>
      <ProblemBanner error={save.error} />
      <div className="space-y-2">
        {Object.entries(INTERVIEW_CRITERIA).map(([k, l]) => (
          <div key={k} className="flex items-center justify-between gap-2 text-sm">
            <span>{l}</span>
            <div className="flex gap-1" role="radiogroup" aria-label={l}>{[1, 2, 3, 4, 5].map((n) => <button key={n} type="button" aria-pressed={scores[k] === n} onClick={() => setScores({ ...scores, [k]: n })} className={`h-8 w-8 rounded-lg border text-sm ${scores[k] === n ? 'border-brand-500 bg-brand-500 text-white' : 'border-[var(--border)] hover:bg-[var(--hover)]'}`}>{n}</button>)}</div>
          </div>
        ))}
      </div>
      <Field label="Recommendation" htmlFor="fb-r"><Select id="fb-r" value={rec} onChange={(e) => setRec(e.target.value as Rec)}>{Object.entries(RECOMMENDATIONS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select></Field>
      <Field label="Comments" htmlFor="fb-c"><Textarea id="fb-c" value={comment} onChange={(e) => setComment(e.target.value)} /></Field>
      <div className="mt-4 flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button busy={save.isPending} onClick={() => save.mutate()}>Save</Button></div>
    </Dialog>
  );
}
