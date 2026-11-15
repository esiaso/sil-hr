'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ApiError, unwrap, hr } from '@/lib/api';
import { CPD_STATUSES, ENROLMENT_STATUSES, formatDate, formatDateTime, formatMoney, MANDATORY_STATES } from '@sil/hr-shared';
import { Badge, Button, Card, Dialog, Empty, Field, Input, Loading, PageHeader, ProblemBanner, Textarea } from '@/components/ui';
import { ScorePicker } from '@/components/performance';
import { useSession } from '@/lib/session';

export default function MyTrainingPage() {
  const { settings } = useSession();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['my-training'], queryFn: () => unwrap(hr.GET('/api/v1/me/training')) });
  const cpd = useQuery({ queryKey: ['my-cpd'], queryFn: () => unwrap(hr.GET('/api/v1/me/cpd', { params: { query: {} } })) });
  const [asking, setAsking] = useState<{ id: string; title: string; cost: string | null } | null>(null);
  const [rating, setRating] = useState<{ id: string; title: string } | null>(null);
  const [claiming, setClaiming] = useState(false);
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['my-training'] }); void qc.invalidateQueries({ queryKey: ['my-cpd'] }); };
  const withdraw = useMutation({ mutationFn: (id: string) => unwrap(hr.POST('/api/v1/training/enrolments/{id}/withdraw', { params: { path: { id } } })), onSuccess: refresh });
  const when = (iso: string) => formatDateTime(iso, settings.timezone, settings.date_format);
  const d = q.data;
  const mine = new Set(d?.enrolments.filter((e) => ['requested', 'enrolled'].includes(e.status)).map((e) => e.session_id));
  return (
    <div className="space-y-4">
      <PageHeader title="My training and CPD" description="Your bookings, mandatory training, sessions you can ask to join and your CPD points." actions={<Button variant="secondary" onClick={() => setClaiming(true)}>Claim CPD points</Button>} />
      <ProblemBanner error={q.error ?? cpd.error ?? withdraw.error} />
      {cpd.data && cpd.data.summary.map((s) => (
        <Card key={s.licensing_body}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div><div className="muted text-xs">{s.licensing_body} CPD, {cpd.data.year}</div><div className="text-2xl font-semibold">{s.earned} <span className="muted text-base font-normal">of {s.status === 'no_requirement' ? 'no set number of' : s.required} points</span></div>{Number(s.pending) > 0 && <div className="muted text-xs">{s.pending} more waiting for verification</div>}</div>
            <div className="text-right text-sm"><Badge value={s.status === 'met' ? 'met' : s.status === 'short' ? 'short' : 'not set'} /><div className="muted text-xs">Licence expires {formatDate(s.licence_expiry, settings.date_format)}</div></div>
          </div>
          {s.status !== 'no_requirement' && <div className="mt-3 h-2 rounded-full bg-[var(--surface-2)]"><div className={`h-2 rounded-full ${s.status === 'met' ? 'bg-emerald-500' : 'bg-amber-500'}`} style={{ width: `${Math.min(100, (Number(s.earned) / Math.max(1, Number(s.required))) * 100)}%` }} /></div>}
        </Card>
      ))}
      {!d ? <Loading /> : (
        <>
          {d.mandatory.length > 0 && (
            <Card>
              <h2 className="mb-2 font-semibold">Mandatory training</h2>
              <table className="data"><thead><tr><th>Programme</th><th>Last done</th><th>Due</th><th>State</th></tr></thead>
                <tbody>{d.mandatory.map((m) => <tr key={m.programme_id}><td>{m.programme_title}</td><td>{formatDate(m.last_completed, settings.date_format) || '–'}</td><td>{formatDate(m.due_on, settings.date_format) || '–'}</td><td><Badge value={MANDATORY_STATES[m.state].toLowerCase()} /></td></tr>)}</tbody>
              </table>
            </Card>
          )}
          <Card>
            <h2 className="mb-2 font-semibold">My sessions</h2>
            {!d.enrolments.length ? <Empty>No training yet.</Empty> : (
              <table className="data"><thead><tr><th>Programme</th><th>When</th><th>Venue</th><th>Status</th><th>Result</th><th /></tr></thead>
                <tbody>{d.enrolments.map((e) => (
                  <tr key={e.id}>
                    <td>{e.programme_title} <span className="muted text-xs">{e.session_number}</span></td><td className="whitespace-nowrap">{when(e.starts_at)}</td><td>{e.venue}</td>
                    <td><Badge value={ENROLMENT_STATUSES[e.status].toLowerCase()} />{e.decision_comment && <div className="muted text-xs">{e.decision_comment}</div>}</td>
                    <td>{e.status === 'attended' ? `${e.passed === false ? 'Not passed' : 'Completed'}${e.score !== null ? ` (${e.score}%)` : ''}${e.cpd_points ? ` · ${e.cpd_points} CPD` : ''}` : ''}</td>
                    <td className="whitespace-nowrap text-right">
                      {['requested', 'enrolled'].includes(e.status) && new Date(e.starts_at) > new Date() && <button type="button" className="link text-sm" onClick={() => window.confirm('Give up your place?') && withdraw.mutate(e.id)}>Withdraw</button>}
                      {e.status === 'attended' && <button type="button" className="link text-sm" onClick={() => setRating({ id: e.id, title: e.programme_title })}>{e.feedback_rating ? 'Change rating' : 'Rate it'}</button>}
                    </td>
                  </tr>
                ))}</tbody>
              </table>
            )}
          </Card>
          <Card>
            <h2 className="mb-2 font-semibold">Coming up</h2>
            {!d.open_sessions.length ? <Empty>No sessions are taking requests.</Empty> : (
              <table className="data"><thead><tr><th>Programme</th><th>When</th><th>Venue</th><th>Places</th><th>CPD</th><th /></tr></thead>
                <tbody>{d.open_sessions.map((s) => (
                  <tr key={s.id}>
                    <td>{s.programme_title}{s.cost_per_person && <div className="muted text-xs">Hospital-funded ({formatMoney(s.cost_per_person)})</div>}</td><td className="whitespace-nowrap">{when(s.starts_at)}</td><td>{s.venue}</td>
                    <td>{s.capacity ? `${Math.max(0, s.capacity - s.enrolled)} left` : 'Open'}</td><td>{Number(s.cpd_points) ? s.cpd_points : '–'}</td>
                    <td className="text-right">{mine.has(s.id) ? <span className="muted text-sm">booked or asked</span> : <Button variant="secondary" onClick={() => setAsking({ id: s.id, title: s.programme_title, cost: s.cost_per_person })}>Ask for a place</Button>}</td>
                  </tr>
                ))}</tbody>
              </table>
            )}
          </Card>
          {cpd.data && (
            <Card>
              <h2 className="mb-2 font-semibold">CPD record, {cpd.data.year}</h2>
              {!cpd.data.entries.length ? <Empty>No CPD points this year.</Empty> : (
                <table className="data"><thead><tr><th>Activity</th><th>Date</th><th>Points</th><th>Body</th><th>Source</th><th>Status</th></tr></thead>
                  <tbody>{cpd.data.entries.map((c) => <tr key={c.id}><td>{c.title}{c.provider && <div className="muted text-xs">{c.provider}</div>}</td><td>{formatDate(c.activity_date, settings.date_format)}</td><td>{c.points}</td><td>{c.licensing_body ?? '–'}</td><td>{c.source === 'training' ? 'Hospital training' : 'Outside activity'}</td><td><Badge value={CPD_STATUSES[c.status].split(' ')[0].toLowerCase()} />{c.decision_comment && <div className="muted text-xs">{c.decision_comment}</div>}</td></tr>)}</tbody>
                </table>
              )}
            </Card>
          )}
        </>
      )}
      {asking && <AskDialog s={asking} onClose={() => { setAsking(null); refresh(); }} />}
      {rating && <RateDialog e={rating} onClose={() => { setRating(null); refresh(); }} />}
      {claiming && <ClaimDialog onClose={() => { setClaiming(false); refresh(); }} />}
    </div>
  );
}

