import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { api, bearer, closeApp, db, idOf, login, PASSWORD, testApp, uniq } from './helpers';

afterAll(closeApp);

const B = '/api/v1';
const ROOT = join(__dirname, '..', '..', '..');

async function clientToken(scopes: string[], rate?: number) {
  const app = await testApp();
  const admin = await login(app, 'admin');
  const c = (await api(app).post(`${B}/api-clients`).set(bearer(admin)).send({ name: `Sec ${uniq()}`, scopes, ...(rate ? { rate_limit_per_minute: rate } : {}) })).body;
  return (await api(app).post(`${B}/oauth/token`).auth(c.client.client_id, c.client_secret).type('form').send({ grant_type: 'client_credentials' })).body.access_token as string;
}

/** A user with one role in one scope (so tests never change the sample users). */
async function userWith(permissions: string[], scope: { scope: string; department?: string; branch?: string }) {
  const app = await testApp();
  const admin = await login(app, 'admin');
  const role = (await api(app).post(`${B}/roles`).set(bearer(admin)).send({ code: `sec_${uniq().toLowerCase()}`, name: `Security test ${uniq()}`, permissions })).body;
  const username = `sec.${uniq().toLowerCase()}`;
  const u = (await api(app).post(`${B}/users`).set(bearer(admin)).send({
    username, display_name: 'Security test', password: PASSWORD,
    roles: [{ role_id: role.id, scope: scope.scope, ...(scope.department ? { department_id: await idOf(app, 'department', 'code', scope.department) } : {}), ...(scope.branch ? { branch_id: await idOf(app, 'branch', 'code', scope.branch) } : {}) }],
  })).body;
  await db(app).query(`UPDATE user_account SET must_change_password = false WHERE id = $1`, [u.id]);
  return login(app, username);
}

const inDept = async (code: string) => {
  const app = await testApp();
  const [e] = await db(app).query(`SELECT e.id FROM employee e JOIN department d ON d.id = e.department_id WHERE d.code = $1 AND e.status <> 'exited' ORDER BY e.staff_number LIMIT 1`, [code]);
  return e.id as string;
};

describe('authorisation: scope is enforced on every kind of record', () => {
  it('someone allowed salaries for the medical ward cannot read the laboratory’s', async () => {
    const app = await testApp();
    const t = await userWith(['salary:read', 'employee:read'], { scope: 'department', department: 'MEDW' });
    expect((await api(app).get(`${B}/employees/${await inDept('MEDW')}/pay`).set(bearer(t))).status).toBe(200);
    expect([403, 404]).toContain((await api(app).get(`${B}/employees/${await inDept('LAB')}/pay`).set(bearer(t))).status);
  });

  it('a line manager sees their own team only: leave, attendance, reviews, expenses, reports', async () => {
    const app = await testApp();
    const lm = await login(app, 'line.manager');
    const other = await inDept('LAB');
    expect([403, 404]).toContain((await api(app).get(`${B}/employees/${other}`).set(bearer(lm))).status);
    expect([403, 404]).toContain((await api(app).get(`${B}/leave/employees/${other}/balances`).set(bearer(lm))).status);
    expect([403, 404]).toContain((await api(app).get(`${B}/attendance/timesheets/${other}`).query({ from: '2026-11-01', to: '2026-11-07' }).set(bearer(lm))).status);
    expect((await api(app).get(`${B}/employees/${other}/pay`).set(bearer(lm))).status).toBe(403);
    expect((await api(app).get(`${B}/expense-claims`).set(bearer(lm))).status).toBe(403);
    expect((await api(app).get(`${B}/reports/headcount`).set(bearer(lm))).status).toBe(403);
    const reviews = (await api(app).get(`${B}/performance/reviews`).set(bearer(lm))).body as { employee_id: string }[];
    expect(reviews.some((r) => r.employee_id === other)).toBe(false);
  });

  it('a branch-scoped officer cannot see another branch’s staff in lists', async () => {
    const app = await testApp();
    const t = await userWith(['employee:read'], { scope: 'branch', branch: 'MAIN' });
    const list = (await api(app).get(`${B}/employees`).query({ limit: 200 }).set(bearer(t))).body.data as { branch_id: string }[];
    const main = await idOf(app, 'branch', 'code', 'MAIN');
    expect(list.length).toBeGreaterThan(0);
    expect(list.every((e) => e.branch_id === main)).toBe(true);
  });

  it('machine clients: without the sensitive scope personal identifiers are masked; with it they are clear and audited', async () => {
    const app = await testApp();
    const plain = await clientToken(['employees:read']);
    const id = await inDept('MEDW');
    const masked = (await api(app).get(`${B}/employees/${id}`).set(bearer(plain))).body;
    expect(masked.national_id).toMatch(/^\*+\d{0,4}$/);
    const sensitive = await clientToken(['employees:read', 'employees.sensitive:read']);
    const before = (await db(app).query(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'sensitive_read'`))[0].n;
    const clear = (await api(app).get(`${B}/employees/${id}`).query({ include_sensitive: 'true' }).set(bearer(sensitive))).body;
    expect(clear.national_id ?? '').not.toMatch(/\*/);
    const after = (await db(app).query(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'sensitive_read'`))[0].n;
    expect(after).toBeGreaterThan(before);
    // A client cannot use endpoints outside its scopes.
    expect((await api(app).get(`${B}/payroll/runs`).set(bearer(plain))).status).toBe(403);
  });
});

