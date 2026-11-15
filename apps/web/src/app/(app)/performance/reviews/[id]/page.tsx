'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { formatDate, MEASURES, REVIEW_STATUSES } from '@sil/hr-shared';
import { Badge, Button, Card, Field, Input, Loading, PageHeader, ProblemBanner, Select, Textarea } from '@/components/ui';
import { ScorePicker } from '@/components/performance';
import { hr, unwrap } from '@/lib/api';
import { useSession } from '@/lib/session';

type Review = Awaited<ReturnType<typeof load>>;
type Goal = Review['goal_list'][number];
type Measure = keyof typeof MEASURES;
const load = (id: string) => unwrap(hr.GET('/api/v1/performance/reviews/{id}', { params: { path: { id } } }));

export default function ReviewPage() {
  const { id } = useParams<{ id: string }>();
  const { settings } = useSession();
  const q = useQuery({ queryKey: ['review', id], queryFn: () => load(id) });
  const r = q.data;
  return (
    <div className="space-y-4">
      <PageHeader title={r ? `${r.employee_name}: ${r.cycle_name}` : 'Appraisal'} description={r ? `${r.position_title ?? ''}${r.department_name ? `, ${r.department_name}` : ''} · reviewer ${r.reviewer_name ?? 'not assigned'} · ${formatDate(r.period_start, settings.date_format)} to ${formatDate(r.period_end, settings.date_format)}` : undefined} />
      <ProblemBanner error={q.error} />
      {!r ? <Loading /> : (
        <>
          <Card>
            <div className="flex flex-wrap items-center gap-4 text-sm">
              <Badge value={REVIEW_STATUSES[r.status].toLowerCase()} />
              <span>Self <b>{r.self_rating ?? '–'}</b></span>
              <span>Manager <b>{r.manager_rating ?? '–'}</b></span>
              <span>Final <b>{r.final_rating ?? '–'}</b>{r.band && <span className="muted"> ({r.band})</span>}</span>
              <span className="muted">Self-review due {formatDate(r.self_review_due, settings.date_format)} · manager review due {formatDate(r.manager_review_due, settings.date_format)}</span>
            </div>
          </Card>
          <Goals r={r} />
          {(r.can.self_review || r.self_submitted_at) && <SelfPart r={r} />}
          {(r.can.manager_review || r.manager_submitted_at || r.manager_comment) && <ManagerPart r={r} />}
          {(r.can.calibrate || r.calibration_comment) && <Calibration r={r} />}
          {(r.can.acknowledge || r.acknowledged_at) && <Acknowledge r={r} />}
          {r.can.reassign && <Reassign r={r} />}
        </>
      )}
    </div>
  );
}

function useRefresh(id: string) {
  const qc = useQueryClient();
  return (data?: Review) => {
    if (data) qc.setQueryData(['review', id], data);
    void qc.invalidateQueries({ queryKey: ['review', id] });
  };
}

