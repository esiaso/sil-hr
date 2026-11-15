import { createServer, type Server } from 'node:http';
import { NotificationsService, normalisePhone } from '../src/modules/notifications/notifications.module';
import { WorkplaceService } from '../src/modules/workplace/workplace.service';
import { api, bearer, closeApp, db, idOf, login, testApp, uniq } from './helpers';

const B = '/api/v1';
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
const at = (days: number, hour: number) => {
  const d = new Date(Date.now() + days * 86_400_000);
  d.setUTCHours(hour, 0, 0, 0);
  return d.toISOString();
};

let sms: Server;
const smsCalls: { headers: Record<string, unknown>; body: string }[] = [];
beforeAll(async () => {
  sms = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      smsCalls.push({ headers: req.headers, body });
      const to = new URLSearchParams(body).get('to');
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ SMSMessageData: { Message: 'Sent to 1/1', Recipients: [{ number: to, status: to === '+254700000999' ? 'InvalidPhoneNumber' : 'Success', statusCode: 101, messageId: `ATXid_${smsCalls.length}` }] } }));
    });
  });
  await new Promise<void>((r) => sms.listen(39126, '127.0.0.1', () => r()));
});
afterAll(async () => {
  await new Promise<void>((r) => sms.close(() => r()));
  await closeApp();
});

describe('announcements', () => {
  it('reach only their audience, and the audience is told once', async () => {
    const app = await testApp();
    const hrm = await login(app, 'hr.manager');
    const nurs = await idOf(app, 'department', 'code', 'NURS');
    const title = `Ward rounds change ${uniq()}`;
    const r = await api(app).post(`${B}/announcements`).set(bearer(hrm)).send({ title, body: 'Morning handover moves to 07:30 from Monday.', department_ids: [nurs], pinned: true });
    expect(r.status).toBe(201);
    expect(r.body.audience).toMatch(/Nursing/);
    // The sample employee is on the medical ward, under nursing; the recruiter is not.
    expect((await api(app).get(`${B}/announcements`).set(bearer(await login(app, 'employee')))).body.some((a: { title: string }) => a.title === title)).toBe(true);
    expect((await api(app).get(`${B}/announcements`).set(bearer(await login(app, 'payroll')))).body.some((a: { title: string }) => a.title === title)).toBe(false);
    const [n] = await db(app).query(`SELECT count(*)::int AS n FROM notification WHERE title = $1`, [`Announcement: ${title}`]);
    expect(n.n).toBeGreaterThan(1);
    expect(await app.get(WorkplaceService).publishDue()).toBe(0);
    expect((await api(app).post(`${B}/announcements`).set(bearer(await login(app, 'employee'))).send({ title: 'x', body: 'y' })).status).toBe(403);
    const later = await api(app).post(`${B}/announcements`).set(bearer(hrm)).send({ title: `Later ${uniq()}`, body: 'Not yet', publish_at: at(3, 6) });
    expect((await api(app).get(`${B}/announcements`).set(bearer(await login(app, 'employee')))).body.some((a: { id: string }) => a.id === later.body.id)).toBe(false);
  });
});

describe('policy documents', () => {
  let id = '';
  it('are published to an audience, read and acknowledged; a new version asks again', async () => {
    const app = await testApp();
    const hrm = await login(app, 'hr.manager');
    const emp = await login(app, 'employee');
    const code = `IPC${uniq()}`;
    const p = await api(app).post(`${B}/policies`).set(bearer(hrm)).field('code', code).field('title', 'Hand hygiene policy').field('category', 'clinical').field('effective_from', '2026-01-01').attach('file', PDF, { filename: 'policy.pdf', contentType: 'application/pdf' });
    expect(p.status).toBe(201);
    id = p.body.id;
    expect(p.body).toMatchObject({ code, requires_ack: true, acknowledged: 0, current_version: { version_no: 1 } });
    const mine = (await api(app).get(`${B}/me/policies`).set(bearer(emp))).body.find((x: { id: string }) => x.id === id);
    expect(mine).toMatchObject({ acknowledged_at: null, version_no: 1 });
    expect((await api(app).get(`${B}/policies/${id}/document`).set(bearer(emp))).status).toBe(200);
    expect((await api(app).post(`${B}/policies/${id}/acknowledge`).set(bearer(emp))).body.acknowledged_at).toBeTruthy();
    const pending = (await api(app).get(`${B}/policies/${id}/acknowledgements`).query({ pending: 'true' }).set(bearer(hrm))).body;
    const [{ employee_id: empId }] = await db(app).query(`SELECT employee_id FROM user_account WHERE username = 'employee'`);
    expect(pending.some((r: { employee_id: string }) => r.employee_id === empId)).toBe(false);
    expect(pending.length).toBeGreaterThan(5);
    const v2 = await api(app).post(`${B}/policies/${id}/versions`).set(bearer(hrm)).field('effective_from', '2026-11-01').field('changes', 'Adds alcohol rub stations').attach('file', PDF, { filename: 'policy-v2.pdf', contentType: 'application/pdf' });
    expect(v2.body).toMatchObject({ acknowledged: 0, current_version: { version_no: 2 } });
    expect((await api(app).get(`${B}/me/policies`).set(bearer(emp))).body.find((x: { id: string }) => x.id === id).acknowledged_at).toBeNull();
    expect((await api(app).get(`${B}/policies`).set(bearer(emp))).status).toBe(403);
  });
});

