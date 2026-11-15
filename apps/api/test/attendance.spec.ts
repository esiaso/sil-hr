import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { api, bearer, closeApp, db, idOf, login, PASSWORD, testApp, uniq } from './helpers';
import { addDays, zonedToUtc } from '../src/modules/attendance/attendance.rules';

afterAll(closeApp);

const B = '/api/v1';
const TZ = 'Africa/Nairobi';
const today = () => new Date().toISOString().slice(0, 10);
/** A recent weekday in the past (attendance is only computed for days that happened). */
function pastWeekday(back: number): string {
  let d = addDays(today(), -back);
  while ([0, 6].includes(new Date(`${d}T00:00:00Z`).getUTCDay())) d = addDays(d, -1);
  return d;
}

async function newStaff(deptPosition: string, username?: string) {
  const app = await testApp();
  const hr = await login(app, 'hr.manager');
  const e = (await api(app).post(`${B}/employees`).set(bearer(hr)).send({ first_name: 'Clock', last_name: `Puncher${uniq()}`, employment_type: 'permanent', status: 'active', hire_date: '2020-01-06', position_id: await idOf(app, 'position', 'code', deptPosition) })).body;
  let token: string | null = null;
  if (username) {
    const admin = await login(app, 'admin');
    const u = (await api(app).post(`${B}/users`).set(bearer(admin)).send({ username, display_name: e.display_name, password: PASSWORD, roles: [{ role_id: await idOf(app, 'role', 'code', 'employee'), scope: 'own' }] })).body;
    await api(app).put(`${B}/employees/${e.id}/user`).set(bearer(admin)).send({ user_id: u.id });
    await db(app).query(`UPDATE user_account SET must_change_password = false WHERE id = $1`, [u.id]);
    token = await login(app, username);
  }
  return { id: e.id as string, staff: e.staff_number as string, token };
}

async function clientToken(scopes: string[]) {
  const app = await testApp();
  const admin = await login(app, 'admin');
  const c = (await api(app).post(`${B}/api-clients`).set(bearer(admin)).send({ name: `Clock ${uniq()}`, scopes })).body;
  return (await api(app).post(`${B}/oauth/token`).auth(c.client.client_id, c.client_secret).type('form').send({ grant_type: 'client_credentials' })).body.access_token as string;
}

