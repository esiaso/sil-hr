import { api, bearer, closeApp, db, idOf, login, testApp, uniq } from './helpers';

afterAll(closeApp);

const B = '/api/v1';
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');

async function person() {
  const app = await testApp();
  const hr = await login(app, 'hr.manager');
  const e = (await api(app).post(`${B}/employees`).set(bearer(hr)).send({ first_name: 'Con', last_name: `Tract${uniq()}`, employment_type: 'contract', status: 'active', hire_date: '2025-01-06', position_id: await idOf(app, 'position', 'code', 'RN-MED') })).body;
  return e.id as string;
}

describe('contracts and change requests', () => {
  it('a contract’s terms can be corrected (audited, If-Match), and the signed copy attached and downloaded', async () => {
    const app = await testApp();
    const hro = await login(app, 'hr.officer');
    const id = await person();
    const c = (await api(app).post(`${B}/contracts`).set(bearer(hro)).send({ employee_id: id, contract_type: 'fixed_term', start_date: '2026-01-01', end_date: '2026-12-31', notice_days: 30, probation_months: 3, basic: '70000.00' })).body;
    expect((await api(app).put(`${B}/contracts/${c.id}`).set(bearer(hro)).send({ notice_days: 60 })).status).toBe(428);
    expect((await api(app).put(`${B}/contracts/${c.id}`).set(bearer(hro)).set('If-Match', `"${c.version}"`).send({ notice_days: 60, end_date: '2025-06-01' })).status).toBe(422);
    const u = await api(app).put(`${B}/contracts/${c.id}`).set(bearer(hro)).set('If-Match', `"${c.version}"`).send({ notice_days: 60, end_date: '2027-03-31', probation_months: 3, basic: '72000.00', terms: 'Night shift allowance applies' });
    expect(u.status).toBe(200);
    expect(u.body).toMatchObject({ notice_days: 60, end_date: '2027-03-31', basic: '72000.00', terms: 'Night shift allowance applies' });
    const [audit] = await db(app).query(`SELECT count(*)::int AS n FROM audit_log WHERE entity_type = 'EmployeeContract' AND entity_id = $1 AND action = 'update'`, [c.id]);
    expect(audit.n).toBeGreaterThan(0);
    expect((await api(app).get(`${B}/contracts/${c.id}/document`).set(bearer(hro))).status).toBe(404);
    const att = await api(app).post(`${B}/contracts/${c.id}/document`).set(bearer(hro)).attach('file', PDF, { filename: 'signed.pdf', contentType: 'application/pdf' });
    expect(att.status).toBe(201);
    expect(att.body.document_id).toBeTruthy();
    expect((await api(app).get(`${B}/contracts/${c.id}/document`).set(bearer(hro))).status).toBe(200);
    expect((await api(app).get(`${B}/contracts/${c.id}/document`).set(bearer(await login(app, 'recruiter')))).status).toBe(403);
  });

  it('a pending change request can be withdrawn; requests filter by kind', async () => {
    const app = await testApp();
    const hro = await login(app, 'hr.officer');
    const id = await person();
    const r = (await api(app).post(`${B}/lifecycle-requests`).set(bearer(hro)).send({ kind: 'transfer', employee_id: id, effective_date: '2027-01-04', position_id: await idOf(app, 'position', 'code', 'RN-SUR'), reason: 'Surgical ward needs more nurses' })).body;
    expect(r.status).toBe('pending');
    const confirmations = (await api(app).get(`${B}/lifecycle-requests`).query({ kind: 'transfer' }).set(bearer(hro))).body as { id: string; kind: string }[];
    expect(confirmations.every((x) => x.kind === 'transfer')).toBe(true);
    expect(confirmations.some((x) => x.id === r.id)).toBe(true);
    const c = await api(app).post(`${B}/lifecycle-requests/${r.id}/cancel`).set(bearer(hro));
    expect(c.body.status).toBe('cancelled');
    const [inst] = await db(app).query(`SELECT status FROM workflow_instance WHERE subject_id = $1`, [r.id]);
    expect(inst.status).toBe('cancelled');
    expect((await api(app).post(`${B}/lifecycle-requests/${r.id}/cancel`).set(bearer(hro))).status).toBe(409);
  });
});