describe('meetings and the calendar', () => {
  let meetingId = '';
  let roomId = '';
  it('a room cannot be double-booked; attendees are invited and respond', async () => {
    const app = await testApp();
    const hrm = await login(app, 'hr.manager');
    roomId = (await api(app).post(`${B}/meeting-rooms`).set(bearer(hrm)).send({ name: `Room ${uniq()}`, capacity: 4 })).body.id;
    const [lm] = await db(app).query(`SELECT id FROM user_account WHERE username IN ('line.manager') `);
    const [emp] = await db(app).query(`SELECT id FROM user_account WHERE username = 'employee'`);
    const body = { title: 'Ward staffing review', room_id: roomId, starts_at: at(2, 7), ends_at: at(2, 8), agenda: '1. Night rota\n2. Sick leave cover', attendee_user_ids: [lm.id, emp.id] };
    const m1 = await api(app).post(`${B}/meetings`).set(bearer(hrm)).send(body);
    expect(m1.status).toBe(201);
    meetingId = m1.body.id;
    expect(m1.body.attendee_list).toHaveLength(2);
    const clash = await api(app).post(`${B}/meetings`).set(bearer(await login(app, 'line.manager'))).send({ ...body, title: 'Clash', starts_at: at(2, 7).replace(':00:00', ':30:00'), ends_at: at(2, 9), attendee_user_ids: [] });
    expect(clash.status).toBe(409);
    const tooMany = (await db(app).query(`SELECT id FROM user_account LIMIT 5`)).map((u: { id: string }) => u.id);
    expect((await api(app).post(`${B}/meetings`).set(bearer(hrm)).send({ ...body, starts_at: at(4, 7), ends_at: at(4, 8), attendee_user_ids: tooMany })).status).toBe(422);
    const e = await login(app, 'employee');
    expect((await api(app).post(`${B}/meetings/${meetingId}/response`).set(bearer(e)).send({ response: 'accepted' })).body.my_response).toBe('accepted');
    expect((await api(app).get(`${B}/meetings/${meetingId}`).set(bearer(await login(app, 'payroll')))).status).toBe(404);
    const ics = await api(app).get(`${B}/meetings/${meetingId}/ics`).set(bearer(e));
    expect(ics.text).toContain('BEGIN:VEVENT');
    expect(ics.text).toContain('SUMMARY:Ward staffing review');
    const av = (await api(app).get(`${B}/meeting-rooms/availability`).query({ date: at(2, 7).slice(0, 10) }).set(bearer(e))).body.find((r: { room_id: string }) => r.room_id === roomId);
    expect(av.busy).toHaveLength(1);
  });

  it('minutes and action items', async () => {
    const app = await testApp();
    const hrm = await login(app, 'hr.manager');
    const [emp] = await db(app).query(`SELECT id FROM user_account WHERE username = 'employee'`);
    expect((await api(app).put(`${B}/meetings/${meetingId}/minutes`).set(bearer(hrm)).send({ minutes: 'Agreed a new night rota.' })).status).toBe(409);
    await db(app).query(`UPDATE meeting SET starts_at = now() - interval '2 hours', ends_at = now() - interval '1 hour' WHERE id = $1`, [meetingId]);
    const mins = await api(app).put(`${B}/meetings/${meetingId}/minutes`).set(bearer(hrm)).send({ minutes: 'Agreed a new night rota.', attended_user_ids: [emp.id] });
    expect(mins.body).toMatchObject({ status: 'held' });
    const act = await api(app).post(`${B}/meetings/${meetingId}/actions`).set(bearer(hrm)).send({ description: 'Draft the December night rota', owner_user_id: emp.id, due_date: at(5, 0).slice(0, 10) });
    expect(act.status).toBe(201);
    const e = await login(app, 'employee');
    const mine = (await api(app).get(`${B}/me/actions`).set(bearer(e))).body.find((x: { meeting_id: string }) => x.meeting_id === meetingId);
    expect(mine).toMatchObject({ status: 'open', meeting_title: 'Ward staffing review' });
    expect((await api(app).put(`${B}/meeting-actions/${mine.id}`).set(bearer(e)).send({ status: 'done' })).body.status).toBe('done');
    expect((await api(app).put(`${B}/meeting-actions/${mine.id}`).set(bearer(await login(app, 'payroll'))).send({ status: 'open' })).status).toBe(404);
  });

  it('the calendar combines leave, holidays, meetings and training; the ICS feed works by secret URL', async () => {
    const app = await testApp();
    const e = await login(app, 'employee');
    const y = new Date().getFullYear();
    const cal = (await api(app).get(`${B}/me/calendar`).query({ from: `${y}-01-01`, to: `${y + 1}-01-31` }).set(bearer(e))).body;
    const kinds = new Set(cal.map((c: { kind: string }) => c.kind));
    expect(kinds.has('holiday')).toBe(true);
    expect(kinds.has('meeting')).toBe(true);
    expect(kinds.has('training')).toBe(true);

    const f1 = await api(app).post(`${B}/me/calendar-feed`).set(bearer(e));
    const path = new URL(f1.body.url).pathname;
    const feed = await api(app).get(path);
    expect(feed.status).toBe(200);
    expect(feed.headers['content-type']).toMatch(/text\/calendar/);
    expect(feed.text).toContain('BEGIN:VCALENDAR');
    const f2 = await api(app).post(`${B}/me/calendar-feed`).set(bearer(e));
    expect((await api(app).get(path)).status).toBe(404);
    expect((await api(app).get(new URL(f2.body.url).pathname)).status).toBe(200);
  });
});

