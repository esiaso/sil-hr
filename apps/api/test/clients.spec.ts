import { api, bearer, closeApp, db, idOf, login, testApp, uniq } from './helpers';

afterAll(closeApp);

const B = '/api/v1';
const basic = (id: string, secret: string) => `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`;

async function newClient(scopes: string[]) {
  const app = await testApp();
  const admin = await login(app, 'admin');
  const res = await api(app).post(`${B}/api-clients`).set(bearer(admin)).send({ name: `Procurement ${uniq()}`, scopes });
  expect(res.status).toBe(201);
  return { admin, id: res.body.client.id as string, clientId: res.body.client.client_id as string, secret: res.body.client_secret as string };
}

async function token(clientId: string, secret: string, scope?: string) {
  const app = await testApp();
  return api(app).post(`${B}/oauth/token`).set('Authorization', basic(clientId, secret)).type('form').send({ grant_type: 'client_credentials', ...(scope ? { scope } : {}) });
}

describe('machine clients (OAuth 2.0 client credentials)', () => {
  it('issues a short-lived token carrying the granted scopes, usable on scoped endpoints only', async () => {
    const app = await testApp();
    const c = await newClient(['org:read']);
    const t = await token(c.clientId, c.secret);
    expect(t.status).toBe(200);
    expect(t.body).toMatchObject({ token_type: 'Bearer', expires_in: 900, scope: 'org:read' });
    const access = t.body.access_token;

    expect((await api(app).get(`${B}/departments`).set(bearer(access))).status).toBe(200);
    expect((await api(app).get(`${B}/departments/tree`).set(bearer(access))).status).toBe(200);
    const write = await api(app).post(`${B}/branches`).set(bearer(access)).send({ code: 'NO', name: 'No' });
    expect(write.status).toBe(403);
    expect((await api(app).get(`${B}/users`).set(bearer(access))).status).toBe(403);
    expect((await api(app).get(`${B}/auth/me`).set(bearer(access))).body.code).toBe('users_only');

    // Calls are audited against the client, and last-used is recorded.
    const audit = await db(app).query(`SELECT actor_type, action FROM audit_log WHERE actor_id = $1 ORDER BY id DESC LIMIT 1`, [c.id]);
    expect(audit[0]).toEqual({ actor_type: 'client', action: 'token_issued' });
    const [row] = await db(app).query(`SELECT last_used_at FROM api_client WHERE id = $1`, [c.id]);
    expect(row.last_used_at).not.toBeNull();
  });

  it('rejects wrong secrets, unknown scopes and unsupported grants', async () => {
    const c = await newClient(['org:read']);
    const wrong = await token(c.clientId, 'hrs_wrong');
    expect(wrong.status).toBe(401);
    expect(wrong.body.error).toBe('invalid_client');
    const scope = await token(c.clientId, c.secret, 'org:read employees.sensitive:read');
    expect(scope.status).toBe(400);
    expect(scope.body.error).toBe('invalid_scope');
    const app = await testApp();
    const grant = await api(app).post(`${B}/oauth/token`).type('form').send({ grant_type: 'password', client_id: c.clientId, client_secret: c.secret });
    expect(grant.body.error).toBe('unsupported_grant_type');
  });

  it('accepts credentials in the form body as well as HTTP Basic', async () => {
    const app = await testApp();
    const c = await newClient(['events:read']);
    const res = await api(app).post(`${B}/oauth/token`).type('form').send({ grant_type: 'client_credentials', client_id: c.clientId, client_secret: c.secret });
    expect(res.status).toBe(200);
  });

  it('rotates secrets with a grace period, revokes them, and disabling the client stops its tokens', async () => {
    const app = await testApp();
    const c = await newClient(['org:read']);
    const rotated = await api(app).post(`${B}/api-clients/${c.id}/secrets`).set(bearer(c.admin)).send({ previous_secret_grace_hours: 1 });
    expect(rotated.status).toBe(201);
    expect((await token(c.clientId, c.secret)).status).toBe(200); // old one still in grace
    expect((await token(c.clientId, rotated.body.client_secret)).status).toBe(200);

    const detail = await api(app).get(`${B}/api-clients/${c.id}`).set(bearer(c.admin));
    const old = detail.body.secrets.find((s: { id: string }) => s.id !== rotated.body.secret_id);
    expect(old.expires_at).not.toBeNull();
    expect((await api(app).delete(`${B}/api-clients/${c.id}/secrets/${old.id}`).set(bearer(c.admin))).status).toBe(204);
    expect((await token(c.clientId, c.secret)).status).toBe(401);

    const live = (await token(c.clientId, rotated.body.client_secret)).body.access_token;
    await api(app).patch(`${B}/api-clients/${c.id}`).set(bearer(c.admin)).set('If-Match', detail.headers.etag).send({ is_active: false });
    expect((await api(app).get(`${B}/departments`).set(bearer(live))).body.code).toBe('client_disabled');
  });

  it('removing a scope from a client takes effect on tokens already issued', async () => {
    const app = await testApp();
    const c = await newClient(['org:read', 'events:read']);
    const live = (await token(c.clientId, c.secret)).body.access_token;
    const detail = await api(app).get(`${B}/api-clients/${c.id}`).set(bearer(c.admin));
    await api(app).patch(`${B}/api-clients/${c.id}`).set(bearer(c.admin)).set('If-Match', detail.headers.etag).send({ scopes: ['events:read'] });
    expect((await api(app).get(`${B}/departments`).set(bearer(live))).status).toBe(403);
  });

  it('lets a client map its own identifiers through external refs', async () => {
    const app = await testApp();
    const c = await newClient(['external_refs:write']);
    const access = (await token(c.clientId, c.secret)).body.access_token;
    const nurs = await idOf(app, 'department', 'code', 'NURS');
    const put = await api(app).put(`${B}/external-refs`).set(bearer(access)).send({ entity_type: 'department', entity_id: nurs, system: 'procurement', external_id: 'DEPT-0007' });
    expect(put.status).toBe(200);
    const found = await api(app).get(`${B}/external-refs`).query({ system: 'procurement', external_id: 'DEPT-0007' }).set(bearer(access));
    expect(found.body.data[0].entity_id).toBe(nurs);
  });

  it('publishes its verification keys as a JWKS', async () => {
    const app = await testApp();
    const jwks = await api(app).get(`${B}/.well-known/jwks.json`);
    expect(jwks.body.keys[0]).toMatchObject({ kty: 'OKP', crv: 'Ed25519', alg: 'EdDSA', use: 'sig' });
  });
});