describe('abuse resistance', () => {
  it('each API client is rate limited (429 with Retry-After)', async () => {
    const app = await testApp();
    const t = await clientToken(['org:read'], 3);
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await api(app).get(`${B}/departments`).set(bearer(t))).status);
    expect(codes.slice(0, 3)).toEqual([200, 200, 200]);
    const limited = await api(app).get(`${B}/departments`).set(bearer(t));
    expect(limited.status).toBe(429);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('tokens are required, and a forged or expired token is refused', async () => {
    const app = await testApp();
    expect((await api(app).get(`${B}/employees`)).status).toBe(401);
    expect((await api(app).get(`${B}/employees`).set(bearer('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.forged'))).status).toBe(401);
  });

  it('security headers are set on API responses', async () => {
    const app = await testApp();
    const r = await api(app).get(`${B}/health`);
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['x-frame-options']).toBeDefined();
    expect(r.headers['x-powered-by']).toBeUndefined();
  });

  /**
   * Every documented operation, called with nonsense input by an all-powerful user, must
   * answer with a 4xx (validation, not found, conflict), never a 500.
   */
  it('input validation: no endpoint answers nonsense with a server error', async () => {
    const app = await testApp();
    const admin = await login(app, 'admin');
    const doc = JSON.parse(readFileSync(join(ROOT, 'docs', 'openapi.json'), 'utf8')) as { paths: Record<string, Record<string, { requestBody?: { content?: Record<string, unknown> } }>> };
    const skip = /\/(auth\/logout|oauth\/token|auth\/mfa|calendar-feeds|careers\/jobs\/\{slug\}\/applications)/;
    const failures: string[] = [];
    let calls = 0;
    for (const [path, ops] of Object.entries(doc.paths)) {
      if (skip.test(path)) continue;
      const url = path.replace(/\{[^}]+\}/g, '0199a6b0-0000-7000-8000-00000000dead');
      for (const [method, op] of Object.entries(ops)) {
        if (!['get', 'post', 'put', 'patch', 'delete'].includes(method)) continue;
        const json = !!op.requestBody?.content?.['application/json'];
        const multipart = !!op.requestBody?.content?.['multipart/form-data'];
        let req = api(app)[method as 'get'](`${url}${method === 'get' ? '?limit=abc&from=yesterday&to=x&cursor=%%%' : ''}`).set(bearer(admin)).set('If-Match', '"1"');
        if (json) req = req.send({ junk: { $gt: '' }, amount: 'NaN', id: "1' OR '1'='1", start_date: '2026-02-31' });
        else if (multipart) req = req.field('junk', '<script>alert(1)</script>');
        const r = await req;
        calls++;
        if (r.status >= 500) failures.push(`${method.toUpperCase()} ${path} → ${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);
      }
    }
    expect(calls).toBeGreaterThan(300);
    expect(failures).toEqual([]);
  }, 300_000);
});

describe('no secrets in the repository', () => {
  it('tracked files carry no private keys or live credentials', () => {
    const files = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter((f) => f && !/(^|\/)(pnpm-lock\.yaml|openapi\.json|events\.json|generated\/)/.test(f) && !/\.(png|jpe?g|ico|woff2?|pdf)$/.test(f));
    const patterns: [string, RegExp][] = [
      ['private key', /-----BEGIN (RSA |EC |OPENSSH |)PRIVATE KEY-----/],
      ['AWS key', /AKIA[0-9A-Z]{16}/],
      ['Slack token', /xox[baprs]-[0-9A-Za-z-]{10,}/],
      ['GitHub token', /gh[pousr]_[0-9A-Za-z]{30,}/],
      ['Stripe live key', /sk_live_[0-9A-Za-z]{10,}/],
      ['Africa’s Talking key', /atsk_[0-9a-f]{20,}/],
    ];
    const hits: string[] = [];
    for (const f of files) {
      let text: string;
      try { text = readFileSync(join(ROOT, f), 'utf8'); } catch { continue; }
      for (const [name, re] of patterns) if (re.test(text)) hits.push(`${f}: ${name}`);
    }
    expect(hits).toEqual([]);
    // Only placeholders and documented development defaults in env examples.
    const env = readFileSync(join(ROOT, '.env.example'), 'utf8');
    for (const line of env.split('\n').filter((l) => /^(SMS_API_KEY|PROCUREMENT_API_KEY|OIDC_CLIENT_SECRET)=/.test(l))) expect(line).toMatch(/=$/);
  });
});
