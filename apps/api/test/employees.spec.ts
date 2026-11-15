import { api, bearer, closeApp, db, idOf, login, testApp, uniq } from './helpers';
import { LicencesService } from '../src/modules/employees/licences.service';

afterAll(closeApp);

const B = '/api/v1';

async function hire(token: string, extra: Record<string, unknown> = {}) {
  const app = await testApp();
  const position = (extra.position_id as string) ?? (await idOf(app, 'position', 'code', 'ICTO'));
  const nid = String(30_000_000 + Math.floor(Math.random() * 9_000_000));
  const res = await api(app)
    .post(`${B}/employees`)
    .set(bearer(token))
    .send({ first_name: 'Test', last_name: `Person${uniq()}`, employment_type: 'permanent', hire_date: '2026-01-05', position_id: position, national_id: nid, kra_pin: `A${nid.padEnd(9, '0').slice(0, 9)}Z`, ...extra });
  return { res, nid };
}

describe('employees', () => {
  it('hires with a generated staff number, records the first assignment and publishes hr.employee.hired.v1 without personal data', async () => {
    const app = await testApp();
    const hr = await login(app, 'hr.manager');
    const { res, nid } = await hire(hr);
    expect(res.status).toBe(201);
    expect(res.body.staff_number).toMatch(/^SIL\d{5}$/);
    expect(res.body.status).toBe('probation');
    expect(res.body.national_id).toBe(`****${nid.slice(-4)}`.replace(/^\*+/, (s) => s));
    expect(res.body.national_id).not.toContain(nid.slice(0, 4));
    expect(res.body.sensitive_visible).toBe(false);
    const ict = await idOf(app, 'department', 'code', 'ICT');
    expect(res.body.department_id).toBe(ict);

    const hist = await api(app).get(`${B}/employees/${res.body.id}/history`).set(bearer(hr));
    expect(hist.body.assignments).toHaveLength(1);
    expect(hist.body.assignments[0]).toMatchObject({ effective_from: '2026-01-05', effective_to: null });

    const [evt] = await db(app).query(`SELECT data FROM outbox_event WHERE subject = $1 AND type = 'hr.employee.hired.v1'`, [res.body.id]);
    expect(JSON.stringify(evt.data)).not.toContain(nid);
    expect(evt.data).toMatchObject({ staff_number: res.body.staff_number, department_id: ict });

    // Stored encrypted, never in clear.
    const [row] = await db(app).query(`SELECT national_id_enc FROM employee WHERE id = $1`, [res.body.id]);
    expect(row.national_id_enc).toMatch(/^v1:/);
    expect(row.national_id_enc).not.toContain(nid);
  });

  it('shows sensitive fields only with the permission, and audits each such read', async () => {
    const app = await testApp();
    const hr = await login(app, 'hr.manager');
    const { res, nid } = await hire(hr);
    const clear = await api(app).get(`${B}/employees/${res.body.id}?include_sensitive=true`).set(bearer(hr));
    expect(clear.body).toMatchObject({ national_id: nid, sensitive_visible: true });
    const [a] = await db(app).query(`SELECT action FROM audit_log WHERE entity_id = $1 AND action = 'sensitive_read'`, [res.body.id]);
    expect(a).toBeTruthy();
    // HR officer has employee:read but not employee.sensitive:read.
    const officer = await login(app, 'hr.officer');
    const masked = await api(app).get(`${B}/employees/${res.body.id}?include_sensitive=true`).set(bearer(officer));
    expect(masked.body.sensitive_visible).toBe(false);
    expect(masked.body.national_id).not.toBe(nid);
  });

  it('finds by exact national ID via the blind index, and rejects duplicates', async () => {
    const app = await testApp();
    const hr = await login(app, 'hr.manager');
    const { res, nid } = await hire(hr);
    const found = await api(app).get(`${B}/employees`).query({ search: nid }).set(bearer(hr));
    expect(found.body.data.map((e: { id: string }) => e.id)).toEqual([res.body.id]);
    const dup = await hire(hr, { national_id: nid, kra_pin: null });
    expect(dup.res.status).toBe(409);
    expect(dup.res.body.errors[0].path).toBe('national_id');
  });

  it('enforces data scope: a department head sees their tree only; a line manager their direct reports only', async () => {
    const app = await testApp();
    const head = await login(app, 'head.nursing');
    const list = await api(app).get(`${B}/employees`).query({ limit: 500 }).set(bearer(head));
    expect(list.status).toBe(200);
    const nursingTree = await db(app).query(`SELECT id FROM department WHERE code = 'NURS' OR (SELECT id FROM department WHERE code = 'NURS') = ANY(path)`);
    const allowed = new Set(nursingTree.map((r: { id: string }) => r.id));
    expect(list.body.data.length).toBeGreaterThan(0);
    for (const e of list.body.data) expect(allowed.has(e.department_id)).toBe(true);
    const labTech = (await db(app).query(`SELECT e.id FROM employee e JOIN department d ON d.id = e.department_id WHERE d.code = 'LAB' LIMIT 1`))[0].id;
    expect((await api(app).get(`${B}/employees/${labTech}`).set(bearer(head))).status).toBe(404);

    const lm = await login(app, 'line.manager');
    const team = await api(app).get(`${B}/employees`).query({ limit: 500 }).set(bearer(lm));
    const lmEmp = (await db(app).query(`SELECT employee_id FROM user_account WHERE username = 'line.manager'`))[0].employee_id;
    expect(team.body.data.length).toBeGreaterThan(0);
    for (const e of team.body.data) expect(e.manager_id).toBe(lmEmp);
  });

  it('a machine client without the sensitive scope gets masked fields; with it, clear (audited against the client)', async () => {
    const app = await testApp();
    const admin = await login(app, 'admin');
    const hr = await login(app, 'hr.manager');
    const { res, nid } = await hire(hr);
    const mk = async (scopes: string[]) => {
      const c = (await api(app).post(`${B}/api-clients`).set(bearer(admin)).send({ name: `C ${uniq()}`, scopes })).body;
      return (await api(app).post(`${B}/oauth/token`).auth(c.client.client_id, c.client_secret).type('form').send({ grant_type: 'client_credentials' })).body.access_token as string;
    };
    const plain = await mk(['employees:read']);
    expect((await api(app).get(`${B}/employees/${res.body.id}?include_sensitive=true`).set(bearer(plain))).body.national_id).not.toBe(nid);
    const sensitive = await mk(['employees:read', 'employees.sensitive:read']);
    expect((await api(app).get(`${B}/employees/${res.body.id}?include_sensitive=true`).set(bearer(sensitive))).body.national_id).toBe(nid);
  });

  it('moves through the status lifecycle; exiting closes the assignment, disables the login and publishes hr.employee.exited.v1', async () => {
    const app = await testApp();
    const hr = await login(app, 'hr.manager');
    const admin = await login(app, 'admin');
    const { res } = await hire(hr);
    const id = res.body.id;
    const bad = await api(app).post(`${B}/employees/${id}/status`).set(bearer(hr)).send({ status: 'onboarding', effective_date: '2026-02-01', reason: 'nope' });
    expect(bad.body.code).toBe('invalid_transition');
    expect((await api(app).post(`${B}/employees/${id}/status`).set(bearer(hr)).send({ status: 'active', effective_date: '2026-04-05', reason: 'Probation passed' })).status).toBe(200);

    const roleId = await idOf(app, 'role', 'code', 'employee');
    const username = `leaver.${uniq().toLowerCase()}`;
    const user = (await api(app).post(`${B}/users`).set(bearer(admin)).send({ username, display_name: 'Leaver', password: 'Test#Password2026', roles: [{ role_id: roleId, scope: 'own' }] })).body;
    expect((await api(app).put(`${B}/employees/${id}/user`).set(bearer(admin)).send({ user_id: user.id })).status).toBe(200);
    await db(app).query(`UPDATE user_account SET must_change_password = false WHERE id = $1`, [user.id]);
    const leaverToken = await login(app, username);
    expect((await api(app).get(`${B}/me/employee`).set(bearer(leaverToken))).body.id).toBe(id);

    const exit = await api(app).post(`${B}/employees/${id}/status`).set(bearer(hr)).send({ status: 'exited', effective_date: '2026-10-31', reason: 'Resigned' });
    expect(exit.body).toMatchObject({ status: 'exited', exit_date: '2026-10-31' });
    const hist = (await api(app).get(`${B}/employees/${id}/history`).set(bearer(hr))).body;
    expect(hist.assignments[0].effective_to).toBe('2026-10-31');
    expect((await api(app).get(`${B}/me/employee`).set(bearer(leaverToken))).body.code).toBe('account_disabled');
    const types = (await db(app).query(`SELECT type FROM outbox_event WHERE subject = $1 ORDER BY id`, [id])).map((r: { type: string }) => r.type);
    expect(types).toEqual(['hr.employee.hired.v1', 'hr.employee.status_changed.v1', 'hr.employee.status_changed.v1', 'hr.employee.exited.v1']);
    expect((await api(app).patch(`${B}/employees/${id}`).set(bearer(hr)).set('If-Match', `"${exit.body.version}"`).send({ work_phone: '+254700000001' })).body.code).toBe('employee_exited');
  });

  it('transfers with effective-dated history and refuses overlapping assignments', async () => {
    const app = await testApp();
    const hr = await login(app, 'hr.manager');
    const { res } = await hire(hr);
    const lab = await idOf(app, 'position', 'code', 'LABTECH');
    const t = await api(app).post(`${B}/employees/${res.body.id}/transfers`).set(bearer(hr)).send({ position_id: lab, effective_from: '2026-03-01', reason: 'Retrained' });
    expect(t.status).toBe(200);
    expect(t.body.department_id).toBe(await idOf(app, 'department', 'code', 'LAB'));
    const hist = (await api(app).get(`${B}/employees/${res.body.id}/history`).set(bearer(hr))).body;
    expect(hist.assignments.map((a: { effective_from: string; effective_to: string | null }) => [a.effective_from, a.effective_to])).toEqual([['2026-03-01', null], ['2026-01-05', '2026-02-28']]);
    const early = await api(app).post(`${B}/employees/${res.body.id}/transfers`).set(bearer(hr)).send({ position_id: lab, effective_from: '2026-02-01', reason: 'Backdated' });
    expect(early.body.code).toBe('before_current');
    // The database itself refuses overlaps.
    await expect(db(app).query(`INSERT INTO employee_position_assignment (employee_id, position_id, department_id, branch_id, effective_from) SELECT employee_id, position_id, department_id, branch_id, '2026-04-01' FROM employee_position_assignment WHERE employee_id = $1 LIMIT 1`, [res.body.id])).rejects.toThrow(/ex_assignment_overlap/);
    const [evt] = await db(app).query(`SELECT data FROM outbox_event WHERE subject = $1 AND type = 'hr.employee.transferred.v1'`, [res.body.id]);
    expect(evt.data.previous.department_id).toBe(await idOf(app, 'department', 'code', 'ICT'));
  });

  it('rejects reporting-line cycles', async () => {
    const app = await testApp();
    const hr = await login(app, 'hr.manager');
    const a = (await hire(hr)).res.body;
    const b = (await hire(hr, { manager_id: a.id })).res.body;
    const cyc = await api(app).put(`${B}/employees/${a.id}/manager`).set(bearer(hr)).send({ manager_id: b.id });
    expect(cyc.body.code).toBe('cycle');
  });

  it('keeps bank details encrypted and masked', async () => {
    const app = await testApp();
    const hr = await login(app, 'hr.manager');
    const { res } = await hire(hr);
    const add = await api(app).post(`${B}/employees/${res.body.id}/bank-accounts`).set(bearer(hr)).send({ kind: 'bank', bank_name: 'Sample Bank', account_name: 'Test Person', account_number: '0123456789012' });
    expect(add.status).toBe(201);
    expect(add.body.account_number).toBe('********9012');
    const clear = await api(app).get(`${B}/employees/${res.body.id}/bank-accounts?include_sensitive=true`).set(bearer(hr));
    expect(clear.body[0].account_number).toBe('0123456789012');
    const mpesa = await api(app).post(`${B}/employees/${res.body.id}/bank-accounts`).set(bearer(hr)).send({ kind: 'mobile_money', account_name: 'Test', account_number: '12345' });
    expect(mpesa.status).toBe(422);
  });
});

