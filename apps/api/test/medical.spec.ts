import { MedicalService } from '../src/modules/medical/medical.service';
import { api, bearer, closeApp, db, idOf, login, PASSWORD, testApp, uniq } from './helpers';

afterAll(closeApp);

const B = '/api/v1';

async function user(username: string, role: string, scope = 'organisation') {
  const app = await testApp();
  const admin = await login(app, 'admin');
  const u = (await api(app).post(`${B}/users`).set(bearer(admin)).send({ username, display_name: username, password: PASSWORD, roles: [{ role_id: await idOf(app, 'role', 'code', role), scope }] })).body;
  await db(app).query(`UPDATE user_account SET must_change_password = false WHERE id = $1`, [u.id]);
  return { id: u.id as string, token: await login(app, username) };
}

async function staff() {
  const app = await testApp();
  const hr = await login(app, 'hr.manager');
  const admin = await login(app, 'admin');
  const e = (await api(app).post(`${B}/employees`).set(bearer(hr)).send({ first_name: 'Covered', last_name: `Member${uniq()}`, employment_type: 'permanent', status: 'active', hire_date: '2020-01-06', position_id: await idOf(app, 'position', 'code', 'ICTO') })).body;
  const username = `med.${uniq().toLowerCase()}`;
  const u = (await api(app).post(`${B}/users`).set(bearer(admin)).send({ username, display_name: e.display_name, password: PASSWORD, roles: [{ role_id: await idOf(app, 'role', 'code', 'employee'), scope: 'own' }] })).body;
  await api(app).put(`${B}/employees/${e.id}/user`).set(bearer(admin)).send({ user_id: u.id });
  await db(app).query(`UPDATE user_account SET must_change_password = false WHERE id = $1`, [u.id]);
  return { id: e.id as string, staff: e.staff_number as string, token: await login(app, username) };
}

async function approve(subjectId: string) {
  const app = await testApp();
  for (const who of ['hr.officer', 'hr.manager']) {
    const t = await login(app, who);
    const task = (await api(app).get(`${B}/workflow/inbox`).set(bearer(t))).body.find((x: { subject_id: string }) => x.subject_id === subjectId);
    expect([who, !!task]).toEqual([who, true]);
    expect((await api(app).post(`${B}/workflow/tasks/${task.id}/decision`).set(bearer(t)).send({ decision: 'approve' })).status).toBe(200);
  }
}

const balanceOf = (cover: { balances: { category_code: string; remaining: string; used: string; held: string; utilisation_pct: number }[] }, code: string) => cover.balances.find((b) => b.category_code === code)!;

