import { api, bearer, closeApp, db, idOf, login, PASSWORD, testApp, uniq } from './helpers';

afterAll(closeApp);

const B = '/api/v1';

async function person(opts: { hire?: string; basic?: string; from?: string; username?: string } = {}) {
  const app = await testApp();
  const hr = await login(app, 'hr.manager');
  const pay = await login(app, 'payroll');
  const e = (await api(app).post(`${B}/employees`).set(bearer(hr)).send({ first_name: 'Paid', last_name: `Person${uniq()}`, employment_type: 'permanent', status: 'active', hire_date: opts.hire ?? '2020-01-06', position_id: await idOf(app, 'position', 'code', 'ICTO') })).body;
  if (opts.basic) {
    const r = await api(app).put(`${B}/employees/${e.id}/salary`).set(bearer(pay)).send({ basic: opts.basic, effective_from: opts.from ?? (opts.hire && opts.hire > '2026-01-01' ? opts.hire : '2026-01-01') });
    expect(r.status).toBe(200);
  }
  let token: string | null = null;
  if (opts.username) {
    const admin = await login(app, 'admin');
    const u = (await api(app).post(`${B}/users`).set(bearer(admin)).send({ username: opts.username, display_name: e.display_name, password: PASSWORD, roles: [{ role_id: await idOf(app, 'role', 'code', 'employee'), scope: 'own' }] })).body;
    await api(app).put(`${B}/employees/${e.id}/user`).set(bearer(admin)).send({ user_id: u.id });
    await db(app).query(`UPDATE user_account SET must_change_password = false WHERE id = $1`, [u.id]);
    token = await login(app, opts.username);
  }
  return { id: e.id as string, staff: e.staff_number as string, token };
}

async function approveRun(runId: string) {
  const app = await testApp();
  for (const who of ['hr.manager', 'finance']) {
    const t = await login(app, who);
    const task = (await api(app).get(`${B}/workflow/inbox`).set(bearer(t))).body.find((x: { subject_id: string }) => x.subject_id === runId);
    expect(task).toBeDefined();
    const d = await api(app).post(`${B}/workflow/tasks/${task.id}/decision`).set(bearer(t)).send({ decision: 'approve' });
    expect(d.status).toBe(200);
  }
}