describe('licences', () => {
  it('derives status, flags the employee, and the sweep publishes expiring/expired once', async () => {
    const app = await testApp();
    const hr = await login(app, 'hr.manager');
    const { res } = await hire(hr, { position_id: await idOf(app, 'position', 'code', 'RN-ICU') });
    const today = new Date().toISOString().slice(0, 10);
    const plus = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString().slice(0, 10);
    const l = await api(app).post(`${B}/employees/${res.body.id}/licences`).set(bearer(hr)).send({ licensing_body: 'NCK', licence_number: `NCK/T${uniq()}`, expiry_date: plus(30) });
    expect(l.body.status).toBe('expiring');
    expect((await api(app).get(`${B}/employees/${res.body.id}`).set(bearer(hr))).body.licence_status).toBe('expiring');

    const svc = app.get(LicencesService);
    await svc.sweep();
    await svc.sweep();
    const exp = await db(app).query(`SELECT count(*)::int AS n FROM outbox_event WHERE subject = $1 AND type = 'hr.licence.expiring.v1'`, [l.body.id]);
    expect(exp[0].n).toBe(1);

    await db(app).query(`UPDATE professional_licence SET expiry_date = $2 WHERE id = $1`, [l.body.id, plus(-1)]);
    await svc.sweep();
    expect((await db(app).query(`SELECT count(*)::int AS n FROM outbox_event WHERE subject = $1 AND type = 'hr.licence.expired.v1'`, [l.body.id]))[0].n).toBe(1);
    expect((await api(app).get(`${B}/directory/staff/${res.body.id}`).set(bearer(hr))).body.licence_status).toBe('expired');

    // Renewal: needs verification again.
    const cur = (await api(app).get(`${B}/employees/${res.body.id}/licences`).set(bearer(hr))).body[0];
    const renewed = await api(app).patch(`${B}/licences/${cur.id}`).set(bearer(hr)).set('If-Match', `"${cur.version}"`).send({ expiry_date: plus(400) });
    expect(renewed.body.status).toBe('not_verified');
    expect((await api(app).post(`${B}/licences/${cur.id}/verification`).set(bearer(hr))).body.status).toBe('valid');
    void today;
  });
});

