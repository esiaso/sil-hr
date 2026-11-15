import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Connector } from './attendance.entities';
import { zonedToUtc } from './attendance.rules';
import type { IncomingPunch } from './attendance.service';

/**
 * Device connectors. Each adapter turns one vendor's attendance data into IncomingPunch
 * records; the attendance service stores them exactly once and derives the days.
 *
 * The vendor contracts below are built from the vendors' published integration guides
 * and have NOT been tried against the hospital's own devices: they are covered by tests
 * against mock servers that follow those guides. See docs/INTEGRATION.md "Needs
 * confirmation" before relying on them in production.
 */
export interface ConnectorAdapter {
  readonly type: Connector['type'];
  /** Problems with the non-secret configuration (empty = fine). */
  validate(config: Record<string, unknown>, hasCredentials: boolean): string[];
  test?(c: Connector, creds: Record<string, string>): Promise<string>;
  pull?(c: Connector, creds: Record<string, string>, from: Date, to: Date): Promise<IncomingPunch[]>;
}

const TIMEOUT_MS = 15_000;
const str = (v: unknown) => (typeof v === 'string' ? v : '');

function deviceLocal(ts: string, timeZone: string): Date {
  // "2026-11-15 08:01:02" in the device's wall-clock time.
  const [date, time] = ts.trim().split(/[ T]/);
  const base = zonedToUtc(date, time.slice(0, 5), timeZone);
  return new Date(base.getTime() + Number(time.slice(6, 8) || 0) * 1000);
}

// ------------------------------------------------------------------ ZKTeco BioTime (server API, pull)

/**
 * BioTime 8.x REST API: POST /jwt-api-token-auth/ for a token, then
 * GET /iclock/api/transactions/?start_time=…&end_time=…&page=…&page_size=…
 * Transactions carry emp_code (the person's code on the device, normally the staff
 * number), punch_time (device local time) and punch_state ("0" check-in, "1" check-out).
 */