describe('attendance from punches', () => {
  it('an office worker on the standing 08:00–17:00 shift: late beyond the 30-minute grace, exactly-once punches', async () => {
    const app = await testApp();
    const p = await newStaff('ICTO');
    const token = await clientToken(['attendance:write', 'attendance:read']);
    const d = pastWeekday(3);
    const events = [
      { staff_number: p.staff, occurred_at: zonedToUtc(d, '08:45', TZ).toISOString(), direction: 'in', external_id: `t-${p.staff}-${d}-in` },
      { staff_number: p.staff, occurred_at: zonedToUtc(d, '17:10', TZ).toISOString(), direction: 'out', external_id: `t-${p.staff}-${d}-out` },
    ];
    const first = await api(app).post(`${B}/clock-events`).set(bearer(token)).send({ events });
    expect(first.body).toMatchObject({ accepted: 2, duplicates: 0, unmatched: 0 });
    const again = await api(app).post(`${B}/clock-events`).set(bearer(token)).send({ events });
    expect(again.body).toMatchObject({ accepted: 0, duplicates: 2 });

    const day = (await api(app).get(`${B}/attendance/days`).query({ from: d, to: d, employee_id: p.id }).set(bearer(token))).body.data[0];
    expect(day).toMatchObject({ status: 'late', late_minutes: 45, shift_code: 'OFFICE', worked_minutes: 445 });

    // The grace is a setting: at 60 minutes the same day is on time.
    const admin = await login(app, 'admin');
    await api(app).put(`${B}/settings/attendance.late_grace_minutes`).set(bearer(admin)).send({ value: 60 });
    try {
      await api(app).post(`${B}/attendance/recompute`).set(bearer(admin)).send({ from: d, to: d });
      const re = (await api(app).get(`${B}/attendance/days`).query({ from: d, to: d, employee_id: p.id }).set(bearer(token))).body.data[0];
      expect(re).toMatchObject({ status: 'present', late_minutes: 0 });
    } finally {
      await api(app).put(`${B}/settings/attendance.late_grace_minutes`).set(bearer(admin)).send({ value: 30 });
    }
  });

  it('a rostered nurse on a night shift: punches across midnight make one day; an unrostered day is a rest day', async () => {
    const app = await testApp();
    const p = await newStaff('RN-SUR');
    const hr = await login(app, 'hr.manager');
    const d = addDays(today(), -4);
    const pattern = await api(app).post(`${B}/rosters/pattern`).set(bearer(hr)).send({ employee_ids: [p.id], from: d, to: addDays(d, 1), pattern: ['N', 'OFF'] });
    expect(pattern.status).toBe(201);
    const token = await clientToken(['attendance:write']);
    await api(app).post(`${B}/clock-events`).set(bearer(token)).send({ events: [
      { staff_number: p.staff, occurred_at: zonedToUtc(d, '18:52', TZ).toISOString() },
      { staff_number: p.staff, occurred_at: zonedToUtc(addDays(d, 1), '07:04', TZ).toISOString() },
    ] });
    const days = (await api(app).get(`${B}/attendance/days`).query({ from: d, to: addDays(d, 1), employee_id: p.id }).set(bearer(hr))).body.data;
    const night = days.find((x: { work_date: string }) => x.work_date === d);
    expect(night).toMatchObject({ shift_code: 'N', status: 'present', worked_minutes: 672 });
    const off = days.find((x: { work_date: string }) => x.work_date === addDays(d, 1));
    expect(off?.status ?? 'rest_day').toBe('rest_day');
    const [evt] = await db(app).query(`SELECT data FROM outbox_event WHERE type = 'hr.roster.changed.v1' AND data->'employee_ids' ? $1`, [p.id]);
    expect(evt.data.from).toBe(d);
  });

  it('clock events are immutable', async () => {
    const app = await testApp();
    await expect(db(app).query(`UPDATE clock_event SET occurred_at = now() WHERE id = (SELECT id FROM clock_event LIMIT 1)`)).rejects.toThrow(/immutable/);
    await expect(db(app).query(`DELETE FROM clock_event`)).rejects.toThrow(/immutable/);
  });

  it('self-service clock in and out, then a regularisation for a missed punch goes through the approval engine', async () => {
    const app = await testApp();
    const p = await newStaff('ICTO', `clk.${uniq().toLowerCase()}`);
    const i = await api(app).post(`${B}/me/clock`).set(bearer(p.token!)).send({ direction: 'in' });
    expect(i.status).toBe(200);
    expect(i.body.punches.at(-1)).toMatchObject({ direction: 'in', source: 'web' });

    const d = pastWeekday(2);
    const req = await api(app).post(`${B}/attendance/regularisations`).set(bearer(p.token!)).send({ work_date: d, clock_in: zonedToUtc(d, '08:00', TZ).toISOString(), clock_out: zonedToUtc(d, '17:00', TZ).toISOString(), reason: 'Device was offline all day' });
    expect(req.status).toBe(201);
    // ICT has no line manager here: the step goes to workflow administrators (hr.manager holds workflow:manage).
    const hr = await login(app, 'hr.manager');
    const inbox = (await api(app).get(`${B}/workflow/inbox`).set(bearer(hr))).body;
    const task = inbox.find((t: { subject_id: string }) => t.subject_id === req.body.id);
    expect(task).toBeTruthy();
    await api(app).post(`${B}/workflow/tasks/${task.id}/decision`).set(bearer(hr)).send({ decision: 'approve' });
    const day = (await api(app).get(`${B}/attendance/days`).query({ from: d, to: d, employee_id: p.id }).set(bearer(hr))).body.data[0];
    expect(day).toMatchObject({ status: 'present', regularised: true, worked_minutes: 480 });
  });

  it('leave for rostered staff counts their planned shifts, not Monday to Friday', async () => {
    const app = await testApp();
    const p = await newStaff('RN-SUR', `ros.${uniq().toLowerCase()}`);
    const hr = await login(app, 'hr.manager');
    let mon = addDays(today(), 14);
    while (new Date(`${mon}T00:00:00Z`).getUTCDay() !== 1) mon = addDays(mon, 1);
    // Works Sat and Sun, off Mon to Fri.
    await api(app).post(`${B}/rosters/pattern`).set(bearer(hr)).send({ employee_ids: [p.id], from: mon, to: addDays(mon, 6), pattern: ['OFF', 'OFF', 'OFF', 'OFF', 'OFF', 'D', 'D'] });
    const annual = await idOf(app, 'leave_type' as never, 'code', 'annual');
    const q = await api(app).post(`${B}/leave/quote`).set(bearer(p.token!)).send({ leave_type_id: annual, start_date: mon, end_date: addDays(mon, 6) });
    expect(q.body.days).toBe(2);
  });

  it('timesheet sums the days and lists overtime by day type (multipliers empty until set)', async () => {
    const app = await testApp();
    const hr = await login(app, 'hr.manager');
    const [e] = await db(app).query(`SELECT e.id FROM employee e JOIN department d ON d.id = e.department_id WHERE d.code = 'HR' ORDER BY e.staff_number LIMIT 1`);
    const ts = await api(app).get(`${B}/attendance/timesheets/${e.id}`).query({ from: addDays(today(), -14), to: addDays(today(), -1) }).set(bearer(hr));
    expect(ts.status).toBe(200);
    expect(ts.body.present_days).toBeGreaterThan(3);
    for (const o of ts.body.overtime) expect(o.multiplier).toBeNull();
    const rule = await api(app).post(`${B}/attendance/overtime-rules`).set(bearer(hr)).send({ day_type: 'public_holiday', multiplier: 2, min_minutes: 0, effective_from: '2026-01-01' });
    expect(rule.status).toBe(201);
  });

  it('a line manager sees attendance only for their reports', async () => {
    const app = await testApp();
    const lm = await login(app, 'line.manager');
    const d = addDays(today(), -14);
    const days = (await api(app).get(`${B}/attendance/days`).query({ from: d, to: today(), limit: 500 }).set(bearer(lm))).body.data;
    const [me] = await db(app).query(`SELECT employee_id FROM user_account WHERE username = 'line.manager'`);
    const allowed = new Set((await db(app).query(`SELECT id FROM employee WHERE manager_id = $1`, [me.employee_id])).map((r: { id: string }) => r.id));
    for (const x of days) expect(allowed.has(x.employee_id)).toBe(true);
  });
});

