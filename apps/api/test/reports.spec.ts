import ExcelJS from 'exceljs';
import { LeaveService } from '../src/modules/leave/leave.service';
import { api, bearer, closeApp, db, login, testApp } from './helpers';

afterAll(closeApp);

const B = '/api/v1';

describe('reports and dashboards', () => {
  const y = new Date().getFullYear();

  it('headcount matches the employee table, by department and gender, and exports to CSV and Excel', async () => {
    const app = await testApp();
    const hrm = await login(app, 'hr.manager');
    const rows = (await api(app).get(`${B}/reports/headcount`).set(bearer(hrm))).body;
    const [n] = await db(app).query(`SELECT count(*)::int AS n FROM employee WHERE deleted_at IS NULL AND status IN ('active', 'probation', 'on_notice', 'suspended') AND hire_date <= current_date`);
    expect(rows.reduce((s: number, r: { total: number }) => s + r.total, 0)).toBe(n.n);
    const g = (await api(app).get(`${B}/reports/headcount`).query({ group_by: 'gender' }).set(bearer(hrm))).body;
    expect(g.map((r: { group: string }) => r.group)).toEqual(expect.arrayContaining(['Female', 'Male']));
    const csv = await api(app).get(`${B}/reports/headcount`).query({ format: 'csv' }).set(bearer(hrm));
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    expect(csv.text.split('\r\n')[0]).toContain('Total');
    const xlsx = await api(app).get(`${B}/reports/headcount`).query({ format: 'xlsx' }).set(bearer(hrm)).buffer(true).parse((res, cb) => { const c: Buffer[] = []; res.on('data', (x: Buffer) => c.push(x)); res.on('end', () => cb(null, Buffer.concat(c))); });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(xlsx.body as never);
    expect(wb.worksheets[0].getRow(3).getCell(1).value).toMatch(/department/i);
    const [audit] = await db(app).query(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'export' AND entity_type = 'Report' AND occurred_at > now() - interval '1 minute'`);
    expect(audit.n).toBeGreaterThanOrEqual(2);
  });

  it('scope: a department head sees only their departments; staff without report:read are refused', async () => {
    const app = await testApp();
    const head = await login(app, 'head.nursing');
    const rows = (await api(app).get(`${B}/reports/headcount`).set(bearer(head))).body;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r: { group: string }) => !/Laboratory|Pharmacy|Finance|Human Resources/.test(r.group))).toBe(true);
    expect((await api(app).get(`${B}/reports/headcount`).set(bearer(await login(app, 'employee')))).status).toBe(403);
  });

  it('turnover, leave liability, payroll and overtime cost, licence and contract expiry', async () => {
    const app = await testApp();
    const hrm = await login(app, 'hr.manager');
    const t = (await api(app).get(`${B}/reports/turnover`).query({ from: `${y}-01-01`, to: `${y}-12-31` }).set(bearer(hrm))).body;
    expect(t.length).toBeGreaterThan(0);
    expect(t[0]).toHaveProperty('turnover_pct');
    await app.get(LeaveService).accrueAll();
    const ll = (await api(app).get(`${B}/reports/leave-liability`).set(bearer(hrm))).body;
    expect(ll.length).toBeGreaterThan(0);
    const r = ll[0];
    expect(Number(r.liability)).toBeCloseTo(Number(r.daily_rate) * r.days, 0);
    const pc = await api(app).get(`${B}/reports/payroll-cost`).query({ from: `${y - 1}-01`, to: `${y}-12` }).set(bearer(await login(app, 'payroll')));
    expect(pc.status).toBe(200);
    for (const row of pc.body) expect(Number(row.total_cost)).toBeCloseTo(Number(row.gross) + Number(row.employer_contributions), 2);
    expect((await api(app).get(`${B}/reports/overtime-cost`).query({ from: `${y}-01`, to: `${y}-12` }).set(bearer(hrm))).status).toBe(200);
    expect((await api(app).get(`${B}/reports/overtime-cost`).query({ from: `${y}-12`, to: `${y}-01` }).set(bearer(hrm))).status).toBe(422);
    const lic = (await api(app).get(`${B}/reports/licence-expiry`).query({ within_days: 60 }).set(bearer(hrm))).body;
    expect(lic.length).toBeGreaterThan(0);
    expect(lic.every((x: { days_left: number }) => x.days_left <= 60)).toBe(true);
    const notExpired = (await api(app).get(`${B}/reports/licence-expiry`).query({ within_days: 60, include_expired: 'false' }).set(bearer(hrm))).body;
    expect(notExpired.every((x: { days_left: number }) => x.days_left >= 0)).toBe(true);
    expect((await api(app).get(`${B}/reports/contract-expiry`).query({ within_days: 365 }).set(bearer(hrm))).status).toBe(200);
  });

  it('the dashboard gives each person what they may see', async () => {
    const app = await testApp();
    const d = (await api(app).get(`${B}/dashboard`).set(bearer(await login(app, 'hr.manager')))).body;
    expect(d.headcount).toBeGreaterThan(10);
    expect(d.headcount_by_department.length).toBeGreaterThan(0);
    const e = (await api(app).get(`${B}/dashboard`).set(bearer(await login(app, 'employee')))).body;
    expect(e).toMatchObject({ headcount: null, last_payroll: null });
    expect(typeof e.pending_approvals).toBe('number');
  });
});

describe('HMIS practitioner registry (FHIR R4)', () => {
  it('searches and reads Practitioner and PractitionerRole with licence status', async () => {
    const app = await testApp();
    const admin = await login(app, 'admin');
    const [nurse] = await db(app).query(`SELECT e.id, e.staff_number, l.licence_number FROM employee e JOIN professional_licence l ON l.employee_id = e.id AND l.licensing_body = 'NCK' AND l.deleted_at IS NULL ORDER BY e.staff_number LIMIT 1`);
    const all = await api(app).get(`${B}/fhir/Practitioner`).set(bearer(admin));
    expect(all.headers['content-type']).toMatch(/application\/fhir\+json/);
    const bundle = JSON.parse(all.text);
    expect(bundle).toMatchObject({ resourceType: 'Bundle', type: 'searchset' });
    expect(bundle.total).toBeGreaterThan(10);
    const byStaff = JSON.parse((await api(app).get(`${B}/fhir/Practitioner`).query({ identifier: `urn:sil:hr:staff-number|${nurse.staff_number}` }).set(bearer(admin))).text);
    expect(byStaff.total).toBe(1);
    const byLicence = JSON.parse((await api(app).get(`${B}/fhir/Practitioner`).query({ identifier: `urn:sil:hr:licence:nck|${nurse.licence_number}` }).set(bearer(admin))).text);
    expect(byLicence.entry[0].resource.id).toBe(nurse.id);
    const p = JSON.parse((await api(app).get(`${B}/fhir/Practitioner/${nurse.id}`).set(bearer(admin))).text);
    expect(p).toMatchObject({ resourceType: 'Practitioner', id: nurse.id, identifier: expect.arrayContaining([{ use: 'official', system: 'urn:sil:hr:staff-number', value: nurse.staff_number }]) });
    expect(p.qualification[0].extension[0]).toMatchObject({ url: 'urn:sil:hr:fhir:licence-status', valueCode: expect.stringMatching(/valid|expired|not_verified|suspended/) });
    const roles = JSON.parse((await api(app).get(`${B}/fhir/PractitionerRole`).query({ practitioner: `Practitioner/${nurse.id}` }).set(bearer(admin))).text);
    expect(roles.entry[0].resource).toMatchObject({ resourceType: 'PractitionerRole', practitioner: { reference: `Practitioner/${nurse.id}` } });
    expect((await api(app).get(`${B}/fhir/Practitioner`).set(bearer(await login(app, 'hr.manager')))).status).toBe(403);
    expect(JSON.parse((await api(app).get(`${B}/fhir/metadata`).set(bearer(admin))).text).fhirVersion).toBe('4.0.1');
  });
});
