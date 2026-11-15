'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { formatDate, formatDateTime, formatMoney, RECOMMENDATIONS, STAGES, type Stage } from '@sil/hr-shared';
import { Badge, Button, Card, Dialog, Empty, Field, Input, Loading, PageHeader, ProblemBanner, Select, Textarea } from '@/components/ui';
import { ApiError, hr, unwrap } from '@/lib/api';
import { useSession } from '@/lib/session';

const BOARD: Stage[] = ['applied', 'screening', 'shortlisted', 'interview', 'assessment', 'offer', 'hired'];
type Posting = NonNullable<Awaited<ReturnType<typeof listPostings>>>[number];
const listPostings = () => unwrap(hr.GET('/api/v1/job-postings', { params: { query: {} } }));

export default function JobsPage() {
  const postings = useQuery({ queryKey: ['postings'], queryFn: listPostings });
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<Posting | 'new' | null>(null);
  const current = postings.data?.find((p) => p.id === (selected ?? postings.data?.find((x) => x.status === 'published')?.id ?? postings.data?.[0]?.id));
  return (
    <div className="space-y-4">
      <PageHeader title="Jobs and candidates" description="Adverts for approved requisitions (shown on the public careers site at /careers) and the people who applied." actions={<Button onClick={() => setEditing('new')}>New advert</Button>} />
      <ProblemBanner error={postings.error} />
      {!postings.data ? <Loading /> : !postings.data.length ? <Card><Empty>No adverts yet. Advertise an approved requisition.</Empty></Card> : (
        <>
          <div className="flex flex-wrap gap-2">
            {postings.data.map((p) => (
              <button key={p.id} type="button" onClick={() => setSelected(p.id)} className={`rounded-xl border px-4 py-2 text-left text-sm ${current?.id === p.id ? 'border-brand-500 bg-brand-50 dark:bg-brand-500/10' : 'border-[var(--border)] bg-[var(--surface)] hover:bg-[var(--hover)]'}`}>
                <div className="font-medium">{p.title}</div>
                <div className="muted text-xs">{p.requisition_number} · {p.applications} applied · <span className="capitalize">{p.status}</span></div>
              </button>
            ))}
          </div>
          {current && <Pipeline posting={current} onEdit={() => setEditing(current)} />}
        </>
      )}
      {editing && <PostingDialog p={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function Pipeline({ posting, onEdit }: { posting: Posting; onEdit: () => void }) {
  const { settings } = useSession();
  const [open, setOpen] = useState<string | null>(null);
  const [showClosed, setShowClosed] = useState(false);
  const apps = useQuery({ queryKey: ['applications', posting.id], queryFn: () => unwrap(hr.GET('/api/v1/job-applications', { params: { query: { posting_id: posting.id } } })) });
  const closed = (apps.data ?? []).filter((a) => a.stage === 'rejected' || a.stage === 'withdrawn');
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <div><Badge value={posting.status} /> <span className="muted">closes {formatDate(posting.closing_date, settings.date_format)}{posting.status === 'published' && !posting.internal_only ? ` · /careers/${posting.slug}` : ''}</span></div>
        <Button variant="secondary" onClick={onEdit}>Edit advert</Button>
      </div>
      {!apps.data ? <Loading /> : (
        <div className="scroll-thin grid auto-cols-[minmax(200px,1fr)] grid-flow-col gap-3 overflow-x-auto pb-2">
          {BOARD.map((s) => {
            const list = apps.data.filter((a) => a.stage === s);
            return (
              <div key={s} className="rounded-xl bg-[var(--surface-2)] p-2">
                <div className="mb-2 flex items-center justify-between px-1 text-xs font-medium uppercase tracking-wide"><span className="muted">{STAGES[s]}</span><span className="muted">{list.length}</span></div>
                <div className="space-y-2">
                  {list.map((a) => (
                    <button key={a.id} type="button" onClick={() => setOpen(a.id)} className="surface block w-full rounded-lg p-3 text-left text-sm hover:shadow-sm">
                      <div className="font-medium">{a.candidate_name}</div>
                      <div className="muted text-xs">{a.source} · {formatDate(a.created_at.slice(0, 10), settings.date_format)}</div>
                      {(a.rating || a.panel_score !== null) && <div className="mt-1 text-xs">{a.rating ? `${'★'.repeat(a.rating)}` : ''}{a.panel_score !== null ? ` panel ${a.panel_score > 0 ? '+' : ''}${a.panel_score}` : ''}</div>}
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
      {closed.length > 0 && <button type="button" className="link text-sm" onClick={() => setShowClosed(!showClosed)}>{showClosed ? 'Hide' : 'Show'} {closed.length} not taken forward or withdrawn</button>}
      {showClosed && <Card><ul className="text-sm">{closed.map((a) => <li key={a.id}><button type="button" className="link" onClick={() => setOpen(a.id)}>{a.candidate_name}</button> <span className="muted">· {STAGES[a.stage]}{a.rejection_reason ? `: ${a.rejection_reason}` : ''}</span></li>)}</ul></Card>}
      {open && <ApplicationDialog id={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

function ApplicationDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const { settings } = useSession();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['application', id], queryFn: () => unwrap(hr.GET('/api/v1/job-applications/{id}', { params: { path: { id } } })) });
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['application', id] }); void qc.invalidateQueries({ queryKey: ['applications'] }); void qc.invalidateQueries({ queryKey: ['postings'] }); };
  const [panel, setPanel] = useState<'interview' | 'assessment' | 'offer' | 'reject' | null>(null);
  const move = useMutation({ mutationFn: (stage: Stage) => unwrap(hr.POST('/api/v1/job-applications/{id}/stage', { params: { path: { id } }, body: { stage } })), onSuccess: refresh });
  const respond = useMutation({ mutationFn: (v: { offer: string; response: 'accepted' | 'declined' | 'withdrawn' }) => unwrap(hr.POST('/api/v1/job-offers/{id}/response', { params: { path: { id: v.offer } }, body: { response: v.response } })), onSuccess: refresh });
  const a = q.data;
  const open = a && !['hired', 'rejected', 'withdrawn'].includes(a.stage);
  return (
    <Dialog open wide title={a ? `${a.candidate_name} · ${a.posting_title}` : 'Application'} onClose={onClose}>
      <ProblemBanner error={q.error ?? move.error ?? respond.error} />
      {!a ? <Loading /> : (
        <div className="space-y-4 text-sm">
          <div className="flex flex-wrap items-center gap-2"><Badge value={a.stage} /><span className="muted">{a.number} · {a.email} · {a.phone}{a.location ? ` · ${a.location}` : ''}</span>{a.cv_document_id && <a className="link" href={`/api/v1/job-applications/${a.id}/cv`}>CV</a>}</div>
          {Object.keys(a.answers).length > 0 && <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">{Object.entries(a.answers).map(([k, v]) => <div key={k} className="contents"><dt className="muted">{k.replace(/_/g, ' ')}</dt><dd>{v}</dd></div>)}</dl>}
          {a.cover_note && <p className="whitespace-pre-wrap rounded-lg bg-[var(--surface-2)] p-3">{a.cover_note}</p>}
          {open && (
            <div className="flex flex-wrap gap-2">
              {a.stage === 'applied' && <Button variant="secondary" onClick={() => move.mutate('screening')}>Start screening</Button>}
              {['applied', 'screening'].includes(a.stage) && <Button variant="secondary" onClick={() => move.mutate('shortlisted')}>Shortlist</Button>}
              <Button variant="secondary" onClick={() => setPanel('interview')}>Schedule interview</Button>
              <Button variant="secondary" onClick={() => setPanel('assessment')}>Record assessment</Button>
              {['interview', 'assessment', 'offer'].includes(a.stage) && <Button onClick={() => setPanel('offer')}>Make an offer</Button>}
              <Button variant="ghost" onClick={() => setPanel('reject')}>Not taking forward</Button>
            </div>
          )}
          {panel === 'interview' && <InterviewForm appId={id} onDone={() => { setPanel(null); refresh(); }} />}
          {panel === 'assessment' && <AssessmentForm appId={id} onDone={() => { setPanel(null); refresh(); }} />}
          {panel === 'offer' && <OfferForm appId={id} onDone={() => { setPanel(null); refresh(); }} />}
          {panel === 'reject' && <RejectForm appId={id} onDone={() => { setPanel(null); refresh(); }} />}
          {a.interviews_detail.length > 0 && (
            <div><div className="mb-1 font-medium">Interviews</div>
              {a.interviews_detail.map((i) => (
                <div key={i.id} className="mb-2 rounded-lg border border-[var(--border)] p-3">
                  <div className="flex justify-between"><span>{formatDateTime(i.scheduled_at, settings.timezone, settings.date_format)} · {i.kind}{i.location ? ` · ${i.location}` : ''}</span><Badge value={i.status} /></div>
                  <div className="muted text-xs">Panel: {i.panel.map((p) => p.name).join(', ')}</div>
                  {i.feedback.map((f) => <div key={f.user_id} className="mt-2"><b>{f.name}</b>: {RECOMMENDATIONS[f.recommendation]}{Object.keys(f.scores).length ? ` (${Object.entries(f.scores).map(([k, v]) => `${k.replace(/_/g, ' ')} ${v}`).join(', ')})` : ''}{f.comment && <div className="muted">{f.comment}</div>}</div>)}
                </div>
              ))}
            </div>
          )}
          {a.assessments.length > 0 && <div><div className="mb-1 font-medium">Assessments</div><ul>{a.assessments.map((x) => <li key={x.id}>{x.name}: {x.score} / {x.max_score} <span className="muted">({formatDate(x.taken_on, settings.date_format)})</span></li>)}</ul></div>}
          {a.offers.length > 0 && (
            <div><div className="mb-1 font-medium">Offers</div>
              {a.offers.map((o) => (
                <div key={o.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[var(--border)] p-3">
                  <div>{o.number} · {o.position_title} · {formatMoney(o.basic)} from {formatDate(o.start_date, settings.date_format)} <Badge value={o.status} />{o.decision_comment && <div className="muted text-xs">{o.decision_comment}</div>}</div>
                  <div className="flex gap-2">
                    {o.letter_document_id && <a className="link" href={`/api/v1/job-offers/${o.id}/letter`}>Offer letter</a>}
                    {o.status === 'approved' && <><Button variant="secondary" onClick={() => respond.mutate({ offer: o.id, response: 'declined' })}>Declined</Button><Button busy={respond.isPending} onClick={() => confirm('Record acceptance? This creates the employee record.') && respond.mutate({ offer: o.id, response: 'accepted' })}>Accepted</Button></>}
                  </div>
                </div>
              ))}
            </div>
          )}
          <div><div className="mb-1 font-medium">History</div><ul className="muted text-xs">{a.events.map((e) => <li key={e.id}>{formatDateTime(e.created_at, settings.timezone, settings.date_format)} · {e.actor_name}{e.to_stage ? ` · ${e.from_stage ? `${e.from_stage} → ` : ''}${e.to_stage}` : ''}{e.note ? ` · ${e.note}` : ''}</li>)}</ul></div>
        </div>
      )}
    </Dialog>
  );
}

function useUsers() {
  return useQuery({ queryKey: ['panel-members'], queryFn: () => unwrap(hr.GET('/api/v1/recruitment/panel-members')) });
}

function InterviewForm({ appId, onDone }: { appId: string; onDone: () => void }) {
  const users = useUseUsersSafe();
  const [v, setV] = useState({ when: '', location: '', kind: 'panel', panel: [] as string[] });
  const save = useMutation({ mutationFn: () => unwrap(hr.POST('/api/v1/job-applications/{id}/interviews', { params: { path: { id: appId } }, body: { scheduled_at: new Date(v.when).toISOString(), location: v.location || null, kind: v.kind as 'panel', panel_user_ids: v.panel } })), onSuccess: onDone });
  return (
    <div className="rounded-lg border border-[var(--border)] p-3">
      <ProblemBanner error={save.error} />
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="When" htmlFor="iv-w"><Input id="iv-w" type="datetime-local" value={v.when} onChange={(e) => setV({ ...v, when: e.target.value })} /></Field>
        <Field label="Where" htmlFor="iv-l"><Input id="iv-l" value={v.location} onChange={(e) => setV({ ...v, location: e.target.value })} /></Field>
        <Field label="Kind" htmlFor="iv-k"><Select id="iv-k" value={v.kind} onChange={(e) => setV({ ...v, kind: e.target.value })}><option value="panel">Panel</option><option value="phone">Phone</option><option value="online">Online</option><option value="practical">Practical</option></Select></Field>
      </div>
      <div className="mt-2 text-sm font-medium">Panel</div>
      <div className="scroll-thin max-h-36 overflow-y-auto text-sm">{users.map((u) => <label key={u.id} className="flex items-center gap-1"><input type="checkbox" checked={v.panel.includes(u.id)} onChange={(e) => setV({ ...v, panel: e.target.checked ? [...v.panel, u.id] : v.panel.filter((x) => x !== u.id) })} />{u.display_name}</label>)}</div>
      <div className="mt-2 flex justify-end"><Button busy={save.isPending} disabled={!v.when || !v.panel.length} onClick={() => save.mutate()}>Schedule</Button></div>
    </div>
  );
}

function useUseUsersSafe() {
  return useUsers().data ?? [];
}

function AssessmentForm({ appId, onDone }: { appId: string; onDone: () => void }) {
  const [v, setV] = useState({ name: '', score: '', max_score: '100', taken_on: new Date().toISOString().slice(0, 10) });
  const save = useMutation({ mutationFn: () => unwrap(hr.POST('/api/v1/job-applications/{id}/assessments', { params: { path: { id: appId } }, body: { name: v.name, score: Number(v.score), max_score: Number(v.max_score), taken_on: v.taken_on } })), onSuccess: onDone });
  const fe = save.error instanceof ApiError ? save.error.fieldErrors : {};
  return (
    <div className="rounded-lg border border-[var(--border)] p-3">
      <ProblemBanner error={save.error} />
      <div className="grid gap-3 sm:grid-cols-4">
        <Field label="Assessment" htmlFor="as-n"><Input id="as-n" placeholder="e.g. Drug calculation test" value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} /></Field>
        <Field label="Score" htmlFor="as-s" error={fe.score}><Input id="as-s" type="number" value={v.score} onChange={(e) => setV({ ...v, score: e.target.value })} /></Field>
        <Field label="Out of" htmlFor="as-m"><Input id="as-m" type="number" value={v.max_score} onChange={(e) => setV({ ...v, max_score: e.target.value })} /></Field>
        <Field label="Date" htmlFor="as-d"><Input id="as-d" type="date" value={v.taken_on} onChange={(e) => setV({ ...v, taken_on: e.target.value })} /></Field>
      </div>
      <div className="mt-2 flex justify-end"><Button busy={save.isPending} disabled={!v.name || v.score === ''} onClick={() => save.mutate()}>Save</Button></div>
    </div>
  );
}

function OfferForm({ appId, onDone }: { appId: string; onDone: () => void }) {
  const [v, setV] = useState({ contract_type: 'permanent', start_date: '', end_date: '', basic: '', probation_months: '6', notice_days: '30', conditions: '' });
  const save = useMutation({ mutationFn: () => unwrap(hr.POST('/api/v1/job-applications/{id}/offers', { params: { path: { id: appId } }, body: { contract_type: v.contract_type as 'permanent', start_date: v.start_date, end_date: v.end_date || null, basic: Number(v.basic).toFixed(2), probation_months: v.probation_months ? Number(v.probation_months) : null, notice_days: Number(v.notice_days), conditions: v.conditions || null } })), onSuccess: onDone });
  return (
    <div className="rounded-lg border border-[var(--border)] p-3">
      <ProblemBanner error={save.error} />
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Contract" htmlFor="of-t"><Select id="of-t" value={v.contract_type} onChange={(e) => setV({ ...v, contract_type: e.target.value })}>{['permanent', 'fixed_term', 'locum', 'internship', 'casual'].map((t) => <option key={t} value={t}>{t.replace('_', ' ')}</option>)}</Select></Field>
        <Field label="Start" htmlFor="of-s"><Input id="of-s" type="date" value={v.start_date} onChange={(e) => setV({ ...v, start_date: e.target.value })} /></Field>
        <Field label="End (fixed term)" htmlFor="of-e"><Input id="of-e" type="date" value={v.end_date} onChange={(e) => setV({ ...v, end_date: e.target.value })} /></Field>
        <Field label="Basic (KES a month)" htmlFor="of-b"><Input id="of-b" type="number" value={v.basic} onChange={(e) => setV({ ...v, basic: e.target.value })} /></Field>
        <Field label="Probation (months)" htmlFor="of-p"><Input id="of-p" type="number" value={v.probation_months} onChange={(e) => setV({ ...v, probation_months: e.target.value })} /></Field>
        <Field label="Notice (days)" htmlFor="of-n"><Input id="of-n" type="number" value={v.notice_days} onChange={(e) => setV({ ...v, notice_days: e.target.value })} /></Field>
      </div>
      <Field label="Special conditions (optional)" htmlFor="of-c"><Textarea id="of-c" value={v.conditions} onChange={(e) => setV({ ...v, conditions: e.target.value })} /></Field>
      <p className="muted text-xs">The offer goes for approval (finance too if above the requisition&rsquo;s range). Approval produces the offer letter.</p>
      <div className="mt-2 flex justify-end"><Button busy={save.isPending} disabled={!v.start_date || !v.basic} onClick={() => save.mutate()}>Send for approval</Button></div>
    </div>
  );
}

function RejectForm({ appId, onDone }: { appId: string; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const save = useMutation({ mutationFn: () => unwrap(hr.POST('/api/v1/job-applications/{id}/stage', { params: { path: { id: appId } }, body: { stage: 'rejected', rejection_reason: reason } })), onSuccess: onDone });
  return (
    <div className="flex gap-2 rounded-lg border border-[var(--border)] p-3"><ProblemBanner error={save.error} /><Input aria-label="Reason" placeholder="Reason (kept on the application)" value={reason} onChange={(e) => setReason(e.target.value)} /><Button variant="danger" busy={save.isPending} disabled={reason.length < 3} onClick={() => save.mutate()}>Confirm</Button></div>
  );
}

function PostingDialog({ p, onClose }: { p: Posting | null; onClose: () => void }) {
  const qc = useQueryClient();
  const reqs = useQuery({ queryKey: ['requisitions', 'approved'], queryFn: () => unwrap(hr.GET('/api/v1/requisitions', { params: { query: { status: 'approved' } } })) });
  const [v, setV] = useState({ requisition_id: p?.requisition_id ?? '', title: p?.title ?? '', summary: p?.summary ?? '', description: p?.description ?? '', requirements: p?.requirements ?? '', location: p?.location ?? '', show_salary: p?.show_salary ?? false, closing_date: p?.closing_date ?? '', internal_only: p?.internal_only ?? false, status: p?.status ?? 'draft' });
  const [questions, setQuestions] = useState(p?.questions ?? []);
  const save = useMutation({
    mutationFn: () => {
      const body = { ...v, summary: v.summary || null, requirements: v.requirements || null, location: v.location || null, questions } as never;
      return p ? unwrap(hr.PUT('/api/v1/job-postings/{id}', { params: { path: { id: p.id }, header: { 'If-Match': `"${p.version}"` } as never }, body })) : unwrap(hr.POST('/api/v1/job-postings', { body }));
    },
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['postings'] }); onClose(); },
  });
  const fe = save.error instanceof ApiError ? save.error.fieldErrors : {};
  return (
    <Dialog open wide title={p ? `Advert: ${p.title}` : 'New advert'} onClose={onClose}>
      <ProblemBanner error={save.error} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Requisition" htmlFor="po-r" error={fe.requisition_id}><Select id="po-r" value={v.requisition_id} disabled={!!p} onChange={(e) => { const r = reqs.data?.find((x) => x.id === e.target.value); setV({ ...v, requisition_id: e.target.value, title: v.title || r?.position_title || '' }); }}><option value="">Choose an approved requisition</option>{reqs.data?.map((r) => <option key={r.id} value={r.id}>{r.number} · {r.position_title} ({r.headcount})</option>)}{p && <option value={p.requisition_id}>{p.requisition_number}</option>}</Select></Field>
        <Field label="Job title" htmlFor="po-t" error={fe.title}><Input id="po-t" value={v.title} onChange={(e) => setV({ ...v, title: e.target.value })} /></Field>
        <Field label="Location" htmlFor="po-l"><Input id="po-l" value={v.location} onChange={(e) => setV({ ...v, location: e.target.value })} /></Field>
        <Field label="Closing date" htmlFor="po-c" error={fe.closing_date}><Input id="po-c" type="date" value={v.closing_date} onChange={(e) => setV({ ...v, closing_date: e.target.value })} /></Field>
      </div>
      <Field label="Summary (one or two lines for the list)" htmlFor="po-s"><Input id="po-s" value={v.summary} onChange={(e) => setV({ ...v, summary: e.target.value })} /></Field>
      <Field label="About the job" htmlFor="po-d" error={fe.description}><Textarea id="po-d" className="min-h-32" value={v.description} onChange={(e) => setV({ ...v, description: e.target.value })} /></Field>
      <Field label="Requirements (one per line)" htmlFor="po-q"><Textarea id="po-q" value={v.requirements} onChange={(e) => setV({ ...v, requirements: e.target.value })} /></Field>
      <div className="mt-2 space-y-2">
        <div className="text-sm font-medium">Screening questions</div>
        {questions.map((q, i) => (
          <div key={i} className="flex flex-wrap gap-2">
            <Input aria-label={`Question ${i + 1}`} value={q.label} onChange={(e) => setQuestions(questions.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} className="flex-1" />
            <Select aria-label={`Question ${i + 1} type`} value={q.type} onChange={(e) => setQuestions(questions.map((x, j) => (j === i ? { ...x, type: e.target.value as 'text' } : x)))} className="max-w-32"><option value="yes_no">Yes/no</option><option value="number">Number</option><option value="text">Text</option></Select>
            <Button variant="ghost" onClick={() => setQuestions(questions.filter((_, j) => j !== i))}>Remove</Button>
          </div>
        ))}
        <Button variant="secondary" onClick={() => setQuestions([...questions, { key: `q${questions.length + 1}`, label: '', type: 'yes_no', required: true }])}>Add question</Button>
      </div>
      <div className="mt-3 flex flex-wrap gap-4 text-sm">
        <label className="flex items-center gap-1"><input type="checkbox" checked={v.show_salary} onChange={(e) => setV({ ...v, show_salary: e.target.checked })} />Show the salary range</label>
        <label className="flex items-center gap-1"><input type="checkbox" checked={v.internal_only} onChange={(e) => setV({ ...v, internal_only: e.target.checked })} />Internal only (not on the careers site)</label>
      </div>
      <div className="mt-4 flex items-center justify-end gap-2">
        <Select aria-label="Status" value={v.status} onChange={(e) => setV({ ...v, status: e.target.value as 'draft' })} className="max-w-40"><option value="draft">Draft</option><option value="published">Published</option><option value="closed">Closed</option></Select>
        <Button variant="secondary" onClick={onClose}>Cancel</Button><Button busy={save.isPending} onClick={() => save.mutate()}>Save</Button>
      </div>
    </Dialog>
  );
}