function Goals({ r }: { r: Review }) {
  const refresh = useRefresh(r.id);
  const [edit, setEdit] = useState<Goal | 'new' | null>(null);
  const live = r.goal_list.filter((g) => g.status !== 'dropped');
  const total = live.reduce((s, g) => s + g.weight, 0);
  const agree = useMutation({ mutationFn: () => unwrap(hr.POST('/api/v1/performance/reviews/{id}/agree-goals', { params: { path: { id: r.id } } })), onSuccess: refresh });
  const drop = useMutation({ mutationFn: (gid: string) => unwrap(hr.POST('/api/v1/performance/goals/{id}/drop', { params: { path: { id: gid } } })), onSuccess: refresh });
  return (
    <Card>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-semibold">Goals <span className={`text-sm font-normal ${total === 100 ? 'muted' : 'text-amber-600'}`}>· weights {total}%</span></h2>
        <div className="flex gap-2">
          {r.can.edit_goals && <Button variant="secondary" onClick={() => setEdit('new')}>Add goal</Button>}
          {r.can.agree_goals && <Button busy={agree.isPending} onClick={() => agree.mutate()}>Agree goals</Button>}
        </div>
      </div>
      <ProblemBanner error={agree.error ?? drop.error} />
      {!live.length ? <p className="muted text-sm">No goals yet.{r.can.edit_goals ? ' Add up to fifteen; their weights must add up to 100.' : ''}</p> : (
        <table className="data">
          <thead><tr><th>Goal</th><th>Measure / target</th><th>Weight</th><th>Progress</th><th>Status</th><th /></tr></thead>
          <tbody>{live.map((g) => (
            <tr key={g.id}>
              <td><div className="font-medium">{g.title}</div>{g.indicator_name && <div className="muted text-xs">{g.indicator_name}</div>}{g.description && <div className="muted text-xs">{g.description}</div>}</td>
              <td>{MEASURES[g.measure]}{g.target ? ` · ${g.target}` : ''}</td>
              <td>{g.weight}%</td>
              <td><Progress g={g} r={r} /></td>
              <td><Badge value={g.status} /></td>
              <td className="whitespace-nowrap text-right">{r.can.edit_goals && <><button type="button" className="link mr-2 text-sm" onClick={() => setEdit(g)}>Edit</button><button type="button" className="link text-sm" onClick={() => drop.mutate(g.id)}>Drop</button></>}</td>
            </tr>
          ))}</tbody>
        </table>
      )}
      {edit && <GoalForm r={r} goal={edit === 'new' ? null : edit} onDone={() => setEdit(null)} />}
    </Card>
  );
}

function Progress({ g, r }: { g: Goal; r: Review }) {
  const refresh = useRefresh(r.id);
  const [v, setV] = useState(String(g.progress));
  const editable = g.status === 'agreed' && ['goal_setting', 'self_review'].includes(r.status) && r.cycle_status !== 'closed' && (r.can.edit_goals || r.can.self_review || r.can.agree_goals || r.status === 'goal_setting');
  const save = useMutation({ mutationFn: () => unwrap(hr.POST('/api/v1/performance/goals/{id}/progress', { params: { path: { id: g.id } }, body: { progress: Number(v) } })), onSuccess: refresh });
  if (!editable) return <span>{g.progress}%{g.progress_note && <span className="muted block text-xs">{g.progress_note}</span>}</span>;
  return (
    <div className="flex items-center gap-1">
      <Input aria-label={`Progress on ${g.title}`} className="w-20" type="number" min={0} max={100} value={v} onChange={(e) => setV(e.target.value)} />%
      {v !== String(g.progress) && <Button variant="ghost" busy={save.isPending} onClick={() => save.mutate()}>Save</Button>}
    </div>
  );
}