export const bioTimeAdapter: ConnectorAdapter = {
  type: 'zkteco_biotime',
  validate(config, hasCredentials) {
    const errors: string[] = [];
    if (!/^https?:\/\//.test(str(config.base_url))) errors.push('base_url: the BioTime server address, e.g. http://10.0.0.5:8081');
    if (!hasCredentials) errors.push('credentials: username and password of a BioTime API user');
    return errors;
  },
  async test(c, creds) {
    await bioTimeToken(c, creds);
    return 'Signed in to BioTime';
  },
  async pull(c, creds, from, to) {
    const token = await bioTimeToken(c, creds);
    const tz = str(c.config.timezone) || 'Africa/Nairobi';
    const fmt = (d: Date) => new Intl.DateTimeFormat('sv-SE', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(d);
    const out: IncomingPunch[] = [];
    for (let page = 1; page <= 200; page++) {
      const url = new URL('/iclock/api/transactions/', str(c.config.base_url));
      url.search = new URLSearchParams({ start_time: fmt(from), end_time: fmt(to), page: String(page), page_size: '500' }).toString();
      const res = await fetch(url, { headers: { Authorization: `JWT ${token}`, Accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) throw new Error(`BioTime transactions: HTTP ${res.status}`);
      const body = (await res.json()) as { data?: { id: number | string; emp_code: string; punch_time: string; punch_state?: string; terminal_sn?: string }[]; next?: string | null };
      for (const t of body.data ?? []) {
        out.push({
          deviceUserId: String(t.emp_code), occurredAt: deviceLocal(t.punch_time, tz), direction: t.punch_state === '0' ? 'in' : t.punch_state === '1' ? 'out' : 'unknown',
          source: 'device', connectorId: c.id, deviceId: t.terminal_sn ?? null, externalId: String(t.id), raw: t,
        });
      }
      if (!body.next) break;
    }
    return out;
  },
};

async function bioTimeToken(c: Connector, creds: Record<string, string>): Promise<string> {
  const res = await fetch(new URL('/jwt-api-token-auth/', str(c.config.base_url)), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: creds.username, password: creds.password }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`BioTime sign-in failed: HTTP ${res.status}`);
  const body = (await res.json()) as { token?: string };
  if (!body.token) throw new Error('BioTime sign-in returned no token');
  return body.token;
}

// ------------------------------------------------------------------ ZKTeco devices pushing (ADMS / iclock)

/**
 * ZKTeco "push" (ADMS) protocol: the device calls GET /iclock/cdata?SN=… to register and
 * POST /iclock/cdata?SN=…&table=ATTLOG with tab-separated lines
 * "PIN<TAB>YYYY-MM-DD HH:MM:SS<TAB>status<TAB>verify…" (status 0 = in, 1 = out).
 * Devices cannot authenticate, so only registered serial numbers (and, if set, source IPs)
 * are accepted.
 */
export const zktecoPushAdapter: ConnectorAdapter = {
  type: 'zkteco_push',
  validate(config) {
    const sns = config.serial_numbers;
    return Array.isArray(sns) && sns.length && sns.every((s) => typeof s === 'string') ? [] : ['serial_numbers: the serial number of every device allowed to push'];
  },
};

export function parseZkAttlog(body: string, c: Connector, sn: string): IncomingPunch[] {
  const tz = str(c.config.timezone) || 'Africa/Nairobi';
  return body
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => line.split('\t'))
    .filter((f) => f.length >= 2 && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(f[1]))
    .map((f) => ({
      deviceUserId: f[0], occurredAt: deviceLocal(f[1], tz), direction: f[2] === '0' ? 'in' as const : f[2] === '1' ? 'out' as const : 'unknown' as const,
      source: 'device' as const, connectorId: c.id, deviceId: sn, externalId: `${sn}:${f[0]}:${f[1]}`, raw: f.join('\t'),
    }));
}

// ------------------------------------------------------------------ Hikvision (ISAPI, pull)

/**
 * Hikvision access-control terminals (face / fingerprint / card) over ISAPI with HTTP
 * Digest authentication: POST /ISAPI/AccessControl/AcsEvent?format=json with an
 * AcsEventCond (major 5 = event, minor 75 = authenticated by face/card/fingerprint),
 * paging by searchResultPosition until responseStatusStrg is not "MORE". Each InfoList
 * item has employeeNoString, time (ISO with offset), serialNo and attendanceStatus.
 */
export const hikvisionIsapiAdapter: ConnectorAdapter = {
  type: 'hikvision_isapi',
  validate(config, hasCredentials) {
    const errors: string[] = [];
    if (!/^https?:\/\//.test(str(config.base_url))) errors.push('base_url: the terminal address, e.g. http://10.0.0.21');
    if (!hasCredentials) errors.push('credentials: username and password of the terminal');
    return errors;
  },
  async test(c, creds) {
    const res = await digestFetch(new URL('/ISAPI/System/deviceInfo', str(c.config.base_url)).toString(), { method: 'GET' }, creds);
    if (!res.ok) throw new Error(`Hikvision device info: HTTP ${res.status}`);
    return 'Reached the Hikvision terminal';
  },
  async pull(c, creds, from, to) {
    const out: IncomingPunch[] = [];
    const searchID = randomUUID();
    const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, '+00:00');
    for (let pos = 0, guard = 0; guard < 500; guard++) {
      const res = await digestFetch(new URL('/ISAPI/AccessControl/AcsEvent?format=json', str(c.config.base_url)).toString(), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ AcsEventCond: { searchID, searchResultPosition: pos, maxResults: 30, major: 5, minor: 75, startTime: iso(from), endTime: iso(to) } }),
      }, creds);
      if (!res.ok) throw new Error(`Hikvision events: HTTP ${res.status}`);
      const body = (await res.json()) as { AcsEvent?: { responseStatusStrg?: string; numOfMatches?: number; InfoList?: { employeeNoString?: string; time: string; serialNo?: number; attendanceStatus?: string }[] } };
      const list = body.AcsEvent?.InfoList ?? [];
      for (const ev of list) {
        if (!ev.employeeNoString) continue;
        out.push({
          deviceUserId: ev.employeeNoString, occurredAt: new Date(ev.time), direction: ev.attendanceStatus === 'checkIn' ? 'in' : ev.attendanceStatus === 'checkOut' ? 'out' : 'unknown',
          source: 'device', connectorId: c.id, deviceId: str(c.config.device_id) || null, externalId: `${str(c.config.base_url)}:${ev.serialNo ?? ev.time}`, raw: ev,
        });
      }
      pos += list.length;
      if (body.AcsEvent?.responseStatusStrg !== 'MORE' || !list.length) break;
    }
    return out;
  },
};

