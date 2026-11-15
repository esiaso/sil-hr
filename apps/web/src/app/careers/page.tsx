import Link from 'next/link';
import { formatDate, type EMPLOYMENT_TYPES } from '@sil/hr-shared';
import { API_URL } from '@/lib/server-session';

export const dynamic = 'force-dynamic';

interface Job { slug: string; title: string; summary: string | null; location: string | null; employment_type: (typeof EMPLOYMENT_TYPES)[number]; salary: string | null; closing_date: string; organisation: string }

export default async function CareersPage() {
  const res = await fetch(`${API_URL}/api/v1/careers/jobs`, { cache: 'no-store' }).catch(() => null);
  const jobs: Job[] = res?.ok ? await res.json() : [];
  const org = jobs[0]?.organisation;
  return (
    <div>
      <h1 className="text-3xl font-semibold tracking-tight">Work with us</h1>
      <p className="muted mt-2">{org ? `Open positions at ${org}.` : 'Open positions.'} Applications are read by our HR team; you will hear from us either way.</p>
      <div className="mt-6 space-y-3">
        {!res?.ok && <p className="muted">The job list is not available right now. Please try again later.</p>}
        {res?.ok && !jobs.length && <div className="surface rounded-xl p-8 text-center"><p className="muted">There are no open positions at the moment. Please check again soon.</p></div>}
        {jobs.map((j) => (
          <Link key={j.slug} href={`/careers/${j.slug}`} className="surface block rounded-xl p-5 transition-shadow hover:shadow-md">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <h2 className="text-lg font-semibold">{j.title}</h2>
                {j.summary && <p className="muted mt-1 text-sm">{j.summary}</p>}
              </div>
              <span className="rounded-full bg-brand-50 px-2.5 py-0.5 text-xs font-medium text-brand-700 dark:bg-brand-500/15 dark:text-brand-200">{j.employment_type.replace('_', ' ')}</span>
            </div>
            <div className="muted mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs">
              {j.location && <span>{j.location}</span>}
              {j.salary && <span>{j.salary}</span>}
              <span>Apply by {formatDate(j.closing_date, 'DD/MM/YYYY')}</span>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