// ---------------------------------------------------------------- device connectors

function listen(handler: Parameters<typeof createServer>[1]): Promise<{ url: string; close: () => Promise<void> }> {
  const s: Server = createServer(handler);
  return new Promise((r) => s.listen(0, '127.0.0.1', () => r({ url: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, close: () => new Promise((c) => s.close(() => c())) })));
}
const read = async (req: import('node:http').IncomingMessage) => {
  let b = '';
  for await (const c of req) b += c;
  return b;
};

describe('device connectors', () => {
  it('ZKTeco BioTime: signs in, pages through transactions, maps emp_code to staff numbers, reports unmatched users', async () => {
    const app = await testApp();
    const p = await newStaff('ICTO');
    const d = pastWeekday(5);
    const tx = [
      { id: 9001, emp_code: p.staff, punch_time: `${d} 07:58:10`, punch_state: '0', terminal_sn: 'BT-1' },
      { id: 9002, emp_code: p.staff, punch_time: `${d} 17:02:00`, punch_state: '1', terminal_sn: 'BT-1' },
      { id: 9003, emp_code: 'VISITOR-77', punch_time: `${d} 09:00:00`, punch_state: '0', terminal_sn: 'BT-1' },
    ];
    const bio = await listen(async (req, res) => {
      if (req.url === '/jwt-api-token-auth/' && req.method === 'POST') {
        const b = JSON.parse(await read(req));
        return void res.writeHead(b.password === 'bt-pass' ? 200 : 400, { 'content-type': 'application/json' }).end(JSON.stringify({ token: 'jwt-abc' }));
      }
      if (req.url?.startsWith('/iclock/api/transactions/')) {
        if (req.headers.authorization !== 'JWT jwt-abc') return void res.writeHead(401).end();
        const page = Number(new URL(req.url, 'http://x').searchParams.get('page'));
        const data = page === 1 ? tx.slice(0, 2) : tx.slice(2);
        return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ count: 3, next: page === 1 ? 'more' : null, data }));
      }
      res.writeHead(404).end();
    });
    try {
      const admin = await login(app, 'admin');
      const c = await api(app).post(`${B}/connectors`).set(bearer(admin)).send({ code: `bt_${uniq().toLowerCase()}`, name: 'BioTime', type: 'zkteco_biotime', config: { base_url: bio.url, timezone: TZ }, credentials: { username: 'api', password: 'bt-pass' }, schedule_minutes: 5 });
      expect(c.status).toBe(201);
      expect(c.body).toMatchObject({ has_credentials: true });
      expect(JSON.stringify(c.body)).not.toContain('bt-pass');
      const [row] = await db(app).query(`SELECT credentials_enc FROM connector WHERE id = $1`, [c.body.id]);
      expect(row.credentials_enc).toMatch(/^v1:/);
      expect((await api(app).post(`${B}/connectors/${c.body.id}/test`).set(bearer(admin))).body.ok).toBe(true);

      const run = await api(app).post(`${B}/connectors/${c.body.id}/run`).set(bearer(admin));
      expect(run.body).toMatchObject({ status: 'succeeded', received: 3, accepted: 3, unmatched: 1 });
      const again = await api(app).post(`${B}/connectors/${c.body.id}/run`).set(bearer(admin));
      expect(again.body).toMatchObject({ received: 3, accepted: 0, duplicates: 3 });
      const unmatched = (await api(app).get(`${B}/connectors/${c.body.id}/unmatched`).set(bearer(admin))).body;
      expect(unmatched[0]).toMatchObject({ device_user_id: 'VISITOR-77', punches: 1 });
      expect((await api(app).get(`${B}/connectors`).set(bearer(admin))).body.find((x: { id: string }) => x.id === c.body.id).health).toBe('degraded');

      const hr = await login(app, 'hr.manager');
      const day = (await api(app).get(`${B}/attendance/days`).query({ from: d, to: d, employee_id: p.id }).set(bearer(hr))).body.data[0];
      expect(day).toMatchObject({ status: 'present', shift_code: 'OFFICE' });
      expect(day.first_in).toBe(zonedToUtc(d, '07:58', TZ).toISOString().replace('.000Z', '.000Z').slice(0, 17) + '10.000Z');

      // Mapping the stranger to an employee re-matches the stored punch.
      const mapped = await api(app).put(`${B}/connectors/${c.body.id}/mappings`).set(bearer(admin)).send({ device_user_id: 'VISITOR-77', employee_id: p.id });
      expect(mapped.body.rematched).toBe(1);
      // Nothing left unmatched, so the connector is healthy again.
      expect((await api(app).get(`${B}/connectors`).set(bearer(admin))).body.find((x: { id: string }) => x.id === c.body.id).health).toBe('ok');
    } finally {
      await bio.close();
    }
  });

  it('ZKTeco BioTime failure: the run fails, the connector turns failing and admins are told', async () => {
    const app = await testApp();
    const admin = await login(app, 'admin');
    const c = (await api(app).post(`${B}/connectors`).set(bearer(admin)).send({ code: `bt_${uniq().toLowerCase()}`, name: 'Unreachable BioTime', type: 'zkteco_biotime', config: { base_url: 'http://127.0.0.1:9' }, credentials: { username: 'a', password: 'b' } })).body;
    const run = await api(app).post(`${B}/connectors/${c.id}/run`).set(bearer(admin));
    expect(run.body.status).toBe('failed');
    const list = (await api(app).get(`${B}/connectors`).set(bearer(admin))).body;
    expect(list.find((x: { id: string }) => x.id === c.id).health).toBe('failing');
    const notes = (await api(app).get(`${B}/notifications`).set(bearer(admin))).body;
    expect(notes.some((n: { title: string }) => n.title.includes('Unreachable BioTime'))).toBe(true);
  });

  it('ZKTeco devices pushing ATTLOG (ADMS): only registered serials are accepted', async () => {
    const app = await testApp();
    const p = await newStaff('ICTO');
    const admin = await login(app, 'admin');
    await api(app).post(`${B}/connectors`).set(bearer(admin)).send({ code: `zkp_${uniq().toLowerCase()}`, name: 'Ward devices', type: 'zkteco_push', config: { serial_numbers: ['ZK-SN-1'], timezone: TZ } });
    expect((await api(app).get('/iclock/cdata?SN=ZK-SN-1&options=all')).text).toContain('GET OPTION FROM: ZK-SN-1');
    expect((await api(app).get('/iclock/cdata?SN=STRANGER')).status).toBe(403);
    const d = pastWeekday(6);
    const body = `${p.staff}\t${d} 08:05:00\t0\t1\t0\n${p.staff}\t${d} 17:01:00\t1\t1\t0\n`;
    const push = await api(app).post('/iclock/cdata?SN=ZK-SN-1&table=ATTLOG').set('content-type', 'text/plain').send(body);
    expect(push.text).toBe('OK: 2');
    const hr = await login(app, 'hr.manager');
    const day = (await api(app).get(`${B}/attendance/days`).query({ from: d, to: d, employee_id: p.id }).set(bearer(hr))).body.data[0];
    expect(day.status).toBe('present');
  });

  it('Hikvision ISAPI: digest authentication and paged AcsEvent search', async () => {
    const app = await testApp();
    const p = await newStaff('ICTO');
    const d = pastWeekday(7);
    let pages = 0;
    const hik = await listen(async (req, res) => {
      const auth = String(req.headers.authorization ?? '');
      if (!auth.startsWith('Digest ')) return void res.writeHead(401, { 'www-authenticate': 'Digest realm="DS-K1T", qop="auth", nonce="n0nce"' }).end();
      // Check the digest response really used the password.
      const f = Object.fromEntries([...auth.matchAll(/(\w+)="?([^",]+)"?/g)].map((m) => [m[1], m[2]]));
      const md5 = (s: string) => createHash('md5').update(s).digest('hex');
      const expect = md5(`${md5(`admin:DS-K1T:hik-pass`)}:n0nce:${f.nc}:${f.cnonce}:auth:${md5(`${req.method}:${f.uri}`)}`);
      if (f.response !== expect) return void res.writeHead(401, { 'www-authenticate': 'Digest realm="DS-K1T", qop="auth", nonce="n0nce"' }).end();
      if (req.url?.startsWith('/ISAPI/System/deviceInfo')) return void res.writeHead(200).end('<DeviceInfo/>');
      const cond = JSON.parse(await read(req)).AcsEventCond;
      pages++;
      const all = [
        { employeeNoString: p.staff, time: zonedToUtc(d, '07:55', TZ).toISOString(), serialNo: 11, attendanceStatus: 'checkIn' },
        { employeeNoString: p.staff, time: zonedToUtc(d, '17:05', TZ).toISOString(), serialNo: 12, attendanceStatus: 'checkOut' },
      ];
      const slice = all.slice(cond.searchResultPosition, cond.searchResultPosition + 1);
      return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ AcsEvent: { responseStatusStrg: cond.searchResultPosition + 1 < all.length ? 'MORE' : 'OK', numOfMatches: slice.length, InfoList: slice } }));
    });
    try {
      const admin = await login(app, 'admin');
      const c = (await api(app).post(`${B}/connectors`).set(bearer(admin)).send({ code: `hik_${uniq().toLowerCase()}`, name: 'Lobby terminal', type: 'hikvision_isapi', config: { base_url: hik.url }, credentials: { username: 'admin', password: 'hik-pass' } })).body;
      expect((await api(app).post(`${B}/connectors/${c.id}/test`).set(bearer(admin))).body.ok).toBe(true);
      const run = await api(app).post(`${B}/connectors/${c.id}/run`).set(bearer(admin));
      expect(run.body).toMatchObject({ status: 'succeeded', received: 2, accepted: 2 });
      expect(pages).toBe(2);
    } finally {
      await hik.close();
    }
  });

  it('Hikvision terminals pushing events (JSON or multipart event_log)', async () => {
    const app = await testApp();
    const p = await newStaff('ICTO');
    const admin = await login(app, 'admin');
    const code = `hikp_${uniq().toLowerCase()}`;
    await api(app).post(`${B}/connectors`).set(bearer(admin)).send({ code, name: 'Gate terminals', type: 'hikvision_push', config: { allowed_ips: ['*'] } });
    const d = pastWeekday(8);
    const ev = (t: string, s: string, n: number) => ({ ipAddress: '10.0.0.30', dateTime: zonedToUtc(d, t, TZ).toISOString(), eventType: 'AccessControllerEvent', AccessControllerEvent: { employeeNoString: p.staff, serialNo: n, attendanceStatus: s, deviceName: 'Gate-1' } });
    const r1 = await api(app).post(`${B}/integrations/hikvision/${code}/events`).send(ev('08:01', 'checkIn', 1));
    expect(r1.body).toMatchObject({ accepted: 1 });
    const r2 = await api(app).post(`${B}/integrations/hikvision/${code}/events`).field('event_log', JSON.stringify(ev('17:00', 'checkOut', 2)));
    expect(r2.body).toMatchObject({ accepted: 1 });
    expect((await api(app).post(`${B}/integrations/hikvision/not_registered/events`).send(ev('17:00', 'checkOut', 3))).status).toBe(403);
    const hr = await login(app, 'hr.manager');
    const day = (await api(app).get(`${B}/attendance/days`).query({ from: d, to: d, employee_id: p.id }).set(bearer(hr))).body.data[0];
    expect(day.status).toBe('present');
  });
});
