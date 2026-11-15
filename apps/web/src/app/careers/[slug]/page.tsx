import Link from 'next/link';
import { notFound } from 'next/navigation';
import { formatDate } from '@sil/hr-shared';
import { API_URL } from '@/lib/server-session';
import { ApplyForm } from './apply-form';

export const dynamic = 'force-dynamic';

interface Job { slug: string; title: string; summary: string | null; description: string; requirements: string | null; location: string | null; employment_type: string; salary: string | null; closing_date: string; organisation: string; questions: { key: string; label: string; type: 'text' | 'yes_no' | 'number'; required: boolean }[] }

export default async function JobPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const res = await fetch(`${API_URL}/api/v1/careers/jobs/${encodeURIComponent(slug)}`, { cache: 'no-store' }).catch(() => null);
  if (!res?.ok) notFound();
  const j: Job = await res.json();
  return (
    <div className="space-y-6">
      <Link href="/careers" className="link text-sm">← All jobs</Link>
      <div>
        <h1 className="text-3xl font-semibold tracking-tight">{j.title}</h1>
        <div className="muted mt-2 flex flex-wrap gap-x-4 text-sm">
          <span>{j.organisation}</span>{j.location && <span>{j.location}</span>}<span>{j.employment_type.replace('_', ' ')}</span>{j.salary && <span>{j.salary}</span>}<span>Apply by {formatDate(j.closing_date, 'DD/MM/YYYY')}</span>
        </div>
      </div>
      <div className="surface space-y-4 rounded-xl p-6 text-[15px] leading-relaxed">
        {j.description.split(/\n\s*\n/).map((p, i) => <p key={i} className="whitespace-pre-line">{p}</p>)}
        {j.requirements && <><h2 className="pt-2 text-lg font-semibold">What you need</h2><ul className="list-disc space-y-1 pl-5">{j.requirements.split('\n').filter((l) => l.trim()).map((l, i) => <li key={i}>{l.replace(/^[-•*]\s*/, '')}</li>)}</ul></>}
      </div>
      <ApplyForm slug={j.slug} title={j.title} questions={j.questions} organisation={j.organisation} />
    </div>
  );
}