describe('SMS gateway', () => {
  it('normalises Kenyan numbers', () => {
    expect(normalisePhone('0712 345 678')).toBe('+254712345678');
    expect(normalisePhone('254712345678')).toBe('+254712345678');
    expect(normalisePhone('+254 700 100001')).toBe('+254700100001');
    expect(normalisePhone('12')).toBeNull();
  });

  it('templates with the sms channel are queued and sent through Africa’s Talking; failures retry', async () => {
    const app = await testApp();
    await db(app).query(`INSERT INTO setting (key, value) VALUES ('sms.enabled', 'true') ON CONFLICT (key) DO UPDATE SET value = 'true'`);
    const svc = app.get(NotificationsService);
    try {
      await db(app).query(`UPDATE notification_template SET channels = ARRAY['in_app', 'sms'] WHERE code = 'meeting_cancelled'`);
      const [[u]] = await db(app).query(`UPDATE user_account SET phone = '0712 345 678' WHERE username = 'employee' RETURNING id`);
      await db(app).query(`DELETE FROM sms_outbox`);
      await svc.notifyUsers([u.id], 'meeting_cancelled', { title: 'Ward meeting', when: 'Mon 10:00' }, null);
      await db(app).query(`INSERT INTO sms_outbox (phone, body) VALUES ('+254700000999', 'bad number')`);
      const sentNow = await svc.sendPendingSms();
      expect(sentNow).toBe(1);
      const sent = smsCalls.find((c) => new URLSearchParams(c.body).get('to') === '+254712345678')!;
      expect(sent.headers.apikey).toBe('test-sms-key');
      expect(new URLSearchParams(sent.body).get('message')).toContain('Cancelled: Ward meeting');
      const rows = await db(app).query(`SELECT phone, status, attempts, provider_message_id FROM sms_outbox ORDER BY phone`);
      expect(rows).toEqual([expect.objectContaining({ phone: '+254700000999', status: 'pending', attempts: 1 }), expect.objectContaining({ phone: '+254712345678', status: 'sent', provider_message_id: expect.stringMatching(/^ATXid_/) })]);
    } finally {
      await db(app).query(`UPDATE notification_template SET channels = ARRAY['in_app', 'email'] WHERE code = 'meeting_cancelled'`);
      await db(app).query(`UPDATE setting SET value = 'false' WHERE key = 'sms.enabled'`);
      await db(app).query(`DELETE FROM sms_outbox`);
    }
  });
});
