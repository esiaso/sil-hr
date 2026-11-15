'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { CONNECTOR_TYPES, formatDateTime, type Connector, type ConnectorType } from '@sil/hr-shared';
import { Badge, Button, Card, Dialog, Empty, Field, Input, Loading, PageHeader, ProblemBanner, Select } from '@/components/ui';
import { ApiError, hr, unwrap } from '@/lib/api';
import { useSession } from '@/lib/session';

const list = (x: unknown) => (Array.isArray(x) ? (x as string[]).join(', ') : '');
const split = (s: string) => s.split(/[\s,]+/).filter(Boolean);
const PULL: ConnectorType[] = ['zkteco_biotime', 'hikvision_isapi'];

function ConnectorDialog({ c, onClose }: { c: Connector | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [v, setV] = useState({
    code: c?.code ?? '', name: c?.name ?? '', type: (c?.type ?? 'zkteco_push') as ConnectorType, match_by: c?.match_by ?? ('staff_number' as const), schedule_minutes: c?.schedule_minutes ?? 15, is_active: c?.is_active ?? true,
    base_url: String(c?.config.base_url ?? ''), timezone: String(c?.config.timezone ?? 'Africa/Nairobi'), device_id: String(c?.config.device_id ?? ''),
    serial_numbers: list(c?.config.serial_numbers), allowed_ips: list(c?.config.allowed_ips), username: '', password: '',
  });
  const pull = PULL.includes(v.type);
  const save = useMutation({
    mutationFn: () => {
      const config: Record<string, unknown> = { timezone: v.timezone };
      if (pull) Object.assign(config, { base_url: v.base_url, ...(v.device_id ? { device_id: v.device_id } : {}) });
      if (v.type === 'zkteco_push') config.serial_numbers = split(v.serial_numbers);
      if (v.allowed_ips || v.type === 'hikvision_push') config.allowed_ips = split(v.allowed_ips);
      const body = { code: v.code, name: v.name, type: v.type, match_by: v.match_by, is_active: v.is_active, schedule_minutes: pull ? v.schedule_minutes : null, config, ...(v.username || v.password ? { credentials: { username: v.username, password: v.password } } : {}) };
      return c ? unwrap(hr.PUT('/api/v1/connectors/{id}', { params: { path: { id: c.id }, header: { 'If-Match': `"${c.version}"` } as never }, body })) : unwrap(hr.POST('/api/v1/connectors', { body }));
    },
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['connectors'] }); onClose(); },
  });
  const fe = save.error instanceof ApiError ? save.error.fieldErrors : {};
  return (
    <Dialog open wide title={c ? c.name : 'New device connector'} onClose={onClose}>
      <ProblemBanner error={save.error} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Kind" htmlFor="cn-type"><Select id="cn-type" value={v.type} disabled={!!c} onChange={(e) => setV({ ...v, type: e.target.value as ConnectorType })}>{Object.entries(CONNECTOR_TYPES).map(([k, x]) => <option key={k} value={k}>{x}</option>)}</Select></Field>
        <Field label="Name" htmlFor="cn-name" error={fe.name}><Input id="cn-name" value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} /></Field>
        <Field label="Code" htmlFor="cn-code" error={fe.code} hint="Lower case, e.g. main_gate"><Input id="cn-code" value={v.code} disabled={!!c} onChange={(e) => setV({ ...v, code: e.target.value })} /></Field>
        <Field label="Device clock timezone" htmlFor="cn-tz"><Input id="cn-tz" value={v.timezone} onChange={(e) => setV({ ...v, timezone: e.target.value })} /></Field>
        {pull && <>
          <Field label={v.type === 'zkteco_biotime' ? 'BioTime server address' : 'Terminal address'} htmlFor="cn-url" error={fe['config.base_url']}><Input id="cn-url" placeholder="http://10.0.0.5:8081" value={v.base_url} onChange={(e) => setV({ ...v, base_url: e.target.value })} /></Field>
          <Field label="Pull every (minutes)" htmlFor="cn-sched"><Input id="cn-sched" type="number" value={v.schedule_minutes ?? ''} onChange={(e) => setV({ ...v, schedule_minutes: Number(e.target.value) })} /></Field>
          <Field label="Username" htmlFor="cn-user" error={fe.credentials} hint={c?.has_credentials ? 'Saved. Leave empty to keep it.' : undefined}><Input id="cn-user" autoComplete="off" value={v.username} onChange={(e) => setV({ ...v, username: e.target.value })} /></Field>
          <Field label="Password" htmlFor="cn-pass"><Input id="cn-pass" type="password" autoComplete="new-password" value={v.password} onChange={(e) => setV({ ...v, password: e.target.value })} /></Field>
        </>}
        {v.type === 'zkteco_push' && <Field label="Device serial numbers" htmlFor="cn-sn" error={fe['config.serial_numbers']} hint="Only devices listed here may push"><Input id="cn-sn" value={v.serial_numbers} onChange={(e) => setV({ ...v, serial_numbers: e.target.value })} /></Field>}
        {!pull && <Field label="Allowed device IP addresses" htmlFor="cn-ips" error={fe['config.allowed_ips']} hint={v.type === 'zkteco_push' ? 'Optional extra check' : 'Every terminal that pushes'}><Input id="cn-ips" value={v.allowed_ips} onChange={(e) => setV({ ...v, allowed_ips: e.target.value })} /></Field>}
        <Field label="Match device users by" htmlFor="cn-match"><Select id="cn-match" value={v.match_by} onChange={(e) => setV({ ...v, match_by: e.target.value as 'staff_number' | 'mapping' })}><option value="staff_number">Staff number (the device user id is the staff number)</option><option value="mapping">A mapping table kept here</option></Select></Field>
      </div>
      <label className="mt-3 flex items-center gap-1 text-sm"><input type="checkbox" checked={v.is_active} onChange={(e) => setV({ ...v, is_active: e.target.checked })} />Active</label>
      <div className="mt-4 flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button busy={save.isPending} onClick={() => save.mutate()}>Save</Button></div>
    </Dialog>
  );
}