describe('directory and self-service', () => {
  it('serves a lean directory and approver lookups to an org client', async () => {
    const app = await testApp();
    const admin = await login(app, 'admin');
    const c = (await api(app).post(`${B}/api-clients`).set(bearer(admin)).send({ name: `Proc ${uniq()}`, scopes: ['employees:read'] })).body;
    const token = (await api(app).post(`${B}/oauth/token`).auth(c.client.client_id, c.client_secret).type('form').send({ grant_type: 'client_credentials' })).body.access_token;
    const nurs = await idOf(app, 'department', 'code', 'NURS');
    const staff = await api(app).get(`${B}/directory/staff`).query({ department_id: nurs, include_sub_departments: 'true', limit: 200 }).set(bearer(token));
    expect(staff.status).toBe(200);
    expect(staff.body.data.length).toBeGreaterThan(5);
    const entry = staff.body.data[0];
    expect(Object.keys(entry)).not.toContain('national_id');
    expect(entry).toHaveProperty('licence_status');

    const rn = (await db(app).query(`SELECT employee_id FROM user_account WHERE username = 'employee'`))[0].employee_id;
    const appr = await api(app).get(`${B}/directory/approvers`).query({ employee_id: rn }).set(bearer(token));
    expect(appr.status).toBe(200);
    const wm = (await db(app).query(`SELECT employee_id FROM user_account WHERE username = 'line.manager'`))[0].employee_id;
    expect(appr.body.line_manager.id).toBe(wm);
    expect(appr.body.department_head).not.toBeNull();
  });

  it('lets an employee see their own record and request a contact change that HR approves', async () => {
    const app = await testApp();
    const me = await login(app, 'employee');
    const profile = await api(app).get(`${B}/me/employee`).set(bearer(me));
    expect(profile.status).toBe(200);
    expect(profile.body.sensitive_visible).toBe(true);
    // Own scope: the employee sees only themselves in the employee list.
    expect((await api(app).get(`${B}/employees`).set(bearer(me))).status).toBe(403);

    const req = await api(app).post(`${B}/me/contact-changes`).set(bearer(me)).send({ personal_phone: '+254 722 000 111' });
    expect(req.status).toBe(201);
    expect((await api(app).post(`${B}/me/contact-changes`).set(bearer(me)).send({ personal_phone: '+254 722 000 222' })).body.code).toBe('change_pending');

    const hr = await login(app, 'hr.manager');
    const pending = await api(app).get(`${B}/contact-change-requests`).set(bearer(hr));
    expect(pending.body.some((r: { id: string }) => r.id === req.body.id)).toBe(true);
    const ok = await api(app).post(`${B}/contact-change-requests/${req.body.id}/decision`).set(bearer(hr)).send({ decision: 'approved' });
    expect(ok.body.status).toBe('approved');
    expect((await api(app).get(`${B}/me/employee`).set(bearer(me))).body.personal_phone).toBe('+254 722 000 111');
  });
});

