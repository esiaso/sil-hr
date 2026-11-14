import { api, bearer, closeApp, db, idOf, login, testApp, uniq } from './helpers';

afterAll(closeApp);

const B = '/api/v1';

describe('organisation structure and API conventions', () => {
  it('creates a department, returns an ETag, and requires If-Match to change it', async () => {
    const app = await testApp();
    const token = await login(app, 'hr.manager');
    const main = await idOf(app, 'branch', 'code', 'MAIN');
    const code = `T${uniq()}`;
    const created = await api(app).post(`${B}/departments`).set(bearer(token)).send({ code, name: 'Physiotherapy', branch_id: main });
    expect(created.status).toBe(201);
    expect(created.headers.etag).toBe('"1"');
    expect(created.body).toMatchObject({ code, name: 'Physiotherapy', branch_id: main, parent_id: null, path: [], depth: 0, status: 'active' });
    // UUID v7: version nibble 7, variant 10xx.
    expect(created.body.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

    const id = created.body.id;
    const noIfMatch = await api(app).patch(`${B}/departments/${id}`).set(bearer(token)).send({ name: 'Physio' });
    expect(noIfMatch.status).toBe(428);
    const ok = await api(app).patch(`${B}/departments/${id}`).set(bearer(token)).set('If-Match', '"1"').send({ name: 'Physio' });
    expect(ok.status).toBe(200);
    expect(ok.headers.etag).toBe('"2"');
    const stale = await api(app).patch(`${B}/departments/${id}`).set(bearer(token)).set('If-Match', '"1"').send({ name: 'Physio 2' });
    expect(stale.status).toBe(412);
    expect(stale.body.code).toBe('version_mismatch');

    const notModified = await api(app).get(`${B}/departments/${id}`).set(bearer(token)).set('If-None-Match', '"2"');
    expect(notModified.status).toBe(304);
  });

  it('validates input with field-level problem details, and maps duplicates to 409', async () => {
    const app = await testApp();
    const token = await login(app, 'hr.manager');
    const bad = await api(app).post(`${B}/departments`).set(bearer(token)).send({ code: 'has space', name: '' });
    expect(bad.status).toBe(422);
    expect(bad.body.code).toBe('validation_failed');
    expect(bad.body.errors.map((e: { path: string }) => e.path)).toEqual(expect.arrayContaining(['code', 'name', 'branch_id']));
    const extra = await api(app).get(`${B}/departments?limit=9999`).set(bearer(token));
    expect(extra.status).toBe(422);

    const dup = await api(app).post(`${B}/departments`).set(bearer(token)).send({ code: 'nurs', name: 'Dup', branch_id: await idOf(app, 'branch', 'code', 'MAIN') });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('duplicate');
  });

  it('pages with cursors and never repeats or skips a row', async () => {
    const app = await testApp();
    const token = await login(app, 'auditor');
    const all: string[] = [];
    let cursor: string | null = null;
    do {
      const res: { status: number; body: { data: { code: string }[]; next_cursor: string | null } } = await api(app)
        .get(`${B}/departments`)
        .query({ limit: 4, sort: 'code', ...(cursor ? { cursor } : {}) })
        .set(bearer(token));
      expect(res.status).toBe(200);
      all.push(...res.body.data.map((d) => d.code));
      cursor = res.body.next_cursor;
    } while (cursor);
    const [{ n }] = await db(app).query(`SELECT count(*)::int AS n FROM department WHERE deleted_at IS NULL`);
    expect(all).toHaveLength(n);
    expect(new Set(all).size).toBe(n);
    expect([...all].sort()).toEqual(all);
    expect((await api(app).get(`${B}/departments?cursor=garbage`).set(bearer(token))).body.code).toBe('invalid_cursor');
    expect((await api(app).get(`${B}/departments?sort=password`).set(bearer(token))).body.code).toBe('invalid_sort');
  });

  it('updated_since returns changes in order, including deletions as tombstones', async () => {
    const app = await testApp();
    const token = await login(app, 'hr.manager');
    const since = new Date(Date.now() - 1000).toISOString();
    const main = await idOf(app, 'branch', 'code', 'MAIN');
    const d = (await api(app).post(`${B}/departments`).set(bearer(token)).send({ code: `T${uniq()}`, name: 'Short-lived', branch_id: main })).body;
    const del = await api(app).delete(`${B}/departments/${d.id}`).set(bearer(token)).set('If-Match', '"1"');
    expect(del.status).toBe(204);
    expect((await api(app).get(`${B}/departments/${d.id}`).set(bearer(token))).status).toBe(404);

    const sync = await api(app).get(`${B}/departments`).query({ updated_since: since }).set(bearer(token));
    const row = sync.body.data.find((x: { id: string }) => x.id === d.id);
    expect(row).toEqual({ id: d.id, deleted: true, deleted_at: expect.any(String) });
    // Normal lists hide deleted rows.
    const list = await api(app).get(`${B}/departments`).query({ search: d.code }).set(bearer(token));
    expect(list.body.data).toHaveLength(0);
  });

  it('moves a department with its whole subtree and rejects cycles', async () => {
    const app = await testApp();
    const token = await login(app, 'hr.manager');
    const main = await idOf(app, 'branch', 'code', 'MAIN');
    const mk = async (name: string, parent?: string) =>
      (await api(app).post(`${B}/departments`).set(bearer(token)).send({ code: `T${uniq()}`, name, branch_id: main, parent_id: parent })).body;
    const a = await mk('A');
    const b = await mk('B', a.id);
    const c = await mk('C', b.id);
    expect(c.path).toEqual([a.id, b.id]);
    const x = await mk('X');

    const cycle = await api(app).patch(`${B}/departments/${a.id}`).set(bearer(token)).set('If-Match', '"1"').send({ parent_id: c.id });
    expect(cycle.status).toBe(422);
    expect(cycle.body.code).toBe('cycle');

    const moved = await api(app).patch(`${B}/departments/${b.id}`).set(bearer(token)).set('If-Match', '"1"').send({ parent_id: x.id });
    expect(moved.status).toBe(200);
    expect(moved.body.path).toEqual([x.id]);
    const cAfter = (await api(app).get(`${B}/departments/${c.id}`).set(bearer(token))).body;
    expect(cAfter.path).toEqual([x.id, b.id]);

    const tree = (await api(app).get(`${B}/departments/tree`).set(bearer(token))).body;
    const xNode = tree.find((n: { id: string }) => n.id === x.id);
    expect(xNode.children[0].id).toBe(b.id);
    expect(xNode.children[0].children[0].id).toBe(c.id);

    const events = await db(app).query(`SELECT type, data FROM outbox_event WHERE subject = $1 ORDER BY id`, [c.id]);
    expect(events.map((e: { type: string }) => e.type)).toEqual(['hr.organisation.department.created.v1', 'hr.organisation.department.updated.v1']);
    expect(events[1].data.changed_fields).toContain('path');
  });

  it('replays a POST with the same Idempotency-Key and refuses a different body', async () => {
    const app = await testApp();
    const token = await login(app, 'hr.manager');
    const key = `test-${uniq()}-${uniq()}`;
    const body = { code: `CC${uniq()}`, name: 'Idempotent cost centre' };
    const first = await api(app).post(`${B}/cost-centres`).set(bearer(token)).set('Idempotency-Key', key).send(body);
    const second = await api(app).post(`${B}/cost-centres`).set(bearer(token)).set('Idempotency-Key', key).send(body);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(second.body.id).toBe(first.body.id);
    const [{ n }] = await db(app).query(`SELECT count(*)::int AS n FROM cost_centre WHERE code = $1`, [body.code]);
    expect(n).toBe(1);
    const different = await api(app).post(`${B}/cost-centres`).set(bearer(token)).set('Idempotency-Key', key).send({ ...body, name: 'Other' });
    expect(different.status).toBe(422);
    expect(different.body.code).toBe('idempotency_key_reused');
  });

  it('checks position reporting lines for cycles', async () => {
    const app = await testApp();
    const token = await login(app, 'hr.manager');
    const dep = await idOf(app, 'department', 'code', 'ICT');
    const p1 = (await api(app).post(`${B}/positions`).set(bearer(token)).send({ code: `P${uniq()}`, title: 'Lead', department_id: dep })).body;
    const p2 = (await api(app).post(`${B}/positions`).set(bearer(token)).send({ code: `P${uniq()}`, title: 'Member', department_id: dep, reports_to_position_id: p1.id, headcount: 3 })).body;
    expect(p2.headcount).toBe(3);
    const cyc = await api(app).patch(`${B}/positions/${p1.id}`).set(bearer(token)).set('If-Match', '"1"').send({ reports_to_position_id: p2.id });
    expect(cyc.body.code).toBe('cycle');
    // PATCH without headcount leaves it alone (no default re-applied).
    const patched = await api(app).patch(`${B}/positions/${p2.id}`).set(bearer(token)).set('If-Match', '"1"').send({ title: 'Engineer' });
    expect(patched.body.headcount).toBe(3);
  });
});

describe('data scopes', () => {
  it('limits a branch-scoped HR officer to their branch', async () => {
    const app = await testApp();
    const officer = await login(app, 'hr.officer'); // hr_officer scoped to MAIN
    const main = await idOf(app, 'branch', 'code', 'MAIN');
    const sat = await idOf(app, 'branch', 'code', 'SAT');
    const inMain = await api(app).post(`${B}/departments`).set(bearer(officer)).send({ code: `T${uniq()}`, name: 'Main unit', branch_id: main });
    expect(inMain.status).toBe(201);
    const inSat = await api(app).post(`${B}/departments`).set(bearer(officer)).send({ code: `T${uniq()}`, name: 'Satellite unit', branch_id: sat });
    expect(inSat.status).toBe(403);
    expect(inSat.body.code).toBe('out_of_scope');
    const satDept = await idOf(app, 'department', 'code', 'SAT-LAB');
    const edit = await api(app).patch(`${B}/departments/${satDept}`).set(bearer(officer)).set('If-Match', '"1"').send({ name: 'Renamed' });
    expect(edit.status).toBe(403);
    // Moving a MAIN department into SAT is also out of scope.
    const move = await api(app).patch(`${B}/departments/${inMain.body.id}`).set(bearer(officer)).set('If-Match', '"1"').send({ branch_id: sat });
    expect(move.status).toBe(403);
  });

  it('limits a department-scoped grant to that department and its descendants', async () => {
    const app = await testApp();
    const admin = await login(app, 'admin');
    const roleId = await idOf(app, 'role', 'code', 'hr_officer');
    const nursing = await idOf(app, 'department', 'code', 'NURS');
    const username = `nurse.hr.${uniq().toLowerCase()}`;
    const u = await api(app).post(`${B}/users`).set(bearer(admin)).send({ username, display_name: 'Nursing HR', password: 'Test#Password2026', roles: [{ role_id: roleId, scope: 'department', department_id: nursing }] });
    expect(u.status).toBe(201);
    await db(app).query(`UPDATE user_account SET must_change_password = false WHERE id = $1`, [u.body.id]);
    const token = await login(app, username);
    const medw = await idOf(app, 'department', 'code', 'MEDW');
    const lab = await idOf(app, 'department', 'code', 'LAB');
    const main = await idOf(app, 'branch', 'code', 'MAIN');
    expect((await api(app).post(`${B}/departments`).set(bearer(token)).send({ code: `T${uniq()}`, name: 'Ward annex', branch_id: main, parent_id: medw })).status).toBe(201);
    expect((await api(app).post(`${B}/departments`).set(bearer(token)).send({ code: `T${uniq()}`, name: 'Lab annex', branch_id: main, parent_id: lab })).status).toBe(403);
    expect((await api(app).post(`${B}/departments`).set(bearer(token)).send({ code: `T${uniq()}`, name: 'Top level', branch_id: main })).status).toBe(403);
  });

  it('refuses callers without the permission with a 403 naming it', async () => {
    const app = await testApp();
    const employee = await login(app, 'employee');
    const res = await api(app).post(`${B}/branches`).set(bearer(employee)).send({ code: 'NOPE', name: 'Nope' });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'missing_permission', missing_permissions: ['branch:manage'] });
    expect((await api(app).get(`${B}/departments`)).status).toBe(401);
  });
});