function Detail({ c }: { c: Connector }) {
  const { settings } = useSession();
  const qc = useQueryClient();
  const runs = useQuery({ queryKey: ['conn-runs', c.id], queryFn: () => unwrap(hr.GET('/api/v1/connectors/{id}/runs', { params: { path: { id: c.id } } })) });
  const unmatched = useQuery({ queryKey: ['conn-unmatched', c.id], queryFn: () => unwrap(hr.GET('/api/v1/connectors/{id}/unmatched', { params: { path: { id: c.id } } })) });
  const mappings = useQuery({ queryKey: ['conn-maps', c.id], queryFn: () => unwrap(hr.GET('/api/v1/connectors/{id}/mappings', { params: { path: { id: c.id } } })) });
  const refresh = () => { for (const k of ['connectors', 'conn-runs', 'conn-unmatched', 'conn-maps']) void qc.invalidateQueries({ queryKey: [k] }); };
  const test = useMutation({ mutationFn: () => unwrap(hr.POST('/api/v1/connectors/{id}/test', { params: { path: { id: c.id } } })), onSuccess: refresh });
  const run = useMutation({ mutationFn: () => unwrap(hr.POST('/api/v1/connectors/{id}/run', { params: { path: { id: c.id } } })), onSuccess: refresh });
  const [mapFor, setMapFor] = useState<string | null>(null);
  const t = (iso: string | null) => (iso ? formatDateTime(iso, settings.timezone, settings.date_format) : '');
  return (
    <div className="space-y-3">
      <ProblemBanner error={test.error ?? run.error} />
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="secondary" busy={test.isPending} onClick={() => test.mutate()}>Test connection</Button>
        {PULL.includes(c.type) && <Button variant="secondary" busy={run.isPending} onClick={() => run.mutate()}>Pull now</Button>}
        {test.data && <span className={`text-sm ${test.data.ok ? 'text-green-700' : 'text-red-600'}`}>{test.data.message}</span>}
      </div>
      {c.push_url && <p className="text-sm">Set the device to push to <code className="break-all">{c.push_url}</code></p>}
      <div>
        <h3 className="mb-1 text-sm font-semibold">Device users not matched to anyone</h3>
        {!unmatched.data ? <Loading /> : !unmatched.data.length ? <p className="muted text-sm">None. Every punch found its person.</p> : (
          <table className="data text-sm"><thead><tr><th>Device user</th><th>Punches</th><th>Last seen</th><th /></tr></thead>
            <tbody>{unmatched.data.map((u) => <tr key={u.device_user_id}><td>{u.device_user_id}</td><td>{u.punches}</td><td>{t(u.last_seen)}</td><td><Button variant="ghost" onClick={() => setMapFor(u.device_user_id)}>Link to a person</Button></td></tr>)}</tbody>
          </table>
        )}
      </div>
      {!!mappings.data?.length && (
        <div>
          <h3 className="mb-1 text-sm font-semibold">Linked device users</h3>
          <ul className="text-sm">{mappings.data.map((m) => <li key={m.id}>{m.device_user_id} → {m.employee_name}</li>)}</ul>
        </div>
      )}
      <div>
        <h3 className="mb-1 text-sm font-semibold">Recent runs</h3>
        {!runs.data ? <Loading /> : !runs.data.length ? <p className="muted text-sm">No runs yet.</p> : (
          <table className="data text-xs"><thead><tr><th>Started</th><th>How</th><th>Result</th><th>Received</th><th>New</th><th>Repeats</th><th>Unmatched</th><th>Problem</th></tr></thead>
            <tbody>{runs.data.map((r) => <tr key={r.id}><td className="whitespace-nowrap">{t(r.started_at)}</td><td>{r.trigger}</td><td><Badge value={r.status} /></td><td>{r.received}</td><td>{r.accepted}</td><td>{r.duplicates}</td><td>{r.unmatched}</td><td className="max-w-xs truncate" title={r.error ?? ''}>{r.error}</td></tr>)}</tbody>
          </table>
        )}
      </div>
      {mapFor && <MapDialog connectorId={c.id} deviceUserId={mapFor} onClose={() => { setMapFor(null); refresh(); }} />}
    </div>
  );
}

