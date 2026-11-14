import { api, bearer, closeApp, db, idOf, login, testApp, uniq } from './helpers';
import { NumberingService } from '../src/modules/numbering/numbering.module';

afterAll(closeApp);

const B = '/api/v1';

describe('audit trail', () => {
  it('records create and update with actor, IP, correlation id and only the changed fields', async () => {
    const app = await testApp();
    const hr = await login(app, 'hr.manager');
    const hrId = await idOf(app, 'user_account', 'username', 'hr.manager');
    const cc = (await api(app).post(`${B}/cost-centres`).set(bearer(hr)).set('X-Correlation-Id', 'audit-test-0001').send({ code: `CC${uniq()}`, name: 'Audited' })).body;
    await api(app).patch(`${B}/cost-centres/${cc.id}`).set(bearer(hr)).set('If-Match', '"1"').send({ name: 'Audited 2' });

    const trail = await api(app).get(`${B}/audit`).query({ entity_type: 'CostCentre', entity_id: cc.id }).set(bearer(hr));
    expect(trail.status).toBe(200);
    const [update, create] = trail.body.data;
    expect(create).toMatchObject({ action: 'create', actor_type: 'user', actor_id: hrId, correlation_id: 'audit-test-0001' });
    expect(create.ip).toBeTruthy();
    expect(update.action).toBe('update');
    expect(update.before).toEqual({ name: 'Audited' });
    expect(update.after).toEqual({ name: 'Audited 2' });
    const [row] = await db(app).query(`SELECT created_by FROM cost_centre WHERE id = $1`, [cc.id]);
    expect(row.created_by).toBe(hrId);
  });

  it('is append-only at the database level', async () => {
    const app = await testApp();
    await expect(db(app).query(`UPDATE audit_log SET action = 'x' WHERE id = (SELECT min(id) FROM audit_log)`)).rejects.toThrow(/append-only/);
    await expect(db(app).query(`DELETE FROM audit_log`)).rejects.toThrow(/append-only/);
    await expect(db(app).query(`TRUNCATE audit_log`)).rejects.toThrow(/append-only/);
  });

  it('writes nothing for a change that rolled back', async () => {
    const app = await testApp();
    const hr = await login(app, 'hr.manager');
    const [{ max: before }] = await db(app).query(`SELECT max(id)::text AS max FROM audit_log`);
    await api(app).post(`${B}/branches`).set(bearer(hr)).send({ code: 'main', name: 'Duplicate branch code' });
    const rows = await db(app).query(`SELECT action, entity_type FROM audit_log WHERE id > $1`, [before]);
    expect(rows.filter((r: { entity_type: string }) => r.entity_type === 'Branch')).toHaveLength(0);
  });

  it('records logins with the user as actor', async () => {
    const app = await testApp();
    await login(app, 'auditor');
    const id = await idOf(app, 'user_account', 'username', 'auditor');
    const [row] = await db(app).query(`SELECT action, actor_id FROM audit_log WHERE entity_type = 'User' AND entity_id = $1 AND action = 'login' ORDER BY id DESC LIMIT 1`, [id]);
    expect(row.actor_id).toBe(id);
  });
});

describe('numbering', () => {
  it('allocates gap-free unique numbers under concurrency, with yearly reset', async () => {
    const app = await testApp();
    const numbering = app.get(NumberingService);
    const numbers = await Promise.all(Array.from({ length: 25 }, () => numbering.next('contract', { date: '2026-03-01' })));
    expect(new Set(numbers).size).toBe(25);
    const seqs = numbers.map((n) => Number(n.split('/')[2])).sort((a, b) => a - b);
    expect(seqs[seqs.length - 1] - seqs[0]).toBe(24);
    expect(numbers[0]).toMatch(/^CON\/2026\/\d{4}$/);
    expect(await numbering.next('contract', { date: '2027-01-02' })).toBe('CON/2027/0001');
  });

  it('does not consume a number when the caller rolls back', async () => {
    const app = await testApp();
    const numbering = app.get(NumberingService);
    const first = await numbering.next('job_requisition', { date: '2026-05-01' });
    await db(app)
      .transaction(async (m) => {
        await numbering.next('job_requisition', { date: '2026-05-01', manager: m });
        throw new Error('rollback');
      })
      .catch(() => undefined);
    const next = await numbering.next('job_requisition', { date: '2026-05-01' });
    expect(Number(next.split('/')[2])).toBe(Number(first.split('/')[2]) + 1);
  });

  it('lets admins change the format, validated', async () => {
    const app = await testApp();
    const admin = await login(app, 'admin');
    const list = (await api(app).get(`${B}/numbering-schemes`).set(bearer(admin))).body;
    const staff = list.find((s: { document_type: string }) => s.document_type === 'staff_number');
    expect(staff.next_preview).toMatch(/^SIL\d{5}$/);
    const bad = await api(app).patch(`${B}/numbering-schemes/${staff.id}`).set(bearer(admin)).set('If-Match', `"${staff.version}"`).send({ format: '{PREFIX}-{NOPE}' });
    expect(bad.status).toBe(422);
  });
});

