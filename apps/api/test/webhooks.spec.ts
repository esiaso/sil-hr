import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import Redis from 'ioredis';
import { api, bearer, closeApp, db, idOf, login, testApp, uniq } from './helpers';
import { OutboxPublisher, WebhookDeliveryProcessor } from '../src/modules/webhooks/publishing';
import { backoffSeconds, verify } from '../src/modules/webhooks/signing';

afterAll(closeApp);

const B = '/api/v1';

interface Received {
  headers: IncomingHttpHeaders;
  body: string;
}

/** A local receiver whose response status the test controls. */
function receiver(): Promise<{ url: string; received: Received[]; respondWith: (s: number) => void; close: () => Promise<void> }> {
  const received: Received[] = [];
  let status = 200;
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push({ headers: req.headers, body });
      res.writeHead(status).end(status === 200 ? 'ok' : 'nope');
    });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({
        url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/hooks`,
        received,
        respondWith: (s) => (status = s),
        close: () => new Promise((r) => server.close(() => r())),
      }),
    ),
  );
}

async function drain() {
  const app = await testApp();
  await app.get(OutboxPublisher).drainOnce(1000);
  await app.get(WebhookDeliveryProcessor).processDue(100);
}

describe('outbox → signed webhook', () => {
  it('delivers a department change as a signed CloudEvent that a consumer can verify', async () => {
    const app = await testApp();
    const admin = await login(app, 'admin');
    const sink = await receiver();
    try {
      await drain(); // flush anything earlier tests left
      const sub = await api(app).post(`${B}/webhooks/subscriptions`).set(bearer(admin)).send({ name: 'Procurement sync', url: sink.url, event_types: ['hr.organisation.department.created.v1'] });
      expect(sub.status).toBe(201);
      expect(sub.body.secret).toMatch(/^whsec_/);
      const secret = sub.body.secret as string;

      const main = await idOf(app, 'branch', 'code', 'MAIN');
      const code = `T${uniq()}`;
      const hr = await login(app, 'hr.manager');
      const dep = await api(app).post(`${B}/departments`).set(bearer(hr)).set('X-Correlation-Id', 'test-correlation-0001').send({ code, name: 'Webhook test', branch_id: main });
      expect(dep.status).toBe(201);
      await drain();

      const mine = sink.received.filter((r) => JSON.parse(r.body).subject === dep.body.id);
      expect(mine).toHaveLength(1);
      const [{ headers, body }] = mine;
      expect(verify(secret, { id: String(headers['webhook-id']), timestamp: String(headers['webhook-timestamp']), signature: String(headers['webhook-signature']) }, body)).toBe(true);
      expect(verify('whsec_' + Buffer.from('wrong').toString('base64'), { id: String(headers['webhook-id']), timestamp: String(headers['webhook-timestamp']), signature: String(headers['webhook-signature']) }, body)).toBe(false);
      const event = JSON.parse(body);
      expect(event).toMatchObject({
        specversion: '1.0',
        type: 'hr.organisation.department.created.v1',
        source: 'urn:sil:hr',
        subject: dep.body.id,
        datacontenttype: 'application/json',
        correlationid: 'test-correlation-0001',
        data: { id: dep.body.id, code, branch_id: main, status: 'active' },
      });
      // Events carry no audit or personal fields.
      expect(Object.keys(event.data).sort()).toEqual(['branch_id', 'code', 'cost_centre_id', 'id', 'name', 'parent_id', 'path', 'status']);

      const log = await api(app).get(`${B}/webhooks/subscriptions/${sub.body.subscription.id}/deliveries`).set(bearer(admin));
      expect(log.body.data[0]).toMatchObject({ status: 'delivered', attempt_count: 1, last_status_code: 200 });
    } finally {
      await sink.close();
    }
  });

  it('publishes to the Redis Stream too', async () => {
    const app = await testApp();
    const hr = await login(app, 'hr.manager');
    const redis = new Redis(process.env.REDIS_URL!);
    try {
      const cc = await api(app).post(`${B}/cost-centres`).set(bearer(hr)).send({ code: `CC${uniq()}`, name: 'Stream test' });
      await drain();
      const entries = await redis.xrevrange('silhr:events', '+', '-', 'COUNT', 50);
      const found = entries.map(([, fields]) => JSON.parse(fields[fields.indexOf('event') + 1])).find((e) => e.subject === cc.body.id);
      expect(found?.type).toBe('hr.organisation.cost_centre.created.v1');
    } finally {
      await redis.quit();
    }
  });

  it('emits no event when the change rolls back', async () => {
    const app = await testApp();
    const hr = await login(app, 'hr.manager');
    const [{ max: before }] = await db(app).query(`SELECT coalesce(max(id), 0)::text AS max FROM outbox_event`);
    const dup = await api(app).post(`${B}/departments`).set(bearer(hr)).send({ code: 'NURS', name: 'Duplicate', branch_id: await idOf(app, 'branch', 'code', 'MAIN') });
    expect(dup.status).toBe(409);
    const [{ max: after }] = await db(app).query(`SELECT coalesce(max(id), 0)::text AS max FROM outbox_event`);
    expect(after).toBe(before);
  });

  it('retries with backoff, dead-letters after the last attempt, pauses the subscription and notifies admins; replay recovers', async () => {
    const app = await testApp();
    const admin = await login(app, 'admin');
    const sink = await receiver();
    sink.respondWith(500);
    await api(app).put(`${B}/settings/webhooks.max_attempts`).set(bearer(admin)).send({ value: 2 });
    await api(app).put(`${B}/settings/webhooks.pause_after_dead_letters`).set(bearer(admin)).send({ value: 1 });
    try {
      await drain();
      const sub = (await api(app).post(`${B}/webhooks/subscriptions`).set(bearer(admin)).send({ name: `Flaky ${uniq()}`, url: sink.url, event_types: ['hr.organisation.cost_centre.created.v1'] })).body;
      const subId = sub.subscription.id;
      await api(app).post(`${B}/cost-centres`).set(bearer(admin)).send({ code: `CC${uniq()}`, name: 'Retry test' });
      await drain();

      let [d] = await db(app).query(`SELECT * FROM webhook_delivery WHERE subscription_id = $1`, [subId]);
      expect(d.status).toBe('retrying');
      expect(d.attempt_count).toBe(1);
      expect(d.last_status_code).toBe(500);
      expect(new Date(d.next_attempt_at).getTime()).toBeGreaterThan(Date.now() + 20_000);

      await db(app).query(`UPDATE webhook_delivery SET next_attempt_at = now() WHERE id = $1`, [d.id]);
      await drain();
      [d] = await db(app).query(`SELECT * FROM webhook_delivery WHERE id = $1`, [d.id]);
      expect(d.status).toBe('dead_lettered');
      const s = (await api(app).get(`${B}/webhooks/subscriptions/${subId}`).set(bearer(admin))).body;
      expect(s.status).toBe('paused');
      expect(s.paused_reason).toContain('Paused automatically');
      const notes = await api(app).get(`${B}/notifications`).set(bearer(admin));
      expect(notes.body.some((n: { title: string }) => n.title.includes(sub.subscription.name))).toBe(true);
      const [{ n: mails }] = await db(app).query(`SELECT count(*)::int AS n FROM email_outbox WHERE subject LIKE $1`, [`%${sub.subscription.name}%`]);
      expect(mails).toBeGreaterThan(0);

      const detail = await api(app).get(`${B}/webhooks/deliveries/${d.id}`).set(bearer(admin));
      expect(detail.body.attempts).toHaveLength(2);

      // Receiver fixed: resume, replay, delivered.
      sink.respondWith(200);
      await api(app).patch(`${B}/webhooks/subscriptions/${subId}`).set(bearer(admin)).set('If-Match', `"${s.version}"`).send({ status: 'active' });
      const replay = await api(app).post(`${B}/webhooks/deliveries/${d.id}/replay`).set(bearer(admin));
      expect(replay.status).toBe(202);
      await drain();
      [d] = await db(app).query(`SELECT * FROM webhook_delivery WHERE id = $1`, [d.id]);
      expect(d.status).toBe('delivered');
      // The same webhook-id is used on every attempt so consumers can de-duplicate.
      const ids = new Set(sink.received.map((r) => r.headers['webhook-id']));
      expect(ids.has(d.id)).toBe(true);
    } finally {
      await api(app).put(`${B}/settings/webhooks.max_attempts`).set(bearer(admin)).send({ value: 8 });
      await api(app).put(`${B}/settings/webhooks.pause_after_dead_letters`).set(bearer(admin)).send({ value: 5 });
      await sink.close();
    }
  });

  it('sends a test event only to the chosen subscription', async () => {
    const app = await testApp();
    const admin = await login(app, 'admin');
    const sink = await receiver();
    try {
      await drain();
      const sub = (await api(app).post(`${B}/webhooks/subscriptions`).set(bearer(admin)).send({ name: 'Tester', url: sink.url, event_types: ['hr.organisation.branch.updated.v1'] })).body;
      expect((await api(app).post(`${B}/webhooks/subscriptions/${sub.subscription.id}/test`).set(bearer(admin))).status).toBe(202);
      await drain();
      expect(sink.received.map((r) => JSON.parse(r.body).type)).toEqual(['hr.webhook.test.v1']);
    } finally {
      await sink.close();
    }
  });

  it('rejects subscriptions to unknown event types', async () => {
    const app = await testApp();
    const admin = await login(app, 'admin');
    const res = await api(app).post(`${B}/webhooks/subscriptions`).set(bearer(admin)).send({ name: 'Bad', url: 'https://example.org/h', event_types: ['hr.nope.v1'] });
    expect(res.body.code).toBe('unknown_event_type');
  });

  it('backs off over roughly a day', () => {
    const total = Array.from({ length: 7 }, (_, i) => backoffSeconds(i + 1, 0.5)).reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThan(8 * 3600);
    expect(total).toBeLessThan(30 * 3600);
  });
});