function MapDialog({ connectorId, deviceUserId, onClose }: { connectorId: string; deviceUserId: string; onClose: () => void }) {
  const [search, setSearch] = useState('');
  const [emp, setEmp] = useState('');
  const found = useQuery({ queryKey: ['map-search', search], enabled: search.length >= 2, queryFn: () => unwrap(hr.GET('/api/v1/employees', { params: { query: { limit: 20, search } } })) });
  const save = useMutation({ mutationFn: () => unwrap(hr.PUT('/api/v1/connectors/{id}/mappings', { params: { path: { id: connectorId } }, body: { device_user_id: deviceUserId, employee_id: emp } })), onSuccess: onClose });
  return (
    <Dialog open title={`Device user ${deviceUserId}`} onClose={onClose}>
      <ProblemBanner error={save.error} />
      <Field label="Find the person" htmlFor="mp-s"><Input id="mp-s" placeholder="Name or staff number" value={search} onChange={(e) => setSearch(e.target.value)} /></Field>
      <div className="mt-2 max-h-56 overflow-y-auto text-sm">{found.data?.data.map((e) => <label key={e.id} className="flex items-center gap-1 py-0.5"><input type="radio" name="mp-emp" checked={emp === e.id} onChange={() => setEmp(e.id)} />{e.first_name} {e.last_name} <span className="muted">{e.staff_number}</span></label>)}</div>
      <p className="muted mt-2 text-xs">Earlier punches from this device user are matched straight away.</p>
      <div className="mt-4 flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button disabled={!emp} busy={save.isPending} onClick={() => save.mutate()}>Link</Button></div>
    </Dialog>
  );
}

export default function ConnectorsPage() {
  const { settings } = useSession();
  const q = useQuery({ queryKey: ['connectors'], queryFn: () => unwrap(hr.GET('/api/v1/connectors')) });
  const [editing, setEditing] = useState<Connector | 'new' | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div className="space-y-4">
      <PageHeader title="Device connectors" description="Clocking terminals. ZKTeco and Hikvision are both supported, either by SIL HR pulling from them on a schedule or by the devices pushing to SIL HR. Any other system can post punches to /api/v1/clock-events." actions={<Button onClick={() => setEditing('new')}>New connector</Button>} />
      <ProblemBanner error={q.error} />
      {!q.data ? <Loading /> : !q.data.length ? <Empty>No connectors yet.</Empty> : q.data.map((c) => (
        <Card key={c.id}>
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <div className="font-semibold">{c.name} {!c.is_active && <Badge value="inactive" />}</div>
              <div className="muted text-xs">{CONNECTOR_TYPES[c.type]}{c.schedule_minutes ? ` · every ${c.schedule_minutes} min` : ''}{c.last_run_at ? ` · last ${formatDateTime(c.last_run_at, settings.timezone, settings.date_format)}` : ''}</div>
              {c.health_message && <div className="mt-1 text-sm">{c.health_message}</div>}
            </div>
            <div className="flex items-center gap-2"><Badge value={c.health} /><Button variant="ghost" onClick={() => setEditing(c)}>Edit</Button><Button variant="ghost" onClick={() => setOpen(open === c.id ? null : c.id)}>{open === c.id ? 'Hide' : 'Details'}</Button></div>
          </div>
          {open === c.id && <div className="mt-3 border-t border-[var(--border)] pt-3"><Detail c={c} /></div>}
        </Card>
      ))}
      {editing && <ConnectorDialog c={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </div>
  );
}