describe('payroll run', () => {
  it('calculate, review, approve, lock, pay and close; payslips, files, journal and self-service', async () => {
    const app = await testApp();
    const pay = await login(app, 'payroll');
    const p = await person({ basic: '100000.00', username: `pay.${uniq().toLowerCase()}` });
    const loanComponent = (await api(app).get(`${B}/payroll/components`).set(bearer(pay))).body.find((c: { code: string }) => c.code === 'LOAN');
    const loan = await api(app).post(`${B}/payroll/loans`).set(bearer(pay)).send({ employee_id: p.id, component_id: loanComponent.id, principal: '15000.00', installment: '10000.00', start_period: '2026-02' });
    expect(loan.status).toBe(201);

    const run = await api(app).post(`${B}/payroll/runs`).set(bearer(pay)).send({ period: '2026-02' });
    expect(run.status).toBe(201);
    expect(run.body).toMatchObject({ status: 'draft', period_start: '2026-02-01', period_end: '2026-02-28', pay_date: '2026-02-27' });
    expect((await api(app).post(`${B}/payroll/runs`).set(bearer(pay)).send({ period: '2026-02' })).status).toBe(409);

    const calc = await api(app).post(`${B}/payroll/runs/${run.body.id}/calculate`).set(bearer(pay));
    expect(calc.status).toBe(200);
    expect(calc.body.status).toBe('calculated');
    expect(calc.body.employees).toBeGreaterThan(10);

    // The worked example from the unit tests, less the loan instalment.
    let slips = (await api(app).get(`${B}/payroll/runs/${run.body.id}/payslips`).set(bearer(pay))).body;
    let mine = slips.find((s: { employee_id: string }) => s.employee_id === p.id);
    expect(mine).toMatchObject({ gross: '100000.00', nssf: '6000.00', shif: '2750.00', housing_levy: '1500.00', taxable_pay: '89750.00', paye: '19308.35', net: '60441.65' });
    expect(mine.warnings).toEqual(expect.arrayContaining(['No KRA PIN on record', 'No bank or M-Pesa account; pay by other means']));
    const detail = (await api(app).get(`${B}/payroll/payslips/${mine.id}`).set(bearer(pay))).body;
    expect(detail.lines.find((l: { code: string }) => l.code === 'LOAN')).toMatchObject({ amount: '10000.00', detail: 'balance after: 5000.00' });

    // Recalculation is idempotent until submission.
    const again = await api(app).post(`${B}/payroll/runs/${run.body.id}/calculate`).set(bearer(pay));
    expect(again.body.net).toBe(calc.body.net);
    slips = (await api(app).get(`${B}/payroll/runs/${run.body.id}/payslips`).set(bearer(pay))).body;
    mine = slips.find((s: { employee_id: string }) => s.employee_id === p.id);

    // The variance report has nothing to compare with yet: everyone is new.
    const v = (await api(app).get(`${B}/payroll/runs/${run.body.id}/variance`).set(bearer(pay))).body;
    expect(v.previous_period).toBeNull();
    expect(v.rows.every((r: { flag: string }) => r.flag === 'new')).toBe(true);

    // Files wait for approval; staff cannot see a draft payslip.
    expect((await api(app).get(`${B}/payroll/runs/${run.body.id}/export`).query({ file: 'p10' }).set(bearer(pay))).status).toBe(409);
    expect((await api(app).get(`${B}/payroll/payslips/${mine.id}`).set(bearer(p.token!))).status).toBe(404);

    const sub = await api(app).post(`${B}/payroll/runs/${run.body.id}/submit`).set(bearer(pay)).send({});
    expect(sub.body.status).toBe('under_review');
    expect((await api(app).post(`${B}/payroll/runs/${run.body.id}/calculate`).set(bearer(pay))).status).toBe(409);
    // Items for a period under review are frozen.
    const bonus = (await api(app).get(`${B}/payroll/components`).set(bearer(pay))).body.find((c: { code: string }) => c.code === 'BONUS');
    expect((await api(app).post(`${B}/payroll/one-offs`).set(bearer(pay)).send({ employee_id: p.id, component_id: bonus.id, period: '2026-02', amount: '5000.00' })).status).toBe(409);

    await approveRun(run.body.id);
    const approved = (await api(app).get(`${B}/payroll/runs/${run.body.id}`).set(bearer(pay))).body;
    expect(approved.status).toBe('approved');
    const [evt] = await db(app).query(`SELECT data FROM outbox_event WHERE type = 'hr.payroll.run.approved.v1' AND subject = $1`, [run.body.id]);
    expect(evt.data).toMatchObject({ period: '2026-02', net: approved.net });

    // Locked: numbered, unchangeable even directly in the database.
    const lockedRes = await api(app).get(`${B}/payroll/payslips/${mine.id}`).set(bearer(pay));
    const locked = lockedRes.body;
    expect(locked.number).toMatch(/^PS\/202602\/\d+/);
    await expect(db(app).query(`UPDATE payslip SET net = 1 WHERE id = $1`, [mine.id])).rejects.toThrow(/cannot be changed/);
    // Salary changes inside an approved month are refused (pay arrears instead).
    expect((await api(app).put(`${B}/employees/${p.id}/salary`).set(bearer(pay)).send({ basic: '120000.00', effective_from: '2026-02-15' })).status).toBe(409);

    // Self-service: the employee sees and downloads their own payslip and P9.
    const own = (await api(app).get(`${B}/me/payslips`).set(bearer(p.token!))).body;
    expect(own.map((s: { id: string }) => s.id)).toEqual([mine.id]);
    const pdf = await api(app).get(`${B}/payroll/payslips/${mine.id}/pdf`).set(bearer(p.token!)).buffer(true).parse((res, cb) => { const c: Buffer[] = []; res.on('data', (d: Buffer) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); });
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect((pdf.body as Buffer).subarray(0, 4).toString()).toBe('%PDF');
    expect((await api(app).get(`${B}/me/p9`).query({ year: 2026 }).set(bearer(p.token!))).status).toBe(200);
    // …but not someone else's.
    const other = slips.find((s: { employee_id: string }) => s.employee_id !== p.id);
    expect((await api(app).get(`${B}/payroll/payslips/${other.id}`).set(bearer(p.token!))).status).toBe(404);

    // Journal balances; the chart of accounts is still placeholders, so it says so.
    const j = (await api(app).get(`${B}/payroll/runs/${run.body.id}/journal`).set(bearer(pay))).body;
    expect(j.total_debit).toBe(j.total_credit);
    expect(j.unmapped).toEqual(expect.arrayContaining(['EARNINGS', 'NET_PAY']));

    // Files: the Excel bank file, M-Pesa CSV and statutory returns.
    for (const [file, extra, type] of [['payments', { channel: 'bank' }, 'spreadsheetml'], ['payments', { channel: 'mobile_money' }, 'text/csv'], ['p10', {}, 'spreadsheetml'], ['nssf', {}, 'spreadsheetml'], ['shif', {}, 'spreadsheetml'], ['housing_levy', {}, 'spreadsheetml'], ['journal', {}, 'spreadsheetml'], ['register', {}, 'spreadsheetml']] as const) {
      const f = await api(app).get(`${B}/payroll/runs/${run.body.id}/export`).query({ file, ...extra }).set(bearer(pay));
      expect([file, f.status]).toEqual([file, 200]);
      expect(f.headers['content-type']).toContain(type);
      expect(f.headers['content-disposition']).toContain('2026-02');
    }
    const [audit] = await db(app).query(`SELECT count(*)::int AS n FROM audit_log WHERE entity_type = 'PayrollRun' AND entity_id = $1 AND action = 'export'`, [run.body.id]);
    expect(audit.n).toBeGreaterThanOrEqual(6);

    // Finance pays and closes.
    const fin = await login(app, 'finance');
    expect((await api(app).post(`${B}/payroll/runs/${run.body.id}/close`).set(bearer(fin))).status).toBe(409);
    expect((await api(app).post(`${B}/payroll/runs/${run.body.id}/mark-paid`).set(bearer(fin))).body.status).toBe('paid');
    expect((await api(app).post(`${B}/payroll/runs/${run.body.id}/close`).set(bearer(fin))).body.status).toBe('closed');

    // March: the loan's last 5,000 comes off and it settles on approval; variance compares with February.
    const mar = (await api(app).post(`${B}/payroll/runs`).set(bearer(pay)).send({ period: '2026-03' })).body;
    await api(app).post(`${B}/payroll/runs/${mar.id}/calculate`).set(bearer(pay));
    const marMine = (await api(app).get(`${B}/payroll/runs/${mar.id}/payslips`).set(bearer(pay))).body.find((s: { employee_id: string }) => s.employee_id === p.id);
    const marLines = (await api(app).get(`${B}/payroll/payslips/${marMine.id}`).set(bearer(pay))).body.lines;
    expect(marLines.find((l: { code: string }) => l.code === 'LOAN').amount).toBe('5000.00');
    const mv = (await api(app).get(`${B}/payroll/runs/${mar.id}/variance`).set(bearer(pay))).body;
    expect(mv.previous_period).toBe('2026-02');
    expect(mv.rows.find((r: { employee_id: string }) => r.employee_id === p.id)).toMatchObject({ previous_net: '60441.65', current_net: '65441.65', change: '5000.00' });
    await api(app).post(`${B}/payroll/runs/${mar.id}/submit`).set(bearer(pay)).send({});
    await approveRun(mar.id);
    const l = (await api(app).get(`${B}/payroll/loans`).query({ employee_id: p.id }).set(bearer(pay))).body[0];
    expect(l).toMatchObject({ status: 'settled', repaid: '15000.00', balance: '0.00' });
    // An earlier month cannot be started once a later one is approved.
    expect((await api(app).post(`${B}/payroll/runs`).set(bearer(pay)).send({ period: '2026-01' })).status).toBe(409);
  });

  it('a returned run goes back to calculated with the reason; the submitter cannot approve', async () => {
    const app = await testApp();
    const pay = await login(app, 'payroll');
    const run = (await api(app).post(`${B}/payroll/runs`).set(bearer(pay)).send({ period: '2026-04' })).body;
    await api(app).post(`${B}/payroll/runs/${run.id}/calculate`).set(bearer(pay));
    await api(app).post(`${B}/payroll/runs/${run.id}/submit`).set(bearer(pay)).send({});
    expect((await api(app).get(`${B}/workflow/inbox`).set(bearer(pay))).body.find((x: { subject_id: string }) => x.subject_id === run.id)).toBeUndefined();
    const hr = await login(app, 'hr.manager');
    const task = (await api(app).get(`${B}/workflow/inbox`).set(bearer(hr))).body.find((x: { subject_id: string }) => x.subject_id === run.id);
    await api(app).post(`${B}/workflow/tasks/${task.id}/decision`).set(bearer(hr)).send({ decision: 'return', comment: 'Add the April risk allowances first' });
    const back = (await api(app).get(`${B}/payroll/runs/${run.id}`).set(bearer(pay))).body;
    expect(back).toMatchObject({ status: 'calculated', decision_comment: 'Add the April risk allowances first' });
    expect((await api(app).delete(`${B}/payroll/runs/${run.id}`).set(bearer(pay))).status).toBe(204);
  });
});