function GoalForm({ r, goal, onDone }: { r: Review; goal: Goal | null; onDone: () => void }) {
  const refresh = useRefresh(r.id);
  const indicators = useQuery({ queryKey: ['indicators', 'active'], queryFn: () => unwrap(hr.GET('/api/v1/performance/indicators', { params: { query: { status: 'active' } } })) });
  const [f, setF] = useState({ indicator_id: goal?.indicator_id ?? '', title: goal?.title ?? '', description: goal?.description ?? '', measure: (goal?.measure ?? 'rating') as Measure, target: goal?.target ?? '', weight: String(goal?.weight ?? 20) });
  const pick = (iid: string) => {
    const i = indicators.data?.find((x) => x.id === iid);
    setF(i ? { ...f, indicator_id: iid, title: f.title || i.name, measure: i.measure, target: f.target || (i.default_target ?? '') } : { ...f, indicator_id: '' });
  };
  const save = useMutation({
    mutationFn: () => {
      const body = { indicator_id: f.indicator_id || null, title: f.title, description: f.description || null, measure: f.measure, target: f.target || null, weight: Number(f.weight) };
      return goal ? unwrap(hr.PUT('/api/v1/performance/goals/{id}', { params: { path: { id: goal.id }, header: { 'If-Match': `"${goal.version}"` } as never }, body })) : unwrap(hr.POST('/api/v1/performance/reviews/{id}/goals', { params: { path: { id: r.id } }, body }));
    },
    onSuccess: (d) => { refresh(d); onDone(); },
  });
  return (
    <div className="mt-3 rounded-xl border border-[var(--border)] p-3">
      <ProblemBanner error={save.error} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="From the indicator library (optional)" htmlFor="g-i"><Select id="g-i" value={f.indicator_id} onChange={(e) => pick(e.target.value)}><option value="">None</option>{indicators.data?.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}</Select></Field>
        <Field label="Goal" htmlFor="g-t"><Input id="g-t" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
        <Field label="Measure" htmlFor="g-m"><Select id="g-m" value={f.measure} onChange={(e) => setF({ ...f, measure: e.target.value as Measure })}>{Object.entries(MEASURES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select></Field>
        <Field label="Target" htmlFor="g-tg"><Input id="g-tg" value={f.target} onChange={(e) => setF({ ...f, target: e.target.value })} /></Field>
        <Field label="Weight (%)" htmlFor="g-w"><Input id="g-w" type="number" min={5} max={100} value={f.weight} onChange={(e) => setF({ ...f, weight: e.target.value })} /></Field>
        <Field label="Details" htmlFor="g-d"><Input id="g-d" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
      </div>
      <div className="mt-3 flex justify-end gap-2"><Button variant="secondary" onClick={onDone}>Cancel</Button><Button busy={save.isPending} onClick={() => save.mutate()}>{goal ? 'Save goal' : 'Add goal'}</Button></div>
    </div>
  );
}

type Scores = Record<string, { score: number | null; comment: string }>;

function ScoreTable({ r, side, scores, setScores, readOnly }: { r: Review; side: 'self' | 'manager'; scores: Scores; setScores: (s: Scores) => void; readOnly: boolean }) {
  const agreed = r.goal_list.filter((g) => g.status === 'agreed');
  if (!agreed.length) return null;
  return (
    <div className="space-y-3">
      {agreed.map((g) => (
        <div key={g.id} className="rounded-lg border border-[var(--border)] p-3 text-sm">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <span><b>{g.title}</b> <span className="muted">· {g.weight}% · progress {g.progress}%{side === 'manager' && g.self_score ? ` · self ${g.self_score}` : ''}</span></span>
            <ScorePicker label={`Score for ${g.title}`} disabled={readOnly} value={scores[g.id]?.score ?? null} onChange={(n) => setScores({ ...scores, [g.id]: { ...(scores[g.id] ?? { comment: '' }), score: n } })} />
          </div>
          {side === 'manager' && g.self_comment && <div className="muted mb-1 text-xs">Employee: {g.self_comment}</div>}
          {readOnly ? (scores[g.id]?.comment && <div>{scores[g.id].comment}</div>) : <Input aria-label={`Comment on ${g.title}`} placeholder="Comment (optional)" value={scores[g.id]?.comment ?? ''} onChange={(e) => setScores({ ...scores, [g.id]: { ...(scores[g.id] ?? { score: null }), comment: e.target.value } })} />}
        </div>
      ))}
    </div>
  );
}

const toBody = (s: Scores) => Object.entries(s).map(([goal_id, v]) => ({ goal_id, score: v.score, comment: v.comment || null }));

function SelfPart({ r }: { r: Review }) {
  const refresh = useRefresh(r.id);
  const init = () => Object.fromEntries(r.goal_list.map((g) => [g.id, { score: g.self_score, comment: g.self_comment ?? '' }]));
  const [scores, setScores] = useState<Scores>(init);
  const [comment, setComment] = useState(r.self_comment ?? '');
  useEffect(() => setScores(init()), [r.version]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = useMutation({ mutationFn: (submit: boolean) => unwrap(hr.PUT('/api/v1/performance/reviews/{id}/self', { params: { path: { id: r.id } }, body: { scores: toBody(scores), comment: comment || null, submit } })), onSuccess: refresh });
  const ro = !r.can.self_review;
  return (
    <Card>
      <h2 className="mb-2 font-semibold">Self-review {r.self_rating && <span className="muted text-sm font-normal">· {r.self_rating}</span>}</h2>
      <ProblemBanner error={save.error} />
      <ScoreTable r={r} side="self" scores={scores} setScores={setScores} readOnly={ro} />
      <Field label="Overall comments" htmlFor="s-c">{ro ? <p className="whitespace-pre-wrap text-sm">{r.self_comment || '–'}</p> : <Textarea id="s-c" value={comment} onChange={(e) => setComment(e.target.value)} />}</Field>
      {!ro && <div className="mt-3 flex justify-end gap-2"><Button variant="secondary" busy={save.isPending && !save.variables} onClick={() => save.mutate(false)}>Save draft</Button><Button busy={save.isPending && !!save.variables} onClick={() => save.mutate(true)}>Submit to my reviewer</Button></div>}
    </Card>
  );
}

function ManagerPart({ r }: { r: Review }) {
  const refresh = useRefresh(r.id);
  const init = () => Object.fromEntries(r.goal_list.map((g) => [g.id, { score: g.manager_score, comment: g.manager_comment ?? '' }]));
  const [scores, setScores] = useState<Scores>(init);
  const [f, setF] = useState({ comment: r.manager_comment ?? '', strengths: r.strengths ?? '', development_needs: r.development_needs ?? '', overall: r.manager_rating ? Math.round(Number(r.manager_rating)) : null as number | null });
  useEffect(() => setScores(init()), [r.version]); // eslint-disable-line react-hooks/exhaustive-deps
  const noGoals = !r.goal_list.some((g) => g.status === 'agreed');
  const save = useMutation({
    mutationFn: (submit: boolean) => unwrap(hr.PUT('/api/v1/performance/reviews/{id}/manager', { params: { path: { id: r.id } }, body: { scores: toBody(scores), overall_rating: noGoals ? f.overall : null, comment: f.comment || null, strengths: f.strengths || null, development_needs: f.development_needs || null, submit } })),
    onSuccess: refresh,
  });
  const ro = !r.can.manager_review;
  const text = (k: 'comment' | 'strengths' | 'development_needs', label: string) => (
    <Field label={label} htmlFor={`m-${k}`}>{ro ? <p className="whitespace-pre-wrap text-sm">{(k === 'comment' ? r.manager_comment : r[k]) || '–'}</p> : <Textarea id={`m-${k}`} value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} />}</Field>
  );
  return (
    <Card>
      <h2 className="mb-2 font-semibold">Manager assessment {r.manager_rating && <span className="muted text-sm font-normal">· {r.manager_rating}</span>}</h2>
      <ProblemBanner error={save.error} />
      {r.status === 'self_review' && !ro && <p className="mb-2 text-sm text-amber-700">The self-review was not submitted by its due date; you can assess without it.</p>}
      <ScoreTable r={r} side="manager" scores={scores} setScores={setScores} readOnly={ro} />
      {noGoals && <Field label="Overall rating (no agreed goals)" htmlFor="m-o"><ScorePicker label="Overall rating" disabled={ro} value={f.overall} onChange={(n) => setF({ ...f, overall: n })} /></Field>}
      <div className="grid gap-3 sm:grid-cols-3">{text('comment', 'Overall comments')}{text('strengths', 'Strengths')}{text('development_needs', 'Development needs')}</div>
      {!ro && <div className="mt-3 flex justify-end gap-2"><Button variant="secondary" busy={save.isPending && !save.variables} onClick={() => save.mutate(false)}>Save draft</Button><Button busy={save.isPending && !!save.variables} onClick={() => save.mutate(true)}>Submit for approval</Button></div>}
    </Card>
  );
}

function Calibration({ r }: { r: Review }) {
  const refresh = useRefresh(r.id);
  const [rating, setRating] = useState(r.final_rating ?? r.manager_rating ?? '');
  const [comment, setComment] = useState('');
  const save = useMutation({ mutationFn: () => unwrap(hr.PUT('/api/v1/performance/reviews/{id}/calibration', { params: { path: { id: r.id } }, body: { final_rating: Number(rating), comment } })), onSuccess: refresh });
  return (
    <Card>
      <h2 className="mb-2 font-semibold">Calibration</h2>
      <ProblemBanner error={save.error} />
      {r.calibration_comment && <p className="mb-2 text-sm">{r.calibration_comment}</p>}
      {r.can.calibrate && (
        <div className="grid items-end gap-3 sm:grid-cols-[8rem_1fr_auto]">
          <Field label="Final rating" htmlFor="c-r"><Input id="c-r" type="number" step="0.01" min={1} max={5} value={rating} onChange={(e) => setRating(e.target.value)} /></Field>
          <Field label="Reason (kept in the audit trail)" htmlFor="c-c"><Input id="c-c" value={comment} onChange={(e) => setComment(e.target.value)} /></Field>
          <Button busy={save.isPending} onClick={() => save.mutate()}>Set final rating</Button>
        </div>
      )}
      {r.can.calibrate && <p className="muted mt-2 text-xs">Approve or return the review itself from Approvals.</p>}
    </Card>
  );
}

function Acknowledge({ r }: { r: Review }) {
  const refresh = useRefresh(r.id);
  const { settings } = useSession();
  const [agree, setAgree] = useState(true);
  const [comment, setComment] = useState('');
  const save = useMutation({ mutationFn: () => unwrap(hr.POST('/api/v1/performance/reviews/{id}/acknowledge', { params: { path: { id: r.id } }, body: { agree, comment: comment || null } })), onSuccess: refresh });
  if (r.acknowledged_at) return <Card><h2 className="mb-1 font-semibold">Acknowledged</h2><p className="text-sm">{formatDate(r.acknowledged_at.slice(0, 10), settings.date_format)}: {r.employee_agrees ? 'agrees with the review' : 'does not agree'}{r.employee_comment ? `. ${r.employee_comment}` : ''}</p></Card>;
  return (
    <Card>
      <h2 className="mb-2 font-semibold">Your acknowledgement</h2>
      <ProblemBanner error={save.error} />
      <div className="flex gap-4 text-sm">
        <label className="flex items-center gap-2"><input type="radio" checked={agree} onChange={() => setAgree(true)} /> I agree with this review</label>
        <label className="flex items-center gap-2"><input type="radio" checked={!agree} onChange={() => setAgree(false)} /> I do not agree</label>
      </div>
      <Field label={agree ? 'Comments (optional)' : 'What do you disagree with?'} htmlFor="a-c"><Textarea id="a-c" value={comment} onChange={(e) => setComment(e.target.value)} /></Field>
      <div className="mt-3 flex justify-end"><Button busy={save.isPending} onClick={() => save.mutate()}>Acknowledge</Button></div>
    </Card>
  );
}

function Reassign({ r }: { r: Review }) {
  const refresh = useRefresh(r.id);
  const users = useQuery({ queryKey: ['active-users'], queryFn: () => unwrap(hr.GET('/api/v1/users', { params: { query: { limit: 100, status: 'active' } } })) });
  const [uid, setUid] = useState('');
  const save = useMutation({ mutationFn: () => unwrap(hr.PUT('/api/v1/performance/reviews/{id}/reviewer', { params: { path: { id: r.id } }, body: { reviewer_user_id: uid } })), onSuccess: refresh });
  const list = users.data?.data ?? [];
  return (
    <Card>
      <h2 className="mb-2 font-semibold">Reviewer</h2>
      <ProblemBanner error={save.error ?? users.error} />
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Change the reviewer" htmlFor="rv-u"><Select id="rv-u" value={uid} onChange={(e) => setUid(e.target.value)}><option value="">Choose…</option>{list.filter((u) => u.status === 'active').map((u) => <option key={u.id} value={u.id}>{u.display_name}</option>)}</Select></Field>
        <Button variant="secondary" disabled={!uid} busy={save.isPending} onClick={() => save.mutate()}>Reassign</Button>
      </div>
    </Card>
  );
}
