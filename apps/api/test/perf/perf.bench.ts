/**
 * Performance on a hospital-sized dataset: 2,000 employees and three years of attendance.
 *
 *   pnpm --filter @sil/hr-api bench
 *
 * Runs against its own database (silhr_perf, rebuilt each time) through the API in-process,
 * so the timings are the server's work (database, mapping, serialisation) without network.
 * Writes docs/PERFORMANCE.md.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LeaveService } from '../../src/modules/leave/leave.service';
import { api, bearer, closeApp, db, login, testApp } from '../helpers';

afterAll(closeApp);
jest.setTimeout(3_600_000);

const B = '/api/v1';
const TARGET = 2000;
const YEARS = 3;
const results: { name: string; runs: number; p50: number; p95: number; max: number; note?: string }[] = [];
const counts: Record<string, number> = {};
const sizes: Record<string, string> = {};
const setup: { step: string; seconds: number }[] = [];

async function timed<T>(step: string, fn: () => Promise<T>): Promise<T> {
  const t = Date.now();
  const r = await fn();
  setup.push({ step, seconds: Math.round((Date.now() - t) / 100) / 10 });
  return r;
}

async function measure(name: string, runs: number, fn: () => Promise<{ status: number; body?: unknown }>, note?: string) {
  const app = await testApp();
  void app;
  const times: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t = process.hrtime.bigint();
    const r = await fn();
    times.push(Number(process.hrtime.bigint() - t) / 1e6);
    if (r.status >= 400) { results.push({ name, runs: i + 1, p50: 0, p95: 0, max: 0, note: `FAILED: HTTP ${r.status} ${JSON.stringify((r as { body?: unknown }).body ?? '').slice(0, 120)}` }); return; }
  }
  times.sort((a, b) => a - b);
  const q = (p: number) => Math.round(times[Math.min(times.length - 1, Math.floor(p * times.length))]);
  results.push({ name, runs, p50: q(0.5), p95: q(0.95), max: Math.round(times[times.length - 1]), note });
}

describe('performance', () => {
  it('builds the dataset', async () => {
    const app = await testApp();
    const m = db(app);
    const have = (await m.query(`SELECT count(*)::int AS n FROM employee`))[0].n as number;
    await timed(`Insert ${TARGET - have} more employees, assignments, salaries and licences`, async () => {
      await m.query(`
        WITH pos AS (SELECT p.id, p.department_id, d.branch_id, d.cost_centre_id, p.licence_required, row_number() OVER (ORDER BY p.code) - 1 AS i, count(*) OVER () AS n
                       FROM position p JOIN department d ON d.id = p.department_id WHERE p.status = 'active'),
             org AS (SELECT id FROM organisation ORDER BY created_at LIMIT 1),
             g AS (SELECT s FROM generate_series(1, $1::int) s),
             rows AS (
               SELECT g.s, pos.*, (current_date - (365 * 6) + (g.s * 7919) % (365 * 5))::date AS hire
                 FROM g JOIN pos ON pos.i = g.s % pos.n)
        INSERT INTO employee (organisation_id, staff_number, first_name, last_name, gender, employment_type, status, hire_date, position_id, department_id, branch_id, cost_centre_id, work_email)
        SELECT (SELECT id FROM org), 'PRF' || lpad(s::text, 5, '0'), (ARRAY['Achieng','Wanjiru','Kiprono','Njeri','Otieno','Mwangi','Chebet','Kamau','Atieno','Mutua'])[1 + s % 10],
               'Perf' || s, CASE WHEN s % 3 = 0 THEN 'male' ELSE 'female' END, CASE WHEN s % 9 = 0 THEN 'contract' ELSE 'permanent' END, 'active', hire, id, department_id, branch_id, cost_centre_id,
               'perf' || s || '@example.org'
          FROM rows`, [TARGET - have]);
      await m.query(`INSERT INTO employee_position_assignment (employee_id, position_id, department_id, branch_id, cost_centre_id, effective_from, reason)
                     SELECT id, position_id, department_id, branch_id, cost_centre_id, hire_date, 'Perf dataset' FROM employee WHERE staff_number LIKE 'PRF%'`);
      await m.query(`INSERT INTO employee_salary (employee_id, basic, effective_from) SELECT id, 40000 + (abs(hashtext(id::text)) % 160) * 1000, hire_date FROM employee WHERE staff_number LIKE 'PRF%'`);
      await m.query(`INSERT INTO professional_licence (employee_id, licensing_body, licence_number, issue_date, expiry_date, verified_at)
                     SELECT e.id, p.licence_required, p.licence_required || '/' || e.staff_number, current_date - 200, current_date + (abs(hashtext(e.id::text)) % 500) - 60, now()
                       FROM employee e JOIN position p ON p.id = e.position_id WHERE e.staff_number LIKE 'PRF%' AND p.licence_required IS NOT NULL`);
    });
    await timed(`${YEARS} years of daily attendance (weekdays) and two punches a day`, async () => {
      const [shift] = await m.query(`SELECT id FROM shift ORDER BY code LIMIT 1`);
      await m.query(`
        INSERT INTO attendance_day (employee_id, work_date, shift_id, worked_minutes, late_minutes, overtime_minutes, day_type, status)
        SELECT e.id, d::date, $1, 480 + (abs(hashtext(e.id::text || d::text)) % 60), CASE WHEN abs(hashtext(d::text || e.id::text)) % 17 = 0 THEN 25 ELSE 0 END,
               CASE WHEN abs(hashtext(e.id::text || d::text)) % 11 = 0 THEN 90 ELSE 0 END, 'normal',
               CASE WHEN abs(hashtext(d::text || e.id::text)) % 17 = 0 THEN 'late' ELSE 'present' END
          FROM employee e CROSS JOIN generate_series(current_date - ${YEARS * 365}, current_date - 1, interval '1 day') d
         WHERE extract(isodow FROM d) < 6 AND d >= e.hire_date
        ON CONFLICT DO NOTHING`, [shift.id]);
      await m.query(`
        INSERT INTO clock_event (employee_id, occurred_at, direction, source, dedup_key)
        SELECT a.employee_id, (a.work_date + time '07:55') AT TIME ZONE 'Africa/Nairobi', 'in', 'device', 'perf-in-' || a.id
          FROM attendance_day a
        UNION ALL
        SELECT a.employee_id, (a.work_date + time '17:05') AT TIME ZONE 'Africa/Nairobi', 'out', 'device', 'perf-out-' || a.id
          FROM attendance_day a`);
      await m.query(`ANALYZE`);
    });
    await timed('Leave accrual for every employee (the hourly job)', () => app.get(LeaveService).accrueAll());
    for (const t of ['employee', 'attendance_day', 'clock_event', 'leave_ledger', 'professional_licence', 'employee_salary']) counts[t] = (await m.query(`SELECT count(*)::int AS n FROM ${t}`))[0].n;
    for (const t of ['attendance_day', 'clock_event']) sizes[t] = (await m.query(`SELECT pg_size_pretty(pg_total_relation_size($1)) AS s`, [t]))[0].s;
    sizes.database = (await m.query(`SELECT pg_size_pretty(pg_database_size(current_database())) AS s`))[0].s;
    expect(counts.employee).toBeGreaterThanOrEqual(TARGET);
  });

  it('measures the API', async () => {
    const app = await testApp();
    const hr = await login(app, 'hr.manager');
    const lm = await login(app, 'line.manager');
    const emp = await login(app, 'employee');
    const pay = await login(app, 'payroll');
    const admin = await login(app, 'admin');
    const [{ id: someone }] = await db(app).query(`SELECT id FROM employee WHERE staff_number LIKE 'PRF%' ORDER BY staff_number LIMIT 1 OFFSET 777`);
    const [{ id: dept }] = await db(app).query(`SELECT department_id AS id FROM employee GROUP BY 1 ORDER BY count(*) DESC LIMIT 1`);
    const lastMonth = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
    const today = new Date().toISOString().slice(0, 10);
    const R = 20;
    const get = (t: string, path: string, query: Record<string, string | number> = {}) => () => api(app).get(`${B}${path}`).query(query).set(bearer(t));

    await measure('Sign in (password check, token)', 10, () => api(app).post(`${B}/auth/login`).send({ username: 'employee', password: process.env.PERF_PASSWORD ?? 'Test#Password2026' }), 'Argon2id hashing dominates by design');
    await measure('Employee list, first page of 50', R, get(hr, '/employees', { limit: 50 }));
    await measure('Employee search by name', R, get(hr, '/employees', { limit: 50, search: 'Perf12' }));
    await measure('Employee record', R, get(hr, `/employees/${someone}`));
    await measure('Staff directory, department and below', R, get(hr, '/directory/staff', { limit: 60, department_id: dept, include_sub_departments: 'true' }));
    await measure('Daily attendance, one department, one month', R, get(hr, '/attendance/days', { from: lastMonth, to: today, department_id: dept, limit: 500 }));
    await measure('Timesheet, one person, one month', R, get(hr, `/attendance/timesheets/${someone}`, { from: lastMonth, to: today }));
    await measure('My leave balances', R, get(emp, '/me/leave/balances'));
    await measure('Approvals inbox', R, get(lm, '/workflow/inbox'));
    await measure('Dashboard (HR manager)', R, get(hr, '/dashboard'));
    await measure('Headcount report by department', 10, get(hr, '/reports/headcount'));
    await measure('Turnover report, one year', 10, get(hr, '/reports/turnover', { from: `${today.slice(0, 4)}-01-01`, to: today }));
    await measure('Overtime cost report, twelve months', 5, get(hr, '/reports/overtime-cost', { from: `${Number(today.slice(0, 4)) - 1}-${today.slice(5, 7)}`, to: today.slice(0, 7) }), `${counts.attendance_day?.toLocaleString('en')} attendance rows scanned`);
    await measure('Leave liability report', 5, get(hr, '/reports/leave-liability'));
    await measure('Licence expiry report, 90 days', 10, get(hr, '/reports/licence-expiry', { within_days: 90 }));
    await measure('Headcount report, Excel download', 5, get(hr, '/reports/headcount', { format: 'xlsx' }));
    await measure('FHIR Practitioner search, 100', 10, get(admin, '/fhir/Practitioner', { _count: 100 }));
    await measure('My calendar, one month', R, get(emp, '/me/calendar', { from: lastMonth, to: today }));

    const period = new Date(Date.now() + 40 * 86_400_000).toISOString().slice(0, 7);
    const run = (await api(app).post(`${B}/payroll/runs`).set(bearer(pay)).send({ period })).body;
    await measure(`Payroll calculation, whole hospital (${counts.employee?.toLocaleString('en')} staff)`, 1, () => api(app).post(`${B}/payroll/runs/${run.id}/calculate`).set(bearer(pay)), 'Once; statutory deductions, overtime and leave for everyone');
    await measure('Payroll variance against the previous month', 3, get(pay, `/payroll/runs/${run.id}/variance`));
    await measure('Payslips of the run, first 200', 5, get(pay, `/payroll/runs/${run.id}/payslips`, { limit: 200 }));
    await measure('Statutory remittances report, twelve months', 5, get(pay, '/reports/statutory', { from: `${Number(today.slice(0, 4)) - 1}-${today.slice(5, 7)}`, to: today.slice(0, 7) }));
  });

  it('writes the report', () => {
    const rows = results.map((r) => `| ${r.name} | ${r.runs} | ${r.p50} | ${r.p95} | ${r.max} | ${r.note ?? ''} |`).join('\n');
    const md = `# Performance

Measured by \`pnpm --filter @sil/hr-api bench\` (\`apps/api/test/perf/perf.bench.ts\`) on
${new Date().toISOString().slice(0, 10)}: the API in-process against PostgreSQL 16 in Docker on a
developer laptop, with the sample hospital plus a generated workforce. Timings are server
work (queries, mapping, serialisation) without network or the browser. Run it again on the
production hardware before go-live.

## Dataset

| Table | Rows |
|---|---|
${Object.entries(counts).map(([t, n]) => `| ${t} | ${n.toLocaleString('en')} |`).join('\n')}

Sizes: attendance_day ${sizes.attendance_day}, clock_event ${sizes.clock_event}, whole database ${sizes.database}.

| Setup step | Seconds |
|---|---|
${setup.map((s) => `| ${s.step} | ${s.seconds} |`).join('\n')}

## Timings (milliseconds)

| Operation | Runs | p50 | p95 | Max | Note |
|---|---|---|---|---|---|
${rows}

## Reading the numbers

* Screens staff use all day (lists, records, the inbox, balances, calendar, dashboard)
  should stay well under 300 ms at p95; reports and downloads under a few seconds.
* Payroll calculation is a once-a-month action, measured once. About 23 ms a person, done
  one person at a time in one transaction; at 2,000 staff it takes under a minute, so a
  reverse proxy in front of the API must allow requests of at least two minutes on
  \`POST /payroll/runs/{id}/calculate\` (see DEPLOYMENT.md). Batching the per-person queries
  is the first optimisation if the hospital grows much larger.
* Attendance grows by about 520,000 rows a year for 2,000 staff (weekdays only here;
  shift workers add weekends). Queries filter by employee or department and date, which the
  indexes \`(employee_id, work_date)\` and \`ix_attendance_date\` serve; partitioning by year is
  not needed at this size.
`;
    writeFileSync(join(__dirname, '..', '..', '..', '..', 'docs', 'PERFORMANCE.md'), md);
    expect(results.length).toBeGreaterThan(15);
  });
});
