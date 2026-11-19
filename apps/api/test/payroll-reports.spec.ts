import { unzipSync } from 'fflate';
import { api, bearer, closeApp, db, login, testApp } from './helpers';

afterAll(closeApp);

const B = '/api/v1';
const PERIOD = '2026-04';

/** One approved payroll month for these tests (created once, reused on reruns). */
async function approvedRun() {
  const app = await testApp();
  const pay = await login(app, 'payroll');
  let run = (await api(app).get(`${B}/payroll/runs`).set(bearer(pay))).body.find((r: { period: string }) => r.period === PERIOD);
  if (!run) run = (await api(app).post(`${B}/payroll/runs`).set(bearer(pay)).send({ period: PERIOD })).body;
  if (['draft', 'calculated'].includes(run.status)) {
    await api(app).post(`${B}/payroll/runs/${run.id}/calculate`).set(bearer(pay));
    const sub = await api(app).post(`${B}/payroll/runs/${run.id}/submit`).set(bearer(pay)).send({});
    if (sub.status >= 300) console.log('SUBMIT', sub.status, JSON.stringify(sub.body));
  }
  for (const who of ['hr.manager', 'finance']) {
    const t = await login(app, who);
    const task = (await api(app).get(`${B}/workflow/inbox`).set(bearer(t))).body.find((x: { subject_id: string }) => x.subject_id === run.id);
    if (task) await api(app).post(`${B}/workflow/tasks/${task.id}/decision`).set(bearer(t)).send({ decision: 'approve' });
  }
  return (await api(app).get(`${B}/payroll/runs/${run.id}`).set(bearer(pay))).body as { id: string; status: string; employees: number; net: string };
}

jest.setTimeout(300_000);

describe('statutory and bank payment reports', () => {
  it('statutory remittances add up to the payslips, staff and employer shares included', async () => {
    const app = await testApp();
    const run = await approvedRun();
    expect(run.status).toBe('approved');
    const pay = await login(app, 'payroll');
    const [row] = (await api(app).get(`${B}/reports/statutory`).query({ from: PERIOD, to: PERIOD }).set(bearer(pay))).body;
    const [sum] = await db(app).query(
      `SELECT sum(paye)::numeric(14,2)::text AS paye, sum(nssf)::numeric(14,2)::text AS nssf, sum(shif)::numeric(14,2)::text AS shif, sum(housing_levy)::numeric(14,2)::text AS ahl,
              (SELECT coalesce(sum(l.amount), 0)::numeric(14,2)::text FROM payslip_line l JOIN payslip p ON p.id = l.payslip_id WHERE p.run_id = $1 AND l.code = 'AHL_ER') AS ahl_er
         FROM payslip WHERE run_id = $1`,
      [run.id],
    );
    expect(row).toMatchObject({ period: PERIOD, employees: run.employees, paye: sum.paye, nssf_employee: sum.nssf, shif: sum.shif, housing_levy_employee: sum.ahl, housing_levy_employer: sum.ahl_er });
    // The Housing Levy is matched 1.5% + 1.5%.
    expect(row.housing_levy_employer).toBe(row.housing_levy_employee);
    const total = ['paye', 'nssf_total', 'shif', 'housing_levy_total', 'nita'].reduce((s, k) => s + Number(row[k]), 0);
    expect(Number(row.total_remittance)).toBeCloseTo(total, 2);

    const byEmp = (await api(app).get(`${B}/reports/statutory-employees`).query({ from: PERIOD, to: PERIOD }).set(bearer(pay))).body as { paye: string }[];
    expect(byEmp).toHaveLength(run.employees);
    expect(byEmp.reduce((s, r) => s + Number(r.paye), 0)).toBeCloseTo(Number(row.paye), 2);
    const xlsx = await api(app).get(`${B}/reports/statutory`).query({ from: PERIOD, to: PERIOD, format: 'xlsx' }).set(bearer(pay)).buffer(true).parse((res, cb) => { const c: Buffer[] = []; res.on('data', (x: Buffer) => c.push(x)); res.on('end', () => cb(null, Buffer.concat(c))); });
    expect((xlsx.body as Buffer).subarray(0, 2).toString()).toBe('PK');
    expect((await api(app).get(`${B}/reports/statutory`).query({ from: PERIOD, to: PERIOD }).set(bearer(await login(app, 'line.manager')))).status).toBe(403);
  });

  it('bank payments: totals by bank match the net pay; the detail masks account numbers', async () => {
    const app = await testApp();
    const run = await approvedRun();
    const fin = await login(app, 'finance');
    const rows = (await api(app).get(`${B}/reports/bank-payments`).query({ from: PERIOD, to: PERIOD }).set(bearer(fin))).body as { amount: string; employees: number }[];
    const [net] = await db(app).query(`SELECT sum(net)::numeric(14,2)::text AS n, count(*) FILTER (WHERE net > 0)::int AS c FROM payslip WHERE run_id = $1`, [run.id]);
    expect(rows.reduce((s, r) => s + Number(r.amount), 0)).toBeCloseTo(Number(net.n), 2);
    expect(rows.reduce((s, r) => s + r.employees, 0)).toBe(net.c);
    const detail = (await api(app).get(`${B}/reports/bank-payments-detail`).query({ period: PERIOD }).set(bearer(fin))).body as { account: string }[];
    expect(detail).toHaveLength(net.c);
    expect(detail.every((d) => d.account === '–' || /^••••\d{0,4}$/.test(d.account))).toBe(true);
  });
});

describe('P9 tools', () => {
  it('lists who gets a P9, and downloads one or all of them as a ZIP of PDFs', async () => {
    const app = await testApp();
    await approvedRun();
    const pay = await login(app, 'payroll');
    const year = Number(PERIOD.slice(0, 4));
    const people = (await api(app).get(`${B}/payroll/p9/employees`).query({ year }).set(bearer(pay))).body as { employee_id: string; staff_number: string; months: number }[];
    expect(people.length).toBeGreaterThan(5);
    const one = await api(app).get(`${B}/payroll/p9`).query({ employee_id: people[0].employee_id, year }).set(bearer(pay)).buffer(true).parse((res, cb) => { const c: Buffer[] = []; res.on('data', (x: Buffer) => c.push(x)); res.on('end', () => cb(null, Buffer.concat(c))); });
    expect((one.body as Buffer).subarray(0, 4).toString()).toBe('%PDF');
    const zip = await api(app).get(`${B}/payroll/p9/bulk`).query({ year }).set(bearer(pay)).buffer(true).parse((res, cb) => { const c: Buffer[] = []; res.on('data', (x: Buffer) => c.push(x)); res.on('end', () => cb(null, Buffer.concat(c))); });
    expect(zip.headers['content-type']).toMatch(/zip/);
    const files = unzipSync(new Uint8Array(zip.body as Buffer));
    expect(Object.keys(files)).toHaveLength(people.length);
    expect(Object.keys(files)).toContain(`p9-${year}-${people[0].staff_number}.pdf`);
    expect(Buffer.from(files[`p9-${year}-${people[0].staff_number}.pdf`]).subarray(0, 4).toString()).toBe('%PDF');
    expect((await api(app).get(`${B}/payroll/p9/bulk`).query({ year: 2001 }).set(bearer(pay))).status).toBe(422);
    expect((await api(app).get(`${B}/payroll/p9/bulk`).query({ year }).set(bearer(await login(app, 'employee')))).status).toBe(403);
  });
});