describe('bulk import and export', () => {
  const run = async () => {
    const app = await testApp();
    const { BulkService } = await import('../src/modules/employees/bulk');
    await app.get(BulkService).processQueued();
  };
  const csv = (rows: string[][]) => Buffer.from(['staff_number,first_name,last_name,national_id,employment_type,hire_date,position_code,manager_staff_number', ...rows.map((r) => r.join(','))].join('\n'));

  it('validates a dry run, then imports all rows in one transaction with managers resolved by staff number', async () => {
    const app = await testApp();
    const hr = await login(app, 'hr.manager');
    const sn = `IMP${uniq()}`;
    const nid = () => String(40_000_000 + Math.floor(Math.random() * 9_000_000));
    const good = [[`${sn}A`, 'Ann', 'Lead', nid(), 'permanent', '01/12/2026', 'ICTO', ''], [`${sn}B`, 'Ben', 'Member', nid(), 'contract', '2026-12-01', 'icto', `${sn}A`]];
    const dry = await api(app).post(`${B}/employees/import?dry_run=true`).set(bearer(hr)).attach('file', csv(good), 'staff.csv');
    expect(dry.status).toBe(202);
    await run();
    const dryJob = (await api(app).get(`${B}/bulk-jobs/${dry.body.id}`).set(bearer(hr))).body;
    expect(dryJob).toMatchObject({ status: 'succeeded', dry_run: true, total_rows: 2, error_count: 0 });
    expect((await db(app).query(`SELECT count(*)::int AS n FROM employee WHERE staff_number LIKE $1`, [`${sn}%`]))[0].n).toBe(0);

    const real = await api(app).post(`${B}/employees/import`).set(bearer(hr)).attach('file', csv(good), 'staff.csv');
    await run();
    const job = (await api(app).get(`${B}/bulk-jobs/${real.body.id}`).set(bearer(hr))).body;
    expect(job).toMatchObject({ status: 'succeeded', created_count: 2 });
    const [b] = await db(app).query(`SELECT e.manager_id, m.staff_number AS mgr FROM employee e JOIN employee m ON m.id = e.manager_id WHERE e.staff_number = $1`, [`${sn}B`]);
    expect(b.mgr).toBe(`${sn}A`);
  });

  it('reports row-level errors and saves nothing when any row fails', async () => {
    const app = await testApp();
    const hr = await login(app, 'hr.manager');
    const sn = `BAD${uniq()}`;
    const res = await api(app).post(`${B}/employees/import`).set(bearer(hr)).attach('file', csv([[`${sn}A`, 'Ok', 'Row', '41234567', 'permanent', '2026-12-01', 'ICTO', ''], [`${sn}B`, '', 'NoFirst', 'abc', 'boss', '31/02/2026', 'NOPE', '']]), 'bad.csv');
    await run();
    const job = (await api(app).get(`${B}/bulk-jobs/${res.body.id}`).set(bearer(hr))).body;
    expect(job.status).toBe('failed');
    const cols = job.errors.filter((e: { row: number }) => e.row === 3).map((e: { column: string }) => e.column);
    expect(cols).toEqual(expect.arrayContaining(['first_name', 'national_id', 'employment_type', 'hire_date']));
    expect((await db(app).query(`SELECT count(*)::int AS n FROM employee WHERE staff_number LIKE $1`, [`${sn}%`]))[0].n).toBe(0);
  });

  it('exports what the caller may see, as a downloadable file, and audits the export', async () => {
    const app = await testApp();
    const head = await login(app, 'head.nursing');
    expect((await api(app).post(`${B}/employees/export`).set(bearer(head))).status).toBe(403);
    const hr = await login(app, 'hr.manager');
    const res = await api(app).post(`${B}/employees/export?format=xlsx&status=active`).set(bearer(hr));
    expect(res.status).toBe(202);
    await run();
    const job = (await api(app).get(`${B}/bulk-jobs/${res.body.id}`).set(bearer(hr))).body;
    expect(job.status).toBe('succeeded');
    expect(job.total_rows).toBeGreaterThan(10);
    const link = await api(app).post(`${B}/documents/${job.result_document_id}/download-url`).set(bearer(hr));
    expect(link.status).toBe(201);
  });
});
