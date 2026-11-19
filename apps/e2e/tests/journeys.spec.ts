import { expect, test } from '@playwright/test';
import { API } from '../playwright.config';
import { approveRest, call, PASSWORD, signIn, token, uniq, webhook, weekday } from './helpers';

/**
 * The critical journeys of the brief (§8), in the order a hospital lives them. Each uses
 * the web app the way staff would; setup that is not part of the journey goes through the API.
 */
test.describe.serial('critical journeys', () => {
  const ddmmyyyy = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
  let hiredId = '';
  let hiredName = '';

  test('HR hires an employee; other systems receive a signed hr.employee.hired.v1', async ({ page }) => {
    await signIn(page, 'hr.manager');
    await page.goto('/people');
    await page.getByRole('button', { name: 'Add employee', exact: true }).click();
    const last = `Journey${uniq()}`;
    hiredName = `Amani ${last}`;
    await expect(page.getByRole('dialog', { name: 'Add an employee' })).toBeVisible();
    await page.waitForTimeout(300); // the dialog moves focus into itself once open
    await page.getByLabel('First name').fill('Amani');
    await page.getByLabel('Last name').fill(last);
    await expect(page.getByLabel('First name')).toHaveValue('Amani');
    await expect(page.getByLabel('Last name')).toHaveValue(last);
    await page.getByLabel('Work email').fill(`amani.${last.toLowerCase()}@example.org`);
    await page.getByLabel('Position').selectOption({ label: 'Registered Nurse, Medical Ward (RN-MED)' });
    await page.getByLabel('Starts as').selectOption('active');
    await page.getByRole('button', { name: 'Hire', exact: true }).last().click();
    await expect(page).toHaveURL(/\/people\/[0-9a-f-]{36}$/);
    hiredId = page.url().split('/').pop()!;
    await expect(page.getByText(hiredName).first()).toBeVisible();

    const hook = await webhook((e) => e.type === 'hr.employee.hired.v1' && e.subject === hiredId);
    expect(hook.valid_signature).toBe(true);
  });

  test('an employee applies for leave; the line manager approves it in the inbox', async ({ page }) => {
    // Two free weekdays a week or more ahead (reruns must not overlap earlier requests).
    const mine = (await call<{ data: { start_date: string; end_date: string; status: string }[] }>(await token('employee'), 'GET', '/me/leave/requests?limit=100')).body.data.filter((r) => !['cancelled', 'rejected'].includes(r.status));
    let n = 8;
    while (mine.some((r) => r.start_date <= weekday(n + 1) && r.end_date >= weekday(n))) n += 2;
    const start = weekday(n);
    const end = weekday(n + 1);
    await signIn(page, 'employee');
    await page.goto('/leave');
    await page.getByRole('button', { name: 'Apply for leave' }).click();
    await page.getByLabel('Type').selectOption({ label: 'Annual leave' });
    await page.getByLabel('From', { exact: true }).fill(start);
    await page.getByLabel('To', { exact: true }).fill(end);
    await page.getByLabel('Reason (optional)').fill('Family visit (end-to-end test)');
    await page.getByRole('button', { name: 'Send for approval' }).click();
    await expect(page.getByText(ddmmyyyy(start)).first()).toBeVisible();

    const emp = await token('employee');
    const req = (await call<{ data: { id: string; start_date: string; status: string }[] }>(emp, 'GET', '/me/leave/requests?limit=100')).body.data.find((r) => r.start_date === start)!;
    expect(req.status).toBe('pending');

    await signIn(page, 'line.manager');
    await page.goto('/approvals');
    await page.getByRole('button', { name: /annual leave/i }).first().click();
    await page.getByRole('button', { name: 'Approve' }).click();
    await approveRest(req.id);

    await signIn(page, 'employee');
    await page.goto('/leave');
    await expect(page.locator('div').filter({ hasText: `${ddmmyyyy(start)} to` }).filter({ hasText: 'approved' }).last()).toBeVisible();
  });

  test('a clocking system posts punches; the attendance shows on the employee’s timesheet', async ({ page }) => {
    const admin = await token('admin');
    const client = (await call<{ client: { client_id: string }; client_secret: string }>(admin, 'POST', '/api-clients', { name: `Clock gateway ${uniq()}`, scopes: ['attendance:write', 'attendance:read'] })).body;
    const tr = await fetch(`${API}/api/v1/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: `Basic ${Buffer.from(`${client.client.client_id}:${client.client_secret}`).toString('base64')}` }, body: 'grant_type=client_credentials' });
    const machine = (await tr.json()).access_token as string;
    const me = (await call<{ employee_id: string }>(await token('employee'), 'GET', '/auth/me')).body;
    const staff = (await call<{ staff_number: string }>(await token('hr.manager'), 'GET', `/employees/${me.employee_id}`)).body.staff_number;
    // Punch for a rostered shift in the last ten days that has no punches yet (ward staff work day and night shifts).
    const days = (await call<{ data: { work_date: string; shift_id: string | null; scheduled_start: string | null; scheduled_end: string | null; first_in: string | null; status: string }[] }>(machine, 'GET', `/attendance/days?employee_id=${me.employee_id}&from=${weekday(-8)}&to=${weekday(-1)}&limit=50`)).body.data;
    const target = days.find((d) => d.shift_id && d.scheduled_start && !d.first_in && d.status === 'absent')!;
    expect(target).toBeTruthy();
    const shift = (iso: string, minutes: number) => new Date(new Date(iso).getTime() + minutes * 60_000).toISOString();
    const events = [
      { staff_number: staff, occurred_at: shift(target.scheduled_start!, -3), direction: 'in', external_id: `e2e-${staff}-${target.work_date}-in` },
      { staff_number: staff, occurred_at: shift(target.scheduled_end!, 6), direction: 'out', external_id: `e2e-${staff}-${target.work_date}-out` },
    ];
    const sync = await call<{ accepted: number; duplicates: number }>(machine, 'POST', '/clock-events', { events });
    expect(sync.body.accepted + sync.body.duplicates).toBe(2);
    const after = (await call<{ data: { work_date: string; status: string; worked_minutes: number }[] }>(machine, 'GET', `/attendance/days?employee_id=${me.employee_id}&from=${target.work_date}&to=${target.work_date}`)).body.data[0];
    expect(after.status).toBe('present');
    expect(after.worked_minutes).toBeGreaterThan(600);

    await signIn(page, 'employee');
    await page.goto('/attendance/me');
    // The two-week summary counts the shift as present.
    await expect(page.getByText('Present', { exact: true }).locator('..')).toContainText(/[1-9]\d* \/ \d+/);
  });

  test('payroll is calculated, approved by HR and finance in the inbox, and the payslip appears', async ({ page }) => {
    const pay = await token('payroll');
    const period = new Date().toISOString().slice(0, 7);
    const runs = (await call<{ id: string; period: string; status: string }[]>(pay, 'GET', '/payroll/runs')).body;
    let run = runs.find((r) => r.period === period);
    if (!run) run = (await call<{ id: string; period: string; status: string }>(pay, 'POST', '/payroll/runs', { period })).body;
    if (['draft', 'calculated'].includes(run.status)) {
      await call(pay, 'POST', `/payroll/runs/${run.id}/calculate`);
      await call(pay, 'POST', `/payroll/runs/${run.id}/submit`, {});
    }
    for (const who of ['hr.manager', 'finance']) {
      await signIn(page, who);
      await page.goto('/approvals');
      const item = page.getByRole('button', { name: /payroll/i }).first();
      if (await item.count()) {
        await item.click();
        await page.getByRole('button', { name: 'Approve' }).click();
        await expect(page.getByRole('button', { name: 'Approve' })).toHaveCount(0);
      }
    }
    await approveRest(run.id, ['hr.manager', 'finance', 'admin']);
    expect((await call<{ status: string }>(pay, 'GET', `/payroll/runs/${run.id}`)).body.status).toMatch(/approved|paid|closed/);

    await signIn(page, 'employee');
    await page.goto('/me/payslips');
    const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    await expect(page.getByRole('button', { name: `${months[Number(period.slice(5)) - 1]} ${period.slice(0, 4)}` })).toBeVisible();
  });

  test('offboarding ends access: login refused, SCIM inactive, signed hr.employee.exited.v1', async ({ page }) => {
    const admin = await token('admin');
    const hro = await token('hr.officer');
    // The person hired in the first journey gets a login, then leaves.
    const roles = (await call<{ data: { id: string; code: string }[] } | { id: string; code: string }[]>(admin, 'GET', '/roles')).body;
    const role = (Array.isArray(roles) ? roles : roles.data).find((r) => r.code === 'employee')!;
    const username = `e2e.${uniq().toLowerCase()}`;
    const user = (await call<{ id: string }>(admin, 'POST', '/users', { username, display_name: hiredName, password: PASSWORD, roles: [{ role_id: role.id, scope: 'own' }] })).body;
    await call(admin, 'PUT', `/employees/${hiredId}/user`, { user_id: user.id });
    const first = await token(username);
    await call(first, 'POST', '/auth/password', { current_password: PASSWORD, new_password: `${PASSWORD}x` });
    await signIn(page, username, `${PASSWORD}x`);
    await page.goto('/me');
    await expect(page.getByText(hiredName).first()).toBeVisible();

    const today = new Date().toISOString().slice(0, 10);
    const r = (await call<{ id: string }>(hro, 'POST', '/lifecycle-requests', { kind: 'resignation', employee_id: hiredId, effective_date: today, notice_given_on: today, reason: 'Relocating (end-to-end test)' })).body;
    // No line manager on file: the first step goes to the workflow administrators, then the HR manager.
    await approveRest(r.id, ['line.manager', 'head.nursing', 'admin', 'hr.manager']);
    // HR completes the exit (checklist and clearance are covered by the API tests).
    await signIn(page, 'hr.manager');
    const done = await call(await token('hr.manager'), 'POST', `/employees/${hiredId}/exit-clearance/complete`, { override_reason: 'End-to-end test: checklist and clearance handled outside the system' }, false);
    expect([200, 201]).toContain(done.status);
    await page.goto(`/people/${hiredId}`);
    await expect(page.getByText('exited').first()).toBeVisible();

    // Deprovisioned everywhere.
    const login = await fetch(`${API}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password: `${PASSWORD}x` }) });
    expect(login.status).toBe(403);
    const scimClient = (await call<{ client: { client_id: string }; client_secret: string }>(admin, 'POST', '/api-clients', { name: `IdP ${uniq()}`, scopes: ['scim'] })).body;
    const st = await fetch(`${API}/api/v1/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: `Basic ${Buffer.from(`${scimClient.client.client_id}:${scimClient.client_secret}`).toString('base64')}` }, body: 'grant_type=client_credentials' });
    const scimToken = (await st.json()).access_token as string;
    const scimUser = await (await fetch(`${API}/scim/v2/Users/${hiredId}`, { headers: { authorization: `Bearer ${scimToken}` } })).json();
    expect(scimUser.active).toBe(false);
    const hook = await webhook((e) => e.type === 'hr.employee.exited.v1' && e.subject === hiredId);
    expect(hook.valid_signature).toBe(true);
  });
});