describe('proration and unpaid leave', () => {
  it('a joiner on 16 March is paid for the working days from then; unpaid leave comes off at the daily rate', async () => {
    const app = await testApp();
    const pay = await login(app, 'payroll');
    const joiner = await person({ hire: '2026-05-18', basic: '66000.00' });
    const run = (await api(app).post(`${B}/payroll/runs`).set(bearer(pay)).send({ period: '2026-05' })).body;
    await api(app).post(`${B}/payroll/runs/${run.id}/calculate`).set(bearer(pay));
    const slip = (await api(app).get(`${B}/payroll/runs/${run.id}/payslips`).set(bearer(pay))).body.find((s: { employee_id: string }) => s.employee_id === joiner.id);
    // May 2026: 20 working days (Labour Day on Friday 1 May); from Monday 18 May: 10.
    expect(slip.basic).toBe('33000.00');
    const lines = (await api(app).get(`${B}/payroll/payslips/${slip.id}`).set(bearer(pay))).body.lines;
    expect(lines.find((l: { code: string }) => l.code === 'BASIC').detail).toBe('10 of 20 days');

    // Two days of approved unpaid leave in the month.
    const unpaid = (await db(app).query(`SELECT id FROM leave_type WHERE code = 'unpaid'`))[0].id;
    await db(app).query(`INSERT INTO leave_request (number, employee_id, leave_type_id, start_date, end_date, days, status, leave_year) VALUES ($1, $2, $3, '2026-05-21', '2026-05-22', 2, 'approved', 2026)`, [`T-${uniq()}`, joiner.id, unpaid]);
    await api(app).post(`${B}/payroll/runs/${run.id}/calculate`).set(bearer(pay));
    const after = (await api(app).get(`${B}/payroll/runs/${run.id}/payslips`).set(bearer(pay))).body.find((s: { employee_id: string }) => s.employee_id === joiner.id);
    // 66,000 / 20 = 3,300 a day × 2
    expect(after.basic).toBe('26400.00');
    await api(app).delete(`${B}/payroll/runs/${run.id}`).set(bearer(pay));
  });
});