describe('settings', () => {
  it('exposes public settings without login and validates every change', async () => {
    const app = await testApp();
    const pub = await api(app).get(`${B}/settings/public`);
    expect(pub.body).toMatchObject({ currency: 'KES', timezone: 'Africa/Nairobi', date_format: 'DD/MM/YYYY' });
    const admin = await login(app, 'admin');
    expect((await api(app).put(`${B}/settings/locale.timezone`).set(bearer(admin)).send({ value: 'Mars/Olympus' })).status).toBe(422);
    expect((await api(app).put(`${B}/settings/calendar.working_days`).set(bearer(admin)).send({ value: [1, 2, 3, 4, 5, 6] })).status).toBe(200);
    expect((await api(app).put(`${B}/settings/nope`).set(bearer(admin)).send({ value: 1 })).status).toBe(404);
    const all = (await api(app).get(`${B}/settings`).set(bearer(admin))).body;
    expect(all.find((s: { key: string }) => s.key === 'calendar.working_days').value).toEqual([1, 2, 3, 4, 5, 6]);
    await api(app).put(`${B}/settings/calendar.working_days`).set(bearer(admin)).send({ value: [1, 2, 3, 4, 5] });
  });
});

describe('documents', () => {
  const pdf = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');

  it('stores versions in object storage and hands out short-lived signed links', async () => {
    const app = await testApp();
    const hr = await login(app, 'hr.manager');
    const created = await api(app).post(`${B}/documents`).set(bearer(hr)).field('owner_type', 'policy').field('title', 'Leave policy').attach('file', pdf, { filename: 'leave.pdf', contentType: 'application/pdf' });
    expect(created.status).toBe(201);
    expect(created.body.current_version).toMatchObject({ version_no: 1, mime_type: 'application/pdf', file_name: 'leave.pdf', scan_status: 'not_scanned' });
    const v2 = await api(app).post(`${B}/documents/${created.body.id}/versions`).set(bearer(hr)).attach('file', Buffer.concat([pdf, Buffer.from('% v2')]), { filename: 'leave-v2.pdf', contentType: 'application/pdf' });
    expect(v2.body.current_version.version_no).toBe(2);
    expect(v2.body.versions).toHaveLength(2);

    const link = await api(app).post(`${B}/documents/${created.body.id}/download-url`).set(bearer(hr));
    expect(link.status).toBe(201);
    expect(link.body.url).toContain('X-Amz-Expires=300');
    const download = await fetch(link.body.url);
    expect(download.status).toBe(200);
    expect(Buffer.from(await download.arrayBuffer()).subarray(0, 5).toString()).toBe('%PDF-');
    // The database holds object keys, never public paths.
    const [row] = await db(app).query(`SELECT object_key FROM document_version WHERE document_id = $1 ORDER BY version_no LIMIT 1`, [created.body.id]);
    expect(row.object_key).toMatch(/^documents\//);
  });

  it('checks file content, not the declared type', async () => {
    const app = await testApp();
    const hr = await login(app, 'hr.manager');
    const exe = await api(app).post(`${B}/documents`).set(bearer(hr)).field('owner_type', 'policy').field('title', 'Sneaky').attach('file', Buffer.from('MZ\x90\x00binary'), { filename: 'x.pdf', contentType: 'application/pdf' });
    expect(exe.status).toBe(415);
  });

  it('audits downloads of sensitive documents as sensitive reads', async () => {
    const app = await testApp();
    const hr = await login(app, 'hr.manager');
    const d = (await api(app).post(`${B}/documents`).set(bearer(hr)).field('owner_type', 'medical').field('title', 'Fitness certificate').field('is_sensitive', 'true').attach('file', pdf, { filename: 'fit.pdf', contentType: 'application/pdf' })).body;
    await api(app).post(`${B}/documents/${d.id}/download-url`).set(bearer(hr));
    const [row] = await db(app).query(`SELECT action FROM audit_log WHERE entity_type = 'Document' AND entity_id = $1 ORDER BY id DESC LIMIT 1`, [d.id]);
    expect(row.action).toBe('sensitive_read');
  });
});

describe('operations', () => {
  it('reports liveness and readiness', async () => {
    const app = await testApp();
    expect((await api(app).get(`${B}/health`)).body).toEqual({ status: 'ok' });
    const ready = await api(app).get(`${B}/health/ready`);
    expect(ready.status).toBe(200);
    expect(ready.body.checks).toEqual({ database: 'ok', redis: 'ok', object_storage: 'ok' });
  });

  it('serves metrics only to callers with system:metrics', async () => {
    const app = await testApp();
    expect((await api(app).get(`${B}/metrics`)).status).toBe(403);
    const admin = await login(app, 'admin');
    const res = await api(app).get(`${B}/metrics`).set(bearer(admin));
    expect(res.status).toBe(200);
    expect(res.text).toContain('silhr_http_request_duration_seconds');
  });

  it('echoes a correlation id on every response', async () => {
    const app = await testApp();
    const res = await api(app).get(`${B}/health`).set('X-Correlation-Id', 'my-correlation-123');
    expect(res.headers['x-correlation-id']).toBe('my-correlation-123');
    expect((await api(app).get(`${B}/health`)).headers['x-correlation-id']).toMatch(/^[0-9a-f-]{36}$/);
  });
});
