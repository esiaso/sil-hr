import { authenticator } from 'otplib';
import { api, bearer, closeApp, db, login, PASSWORD, testApp, uniq } from './helpers';

afterAll(closeApp);

async function newUser(roles: { role: string; scope: string }[] = []) {
  const app = await testApp();
  const admin = await login(app, 'admin');
  const roleRows = await db(app).query(`SELECT id, code FROM role`);
  const username = `u.${uniq().toLowerCase()}`;
  const res = await api(app)
    .post('/api/v1/users')
    .set(bearer(admin))
    .send({ username, display_name: 'Test user', password: PASSWORD, roles: roles.map((r) => ({ role_id: roleRows.find((x: { code: string }) => x.code === r.role).id, scope: r.scope })) });
  expect(res.status).toBe(201);
  return { username, id: res.body.id as string, admin };
}

describe('login and tokens', () => {
  it('logs in, returns /me with permissions, and rejects a wrong password with a problem document', async () => {
    const app = await testApp();
    const token = await login(app, 'hr.manager');
    const me = await api(app).get('/api/v1/auth/me').set(bearer(token));
    expect(me.status).toBe(200);
    expect(me.body.username).toBe('hr.manager');
    expect(me.body.permissions).toContain('department:manage');
    expect(me.body.roles[0]).toMatchObject({ code: 'hr_manager', scope: 'organisation' });

    const bad = await api(app).post('/api/v1/auth/login').send({ username: 'hr.manager', password: 'nope' });
    expect(bad.status).toBe(401);
    expect(bad.headers['content-type']).toContain('application/problem+json');
    expect(bad.body).toMatchObject({ status: 401, code: 'invalid_credentials', type: 'urn:sil:hr:problem:invalid_credentials' });
    expect(bad.body.correlation_id).toBeTruthy();
  });

  it('locks the account after the configured number of failures', async () => {
    const app = await testApp();
    const { username } = await newUser([{ role: 'employee', scope: 'own' }]);
    for (let i = 0; i < 5; i++) await api(app).post('/api/v1/auth/login').send({ username, password: 'wrong' });
    const locked = await api(app).post('/api/v1/auth/login').send({ username, password: PASSWORD });
    expect(locked.status).toBe(423);
    expect(locked.body.code).toBe('account_locked');
    const history = await db(app).query(`SELECT outcome FROM login_history WHERE username = $1 ORDER BY occurred_at`, [username]);
    expect(history.map((h: { outcome: string }) => h.outcome)).toEqual([...Array(5).fill('bad_credentials'), 'locked']);
  });

  it('forces a password change before anything else for new accounts', async () => {
    const app = await testApp();
    const { username } = await newUser([{ role: 'hr_manager', scope: 'organisation' }]);
    const res = await api(app).post('/api/v1/auth/login').send({ username, password: PASSWORD });
    expect(res.body.must_change_password).toBe(true);
    const token = res.body.access_token;
    expect((await api(app).get('/api/v1/departments').set(bearer(token))).body.code).toBe('password_change_required');
    expect((await api(app).get('/api/v1/auth/me').set(bearer(token))).status).toBe(200);
    const weak = await api(app).post('/api/v1/auth/password').set(bearer(token)).send({ current_password: PASSWORD, new_password: 'short' });
    expect(weak.status).toBe(422);
    expect(weak.body.code).toBe('weak_password');
    const ok = await api(app).post('/api/v1/auth/password').set(bearer(token)).send({ current_password: PASSWORD, new_password: 'Another#Pass2026' });
    expect(ok.status).toBe(204);
    expect((await api(app).get('/api/v1/departments').set(bearer(token))).status).toBe(200);
  });

  it('rotates refresh tokens and revokes the whole session when a used one is replayed', async () => {
    const app = await testApp();
    const first = await api(app).post('/api/v1/auth/login').send({ username: 'payroll', password: PASSWORD });
    const r1 = first.body.refresh_token;
    const second = await api(app).post('/api/v1/auth/refresh').send({ refresh_token: r1 });
    expect(second.status).toBe(200);
    expect(second.body.refresh_token).not.toBe(r1);

    // Replaying the used token is treated as theft: the family is revoked.
    const replay = await api(app).post('/api/v1/auth/refresh').send({ refresh_token: r1 });
    expect(replay.body.code).toBe('refresh_token_reused');
    expect((await api(app).post('/api/v1/auth/refresh').send({ refresh_token: second.body.refresh_token })).status).toBe(401);
    // …and access tokens from that login stop working at once.
    expect((await api(app).get('/api/v1/organisation').set(bearer(second.body.access_token))).body.code).toBe('session_revoked');
  });

  it('logout ends the session for the access token too', async () => {
    const app = await testApp();
    const token = await login(app, 'finance');
    expect((await api(app).post('/api/v1/auth/logout').set(bearer(token)).send({})).status).toBe(204);
    expect((await api(app).get('/api/v1/organisation').set(bearer(token))).status).toBe(401);
  });

  it('disabling a user stops their existing token immediately', async () => {
    const app = await testApp();
    const { username, id, admin } = await newUser([{ role: 'auditor', scope: 'organisation' }]);
    await db(app).query(`UPDATE user_account SET must_change_password = false WHERE id = $1`, [id]);
    const token = await login(app, username);
    const user = await api(app).get(`/api/v1/users/${id}`).set(bearer(admin));
    const res = await api(app).patch(`/api/v1/users/${id}`).set(bearer(admin)).set('If-Match', user.headers.etag).send({ status: 'disabled' });
    expect(res.status).toBe(200);
    expect((await api(app).get('/api/v1/organisation').set(bearer(token))).body.code).toBe('account_disabled');
  });

  it('enrols TOTP, then requires the second factor; recovery codes work once', async () => {
    const app = await testApp();
    const { username, id } = await newUser([{ role: 'auditor', scope: 'organisation' }]);
    await db(app).query(`UPDATE user_account SET must_change_password = false WHERE id = $1`, [id]);
    const token = await login(app, username);
    const enrol = await api(app).post('/api/v1/auth/mfa/enrol').set(bearer(token));
    expect(enrol.status).toBe(201);
    expect(enrol.body.qr_data_url).toMatch(/^data:image\/png;base64,/);
    const confirm = await api(app).post('/api/v1/auth/mfa/confirm').set(bearer(token)).send({ code: authenticator.generate(enrol.body.secret) });
    expect(confirm.status).toBe(200);
    expect(confirm.body.recovery_codes).toHaveLength(10);

    const step1 = await api(app).post('/api/v1/auth/login').send({ username, password: PASSWORD });
    expect(step1.body).toMatchObject({ mfa_required: true });
    expect(step1.body.access_token).toBeUndefined();
    const wrong = await api(app).post('/api/v1/auth/mfa/verify').send({ mfa_token: step1.body.mfa_token, code: '000000' });
    expect(wrong.status).toBe(401);
    const ok = await api(app).post('/api/v1/auth/mfa/verify').send({ mfa_token: step1.body.mfa_token, code: authenticator.generate(enrol.body.secret) });
    expect(ok.status).toBe(200);
    expect(ok.body.access_token).toBeTruthy();

    const recovery = confirm.body.recovery_codes[0];
    const viaRecovery = await api(app).post('/api/v1/auth/mfa/verify').send({ mfa_token: step1.body.mfa_token, code: recovery });
    expect(viaRecovery.status).toBe(200);
    const again = await api(app).post('/api/v1/auth/mfa/verify').send({ mfa_token: step1.body.mfa_token, code: recovery });
    expect(again.status).toBe(401);
    // The MFA token alone is not an access token.
    expect((await api(app).get('/api/v1/organisation').set(bearer(step1.body.mfa_token))).status).toBe(401);
  });

  it('never writes the TOTP secret or password hash to the audit trail in clear', async () => {
    const app = await testApp();
    const rows = await db(app).query(`SELECT after FROM audit_log WHERE entity_type = 'User' AND (after ? 'passwordHash' OR after ? 'mfaSecretEnc')`);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      for (const k of ['passwordHash', 'mfaSecretEnc']) if (r.after[k] !== undefined && r.after[k] !== null) expect(r.after[k]).toBe('[REDACTED]');
    }
  });
});

describe('IP allow-list', () => {
  it('blocks logins from outside the allowed networks when enabled', async () => {
    const app = await testApp();
    const admin = await login(app, 'admin');
    const rule = await api(app).post('/api/v1/ip-allow-rules').set(bearer(admin)).send({ cidr: '10.99.0.0/16', applies_to: 'all' });
    expect(rule.status).toBe(201);
    await api(app).put('/api/v1/settings/security.ip_allow_list_enabled').set(bearer(admin)).send({ value: true });
    try {
      const res = await api(app).post('/api/v1/auth/login').send({ username: 'recruiter', password: PASSWORD });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('ip_not_allowed');
    } finally {
      await api(app).put('/api/v1/settings/security.ip_allow_list_enabled').set(bearer(admin)).send({ value: false });
      await api(app).delete(`/api/v1/ip-allow-rules/${rule.body.id}`).set(bearer(admin));
    }
    expect((await api(app).post('/api/v1/auth/login').send({ username: 'recruiter', password: PASSWORD })).status).toBe(200);
  });
});
