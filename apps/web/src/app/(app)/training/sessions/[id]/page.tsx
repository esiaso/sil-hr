'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { ENROLMENT_STATUSES, formatDateTime, formatMoney } from '@sil/hr-shared';
import { Badge, Button, Card, Empty, Input, Loading, PageHeader, ProblemBanner } from '@/components/ui';
import { EmployeePicker } from '@/components/employee-picker';
import { SessionDialog } from '@/components/training';
import { hr, unwrap } from '@/lib/api';
import { useSession } from '@/lib/session';

type Detail = Awaited<ReturnType<typeof load>>;
const load = (id: string) => unwrap(hr.GET('/api/v1/training/sessions/{id}', { params: { path: { id } } }));

export default function SessionPage() {
  const { id } = useParams<{ id: string }>();
  const { settings, can } = useSession();
  const manage = can('training:manage');
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['session', id], queryFn: () => load(id) });
  const [editing, setEditing] = useState(false);
  const done = (d: Detail) => { qc.setQueryData(['session', id], d); void qc.invalidateQueries({ queryKey: ['sessions'] }); };
  const cancel = useMutation({ mutationFn: () => unwrap(hr.POST('/api/v1/training/sessions/{id}/cancel', { params: { path: { id } } })), onSuccess: () => void q.refetch() });
  const complete = useMutation({ mutationFn: () => unwrap(hr.POST('/api/v1/training/sessions/{id}/complete', { params: { path: { id } } })), onSuccess: done });
  const s = q.data;
  const started = s && new Date(s.starts_at) <= new Date();
  const ended = s && new Date(s.ends_at) <= new Date();
  return (
    <div className="space-y-4">
      <PageHeader
        title={s ? `${s.programme_title} · ${s.number}` : 'Training session'}
        description={s ? `${formatDateTime(s.starts_at, settings.timezone, settings.date_format)} to ${formatDateTime(s.ends_at, settings.timezone, settings.date_format)}${s.venue ? ` · ${s.venue}` : ''}${s.trainer ? ` · ${s.trainer}` : ''}` : undefined}
        actions={s && manage && s.status === 'scheduled' && (
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => setEditing(true)}>Edit</Button>
            {ended && <Button busy={complete.isPending} onClick={() => complete.mutate()}>Close session</Button>}
            {!started && <Button variant="ghost" busy={cancel.isPending} onClick={() => window.confirm('Cancel this session? Everyone booked is told.') && cancel.mutate()}>Cancel session</Button>}
          </div>
        )}
      />
      <ProblemBanner error={q.error ?? cancel.error ?? complete.error} />
      {!s ? <Loading /> : (
        <>
          <Card>
            <div className="flex flex-wrap gap-4 text-sm">
              <Badge value={s.status} />
              <span>{s.enrolled}{s.capacity ? ` of ${s.capacity}` : ''} booked</span>
              {s.requested > 0 && <span>{s.requested} waiting for approval</span>}
              {s.status !== 'scheduled' || started ? <span>{s.attended} attended</span> : null}
              {Number(s.cpd_points) > 0 && <span>{s.cpd_points} CPD points</span>}
              {s.pass_mark && <span>Pass mark {s.pass_mark}%</span>}
              {s.cost_per_person && <span>{formatMoney(s.cost_per_person)} per person</span>}
            </div>
          </Card>
          {manage && s.status === 'scheduled' && <Enrol s={s} onDone={done} />}
          <Attendees s={s} manage={manage && s.status === 'scheduled' && !!started} onDone={done} />
        </>
      )}
      {editing && s && <SessionDialog session={s} onClose={() => setEditing(false)} />}
    </div>
  );
}

