import { createServer, type Server } from 'node:http';
import { LifecycleService } from '../src/modules/lifecycle/lifecycle.service';
import { api, bearer, closeApp, db, idOf, login, PASSWORD, testApp, uniq } from './helpers';

const B = '/api/v1';
const today = () => new Date().toISOString().slice(0, 10);
const plus = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

// A stand-in for sil_procurement's exit clearance (same path, header and answer shape).
const held = new Map<string, boolean>();
let proc: Server;
const calls: { path: string; key: string | undefined }[] = [];
beforeAll(async () => {
  proc = createServer((req, res) => {
    calls.push({ path: req.url ?? '', key: req.headers['x-api-key'] as string | undefined });
    const m = /^\/api\/v1\/integration\/hr\/staff\/([^/]+)\/exit-clearance$/.exec(req.url ?? '');
    if (!m || req.headers['x-api-key'] !== 'test-hr-key') { res.writeHead(403).end(); return; }
    const staff = decodeURIComponent(m[1]);
    if (!held.has(staff)) { res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ code: 'STAFF_NOT_FOUND' })); return; }
    const hold = held.get(staff)!;
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
      staff: { employeeNo: staff }, cleared: !hold, blockers: hold ? ['ASSETS_HELD'] : [],
      assets: hold ? [{ tagNo: 'SIL-LAP-0042', description: 'Laptop', serialNo: 'X1', location: 'ICT', cost: '95000.00' }] : [],
      outstandingAdvances: [], pettyCashFloats: [],
    }));
  });
  await new Promise<void>((r) => proc.listen(39125, '127.0.0.1', () => r()));
});
afterAll(async () => {
  await new Promise((r) => proc.close(r));
  await closeApp();
});

async function staff(position = 'RN-MED', opts: { manager?: string; basic?: string } = {}) {
  const app = await testApp();
  const hr = await login(app, 'hr.manager');
  const admin = await login(app, 'admin');
  const e = (await api(app).post(`${B}/employees`).set(bearer(hr)).send({ first_name: 'Life', last_name: `Cycle${uniq()}`, employment_type: 'permanent', status: 'active', hire_date: '2021-03-01', position_id: await idOf(app, 'position', 'code', position) })).body;
  if (opts.manager) {
    const [mgr] = await db(app).query(`SELECT employee_id FROM user_account WHERE username = $1`, [opts.manager]);
    await api(app).put(`${B}/employees/${e.id}/manager`).set(bearer(hr)).send({ manager_id: mgr.employee_id });
  }
  if (opts.basic) await api(app).put(`${B}/employees/${e.id}/salary`).set(bearer(await login(app, 'payroll'))).send({ basic: opts.basic, effective_from: '2026-11-01' });
  const username = `lc.${uniq().toLowerCase()}`;
  const u = (await api(app).post(`${B}/users`).set(bearer(admin)).send({ username, display_name: e.display_name, password: PASSWORD, roles: [{ role_id: await idOf(app, 'role', 'code', 'employee'), scope: 'own' }] })).body;
  await api(app).put(`${B}/employees/${e.id}/user`).set(bearer(admin)).send({ user_id: u.id });
  await db(app).query(`UPDATE user_account SET must_change_password = false WHERE id = $1`, [u.id]);
  return { id: e.id as string, staff: e.staff_number as string, token: await login(app, username), userId: u.id as string };
}

/** Each step: the first of the candidate users (a | b) with the task in their inbox approves. */
async function decide(subjectId: string, who: string[], decision = 'approve') {
  const app = await testApp();
  for (const step of who) {
    let task: { id: string } | undefined;
    let t = '';
    let w = step;
    for (const cand of step.split('|')) {
      t = await login(app, cand);
      task = (await api(app).get(`${B}/workflow/inbox`).set(bearer(t))).body.find((x: { subject_id: string }) => x.subject_id === subjectId);
      if (task) { w = cand; break; }
    }
    expect([w, !!task]).toEqual([w, true]);
    const r = await api(app).post(`${B}/workflow/tasks/${task!.id}/decision`).set(bearer(t)).send({ decision, comment: decision === 'approve' ? undefined : 'Not now' });
    expect([w, r.status]).toEqual([w, 200]);
  }
}