function AskDialog({ s, onClose }: { s: { id: string; title: string; cost: string | null }; onClose: () => void }) {
  const [reason, setReason] = useState('');
  const save = useMutation({ mutationFn: () => unwrap(hr.POST('/api/v1/training/sessions/{id}/request', { params: { path: { id: s.id } }, body: { reason: reason || null } })), onSuccess: onClose });
  return (
    <Dialog open title={`Ask for a place: ${s.title}`} onClose={onClose}>
      <ProblemBanner error={save.error} />
      <p className="mb-2 text-sm">Your line manager approves the request{s.cost ? ', then the HR manager, as the hospital pays for it' : ''}.</p>
      <Field label="Why (optional)" htmlFor="ask-r"><Textarea id="ask-r" value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      <div className="mt-4 flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button busy={save.isPending} onClick={() => save.mutate()}>Send request</Button></div>
    </Dialog>
  );
}

function RateDialog({ e, onClose }: { e: { id: string; title: string }; onClose: () => void }) {
  const [rating, setRating] = useState<number | null>(null);
  const [comment, setComment] = useState('');
  const save = useMutation({ mutationFn: () => unwrap(hr.PUT('/api/v1/training/enrolments/{id}/feedback', { params: { path: { id: e.id } }, body: { rating: rating ?? 0, comment: comment || null } })), onSuccess: onClose });
  return (
    <Dialog open title={`Rate: ${e.title}`} onClose={onClose}>
      <ProblemBanner error={save.error} />
      <Field label="How useful was it? (1 to 5)" htmlFor="rt"><ScorePicker label="Rating" value={rating} onChange={setRating} /></Field>
      <Field label="Comments" htmlFor="rt-c"><Textarea id="rt-c" value={comment} onChange={(ev) => setComment(ev.target.value)} /></Field>
      <div className="mt-4 flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button disabled={!rating} busy={save.isPending} onClick={() => save.mutate()}>Save</Button></div>
    </Dialog>
  );
}

