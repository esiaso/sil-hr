'use client';

import { useRef, useState } from 'react';
import { Button, Field, Input, Select, Textarea } from '@/components/ui';

type Question = { key: string; label: string; type: 'text' | 'yes_no' | 'number'; required: boolean };

export function ApplyForm({ slug, title, questions, organisation }: { slug: string; title: string; questions: Question[]; organisation: string }) {
  const [v, setV] = useState({ first_name: '', last_name: '', email: '', phone: '', location: '', cover_note: '' });
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [done, setDone] = useState<string | null>(null);
  const cv = useRef<HTMLInputElement>(null);
  const honeypot = useRef<HTMLInputElement>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setFieldErrors({});
    const body = new FormData();
    for (const [k, x] of Object.entries(v)) if (x) body.set(k, x);
    body.set('answers', JSON.stringify(answers));
    body.set('consent', consent ? 'true' : 'false');
    if (honeypot.current?.value) body.set('website', honeypot.current.value);
    const f = cv.current?.files?.[0];
    if (f) body.set('cv', f);
    try {
      const res = await fetch(`/api/v1/careers/jobs/${encodeURIComponent(slug)}/applications`, { method: 'POST', body, headers: { 'x-requested-with': 'sil-hr-web' } });
      const json = await res.json();
      if (!res.ok) {
        setError(res.status === 429 ? 'Too many applications from this connection. Please try again in an hour.' : (json.detail ?? 'The application could not be sent.'));
        setFieldErrors(Object.fromEntries((json.errors ?? []).map((x: { path: string; message: string }) => [x.path, x.message])));
      } else setDone(json.message);
    } catch {
      setError('The application could not be sent. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  };

  if (done) return <div className="surface rounded-xl p-6"><h2 className="text-lg font-semibold">Application sent</h2><p className="mt-2">{done}</p></div>;
  return (
    <form onSubmit={submit} className="surface space-y-4 rounded-xl p-6" noValidate>
      <h2 className="text-lg font-semibold">Apply for {title}</h2>
      {error && <div role="alert" className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/50 dark:text-red-200">{error}</div>}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="First name" htmlFor="ap-fn" error={fieldErrors.first_name}><Input id="ap-fn" required autoComplete="given-name" value={v.first_name} onChange={(e) => setV({ ...v, first_name: e.target.value })} /></Field>
        <Field label="Last name" htmlFor="ap-ln" error={fieldErrors.last_name}><Input id="ap-ln" required autoComplete="family-name" value={v.last_name} onChange={(e) => setV({ ...v, last_name: e.target.value })} /></Field>
        <Field label="Email" htmlFor="ap-em" error={fieldErrors.email}><Input id="ap-em" type="email" required autoComplete="email" value={v.email} onChange={(e) => setV({ ...v, email: e.target.value })} /></Field>
        <Field label="Phone" htmlFor="ap-ph" error={fieldErrors.phone}><Input id="ap-ph" type="tel" required autoComplete="tel" placeholder="+254 7…" value={v.phone} onChange={(e) => setV({ ...v, phone: e.target.value })} /></Field>
        <Field label="Where you live (optional)" htmlFor="ap-lo"><Input id="ap-lo" value={v.location} onChange={(e) => setV({ ...v, location: e.target.value })} /></Field>
        <Field label="CV (PDF or Word, up to 10 MB)" htmlFor="ap-cv" error={fieldErrors.cv}><input id="ap-cv" ref={cv} type="file" required accept="application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document" className="text-sm" /></Field>
      </div>
      {questions.map((q) => (
        <Field key={q.key} label={`${q.label}${q.required ? '' : ' (optional)'}`} htmlFor={`ap-q-${q.key}`} error={fieldErrors[`answers.${q.key}`]}>
          {q.type === 'yes_no'
            ? <Select id={`ap-q-${q.key}`} value={answers[q.key] ?? ''} onChange={(e) => setAnswers({ ...answers, [q.key]: e.target.value })} className="max-w-40"><option value="">Choose</option><option value="yes">Yes</option><option value="no">No</option></Select>
            : <Input id={`ap-q-${q.key}`} type={q.type === 'number' ? 'number' : 'text'} value={answers[q.key] ?? ''} onChange={(e) => setAnswers({ ...answers, [q.key]: e.target.value })} />}
        </Field>
      ))}
      <Field label="Anything you would like to add (optional)" htmlFor="ap-cn"><Textarea id="ap-cn" value={v.cover_note} onChange={(e) => setV({ ...v, cover_note: e.target.value })} /></Field>
      <div aria-hidden className="hidden"><label>Website<input ref={honeypot} tabIndex={-1} autoComplete="off" /></label></div>
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" className="mt-1" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
        <span>I agree that {organisation} may use the details and CV I send to consider me for this and similar jobs,, and keep them for the period set out in its recruitment privacy policy. I can ask for them to be removed at any time (Data Protection Act, 2019).</span>
      </label>
      {fieldErrors.consent && <p className="text-xs text-red-600">Please give your consent to send the application.</p>}
      <Button type="submit" busy={busy} disabled={!consent}>Send application</Button>
    </form>
  );
}
