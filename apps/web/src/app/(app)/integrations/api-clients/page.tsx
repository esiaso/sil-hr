'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { formatDateTime, type ApiClient } from '@sil/hr-shared';
import { Badge, Button, Dialog, Field, Input, Loading, PageHeader, ProblemBanner, SecretReveal } from '@/components/ui';
import { hr, unwrap } from '@/lib/api';
import { useSession } from '@/lib/session';

function ScopePicker({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const cat = useQuery({ queryKey: ['permissions'], queryFn: () => unwrap(hr.GET('/api/v1/permissions')) });
  return (
    <fieldset className="space-y-1 text-sm">
      <legend className="mb-1 font-medium">Scopes</legend>
      {cat.data?.client_scopes.map((s) => (
        <label key={s.scope} className="flex items-start gap-2">
          <input type="checkbox" className="mt-1" checked={value.includes(s.scope)} onChange={(e) => onChange(e.target.checked ? [...value, s.scope] : value.filter((x) => x !== s.scope))} />
          <span><code>{s.scope}</code> <span className="muted">{s.description}</span></span>
        </label>
      ))}
    </fieldset>
  );
}

function ClientDialog({ client, onClose }: { client: ApiClient | 'new'; onClose: () => void }) {
  const qc = useQueryClient();
  const isNew = client === 'new';
  const [name, setName] = useState(isNew ? '' : client.name);
  const [description, setDescription] = useState(isNew ? '' : (client.description ?? ''));
  const [scopes, setScopes] = useState<string[]>(isNew ? [] : client.scopes);
  const [rate, setRate] = useState(isNew ? 600 : client.rate_limit_per_minute);
  const [secret, setSecret] = useState<{ client_id: string; client_secret: string } | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['api-clients'] });
  const save = useMutation({
    mutationFn: async () => {
      if (isNew) {
        const r = await unwrap(hr.POST('/api/v1/api-clients', { body: { name, description: description || null, scopes: scopes as never, rate_limit_per_minute: rate } }));
        setSecret({ client_id: r.client.client_id, client_secret: r.client_secret });
      } else {
        await unwrap(hr.PATCH('/api/v1/api-clients/{id}', { params: { path: { id: client.id }, header: { 'If-Match': `"${client.version}"` } }, body: { name, description: description || null, scopes: scopes as never, rate_limit_per_minute: rate } }));
        onClose();
      }
      void refresh();
    },
  });
  const rotate = useMutation({
    mutationFn: async () => {
      if (isNew) return;
      const r = await unwrap(hr.POST('/api/v1/api-clients/{id}/secrets', { params: { path: { id: client.id } }, body: { previous_secret_grace_hours: 24 } }));
      setSecret(r);
      void refresh();
    },
  });
  const toggle = useMutation({
    mutationFn: async () => {
      if (isNew) return;
      await unwrap(hr.PATCH('/api/v1/api-clients/{id}', { params: { path: { id: client.id }, header: { 'If-Match': `"${client.version}"` } }, body: { is_active: !client.is_active } }));
      void refresh();
      onClose();
    },
  });
  return (
    <Dialog open wide title={isNew ? 'New API client' : client.name} onClose={onClose}>
      <ProblemBanner error={save.error ?? rotate.error ?? toggle.error} />
      {secret ? (
        <div className="space-y-3">
          <p className="text-sm">Client id: <code>{secret.client_id}</code></p>
          <SecretReveal label="Client secret" value={secret.client_secret} />
          <p className="muted text-xs">Get a token: <code>curl -u &lt;client_id&gt;:&lt;secret&gt; -d grant_type=client_credentials /api/v1/oauth/token</code></p>
          <div className="text-right"><Button onClick={onClose}>Done</Button></div>
        </div>
      ) : (
        <div className="space-y-3">
          <Field label="Name" htmlFor="c-name" hint="The consuming system, e.g. Procurement"><Input id="c-name" value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label="Description" htmlFor="c-desc"><Input id="c-desc" value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
          <Field label="Requests per minute" htmlFor="c-rate"><Input id="c-rate" type="number" value={rate} onChange={(e) => setRate(Number(e.target.value))} className="max-w-40" /></Field>
          <ScopePicker value={scopes} onChange={setScopes} />
          {!isNew && (
            <div className="space-y-2 border-t border-[var(--border)] pt-3 text-sm">
              <div className="font-medium">Secrets</div>
              <ul className="space-y-1">
                {client.secrets.map((s) => (
                  <li key={s.id} className="flex flex-wrap items-center gap-2">
                    <code>{s.prefix}…</code>
                    {s.revoked_at ? <Badge value="revoked" /> : s.expires_at ? <span className="muted text-xs">expires {formatDateTime(s.expires_at)}</span> : <Badge value="active" />}
                    <span className="muted text-xs">last used {s.last_used_at ? formatDateTime(s.last_used_at) : 'never'}</span>
                    {!s.revoked_at && (
                      <Button variant="ghost" onClick={async () => { await unwrap(hr.DELETE('/api/v1/api-clients/{id}/secrets/{secretId}', { params: { path: { id: client.id, secretId: s.id } } })); void refresh(); onClose(); }}>Revoke</Button>
                    )}
                  </li>
                ))}
              </ul>
              <div className="flex gap-2">
                <Button variant="secondary" busy={rotate.isPending} onClick={() => rotate.mutate()}>Rotate secret</Button>
                <Button variant={client.is_active ? 'danger' : 'secondary'} onClick={() => toggle.mutate()}>{client.is_active ? 'Disable client' : 'Enable client'}</Button>
              </div>
              <p className="muted text-xs">Rotation keeps the old secret working for 24 hours so the other system can switch over.</p>
            </div>
          )}
          <div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button busy={save.isPending} disabled={!name || !scopes.length} onClick={() => save.mutate()}>Save</Button></div>
        </div>
      )}
    </Dialog>
  );
}

export default function ApiClientsPage() {
  const { settings } = useSession();
  const q = useQuery({ queryKey: ['api-clients'], queryFn: () => unwrap(hr.GET('/api/v1/api-clients')) });
  const [open, setOpen] = useState<ApiClient | 'new' | null>(null);
  return (
    <div>
      <PageHeader title="API clients" description="Other systems (procurement, HMIS, lab, finance) call the HR API with OAuth 2.0 client credentials. Each gets only the scopes it needs, and every call it makes is audited against it." actions={<Button onClick={() => setOpen('new')}>New client</Button>} />
      <ProblemBanner error={q.error} />
      {!q.data ? <Loading /> : (
        <div className="surface overflow-x-auto rounded-xl">
          <table className="data">
            <thead><tr><th>Client</th><th>Client id</th><th>Scopes</th><th>Status</th><th>Last used</th><th /></tr></thead>
            <tbody>
              {q.data.map((c) => (
                <tr key={c.id}>
                  <td>{c.name}<div className="muted text-xs">{c.description}</div></td>
                  <td className="font-mono text-xs">{c.client_id}</td>
                  <td className="text-xs">{c.scopes.join(' ')}</td>
                  <td><Badge value={c.is_active ? 'active' : 'disabled'} /></td>
                  <td className="text-xs">{c.last_used_at ? formatDateTime(c.last_used_at, settings.timezone, settings.date_format) : 'never'}</td>
                  <td><Button variant="ghost" onClick={() => setOpen(c)}>Manage</Button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {open && <ClientDialog client={open} onClose={() => setOpen(null)} />}
    </div>
  );
}
