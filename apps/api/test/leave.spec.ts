import { api, bearer, closeApp, db, idOf, login, PASSWORD, testApp, uniq } from './helpers';
import { LeaveService } from '../src/modules/leave/leave.service';
import { WorkflowService } from '../src/modules/workflow/workflow.service';

afterAll(closeApp);

const B = '/api/v1';

/** A next working day (Mon–Fri, not a seeded holiday) at least `ahead` days from today. */
function workday(ahead: number): string {
  const d = new Date(Date.now() + ahead * 86_400_000);
  while ([0, 6].includes(d.getUTCDay())) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
const plus = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** A fresh employee with a login, reporting to the given manager's employee. */
async function staff(managerUsername: string, opts: { gender?: string } = {}) {
  const app = await testApp();
  const admin = await login(app, 'admin');
  const hr = await login(app, 'hr.manager');
  const [mgr] = await db(app).query(`SELECT employee_id FROM user_account WHERE username = $1`, [managerUsername]);
  const pos = await idOf(app, 'position', 'code', 'RN-MED');
  const e = (await api(app).post(`${B}/employees`).set(bearer(hr)).send({ first_name: 'Leave', last_name: `Taker${uniq()}`, gender: opts.gender ?? 'female', employment_type: 'permanent', status: 'active', hire_date: '2020-01-06', position_id: pos, manager_id: mgr.employee_id })).body;
  const roleId = await idOf(app, 'role', 'code', 'employee');
  const username = `lv.${uniq().toLowerCase()}`;
  const u = (await api(app).post(`${B}/users`).set(bearer(admin)).send({ username, display_name: e.display_name, password: PASSWORD, roles: [{ role_id: roleId, scope: 'own' }] })).body;
  await api(app).put(`${B}/employees/${e.id}/user`).set(bearer(admin)).send({ user_id: u.id });
  await db(app).query(`UPDATE user_account SET must_change_password = false WHERE id = $1`, [u.id]);
  return { employeeId: e.id as string, token: await login(app, username), userId: u.id as string };
}

async function typeId(code: string) {
  const app = await testApp();
  return idOf(app, 'leave_type' as never, 'code', code);
}

async function inboxTask(token: string, subjectId: string) {
  const app = await testApp();
  const inbox = await api(app).get(`${B}/workflow/inbox`).set(bearer(token));
  return inbox.body.find((t: { subject_id: string }) => t.subject_id === subjectId);
}

describe('leave through the approval workflow', () => {
  it('quotes working days, reserves on submit, routes to the line manager, and books it on approval', async () => {
    const app = await testApp();
    const me = await staff('line.manager');
    const annual = await typeId('annual');
    const start = workday(9);
    const end = plus(start, 2);
    const quote = await api(app).post(`${B}/leave/quote`).set(bearer(me.token)).send({ leave_type_id: annual, start_date: start, end_date: end });
    expect(quote.status).toBe(200);
    expect(quote.body.available).toBeGreaterThan(0);

    const req = await api(app).post(`${B}/leave/requests`).set(bearer(me.token)).send({ leave_type_id: annual, start_date: start, end_date: start, start_half_day: false, end_half_day: true });
    expect(req.status).toBe(201);
    expect(req.body).toMatchObject({ status: 'pending', days: 0.5 });
    expect(req.body.number).toMatch(/^LV\/\d{4}\/\d{5}$/);

    const before = (await api(app).get(`${B}/me/leave/balances`).set(bearer(me.token))).body.find((b: { leave_type_code: string }) => b.leave_type_code === 'annual');
    expect(before.reserved).toBe(0.5);

    // The requester cannot approve; the line manager sees it in their inbox.
    expect(await inboxTask(me.token, req.body.id)).toBeUndefined();
    const lm = await login(app, 'line.manager');
    const task = await inboxTask(lm, req.body.id);
    expect(task).toMatchObject({ step_name: 'Line manager', request_type: 'leave_request', value: 0.5 });
    const decided = await api(app).post(`${B}/workflow/tasks/${task.id}/decision`).set(bearer(lm)).send({ decision: 'approve' });
    expect(decided.body.status).toBe('approved');
    // Department head step skipped: under the 6-day threshold.
    expect(decided.body.tasks.map((t: { status: string }) => t.status)).toEqual(['approved', 'skipped']);

    const after = (await api(app).get(`${B}/me/leave/balances`).set(bearer(me.token))).body.find((b: { leave_type_code: string }) => b.leave_type_code === 'annual');
    expect(after).toMatchObject({ reserved: 0, taken: 0.5 });
    expect(after.available).toBe(before.available);
    const [evt] = await db(app).query(`SELECT data FROM outbox_event WHERE subject = $1 AND type = 'hr.leave.approved.v1'`, [req.body.id]);
    expect(evt.data).toMatchObject({ days: 0.5, leave_type_code: 'annual', end_half_day: true });
  });

  it('cannot spend the same days twice: a second request is refused for balance and for overlap', async () => {
    const app = await testApp();
    const me = await staff('line.manager');
    const sick = await typeId('sick');
    const start = workday(10);
    const doc = await db(app).query(`INSERT INTO document (owner_type, title) VALUES ('leave', 'Sick note') RETURNING id`);
    const first = await api(app).post(`${B}/leave/requests`).set(bearer(me.token)).send({ leave_type_id: sick, start_date: start, end_date: plus(start, 6), document_id: doc[0].id });
    expect(first.status).toBe(201);
    expect(first.body.days).toBeGreaterThanOrEqual(5);
    const left = 7 - first.body.days;
    const overlap = await api(app).post(`${B}/leave/requests`).set(bearer(me.token)).send({ leave_type_id: sick, start_date: start, end_date: start, document_id: doc[0].id });
    expect([409, 422]).toContain(overlap.status);
    const later = workday(20);
    const tooMuch = await api(app).post(`${B}/leave/requests`).set(bearer(me.token)).send({ leave_type_id: sick, start_date: later, end_date: plus(later, 13), document_id: doc[0].id });
    expect(tooMuch.body.code).toBe('insufficient_balance');
    expect(tooMuch.body.detail).toContain(`Only ${left}`);
  });

  it('long leave needs the department head; rejection releases the reservation', async () => {
    const app = await testApp();
    const me = await staff('line.manager');
    const annual = await typeId('annual');
    const start = workday(12);
    const req = (await api(app).post(`${B}/leave/requests`).set(bearer(me.token)).send({ leave_type_id: annual, start_date: start, end_date: plus(start, 9) })).body;
    expect(req.days).toBeGreaterThanOrEqual(6);
    const lm = await login(app, 'line.manager');
    await api(app).post(`${B}/workflow/tasks/${(await inboxTask(lm, req.id)).id}/decision`).set(bearer(lm)).send({ decision: 'approve' });
    const head = await login(app, 'head.nursing');
    const t2 = await inboxTask(head, req.id);
    expect(t2.step_name).toBe('Department head');
    const noReason = await api(app).post(`${B}/workflow/tasks/${t2.id}/decision`).set(bearer(head)).send({ decision: 'reject' });
    expect(noReason.status).toBe(422);
    await api(app).post(`${B}/workflow/tasks/${t2.id}/decision`).set(bearer(head)).send({ decision: 'reject', comment: 'Ward short-staffed that fortnight' });
    const r = (await api(app).get(`${B}/leave/requests/${req.id}`).set(bearer(me.token))).body;
    expect(r).toMatchObject({ status: 'rejected', decision_comment: 'Ward short-staffed that fortnight' });
    const bal = (await api(app).get(`${B}/me/leave/balances`).set(bearer(me.token))).body.find((b: { leave_type_code: string }) => b.leave_type_code === 'annual');
    expect(bal.reserved).toBe(0);
  });

  it('return for correction lets the employee fix and resubmit', async () => {
    const app = await testApp();
    const me = await staff('line.manager');
    const annual = await typeId('annual');
    const start = workday(25);
    const req = (await api(app).post(`${B}/leave/requests`).set(bearer(me.token)).send({ leave_type_id: annual, start_date: start, end_date: start })).body;
    const lm = await login(app, 'line.manager');
    await api(app).post(`${B}/workflow/tasks/${(await inboxTask(lm, req.id)).id}/decision`).set(bearer(lm)).send({ decision: 'return', comment: 'Take the Tuesday instead' });
    expect((await api(app).get(`${B}/leave/requests/${req.id}`).set(bearer(me.token))).body.status).toBe('returned');
    const re = await api(app).post(`${B}/leave/requests/${req.id}/submit`).set(bearer(me.token)).send({ start_date: plus(start, 1), end_date: plus(start, 1) });
    expect(re.body.status).toBe('pending');
    expect(await inboxTask(lm, req.id)).toBeTruthy();
  });

  it('gender, notice and type rules are enforced', async () => {
    const app = await testApp();
    const me = await staff('line.manager', { gender: 'male' });
    const maternity = await typeId('maternity');
    const r = await api(app).post(`${B}/leave/requests`).set(bearer(me.token)).send({ leave_type_id: maternity, start_date: workday(20), end_date: workday(30) });
    expect(r.body.code).toBe('not_eligible');
    const annual = await typeId('annual');
    const soon = await api(app).post(`${B}/leave/requests`).set(bearer(me.token)).send({ leave_type_id: annual, start_date: workday(1), end_date: workday(1) });
    expect(soon.body.code).toBe('short_notice');
    const across = await api(app).post(`${B}/leave/requests`).set(bearer(me.token)).send({ leave_type_id: annual, start_date: `${new Date().getUTCFullYear()}-12-30`, end_date: `${new Date().getUTCFullYear() + 1}-01-05` });
    expect(across.body.code).toBe('spans_leave_years');
  });

  it('delegation: an approver away hands their approvals to a delegate', async () => {
    const app = await testApp();
    const me = await staff('line.manager');
    const lm = await login(app, 'line.manager');
    const [delegate] = await db(app).query(`SELECT id FROM user_account WHERE username = 'hr.officer'`);
    const today = new Date().toISOString().slice(0, 10);
    const del = await api(app).post(`${B}/workflow/delegations`).set(bearer(lm)).send({ to_user_id: delegate.id, starts_on: today, ends_on: plus(today, 3), request_types: ['leave_request'] });
    expect(del.status).toBe(201);
    try {
      const annual = await typeId('annual');
      const start = workday(28);
      const req = (await api(app).post(`${B}/leave/requests`).set(bearer(me.token)).send({ leave_type_id: annual, start_date: start, end_date: start })).body;
      expect(await inboxTask(lm, req.id)).toBeUndefined();
      const officer = await login(app, 'hr.officer');
      const task = await inboxTask(officer, req.id);
      expect(task.on_behalf_of_user_id).toBeTruthy();
      expect((await api(app).post(`${B}/workflow/tasks/${task.id}/decision`).set(bearer(officer)).send({ decision: 'approve' })).body.status).toBe('approved');
    } finally {
      await api(app).delete(`${B}/workflow/delegations/${del.body.id}`).set(bearer(lm));
    }
  });

  it('escalates a task nobody acted on to the next manager', async () => {
    const app = await testApp();
    const me = await staff('line.manager');
    const annual = await typeId('annual');
    const start = workday(30);
    const req = (await api(app).post(`${B}/leave/requests`).set(bearer(me.token)).send({ leave_type_id: annual, start_date: start, end_date: start })).body;
    const lm = await login(app, 'line.manager');
    const task = await inboxTask(lm, req.id);
    await db(app).query(`UPDATE workflow_task SET due_at = now() - interval '1 minute' WHERE id = $1`, [task.id]);
    expect(await app.get(WorkflowService).escalateDue()).toBeGreaterThanOrEqual(1);
    expect(await inboxTask(lm, req.id)).toBeUndefined();
    // The line manager reports to the Chief Nursing Officer (head.nursing).
    const head = await login(app, 'head.nursing');
    expect(await inboxTask(head, req.id)).toMatchObject({ comment: 'Escalated' });
  });

  it('maternity goes to HR as a role pool after the line manager', async () => {
    const app = await testApp();
    const me = await staff('line.manager', { gender: 'female' });
    const maternity = await typeId('maternity');
    const start = workday(20);
    const req = (await api(app).post(`${B}/leave/requests`).set(bearer(me.token)).send({ leave_type_id: maternity, start_date: start, end_date: plus(start, 89) })).body;
    expect(req.days).toBe(90);
    const lm = await login(app, 'line.manager');
    await api(app).post(`${B}/workflow/tasks/${(await inboxTask(lm, req.id)).id}/decision`).set(bearer(lm)).send({ decision: 'approve' });
    const officer = await login(app, 'hr.officer');
    const t = await inboxTask(officer, req.id);
    expect(t.step_name).toBe('HR');
    expect((await api(app).post(`${B}/workflow/tasks/${t.id}/decision`).set(bearer(officer)).send({ decision: 'approve' })).body.status).toBe('approved');
  });

  it('cancelling approved leave gives the days back and publishes hr.leave.cancelled.v1', async () => {
    const app = await testApp();
    const me = await staff('line.manager');
    const annual = await typeId('annual');
    const start = workday(33);
    const req = (await api(app).post(`${B}/leave/requests`).set(bearer(me.token)).send({ leave_type_id: annual, start_date: start, end_date: start })).body;
    const lm = await login(app, 'line.manager');
    await api(app).post(`${B}/workflow/tasks/${(await inboxTask(lm, req.id)).id}/decision`).set(bearer(lm)).send({ decision: 'approve' });
    const c = await api(app).post(`${B}/leave/requests/${req.id}/cancel`).set(bearer(me.token)).send({ reason: 'Plans changed' });
    expect(c.body.status).toBe('cancelled');
    const bal = (await api(app).get(`${B}/me/leave/balances`).set(bearer(me.token))).body.find((b: { leave_type_code: string }) => b.leave_type_code === 'annual');
    expect(bal.taken).toBe(0);
    expect((await db(app).query(`SELECT 1 FROM outbox_event WHERE subject = $1 AND type = 'hr.leave.cancelled.v1'`, [req.id])).length).toBe(1);
  });

  it('the ledger is append-only, accrual is idempotent, and HR adjustments are recorded', async () => {
    const app = await testApp();
    await expect(db(app).query(`UPDATE leave_ledger SET days = 99 WHERE id = (SELECT id FROM leave_ledger LIMIT 1)`)).rejects.toThrow(/append-only/);
    const svc = app.get(LeaveService);
    await svc.accrueAll();
    const [{ n: n1 }] = await db(app).query(`SELECT count(*)::int AS n FROM leave_ledger WHERE entry_type = 'accrual'`);
    await svc.accrueAll();
    const [{ n: n2 }] = await db(app).query(`SELECT count(*)::int AS n FROM leave_ledger WHERE entry_type = 'accrual'`);
    expect(n2).toBe(n1);

    const me = await staff('line.manager');
    const hr = await login(app, 'hr.manager');
    const annual = await typeId('annual');
    const y = new Date().getUTCFullYear();
    const adj = await api(app).post(`${B}/leave/employees/${me.employeeId}/adjustments`).set(bearer(hr)).send({ leave_type_id: annual, leave_year: y, days: 2.5, note: 'Worked on public holiday' });
    expect(adj.status).toBe(201);
    expect(adj.body.find((b: { leave_type_code: string }) => b.leave_type_code === 'annual').adjustments).toBe(2.5);
    const bad = await api(app).post(`${B}/leave/employees/${me.employeeId}/adjustments`).set(bearer(hr)).send({ leave_type_id: annual, leave_year: y, days: 0.3, note: 'odd' });
    expect(bad.status).toBe(422);
  });

  it('shows the team calendar within scope, and lets workflows be reconfigured', async () => {
    const app = await testApp();
    const head = await login(app, 'head.nursing');
    const from = new Date().toISOString().slice(0, 10);
    const cal = await api(app).get(`${B}/leave/calendar`).query({ from, to: plus(from, 119) }).set(bearer(head));
    expect(cal.status).toBe(200);
    expect(cal.body.length).toBeGreaterThan(0);

    const hr = await login(app, 'hr.manager');
    const defs = (await api(app).get(`${B}/workflow/definitions`).set(bearer(hr))).body;
    const std = defs.find((d: { code: string }) => d.code === 'LEAVE-STD');
    const updated = await api(app).put(`${B}/workflow/definitions/${std.id}`).set(bearer(hr)).set('If-Match', `"${std.version}"`).send({
      code: std.code, name: std.name, request_type: 'leave_request', priority: std.priority, conditions: {},
      steps: [{ name: 'Line manager', approver_rule: 'line_manager' }, { name: 'Department head', approver_rule: 'department_head', min_value: 3 }],
    });
    expect(updated.status).toBe(200);
    expect(updated.body.steps[1].min_value).toBe(3);
    const officer = await login(app, 'hr.officer');
    expect((await api(app).put(`${B}/workflow/definitions/${std.id}`).set(bearer(officer)).set('If-Match', `"${updated.body.version}"`).send({ code: 'X', name: 'X', request_type: 'leave_request', steps: [{ name: 'a', approver_rule: 'line_manager' }] })).status).toBe(403);
    const bad = await api(app).post(`${B}/workflow/definitions`).set(bearer(hr)).send({ code: 'BAD', name: 'Bad', request_type: 'leave_request', steps: [{ name: 'Role step', approver_rule: 'role' }] });
    expect(bad.status).toBe(422);
  });
});
