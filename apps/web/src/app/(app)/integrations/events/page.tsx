import type { CatalogueEntry } from '@sil/hr-shared';
import { serverGet } from '@/lib/server-session';

export const metadata = { title: 'Event catalogue' };

/** Generated from the event definitions in code (GET /api/v1/events/catalogue). */
export default async function EventsPage() {
  const res = await serverGet<CatalogueEntry[]>('/api/v1/events/catalogue');
  const docs = process.env.PUBLIC_API_DOCS_URL ?? 'http://localhost:3310/api/v1/docs';
  return (
    <div>
      <h1 className="mb-1 text-xl font-semibold">Event catalogue</h1>
      <p className="muted mb-2 max-w-3xl text-sm">
        Every event HR publishes, as CloudEvents 1.0, through webhooks and the Redis Stream <code>silhr:events</code>. Payloads carry ids and non-sensitive fields; fetch detail through the API with your own scopes. A type never changes incompatibly: breaking changes ship as a new <code>.v2</code>.
      </p>
      <p className="mb-5 text-sm">
        <a className="text-brand-600 underline" href={docs} target="_blank" rel="noreferrer">REST API reference (OpenAPI)</a>
      </p>
      {!res.ok ? <p className="text-red-600">Could not load the catalogue.</p> : (
        <div className="space-y-3">
          {res.data.map((e) => (
            <details key={e.type} className="surface rounded-xl p-4" id={e.type}>
              <summary className="cursor-pointer"><code className="font-semibold">{e.type}</code> <span className="muted text-sm">· {e.description}</span></summary>
              <div className="mt-3 grid gap-3 text-xs md:grid-cols-2">
                <div><div className="muted mb-1 font-semibold">Subject: {e.subject}. Data schema</div><pre className="overflow-x-auto rounded bg-black/5 p-2 dark:bg-white/5">{JSON.stringify(e.data_schema, null, 2)}</pre></div>
                <div><div className="muted mb-1 font-semibold">Example data</div><pre className="overflow-x-auto rounded bg-black/5 p-2 dark:bg-white/5">{JSON.stringify(e.example, null, 2)}</pre></div>
              </div>
            </details>
          ))}
        </div>
      )}
    </div>
  );
}