describe('contracts', () => {
  it('a fixed-term contract ending soon is reminded once; a new contract ends the old one', async () => {
    const app = await testApp();
    const hro = await login(app, 'hr.officer');
    const p = await staff('ICTO');
    const noEnd = await api(app).post(`${B}/contracts`).set(bearer(hro)).send({ employee_id: p.id, contract_type: 'fixed_term', start_date: '2025-01-01' });
    expect(noEnd.status).toBe(422);
    const c = await api(app).post(`${B}/contracts`).set(bearer(hro)).send({ employee_id: p.id, contract_type: 'fixed_term', start_date: '2025-01-01', end_date: plus(20), notice_days: 30 });
    expect(c.status).toBe(201);
    expect(c.body).toMatchObject({ status: 'active', days_left: 20 });
    expect(c.body.number).toMatch(/^CON\/2025\//);
    await app.get(LifecycleService).sweep();
    await app.get(LifecycleService).sweep();
    const [evt] = await db(app).query(`SELECT count(*)::int AS n FROM outbox_event WHERE type = 'hr.contract.expiring.v1' AND subject = $1`, [p.id]);
    expect(evt.n).toBe(1);
    const expiring = (await api(app).get(`${B}/contracts`).query({ expiring_within_days: 30 }).set(bearer(hro))).body;
    expect(expiring.some((x: { id: string }) => x.id === c.body.id)).toBe(true);
    // The person sees their own contract.
    expect((await api(app).get(`${B}/me/contracts`).set(bearer(p.token))).body[0].number).toBe(c.body.number);
  });

  it('a renewal goes through approval and replaces the contract', async () => {
    const app = await testApp();
    const hro = await login(app, 'hr.officer');
    const p = await staff('ICTO');
    const first = (await api(app).post(`${B}/contracts`).set(bearer(hro)).send({ employee_id: p.id, contract_type: 'fixed_term', start_date: '2025-01-01', end_date: plus(10) })).body;
    const r = await api(app).post(`${B}/lifecycle-requests`).set(bearer(hro)).send({ kind: 'contract_renewal', employee_id: p.id, effective_date: plus(11), end_date: plus(11 + 730), reason: 'Good performance; post still needed' });
    expect(r.status).toBe(201);
    await decide(r.body.id, ['hr.manager']);
    const list = (await api(app).get(`${B}/contracts`).query({ employee_id: p.id }).set(bearer(hro))).body;
    expect(list.find((c: { id: string }) => c.id === first.id).status).toBe('renewed');
    expect(list.find((c: { id: string }) => c.id !== first.id)).toMatchObject({ status: 'active', start_date: plus(11), renewed_from_id: first.id });
  });
});

describe('promotion and confirmation', () => {
  it('promotion: department head then HR manager; new position and pay from the date; event', async () => {
    const app = await testApp();
    const hro = await login(app, 'hr.officer');
    const p = await staff('RN-MED', { basic: '60000.00' });
    // Into a post that heads nothing, so other tests' approval routes stay as they are.
    const wm = await idOf(app, 'position', 'code', 'RN-ICU');
    const r = await api(app).post(`${B}/lifecycle-requests`).set(bearer(hro)).send({ kind: 'promotion', employee_id: p.id, effective_date: today(), position_id: wm, new_basic: '85000.00', reason: 'Critical care post after ICU training' });
    expect(r.status).toBe(201);
    expect((await api(app).post(`${B}/lifecycle-requests`).set(bearer(hro)).send({ kind: 'promotion', employee_id: p.id, effective_date: today(), position_id: wm, reason: 'Again' })).status).toBe(409);
    await decide(r.body.id, ['line.manager|head.nursing', 'hr.manager']);
    const e = (await api(app).get(`${B}/employees/${p.id}`).set(bearer(hro))).body;
    expect(e.position_id).toBe(wm);
    const pay = (await api(app).get(`${B}/employees/${p.id}/pay`).set(bearer(await login(app, 'payroll')))).body;
    expect(pay.salaries[0]).toMatchObject({ basic: '85000.00', effective_from: today() });
    const [evt] = await db(app).query(`SELECT data FROM outbox_event WHERE type = 'hr.employee.promoted.v1' AND subject = $1`, [p.id]);
    expect(evt.data).toMatchObject({ position_id: wm, effective_from: today() });
  });
});

describe('exit: resignation, checklist, clearance, final dues, completion', () => {
  it('runs end to end and ends access', async () => {
    const app = await testApp();
    const hro = await login(app, 'hr.officer');
    const p = await staff('RN-MED', { manager: 'line.manager', basic: '66000.00' });
    held.set(p.staff, true);
    // Ten days of annual leave left, to be paid out.
    const annual = (await db(app).query(`SELECT id FROM leave_type WHERE code = 'annual'`))[0].id;
    await api(app).post(`${B}/leave/employees/${p.id}/adjustments`).set(bearer(await login(app, 'hr.manager'))).send({ leave_type_id: annual, leave_year: Number(today().slice(0, 4)), days: 10, note: 'Balance for the test' });
    const available = (await api(app).get(`${B}/leave/employees/${p.id}/balances`).set(bearer(await login(app, 'hr.manager')))).body.find((b: { leave_type_code: string }) => b.leave_type_code === 'annual').available as number;
    const leavePay = (available * 3000).toFixed(2);

    const r = await api(app).post(`${B}/lifecycle-requests`).set(bearer(hro)).send({ kind: 'resignation', employee_id: p.id, effective_date: today(), notice_given_on: plus(-30), reason: 'Moving to another county' });
    expect(r.status).toBe(201);
    await decide(r.body.id, ['line.manager', 'hr.manager']);
    expect((await api(app).get(`${B}/employees/${p.id}`).set(bearer(hro))).body.status).toBe('on_notice');
    const [started] = await db(app).query(`SELECT count(*)::int AS n FROM outbox_event WHERE type = 'hr.employee.offboarding_started.v1' AND subject = $1`, [p.id]);
    expect(started.n).toBe(1);

    // Procurement says a laptop is still with them.
    let ec = (await api(app).post(`${B}/employees/${p.id}/exit-clearance/procurement-check`).set(bearer(hro))).body;
    expect(calls.at(-1)).toEqual({ path: `/api/v1/integration/hr/staff/${p.staff}/exit-clearance`, key: 'test-hr-key' });
    expect(ec.procurement).toMatchObject({ reachable: true, cleared: false, blockers: ['ASSETS_HELD'], assets: [{ tagNo: 'SIL-LAP-0042' }] });
    // 66,000 ÷ 22 = 3,000 a day for the unused leave; no contract on file, so the default 30 days' notice, all served.
    expect(ec).toMatchObject({ ready: false, leave_days: available, leave_pay: leavePay, notice_pay: '0.00', notice_days: 30, notice_served_days: 30 });
    expect(ec.checklist_open_blocking).toBeGreaterThan(0);
    expect((await api(app).post(`${B}/employees/${p.id}/exit-clearance/complete`).set(bearer(hro)).send({})).status).toBe(422);

    // Each team works its own tasks; another team's task is refused.
    const tokens: Record<string, string> = { it: await login(app, 'it.support'), facilities: await login(app, 'facilities'), finance: await login(app, 'finance'), line_manager: await login(app, 'line.manager'), employee: p.token, hr: hro };
    const mine = (await api(app).get(`${B}/me/checklist-tasks`).set(bearer(tokens.it))).body.filter((t: { employee_id: string }) => t.employee_id === p.id);
    expect(mine.length).toBe(2);
    const facTask = (await api(app).get(`${B}/me/checklist-tasks`).set(bearer(tokens.facilities))).body.find((t: { employee_id: string }) => t.employee_id === p.id);
    expect((await api(app).put(`${B}/checklist-tasks/${facTask.id}`).set(bearer(tokens.it)).send({ status: 'done' })).status).toBe(403);
    for (const [group, token] of Object.entries(tokens)) {
      for (const t of (await api(app).get(`${B}/me/checklist-tasks`).set(bearer(token))).body.filter((x: { employee_id: string; assignee: string }) => x.employee_id === p.id && x.assignee === group)) {
        expect((await api(app).put(`${B}/checklist-tasks/${t.id}`).set(bearer(token)).send({ status: 'done', note: 'ok' })).status).toBe(200);
      }
    }
    // The laptop came back.
    held.set(p.staff, false);
    ec = (await api(app).post(`${B}/employees/${p.id}/exit-clearance/procurement-check`).set(bearer(hro))).body;
    expect(ec).toMatchObject({ ready: true, checklist_open_blocking: 0 });

    // Final dues: HR manager then finance; leave pay goes to the exit month's payroll and the leave is encashed.
    const fd = await api(app).post(`${B}/employees/${p.id}/exit-clearance/final-dues`).set(bearer(hro));
    expect(fd.body.final_dues_status).toBe('submitted');
    await decide(fd.body.final_dues_request_id, ['hr.manager', 'finance']);
    const oneOffs = (await api(app).get(`${B}/payroll/one-offs`).query({ employee_id: p.id }).set(bearer(await login(app, 'payroll')))).body;
    expect(oneOffs).toEqual([expect.objectContaining({ component_name: 'Leave encashment', amount: leavePay, period: today().slice(0, 7) })]);
    const bal = (await api(app).get(`${B}/leave/employees/${p.id}/balances`).set(bearer(await login(app, 'hr.manager')))).body.find((b: { leave_type_code: string }) => b.leave_type_code === 'annual');
    expect(bal.available).toBe(0);

    // Completion ends access at once.
    const done = await api(app).post(`${B}/employees/${p.id}/exit-clearance/complete`).set(bearer(hro)).send({});
    expect(done.status).toBe(200);
    expect((await api(app).get(`${B}/employees/${p.id}`).set(bearer(hro))).body.status).toBe('exited');
    expect((await api(app).post('/api/v1/auth/login').send({ username: (await db(app).query(`SELECT username FROM user_account WHERE id = $1`, [p.userId]))[0].username, password: PASSWORD })).status).toBe(403);
    const [exited] = await db(app).query(`SELECT count(*)::int AS n FROM outbox_event WHERE type = 'hr.employee.exited.v1' AND subject = $1`, [p.id]);
    expect(exited.n).toBe(1);
  });

  it('procurement down or unknown staff: the check says so instead of failing', async () => {
    const app = await testApp();
    const hro = await login(app, 'hr.officer');
    const p = await staff('ICTO');
    const r = (await api(app).post(`${B}/lifecycle-requests`).set(bearer(hro)).send({ kind: 'termination', employee_id: p.id, effective_date: plus(30), exit_kind: 'contract_end', reason: 'Project ended' })).body;
    // No line manager: the first step goes to the workflow administrators; then the HR manager.
    await decide(r.id, ['admin', 'hr.manager']);
    const ec = (await api(app).post(`${B}/employees/${p.id}/exit-clearance/procurement-check`).set(bearer(hro))).body;
    expect(ec.procurement).toMatchObject({ reachable: true, cleared: true });
    expect(ec.procurement.error).toContain('no user with this staff number');
  });
});

describe('employee relations', () => {
  it('warnings are seen by the employee and acknowledged; complaints only by the people named', async () => {
    const app = await testApp();
    const hrm = await login(app, 'hr.manager');
    const hro = await login(app, 'hr.officer');
    const p = await staff('ICTO');
    const w = await api(app).post(`${B}/relations-cases`).set(bearer(hrm)).send({ kind: 'warning', employee_id: p.id, severity: 'first', subject: 'Late for three shifts in October', expires_on: plus(180) });
    expect(w.status).toBe(201);
    await api(app).post(`${B}/relations-cases/${w.body.id}/notes`).set(bearer(hrm)).send({ body: 'Internal: discussed with the ward manager' });
    await api(app).post(`${B}/relations-cases/${w.body.id}/notes`).set(bearer(hrm)).send({ body: 'Please speak to HR if something is making you late.', visible_to_employee: true });
    const seen = (await api(app).get(`${B}/relations-cases/${w.body.id}`).set(bearer(p.token))).body;
    expect(seen.notes.map((n: { body: string }) => n.body)).toEqual(['Please speak to HR if something is making you late.']);
    expect((await api(app).post(`${B}/relations-cases/${w.body.id}/acknowledge`).set(bearer(p.token))).body.acknowledged_at).toBeTruthy();
    expect((await api(app).get(`${B}/relations-cases/${w.body.id}`).set(bearer(hro))).status).toBe(200);

    // A grievance about a colleague: the HR managers see it; HR officers and the colleague do not.
    const other = await staff('ICTO');
    const c = await api(app).post(`${B}/me/complaints`).set(bearer(p.token)).send({ subject: 'Bullying on night shift', details: 'Repeated shouting and threats during handover.', about_employee_id: other.id });
    expect(c.status).toBe(201);
    expect(c.body).toMatchObject({ restricted: true, employee_name: null });
    expect((await api(app).get(`${B}/relations-cases/${c.body.id}`).set(bearer(hrm))).body.complainant_name).toContain('Life');
    expect((await api(app).get(`${B}/relations-cases/${c.body.id}`).set(bearer(hro))).status).toBe(404);
    expect((await api(app).get(`${B}/relations-cases/${c.body.id}`).set(bearer(other.token))).status).toBe(404);
    expect((await api(app).get(`${B}/relations-cases`).set(bearer(other.token))).body.some((x: { id: string }) => x.id === c.body.id)).toBe(false);
    // The HR manager names an investigator, who can then see it.
    const [hroUser] = await db(app).query(`SELECT id FROM user_account WHERE username = 'hr.officer'`);
    await api(app).put(`${B}/relations-cases/${c.body.id}`).set(bearer(hrm)).send({ investigator_user_ids: [hroUser.id] });
    expect((await api(app).get(`${B}/relations-cases/${c.body.id}`).set(bearer(hro))).status).toBe(200);
  });
});

describe('letters', () => {
  it('issues PDF and Word letters with merge fields and keeps them on file', async () => {
    const app = await testApp();
    const hro = await login(app, 'hr.officer');
    const p = await staff('ICTO');
    const tpl = (await api(app).get(`${B}/letter-templates`).set(bearer(hro))).body.find((t: { code: string }) => t.code === 'JOINING');
    expect(tpl.fields).toEqual(expect.arrayContaining(['employee.full_name', 'contract.number']));
    const bin = (res: NodeJS.ReadableStream, cb: (e: Error | null, b: Buffer) => void) => { const c: Buffer[] = []; res.on('data', (d: Buffer) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); };
    const pdf = await api(app).post(`${B}/letters`).set(bearer(hro)).send({ template_id: tpl.id, employee_id: p.id, format: 'pdf' }).buffer(true).parse(bin as never);
    expect(pdf.status).toBe(201);
    expect((pdf.body as Buffer).subarray(0, 4).toString()).toBe('%PDF');
    expect(pdf.headers['x-letter-number']).toMatch(/^LT\//);
    const docx = await api(app).post(`${B}/letters`).set(bearer(hro)).send({ template_id: tpl.id, employee_id: p.id, format: 'docx' }).buffer(true).parse(bin as never);
    expect((docx.body as Buffer).subarray(0, 2).toString()).toBe('PK');
    const issued = (await api(app).get(`${B}/letters`).query({ employee_id: p.id }).set(bearer(hro))).body;
    expect(issued).toHaveLength(2);
    const hrm = await login(app, 'hr.manager');
    expect((await api(app).post(`${B}/letter-templates`).set(bearer(hrm)).send({ code: 'BAD', name: 'Bad', body: 'Dear {{employee.shoe_size}}, hello there' })).status).toBe(422);
  });
});