function ClaimDialog({ onClose }: { onClose: () => void }) {
  const [f, setF] = useState({ title: '', provider: '', activity_date: new Date().toISOString().slice(0, 10), points: '', licensing_body: '' });
  const [file, setFile] = useState<File | null>(null);
  const save = useMutation({
    mutationFn: async () => {
      const body = new FormData();
      for (const [k, v] of Object.entries(f)) if (v) body.append(k, v);
      if (file) body.append('evidence', file);
      const res = await fetch('/api/v1/me/cpd', { method: 'POST', body, headers: { 'x-requested-with': 'sil-hr-web' } });
      const json = await res.json();
      if (!res.ok) throw new ApiError(res.status, json);
      return json;
    },
    onSuccess: onClose,
  });
  const text = (k: keyof typeof f, l: string, type = 'text', hint?: string) => <Field label={l} hint={hint} htmlFor={`cl-${k}`}><Input id={`cl-${k}`} type={type} value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} /></Field>;
  return (
    <Dialog open title="Claim CPD points" onClose={onClose}>
      <ProblemBanner error={save.error} />
      <p className="mb-2 text-sm">For a conference, seminar, CME or online course outside the hospital. HR verifies it against your evidence.</p>
      <div className="grid gap-3 sm:grid-cols-2">
        {text('title', 'Activity')}{text('provider', 'Organised by')}{text('activity_date', 'Date', 'date')}{text('points', 'Points awarded')}
        {text('licensing_body', 'For which council', 'text', 'Leave empty for your own licensing body')}
        <Field label="Certificate (PDF or photo)" htmlFor="cl-f"><input id="cl-f" type="file" accept="application/pdf,image/png,image/jpeg" className="text-sm" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></Field>
      </div>
      <div className="mt-4 flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button busy={save.isPending} onClick={() => save.mutate()}>Send claim</Button></div>
    </Dialog>
  );
}