describe('medical scheme', () => {
  let schemeId = '';
  let principal = '';
  let child = '';
  let member: Awaited<ReturnType<typeof staff>>;
  let billing: { token: string };
  const OPD = `OPD ${uniq()}`;

  it('HR sets up a scheme: categories, dated limits by grade, contributions', async () => {
    const app = await testApp();
    const hr = await login(app, 'hr.manager');
    const s = await api(app).post(`${B}/medical/schemes`).set(bearer(hr)).send({ code: `T${uniq().toUpperCase().replace(/[^A-Z0-9]/g, '')}`.slice(0, 12), name: 'Test scheme', max_dependants: 2, over_limit_action: 'approval', contributions_enabled: true });
    expect(s.status).toBe(201);
    schemeId = s.body.id;
    const op = (await api(app).post(`${B}/medical/schemes/${schemeId}/categories`).set(bearer(hr)).send({ code: 'outpatient', name: 'Outpatient', sharing: 'shared', co_pay_pct: 10, per_visit_cap: '20000.00' })).body;
    const dental = (await api(app).post(`${B}/medical/schemes/${schemeId}/categories`).set(bearer(hr)).send({ code: 'dental', name: 'Dental', sharing: 'per_person' })).body;
    const mat = (await api(app).post(`${B}/medical/schemes/${schemeId}/categories`).set(bearer(hr)).send({ code: 'maternity', name: 'Maternity', principal_and_spouse_only: true, waiting_days: 270 })).body;
    expect((await api(app).post(`${B}/medical/schemes/${schemeId}/limit-rules`).set(bearer(hr)).send({ category_id: op.id, annual_limit: '40000.00', effective_from: '2026-01-01' })).status).toBe(201);
    // A higher limit from 1 June closes the first one the day before.
    expect((await api(app).post(`${B}/medical/schemes/${schemeId}/limit-rules`).set(bearer(hr)).send({ category_id: op.id, annual_limit: '50000.00', effective_from: '2026-06-01' })).status).toBe(201);
    await api(app).post(`${B}/medical/schemes/${schemeId}/limit-rules`).set(bearer(hr)).send({ category_id: dental.id, annual_limit: '10000.00', dependant_limit: '5000.00', effective_from: '2026-01-01' });
    await api(app).post(`${B}/medical/schemes/${schemeId}/limit-rules`).set(bearer(hr)).send({ category_id: mat.id, annual_limit: '100000.00', effective_from: '2026-01-01' });
    await api(app).post(`${B}/medical/schemes/${schemeId}/contribution-rates`).set(bearer(hr)).send({ method: 'fixed', value: 1000, per_dependant: '250.00', effective_from: '2026-01-01' });
    const detail = (await api(app).get(`${B}/medical/schemes/${schemeId}`).set(bearer(hr))).body;
    expect(detail.limit_rules.find((r: { annual_limit: string }) => r.annual_limit === '40000.00').effective_to).toBe('2026-05-31');
    expect(detail.categories).toHaveLength(3);
  });

  it('a member of staff applies to join with a child; HR officer then HR manager approve', async () => {
    const app = await testApp();
    member = await staff();
    const tooMany = await api(app).post(`${B}/me/medical/applications`).set(bearer(member.token)).send({ kind: 'enrol', scheme_id: schemeId, dependants: [1, 2, 3].map((n) => ({ name: `Kid ${n}`, relationship: 'child', date_of_birth: '2015-01-01' })) });
    expect(tooMany.status).toBe(422);
    const a = await api(app).post(`${B}/me/medical/applications`).set(bearer(member.token)).send({ kind: 'enrol', scheme_id: schemeId, dependants: [{ name: 'Little Member', relationship: 'child', date_of_birth: '2019-05-01' }] });
    expect(a.status).toBe(201);
    expect(a.body.status).toBe('pending');
    await approve(a.body.id);
    const mineRes = await api(app).get(`${B}/me/medical`).set(bearer(member.token));
    const mine = mineRes.body;
    expect(mine.applications[0].status).toBe('approved');
    const cover = mine.memberships[0];
    principal = cover.id;
    child = cover.family.find((f: { relationship: string }) => f.relationship === 'child').id;
    expect(cover.member_number).toMatch(new RegExp(`-${member.staff}-00$`));
    expect(balanceOf(cover, 'outpatient')).toMatchObject({ remaining: '50000.00' });
    expect(balanceOf(cover, 'dental')).toMatchObject({ remaining: '10000.00' });
    const [evt] = await db(app).query(`SELECT count(*)::int AS n FROM outbox_event WHERE type = 'hr.medical.enrolled.v1' AND data->>'employee_id' = $1`, [member.id]);
    expect(evt.n).toBe(2);

    // Adding a spouse needs a marriage certificate, uploaded by the member.
    const noDoc = await api(app).post(`${B}/me/medical/applications`).set(bearer(member.token)).send({ kind: 'add_dependant', scheme_id: schemeId, dependant: { name: 'Spouse Member', relationship: 'spouse', date_of_birth: '1990-02-02' }, document_ids: [] });
    expect(noDoc.status).toBe(422);
    const doc = await api(app).post(`${B}/me/medical/documents`).set(bearer(member.token)).attach('file', Buffer.from('%PDF-1.4\n% marriage certificate\n'), { filename: 'marriage.pdf', contentType: 'application/pdf' });
    expect(doc.status).toBe(201);
    const add = await api(app).post(`${B}/me/medical/applications`).set(bearer(member.token)).send({ kind: 'add_dependant', scheme_id: schemeId, dependant: { name: 'Spouse Member', relationship: 'spouse', date_of_birth: '1990-02-02' }, document_ids: [doc.body.id] });
    expect(add.status).toBe(201);
    await approve(add.body.id);
    const fam = (await api(app).get(`${B}/me/medical`).set(bearer(member.token))).body.memberships[0].family;
    expect(fam.map((f: { relationship: string }) => f.relationship).sort()).toEqual(['child', 'principal', 'spouse']);
    // The scheme allows two dependants: a third is refused.
    expect((await api(app).post(`${B}/me/medical/applications`).set(bearer(member.token)).send({ kind: 'add_dependant', scheme_id: schemeId, dependant: { name: 'Third', relationship: 'child', date_of_birth: '2022-02-02' }, document_ids: [doc.body.id] })).status).toBe(422);
  });

  it('billing: lookup without HR data, claims with co-pay and caps, shared and per-person limits, holds, reversals', async () => {
    const app = await testApp();
    billing = await user(`billing.${uniq().toLowerCase()}`, 'medical_billing');
    const found = (await api(app).get(`${B}/medical/lookup`).query({ q: member.staff }).set(bearer(billing.token))).body;
    expect(found).toHaveLength(3);
    const [audit] = await db(app).query(`SELECT count(*)::int AS n FROM audit_log WHERE entity_type = 'MedicalMember' AND action = 'sensitive_read' AND after->>'lookup' = $1`, [member.staff]);
    expect(audit.n).toBe(1);
    // No pay or HR records for billing staff.
    expect((await api(app).get(`${B}/employees/${member.id}`).set(bearer(billing.token))).status).toBe(403);
    expect((await api(app).get(`${B}/employees/${member.id}/pay`).set(bearer(billing.token))).status).toBe(403);

    const today = new Date().toISOString().slice(0, 10);
    const claim = (body: Record<string, unknown>) => api(app).post(`${B}/medical/claims`).set(bearer(billing.token)).send({ category_code: 'outpatient', occurred_on: today, facility: OPD, invoice_ref: `INV-${uniq()}`, ...body });
    // 10% co-pay: invoice 10,000 → scheme 9,000.
    const c1 = await claim({ member_id: principal, invoice_amount: '10000.00' });
    expect(c1.status).toBe(201);
    expect(c1.body).toMatchObject({ status: 'posted', remaining: '41000.00', claim: { amount: '9000.00', member_share: '1000.00' } });
    // The child draws on the same (shared) outpatient limit: 30,000 less 10% is 27,000, capped at 20,000 a visit.
    const c2 = await claim({ member_id: child, invoice_amount: '30000.00' });
    expect(c2.body).toMatchObject({ remaining: '21000.00', claim: { amount: '20000.00', member_share: '10000.00' } });
    // A hold reserves 12,000: 82% used or held crosses the 80% alert once.
    const h = await api(app).post(`${B}/medical/holds`).set(bearer(billing.token)).send({ member_id: principal, category_code: 'outpatient', amount: '12000.00', expires_on: today });
    expect(h.status).toBe(201);
    let cover = (await api(app).get(`${B}/medical/members/${principal}/cover`).set(bearer(billing.token))).body;
    expect(balanceOf(cover, 'outpatient')).toMatchObject({ remaining: '9000.00', held: '12000.00', utilisation_pct: 82 });
    const [alert] = await db(app).query(`SELECT count(*)::int AS n FROM outbox_event WHERE type = 'hr.medical.limit_threshold.v1' AND subject = $1 AND (data->>'threshold')::int = 80`, [principal]);
    expect(alert.n).toBe(1);
    // A hold cannot spend the same money twice.
    expect((await api(app).post(`${B}/medical/holds`).set(bearer(billing.token)).send({ member_id: principal, category_code: 'outpatient', amount: '9500.00', expires_on: today })).status).toBe(422);
    // Claiming against the hold releases it: 12,000 invoice → 10,800.
    const c3 = await claim({ member_id: principal, invoice_amount: '12000.00', hold_id: h.body.id });
    expect(c3.body.remaining).toBe('10200.00');
    expect((await claim({ member_id: principal, invoice_amount: '100.00', hold_id: h.body.id })).status).toBe(409);

    // A wrong entry is reversed, never edited.
    const rev = await api(app).post(`${B}/medical/claims/${c1.body.claim.id}/reverse`).set(bearer(billing.token)).send({ reason: 'Billed to the wrong patient' });
    expect(rev.status).toBe(201);
    expect((await api(app).post(`${B}/medical/claims/${c1.body.claim.id}/reverse`).set(bearer(billing.token)).send({ reason: 'Again' })).status).toBe(409);
    await expect(db(app).query(`UPDATE medical_ledger SET amount = 1 WHERE id = $1`, [c1.body.claim.id])).rejects.toThrow(/append-only/);
    cover = (await api(app).get(`${B}/medical/members/${principal}/cover`).set(bearer(billing.token))).body;
    expect(balanceOf(cover, 'outpatient').remaining).toBe('19200.00');

    // Per-person dental: the child's own 5,000; the principal's 10,000 is untouched.
    await api(app).post(`${B}/medical/claims`).set(bearer(billing.token)).send({ member_id: child, category_code: 'dental', occurred_on: today, invoice_amount: '5000.00', facility: 'Dental clinic', invoice_ref: `D-${uniq()}` });
    expect(balanceOf((await api(app).get(`${B}/medical/members/${child}/cover`).set(bearer(billing.token))).body, 'dental').remaining).toBe('0.00');
    expect(balanceOf((await api(app).get(`${B}/medical/members/${principal}/cover`).set(bearer(billing.token))).body, 'dental').remaining).toBe('10000.00');
    // Maternity covers the principal and spouse only, after a waiting period.
    expect((await api(app).post(`${B}/medical/claims`).set(bearer(billing.token)).send({ member_id: child, category_code: 'maternity', occurred_on: today, invoice_amount: '1000.00', facility: 'X', invoice_ref: `M-${uniq()}` })).status).toBe(422);
  });

  it('over the limit: held for approval, then posted when approved', async () => {
    const app = await testApp();
    const today = new Date().toISOString().slice(0, 10);
    // Invoice 30,000 → 27,000, capped at 20,000 a visit; only 19,200 left.
    const over = await api(app).post(`${B}/medical/claims`).set(bearer(billing.token)).send({ member_id: principal, category_code: 'outpatient', occurred_on: today, invoice_amount: '30000.00', facility: 'SIL Hospital', invoice_ref: `O-${uniq()}` });
    expect(over.status).toBe(201);
    expect(over.body).toMatchObject({ status: 'pending_approval', claim: null });
    expect(over.body.message).toContain('KES 20000.00 is more than the KES 19200.00 left');
    await approve(over.body.application_id);
    const cover = (await api(app).get(`${B}/medical/members/${principal}/cover`).set(bearer(billing.token))).body;
    expect(balanceOf(cover, 'outpatient')).toMatchObject({ remaining: '-800.00', used: '50800.00' });
    const [hundred] = await db(app).query(`SELECT count(*)::int AS n FROM outbox_event WHERE type = 'hr.medical.limit_threshold.v1' AND subject = $1 AND (data->>'threshold')::int = 100`, [principal]);
    expect(hundred.n).toBe(1);
  });

  it('HMIS: eligibility, idempotent claims and duplicates, by member number with client scopes', async () => {
    const app = await testApp();
    const admin = await login(app, 'admin');
    const c = (await api(app).post(`${B}/api-clients`).set(bearer(admin)).send({ name: `HMIS billing ${uniq()}`, scopes: ['medical:write'] })).body;
    const token = (await api(app).post(`${B}/oauth/token`).auth(c.client.client_id, c.client_secret).type('form').send({ grant_type: 'client_credentials' })).body.access_token;
    const childNo = (await api(app).get(`${B}/medical/members/${child}/cover`).set(bearer(billing.token))).body.member_number;
    const el = await api(app).get(`${B}/medical/eligibility`).query({ member_number: childNo, category_code: 'optical' }).set(bearer(token));
    expect(el.body).toMatchObject({ eligible: false, reason: 'No such cover in this scheme' });
    const ok = (await api(app).get(`${B}/medical/eligibility`).query({ member_number: childNo, category_code: 'dental' }).set(bearer(token))).body;
    expect(ok).toMatchObject({ eligible: true, balances: [{ remaining: '0.00' }] });

    const today = new Date().toISOString().slice(0, 10);
    const body = { member_number: childNo, category_code: 'outpatient', occurred_on: today, invoice_amount: '0.50', facility: 'HMIS', invoice_ref: 'B-1', external_ref: `hmis-${uniq()}` };
    // The outpatient limit is used up, so this goes to approval; the same key replays the same answer.
    const first = await api(app).post(`${B}/medical/claims`).set(bearer(token)).set('Idempotency-Key', `idem-${uniq()}-x`).send(body);
    const key = first.request.getHeader('Idempotency-Key') as string;
    const again = await api(app).post(`${B}/medical/claims`).set(bearer(token)).set('Idempotency-Key', key).send(body);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.body).toEqual(first.body);
    const [apps] = await db(app).query(`SELECT count(*)::int AS n FROM medical_application WHERE kind = 'over_limit_claim' AND details->'claim'->>'external_ref' = $1`, [body.external_ref]);
    expect(apps.n).toBe(1);
    // Write scope only: no setup.
    expect((await api(app).post(`${B}/medical/schemes`).set(bearer(token)).send({ code: 'NOPE', name: 'No' })).status).toBe(403);
  });

  it('contributions go to payroll; leaving ends cover and stops them', async () => {
    const app = await testApp();
    const pay = await login(app, 'payroll');
    expect((await api(app).put(`${B}/employees/${member.id}/salary`).set(bearer(pay)).send({ basic: '60000.00', effective_from: '2026-11-01' })).status).toBe(200);
    const run = (await api(app).post(`${B}/payroll/runs`).set(bearer(pay)).send({ period: '2026-12' })).body;
    await api(app).post(`${B}/payroll/runs/${run.id}/calculate`).set(bearer(pay));
    const slip = (await api(app).get(`${B}/payroll/runs/${run.id}/payslips`).set(bearer(pay))).body.find((s: { employee_id: string }) => s.employee_id === member.id);
    const lines = (await api(app).get(`${B}/payroll/payslips/${slip.id}`).set(bearer(pay))).body.lines;
    // 1,000 + 250 for each of the two dependants.
    expect(lines.find((l: { code: string }) => l.code === 'MEDICAL')).toMatchObject({ amount: '1500.00', detail: 'with 2 dependant(s)' });

    // The employee leaves: the hourly sweep ends cover for the family and tells billing systems.
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    await db(app).query(`UPDATE employee SET status = 'exited', exit_date = $2 WHERE id = $1`, [member.id, yesterday]);
    await app.get(MedicalService).sweep();
    const [ended] = await db(app).query(`SELECT count(*)::int AS n FROM outbox_event WHERE type = 'hr.medical.cover_ended.v1' AND data->>'employee_id' = $1`, [member.id]);
    expect(ended.n).toBe(3);
    const el = (await api(app).get(`${B}/medical/eligibility`).query({ member_id: principal }).set(bearer(billing.token))).body;
    expect(el.eligible).toBe(false);
    await api(app).post(`${B}/payroll/runs/${run.id}/calculate`).set(bearer(pay));
    const after = (await api(app).get(`${B}/payroll/runs/${run.id}/payslips`).set(bearer(pay))).body.find((s: { employee_id: string }) => s.employee_id === member.id);
    if (after) expect((await api(app).get(`${B}/payroll/payslips/${after.id}`).set(bearer(pay))).body.lines.some((l: { code: string }) => l.code === 'MEDICAL')).toBe(false);
    expect((await api(app).delete(`${B}/payroll/runs/${run.id}`).set(bearer(pay))).status).toBe(204);
  });

  it('reports and access', async () => {
    const app = await testApp();
    const hr = await login(app, 'hr.manager');
    const util = (await api(app).get(`${B}/medical/reports/utilisation`).query({ scheme_id: schemeId }).set(bearer(hr))).body;
    expect(Array.isArray(util)).toBe(true);
    const fac = (await api(app).get(`${B}/medical/reports/facilities`).query({ from: '2026-01-01', to: '2026-12-31' }).set(bearer(hr))).body;
    // The first claim was reversed, so it does not count.
    expect(fac.find((f: { facility: string }) => f.facility === OPD)).toMatchObject({ claims: 2, scheme_paid: '30800.00', member_paid: '11200.00' });
    const fund = (await api(app).get(`${B}/medical/reports/funding`).query({ from: '2026-01', to: '2026-12' }).set(bearer(hr))).body;
    expect(fund.length).toBeGreaterThan(0);
    const x = await api(app).get(`${B}/medical/reports/export`).query({ report: 'near_limit' }).set(bearer(hr));
    expect(x.headers['content-type']).toContain('spreadsheetml');
    const head = await login(app, 'head.nursing');
    expect((await api(app).get(`${B}/medical/lookup`).query({ q: 'SIL' }).set(bearer(head))).status).toBe(403);
    expect((await api(app).get(`${B}/medical/reports/utilisation`).set(bearer(billing.token))).status).toBe(403);
  });
});