describe('setup', () => {
  it('rate tables: validated, a new table closes the old one, and tables used by an approved payroll are frozen', async () => {
    const app = await testApp();
    const pay = await login(app, 'payroll');
    const bad = await api(app).post(`${B}/payroll/statutory-rates`).set(bearer(pay)).send({ code: 'NSSF', effective_from: '2027-02-01', params: { rate: 6, lel: 9000, uel: 100 } });
    expect(bad.status).toBe(422);
    const next = await api(app).post(`${B}/payroll/statutory-rates`).set(bearer(pay)).send({ code: 'NSSF', effective_from: '2027-02-01', params: { rate: 0.06, lel: 9000, uel: 144000 }, source: 'Year 5 (example)' });
    expect(next.status).toBe(201);
    const rates = (await api(app).get(`${B}/payroll/statutory-rates`).set(bearer(pay))).body.filter((r: { code: string }) => r.code === 'NSSF');
    expect(rates.find((r: { effective_from: string }) => r.effective_from === '2026-02-01').effective_to).toBe('2027-01-31');
    // February 2026 was approved in the run test above (files run in order within this file).
    const y4 = rates.find((r: { effective_from: string }) => r.effective_from === '2026-02-01');
    const edit = await api(app).put(`${B}/payroll/statutory-rates/${y4.id}`).set(bearer(pay)).set('If-Match', `"${y4.version}"`).send({ code: 'NSSF', effective_from: '2026-02-01', effective_to: '2027-01-31', params: { rate: 0.07, lel: 9000, uel: 108000 } });
    expect(edit.status).toBe(409);
    expect((await api(app).delete(`${B}/payroll/statutory-rates/${next.body.id}`).set(bearer(pay))).status).toBe(204);
  });

  it('formulas are checked before they are saved', async () => {
    const app = await testApp();
    const pay = await login(app, 'payroll');
    expect((await api(app).post(`${B}/payroll/components/check-formula`).set(bearer(pay)).send({ formula: 'min(basic * 0.1, 8000)', basic: 50000 })).body).toEqual({ ok: true, value: 5000, message: null });
    const r = await api(app).post(`${B}/payroll/components`).set(bearer(pay)).send({ code: `X${uniq().toUpperCase().replace(/[^A-Z0-9]/g, '')}`.slice(0, 20), name: 'Bad', kind: 'earning', method: 'formula', formula: 'salary * 2' });
    expect(r.status).toBe(422);
    expect(r.body.errors[0]).toMatchObject({ path: 'formula', message: 'Unknown name "salary"' });
  });

  it('access: only payroll roles see runs and salaries', async () => {
    const app = await testApp();
    const head = await login(app, 'head.nursing');
    expect((await api(app).get(`${B}/payroll/runs`).set(bearer(head))).status).toBe(403);
    const p = await person({ basic: '50000.00', from: '2026-12-01' });
    expect((await api(app).get(`${B}/employees/${p.id}/pay`).set(bearer(head))).status).toBe(403);
    const hrm = await login(app, 'hr.manager');
    expect((await api(app).get(`${B}/employees/${p.id}/pay`).set(bearer(hrm))).body.salaries[0].basic).toBe('50000.00');
    expect((await api(app).put(`${B}/employees/${p.id}/salary`).set(bearer(hrm)).send({ basic: '1.00', effective_from: '2026-12-01' })).status).toBe(403);
  });
});
