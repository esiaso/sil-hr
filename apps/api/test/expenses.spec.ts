import { api, bearer, closeApp, db, login, testApp } from './helpers';

afterAll(closeApp);

const B = '/api/v1';
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

async function approveAll(subjectId: string) {
  const app = await testApp();
  const people = ['line.manager', 'finance', 'head.nursing', 'hr.manager', 'admin'];
  for (let guard = 0; guard < 6; guard++) {
    let acted = false;
    for (const p of people) {
      const t = await login(app, p);
      const task = (await api(app).get(`${B}/workflow/inbox`).set(bearer(t))).body.find((x: { subject_id: string }) => x.subject_id === subjectId);
      if (!task) continue;
      const r = await api(app).post(`${B}/workflow/tasks/${task.id}/decision`).set(bearer(t)).send({ decision: 'approve' });
      if (r.status === 200) { acted = true; break; }
    }
    if (!acted) return;
  }
}

describe('travel and expenses', () => {
  let tripId = '';
  let claimId = '';
  let empId = '';

  it('a trip with an advance is approved by the line manager and finance; payroll pays the advance', async () => {
    const app = await testApp();
    const emp = await login(app, 'employee');
    [{ employee_id: empId }] = await db(app).query(`SELECT employee_id FROM user_account WHERE username = 'employee'`);
    expect((await api(app).post(`${B}/travel-requests`).set(bearer(emp)).send({ purpose: 'Nursing conference', destination: 'Mombasa', depart_on: day(-10), return_on: day(-8), estimated_cost: '20000.00', advance: '30000.00' })).status).toBe(422);
    const t = await api(app).post(`${B}/travel-requests`).set(bearer(emp)).send({ purpose: 'Kenya nursing conference', destination: 'Mombasa', depart_on: day(-10), return_on: day(-8), estimated_cost: '25000.00', advance: '10000.00' });
    expect(t.status).toBe(201);
    tripId = t.body.id;
    expect(t.body.number).toMatch(/^TRV\//);
    const [d] = await db(app).query(`SELECT d.code FROM workflow_instance i JOIN workflow_definition d ON d.id = i.definition_id WHERE i.subject_id = $1`, [tripId]);
    expect(d.code).toBe('TRAVEL-ADVANCE');
    await approveAll(tripId);
    const mine = (await api(app).get(`${B}/me/travel-requests`).set(bearer(emp))).body.find((x: { id: string }) => x.id === tripId);
    expect(mine).toMatchObject({ status: 'approved', advance: '10000.00', advance_period: expect.stringMatching(/^\d{4}-\d{2}$/) });
    const [adv] = await db(app).query(`SELECT o.amount::text, o.period FROM payroll_one_off o JOIN pay_component c ON c.id = o.component_id WHERE c.code = 'TRAVEL_ADV' AND o.employee_id = $1 AND o.note LIKE $2`, [empId, `%${mine.number}%`]);
    expect(adv).toMatchObject({ amount: '10000.00', period: mine.advance_period });
  });

  it('a claim against the trip: receipts are required above the limit; approval pays the net after the advance', async () => {
    const app = await testApp();
    const emp = await login(app, 'employee');
    const c = await api(app).post(`${B}/expense-claims`).set(bearer(emp)).send({ title: 'Mombasa conference', travel_request_id: tripId });
    expect(c.status).toBe(201);
    claimId = c.body.id;
    expect((await api(app).post(`${B}/expense-claims`).set(bearer(emp)).send({ title: 'Again', travel_request_id: tripId })).status).toBe(409);
    expect((await api(app).post(`${B}/expense-claims/${claimId}/submit`).set(bearer(emp))).status).toBe(422);
    const item = (f: Record<string, string>, receipt = true) => {
      const r = api(app).post(`${B}/expense-claims/${claimId}/items`).set(bearer(emp));
      for (const [k, v] of Object.entries(f)) r.field(k, v);
      return receipt ? r.attach('receipt', PDF, { filename: 'receipt.pdf', contentType: 'application/pdf' }) : r;
    };
    expect((await item({ spent_on: day(-10), category: 'transport', description: 'SGR ticket', amount: '3000.00' })).status).toBe(201);
    expect((await item({ spent_on: day(-9), category: 'accommodation', description: 'Hotel, 2 nights', amount: '12000.00' })).status).toBe(201);
    const noReceipt = await item({ spent_on: day(-8), category: 'meals', description: 'Dinner', amount: '800.00' }, false);
    expect(noReceipt.body.total).toBe('15800.00');
    expect((await api(app).post(`${B}/expense-claims/${claimId}/submit`).set(bearer(emp))).status).toBe(422);
    const dinner = noReceipt.body.items.find((i: { description: string }) => i.description === 'Dinner');
    const after = await api(app).delete(`${B}/expense-claims/${claimId}/items/${dinner.id}`).set(bearer(emp));
    expect(after.body.total).toBe('15000.00');
    await item({ spent_on: day(-8), category: 'meals', description: 'Lunch', amount: '400.00' }, false);
    const sub = await api(app).post(`${B}/expense-claims/${claimId}/submit`).set(bearer(emp));
    expect(sub.body).toMatchObject({ status: 'pending', total: '15400.00', advance_offset: '10000.00', net: '5400.00' });
    // The approver can open the receipts.
    const fin = await login(app, 'finance');
    const lmTask = (await api(app).get(`${B}/workflow/inbox`).set(bearer(await login(app, 'line.manager')))).body.find((x: { subject_id: string }) => x.subject_id === claimId);
    expect(lmTask).toBeTruthy();
    const withReceipt = sub.body.items.find((i: { receipt_document_id: string | null }) => i.receipt_document_id);
    expect((await api(app).get(`${B}/expense-items/${withReceipt.id}/receipt`).set(bearer(fin))).status).toBe(200);
    expect((await api(app).get(`${B}/expense-items/${withReceipt.id}/receipt`).set(bearer(await login(app, 'recruiter')))).status).toBe(404);
    await approveAll(claimId);
    const done = (await api(app).get(`${B}/expense-claims/${claimId}`).set(bearer(emp))).body;
    expect(done).toMatchObject({ status: 'approved', paid_period: expect.stringMatching(/^\d{4}-\d{2}$/) });
    const [pay] = await db(app).query(`SELECT o.amount::text FROM payroll_one_off o JOIN pay_component c ON c.id = o.component_id WHERE c.code = 'EXPENSE_REIMB' AND o.note = $1`, [`Expense claim ${done.number}`]);
    expect(pay.amount).toBe('5400.00');
    const [evt] = await db(app).query(`SELECT data FROM outbox_event WHERE type = 'hr.expense_claim.approved.v1' AND data->>'id' = $1`, [claimId]);
    expect(evt.data).toMatchObject({ net: '5400.00', advance_offset: '10000.00' });
    expect((await api(app).post(`${B}/expense-claims/${claimId}/cancel`).set(bearer(emp))).status).toBe(409);
  });

  it('an unspent advance is recovered through payroll; HR sees claims in scope', async () => {
    const app = await testApp();
    const emp = await login(app, 'employee');
    const t = await api(app).post(`${B}/travel-requests`).set(bearer(emp)).send({ purpose: 'Outreach clinic', destination: 'Machakos', depart_on: day(-5), return_on: day(-5), estimated_cost: '8000.00', advance: '8000.00' });
    await approveAll(t.body.id);
    const c = await api(app).post(`${B}/expense-claims`).set(bearer(emp)).send({ title: 'Outreach', travel_request_id: t.body.id });
    await api(app).post(`${B}/expense-claims/${c.body.id}/items`).set(bearer(emp)).field('spent_on', day(-5)).field('category', 'fuel').field('description', 'Fuel').field('amount', '3000.00').attach('receipt', PDF, { filename: 'r.pdf', contentType: 'application/pdf' });
    expect((await api(app).post(`${B}/expense-claims/${c.body.id}/submit`).set(bearer(emp))).body.net).toBe('-5000.00');
    await approveAll(c.body.id);
    const [rec] = await db(app).query(`SELECT o.amount::text FROM payroll_one_off o JOIN pay_component c ON c.id = o.component_id WHERE c.code = 'ADV_RECOVERY' AND o.employee_id = $1 ORDER BY o.created_at DESC LIMIT 1`, [empId]);
    expect(rec.amount).toBe('5000.00');
    const list = (await api(app).get(`${B}/expense-claims`).set(bearer(await login(app, 'hr.manager')))).body;
    expect(list.some((x: { id: string }) => x.id === claimId)).toBe(true);
    expect((await api(app).get(`${B}/expense-claims`).set(bearer(await login(app, 'recruiter')))).status).toBe(403);
  });
});
