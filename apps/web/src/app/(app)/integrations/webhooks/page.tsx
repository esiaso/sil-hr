'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { formatDateTime } from '@sil/hr-shared';
import { Badge, Button, Dialog, Field, Input, Loading, PageHeader, ProblemBanner, SecretReveal } from '@/components/ui';
import { hr, unwrap } from '@/lib/api';
import { useSession } from '@/lib/session';

function NewSubscription({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const cat = useQuery({ queryKey: ['catalogue'], queryFn: () => unwrap(hr.GET('/api/v1/events/catalogue')) });
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [types, setTypes] = useState<string[]>([]);
  const [secret, setSecret] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () => unwrap(hr.POST('/api/v1/webhooks/subscriptions', { body: { name, url, event_types: types } })),
    onSuccess: (r) => { setSecret(r.secret); void qc.invalidateQueries({ queryKey: ['webhooks'] }); },
  });
  return (
    <Dialog open wide title="New webhook subscription" onClose={onClose}>
      <ProblemBanner error={save.error} />
      {secret ? (
        <div className="space-y-3">
          <SecretReveal label="Signing secret" value={secret} />
          <p className="muted text-sm">Verify each delivery's <code>webhook-signature</code> header with this secret (Standard Webhooks, HMAC-SHA256). See the integration guide for code.</p>
          <div className="text-right"><Button onClick={onClose}>Done</Button></div>
        </div>
      ) : (
        <div className="space-y-3">
          <Field label="Name" htmlFor="w-name"><Input id="w-name" value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label="Endpoint URL" htmlFor="w-url" hint="HTTPS in production"><Input id="w-url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://procurement.example/hooks/hr" /></Field>
          <fieldset className="text-sm">
            <legend className="mb-1 font-medium">Events</legend>
            <label className="flex items-center gap-2"><input type="checkbox" checked={types.includes('*')} onChange={(e) => setTypes(e.target.checked ? ['*'] : [])} /> Every event type</label>
            {!types.includes('*') && cat.data?.filter((e) => e.type !== 'hr.webhook.test.v1').map((e) => (
              <label key={e.type} className="flex items-start gap-2">
                <input type="checkbox" className="mt-1" checked={types.includes(e.type)} onChange={(ev) => setTypes(ev.target.checked ? [...types, e.type] : types.filter((t) => t !== e.type))} />
                <span><code>{e.type}</code> <span className="muted">{e.description}</span></span>
              </label>
            ))}
          </fieldset>
          <div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button busy={save.isPending} disabled={!name || !url || !types.length} onClick={() => save.mutate()}>Create</Button></div>
        </div>
      )}
    </Dialog>
  );
}

export default function WebhooksPage() {
  const { can, settings } = useSession();
  const q = useQuery({ queryKey: ['webhooks'], queryFn: () => unwrap(hr.GET('/api/v1/webhooks/subscriptions')) });
  const [creating, setCreating] = useState(false);
  return (
    <div>
      <PageHeader title="Webhooks" description="HR pushes signed CloudEvents to these endpoints when something changes. Failed deliveries are retried with backoff for about a day, then dead-lettered; a subscription that keeps failing is paused and admins are told." actions={can('webhook:manage') && <Button onClick={() => setCreating(true)}>New subscription</Button>} />
      <ProblemBanner error={q.error} />
      {!q.data ? <Loading /> : (
        <div className="surface overflow-x-auto rounded-xl">
          <table className="data">
            <thead><tr><th>Name</th><th>Endpoint</th><th>Events</th><th>Status</th><th>Last delivery</th><th /></tr></thead>
            <tbody>
              {q.data.map((s) => (
                <tr key={s.id}>
                  <td>{s.name}</td>
                  <td className="max-w-xs truncate font-mono text-xs">{s.url}</td>
                  <td className="text-xs">{s.event_types.length === 1 && s.event_types[0] === '*' ? 'all' : `${s.event_types.length} types`}</td>
                  <td><Badge value={s.status} />{s.consecutive_failures > 0 && <span className="muted ml-1 text-xs">{s.consecutive_failures} failed</span>}</td>
                  <td className="text-xs">{s.last_delivery_at ? formatDateTime(s.last_delivery_at, settings.timezone, settings.date_format) : '—'}</td>
                  <td><Link className="text-brand-600 text-sm underline" href={`/integrations/webhooks/${s.id}`}>Delivery log</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {creating && <NewSubscription onClose={() => setCreating(false)} />}
    </div>
  );
}