/** Fetch with HTTP Digest authentication (RFC 7616, MD5, qop=auth), as Hikvision devices require. */
export async function digestFetch(url: string, init: RequestInit, creds: Record<string, string>): Promise<Response> {
  const first = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (first.status !== 401) return first;
  const header = first.headers.get('www-authenticate') ?? '';
  if (!/^Digest/i.test(header)) return first;
  const params = Object.fromEntries([...header.matchAll(/(\w+)="?([^",]+)"?/g)].map((m) => [m[1].toLowerCase(), m[2]]));
  const md5 = (s: string) => createHash('md5').update(s).digest('hex');
  const path = new URL(url).pathname + new URL(url).search;
  const method = (init.method ?? 'GET').toUpperCase();
  const cnonce = randomBytes(8).toString('hex');
  const nc = '00000001';
  const ha1 = md5(`${creds.username}:${params.realm}:${creds.password}`);
  const ha2 = md5(`${method}:${path}`);
  const response = params.qop ? md5(`${ha1}:${params.nonce}:${nc}:${cnonce}:auth:${ha2}`) : md5(`${ha1}:${params.nonce}:${ha2}`);
  const auth = `Digest username="${creds.username}", realm="${params.realm}", nonce="${params.nonce}", uri="${path}", response="${response}"${params.qop ? `, qop=auth, nc=${nc}, cnonce="${cnonce}"` : ''}${params.opaque ? `, opaque="${params.opaque}"` : ''}`;
  return fetch(url, { ...init, headers: { ...(init.headers as Record<string, string>), Authorization: auth }, signal: AbortSignal.timeout(TIMEOUT_MS) });
}

// ------------------------------------------------------------------ Hikvision pushing (HTTP listening)

/**
 * Hikvision "HTTP listening" / alarm-server push: the terminal POSTs each event as JSON
 * (or as a multipart field "event_log") with eventType "AccessControllerEvent". Only
 * registered device serials / IPs are accepted.
 */
export const hikvisionPushAdapter: ConnectorAdapter = {
  type: 'hikvision_push',
  validate(config) {
    const ips = config.allowed_ips;
    return Array.isArray(ips) && ips.length ? [] : ['allowed_ips: the IP address of every terminal allowed to push'];
  },
};

export function parseHikvisionEvent(payload: unknown, c: Connector): IncomingPunch[] {
  const p = payload as { dateTime?: string; eventType?: string; AccessControllerEvent?: { employeeNoString?: string; serialNo?: number; attendanceStatus?: string; deviceName?: string; majorEventType?: number; subEventType?: number } };
  const ev = p?.AccessControllerEvent;
  if (p?.eventType !== 'AccessControllerEvent' || !ev?.employeeNoString || !p.dateTime) return [];
  return [{
    deviceUserId: ev.employeeNoString, occurredAt: new Date(p.dateTime), direction: ev.attendanceStatus === 'checkIn' ? 'in' : ev.attendanceStatus === 'checkOut' ? 'out' : 'unknown',
    source: 'device', connectorId: c.id, deviceId: ev.deviceName ?? null, externalId: `${ev.deviceName ?? c.code}:${ev.serialNo ?? p.dateTime}`, raw: p,
  }];
}

export const ADAPTERS: Record<Connector['type'], ConnectorAdapter> = {
  zkteco_biotime: bioTimeAdapter,
  zkteco_push: zktecoPushAdapter,
  hikvision_isapi: hikvisionIsapiAdapter,
  hikvision_push: hikvisionPushAdapter,
};