function Enrol({ s, onDone }: { s: Detail; onDone: (d: Detail) => void }) {
  const [picked, setPicked] = useState<{ id: string; name: string }[]>([]);
  const [next, setNext] = useState<{ id: string; name: string } | null>(null);
  useEffect(() => { if (next) { setPicked((p) => (p.some((x) => x.id === next.id) ? p : [...p, next])); setNext(null); } }, [next]);
  const save = useMutation({ mutationFn: () => unwrap(hr.POST('/api/v1/training/sessions/{id}/enrol', { params: { path: { id: s.id } }, body: { employee_ids: picked.map((p) => p.id) } })), onSuccess: (d) => { setPicked([]); onDone(d); } });
  return (
    <Card>
      <h2 className="mb-2 font-semibold">Book staff</h2>
      <ProblemBanner error={save.error} />
      <div className="grid items-start gap-3 sm:grid-cols-[1fr_auto]">
        <div>
          <EmployeePicker id="en-pick" value={next} onChange={setNext} />
          {picked.length > 0 && <div className="mt-2 flex flex-wrap gap-2">{picked.map((p) => <span key={p.id} className="rounded-full bg-[var(--surface-2)] px-3 py-1 text-sm">{p.name} <button type="button" aria-label={`Remove ${p.name}`} className="muted ml-1" onClick={() => setPicked(picked.filter((x) => x.id !== p.id))}>×</button></span>)}</div>}
        </div>
        <Button disabled={!picked.length} busy={save.isPending} onClick={() => save.mutate()}>Book {picked.length || ''}</Button>
      </div>
      <p className="muted mt-2 text-xs">Booking here needs no approval. Anyone waiting for approval is booked straight away.</p>
    </Card>
  );
}

function Attendees({ s, manage, onDone }: { s: Detail; manage: boolean; onDone: (d: Detail) => void }) {
  const markable = s.attendees.filter((a) => ['enrolled', 'attended', 'absent'].includes(a.status));
  const [marks, setMarks] = useState<Record<string, { attended: boolean | null; score: string }>>({});
  useEffect(() => setMarks(Object.fromEntries(markable.map((a) => [a.id, { attended: a.status === 'attended' ? true : a.status === 'absent' ? false : null, score: a.score === null ? '' : String(a.score) }]))), [s.version, s.attended]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = useMutation({
    mutationFn: () => unwrap(hr.POST('/api/v1/training/sessions/{id}/attendance', { params: { path: { id: s.id } }, body: { records: Object.entries(marks).filter(([, m]) => m.attended !== null).map(([enrolment_id, m]) => ({ enrolment_id, attended: !!m.attended, score: m.score === '' ? null : Number(m.score) })) } })),
    onSuccess: onDone,
  });
  return (
    <Card>
      <div className="mb-2 flex items-center justify-between"><h2 className="font-semibold">Attendees</h2>{manage && markable.length > 0 && <Button busy={save.isPending} onClick={() => save.mutate()}>Save attendance</Button>}</div>
      <ProblemBanner error={save.error} />
      {!s.attendees.length ? <Empty>No one booked yet.</Empty> : (
        <table className="data">
          <thead><tr><th>Name</th><th>Department</th><th>Status</th>{manage && <th>Attended</th>}<th>Score</th><th>Result</th><th>CPD</th><th>Feedback</th></tr></thead>
          <tbody>{s.attendees.map((a) => {
            const m = marks[a.id];
            return (
              <tr key={a.id}>
                <td>{a.employee_name} <span className="muted text-xs">{a.staff_number}</span></td><td>{a.department_name}</td>
                <td><Badge value={ENROLMENT_STATUSES[a.status].toLowerCase()} />{a.decision_comment && <div className="muted text-xs">{a.decision_comment}</div>}</td>
                {manage && <td>{m ? <div className="flex gap-2 text-sm"><label className="flex items-center gap-1"><input type="radio" name={`at-${a.id}`} checked={m.attended === true} onChange={() => setMarks({ ...marks, [a.id]: { ...m, attended: true } })} /> Yes</label><label className="flex items-center gap-1"><input type="radio" name={`at-${a.id}`} checked={m.attended === false} onChange={() => setMarks({ ...marks, [a.id]: { ...m, attended: false } })} /> No</label></div> : '–'}</td>}
                <td>{manage && m && s.pass_mark ? <Input aria-label={`Score for ${a.employee_name}`} className="w-20" type="number" min={0} max={100} value={m.score} onChange={(e) => setMarks({ ...marks, [a.id]: { ...m, score: e.target.value } })} /> : a.score ?? '–'}</td>
                <td>{a.passed === null ? (a.status === 'attended' ? 'Completed' : '–') : a.passed ? 'Passed' : 'Not passed'}</td>
                <td>{a.cpd_points ?? '–'}</td>
                <td>{a.feedback_rating ? `${'★'.repeat(a.feedback_rating)}` : ''}{a.feedback_comment && <div className="muted text-xs">{a.feedback_comment}</div>}</td>
              </tr>
            );
          })}</tbody>
        </table>
      )}
      {manage && s.pass_mark && <p className="muted mt-2 text-xs">Scores are out of 100; {s.pass_mark} or more passes. Only a pass completes the training and earns the CPD points.</p>}
    </Card>
  );
}
