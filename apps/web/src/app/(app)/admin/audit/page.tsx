import { formatDateTime, type AuditEntry, type PublicSettings } from '@sil/hr-shared';
import Link from 'next/link';
import { serverGet } from '@/lib/server-session';

export const metadata = { title: 'Audit trail' };

/** Server-rendered, filterable by URL (?entity_type=&action=&search=&cursor=). */
export default async function AuditPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const qs = new URLSearchParams(Object.entries(sp).filter((e): e is [string, string] => !!e[1]));
  qs.set('limit', '50');
  const [res, settings] = await Promise.all([serverGet<{ data: AuditEntry[]; next_cursor: string | null }>(`/api/v1/audit?${qs}`), serverGet<PublicSettings>('/api/v1/settings/public')]);
  const tz = settings.ok ? settings.data.timezone : 'Africa/Nairobi';
  const df = settings.ok ? settings.data.date_format : 'DD/MM/YYYY';
  const next = new URLSearchParams(qs);
  if (res.ok && res.data.next_cursor) next.set('cursor', res.data.next_cursor);
  return (
    <div>
      <h1 className="mb-1 text-xl font-semibold">Audit trail</h1>
      <p className="muted mb-4 text-sm">Append-only record of every change, login, export and sensitive read. The database refuses edits and deletes.</p>
      <form className="mb-3 flex flex-wrap gap-2" method="get">
        <input name="search" defaultValue={sp.search} placeholder="Actor or record" className="input max-w-xs" aria-label="Search" />
        <input name="entity_type" defaultValue={sp.entity_type} placeholder="Entity type, e.g. Department" className="input max-w-xs" aria-label="Entity type" />
        <select name="action" defaultValue={sp.action ?? ''} className="input max-w-40" aria-label="Action">
          <option value="">Any action</option>
          {['create', 'update', 'delete', 'login', 'login_failed', 'logout', 'token_issued', 'sensitive_read', 'replay', 'secret_rotated'].map((a) => (
            <option key={a}>{a}</option>
          ))}
        </select>
        <button className="bg-brand-600 rounded-md px-3 py-2 text-sm text-white">Filter</button>
      </form>
      {!res.ok ? (
        <p className="text-red-600">{res.problem.detail ?? `Error ${res.status}`}</p>
      ) : (
        <div className="surface overflow-x-auto rounded-xl">
          <table className="data">
            <thead>
              <tr>
                <th>When</th>
                <th>Who</th>
                <th>Action</th>
                <th>Record</th>
                <th>Change</th>
                <th>IP</th>
              </tr>
            </thead>
            <tbody>
              {res.data.data.map((a) => (
                <tr key={a.id}>
                  <td className="whitespace-nowrap">{formatDateTime(a.occurred_at, tz, df)}</td>
                  <td>
                    {a.actor_name ?? a.actor_type}
                    <div className="muted text-xs">{a.actor_type}</div>
                  </td>
                  <td>{a.action}</td>
                  <td>
                    {a.entity_type}
                    <div className="muted font-mono text-xs">{a.entity_id?.slice(0, 13)}</div>
                  </td>
                  <td className="max-w-md">
                    {a.action === 'update' && a.after ? (
                      <ul className="text-xs">
                        {Object.keys(a.after).map((k) => (
                          <li key={k}>
                            <b>{k}</b>: {JSON.stringify(a.before?.[k] ?? null)} → {JSON.stringify(a.after?.[k])}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <span className="muted text-xs">{a.after ? Object.keys(a.after).slice(0, 6).join(', ') : ''}</span>
                    )}
                  </td>
                  <td className="muted text-xs">{a.ip}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {res.ok && res.data.next_cursor && (
        <div className="mt-3 text-center">
          <Link className="text-brand-600 text-sm underline" href={`/admin/audit?${next}`}>
            Older entries →
          </Link>
        </div>
      )}
    </div>
  );
}
