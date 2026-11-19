import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SiteConfigService } from '../src/modules/site-config/site-config.module';
import { SettingsService } from '../src/modules/settings/settings.module';
import { DataSource as DataSourceToken } from 'typeorm';
import { api, bearer, closeApp, db, login, testApp } from './helpers';


const B = '/api/v1';
const EXAMPLE = join(__dirname, '..', '..', '..', 'config', 'site.example.json');
const dir = mkdtempSync(join(tmpdir(), 'site-config-'));
const file = join(dir, 'site.json');

describe('hospital configuration file', () => {
  beforeAll(() => { process.env.SITE_CONFIG_FILE = file; });
  afterAll(async () => {
    delete process.env.SITE_CONFIG_FILE;
    // Other suites expect the default rating bands and pay day.
    await (await testApp()).get(DataSourceToken).query("DELETE FROM setting WHERE key IN ('performance.rating_bands', 'payroll.pay_day')");
    await closeApp();
  });

  it('the shipped example is valid and applies; applying again changes nothing', async () => {
    const app = await testApp();
    const cfg = JSON.parse(readFileSync(EXAMPLE, 'utf8'));
    cfg.payroll.pay_day = 25;
    cfg.payroll.chart_of_accounts.NET_PAY = { credit: '2100' };
    cfg.payroll.mpesa.method = 'bank_bulk';
    cfg.performance.rating_bands = [{ min: 4, label: 'Excellent' }, { min: 3, label: 'Good' }, { min: 2, label: 'Fair' }, { min: 0, label: 'Poor' }];
    cfg.cpd_requirements.push({ licensing_body: 'PPB', points_per_year: 20 });
    cfg.mandatory_training.push({ code: 'HANDHYG', title: 'Hand hygiene refresher', mandatory_for: 'clinical', refresh_months: 6 });
    cfg.medical.effective_from = '2027-01-01';
    cfg.medical.schemes[0].categories[1].limits[0].annual_limit = '120000.00';
    process.env.HIK_MAIN_GATE_USERNAME = 'admin';
    process.env.HIK_MAIN_GATE_PASSWORD = 'device-pass';
    writeFileSync(file, JSON.stringify(cfg));

    const svc = app.get(SiteConfigService);
    const r = await svc.apply();
    expect(r.applied).toBe(true);
    expect(r.changes.join('\n')).toMatch(/Pay day: 0 → 25/);
    const settings = app.get(SettingsService);
    expect(await settings.get('payroll.pay_day')).toBe(25);
    expect((await settings.get('performance.rating_bands'))[0]).toEqual({ min: 4, label: 'Excellent' });
    const [acc] = await db(app).query(`SELECT credit_account FROM gl_account_map WHERE key = 'NET_PAY'`);
    expect(acc.credit_account).toBe('2100');
    const [mp] = await db(app).query(`SELECT note FROM payment_file_format WHERE code = 'MPESA_CSV'`);
    expect(mp.note).toMatch(/bank bulk/);
    const [ppb] = await db(app).query(`SELECT points_per_year::text AS p FROM cpd_requirement WHERE licensing_body = 'PPB'`);
    expect(ppb.p).toBe('20.0');
    const [hh] = await db(app).query(`SELECT mandatory_for, refresh_months FROM training_programme WHERE code = 'HANDHYG'`);
    expect(hh).toEqual({ mandatory_for: 'clinical', refresh_months: 6 });
    const [dev] = await db(app).query(`SELECT type, match_by, is_active, config->>'model' AS model, credentials_enc IS NOT NULL AS has_creds FROM connector WHERE code = 'main_gate_hik'`);
    expect(dev).toMatchObject({ type: 'hikvision_isapi', match_by: 'staff_number', is_active: false, has_creds: true });
    expect(dev.model).toMatch(/DS-K1T341/);
    const [lim] = await db(app).query(
      `SELECT r.annual_limit::text AS l FROM medical_limit_rule r JOIN medical_category c ON c.id = r.category_id JOIN medical_scheme s ON s.id = r.scheme_id
        WHERE s.code = 'SMS' AND c.code = 'outpatient' AND r.job_grade_id IS NULL AND r.effective_from = '2027-01-01'`,
    );
    expect(lim.l).toBe('120000.00');
    expect(r.warnings.join('\n')).toMatch(/placeholders/);

    expect((await svc.apply()).applied).toBe(false);
    const again = await svc.apply(true);
    expect(again.changes.filter((c) => /limit|Pay day|CPD|Rating/.test(c))).toEqual([]);

    // Appraisal bands now follow the setting.
    const hrm = await login(app, 'hr.manager');
    const st = (await api(app).get(`${B}/admin/site-config`).set(bearer(await login(app, 'admin')))).body;
    expect(st).toMatchObject({ exists: true, pending: false });
    expect((await api(app).get(`${B}/admin/site-config`).set(bearer(hrm))).status).toBe(403);
  });

  it('a broken file is refused with the path of each problem, and nothing changes', async () => {
    const app = await testApp();
    writeFileSync(file, JSON.stringify({ version: 1, payroll: { pay_day: 45 }, performance: { rating_bands: [{ min: 9, label: 'x' }] } }));
    const res = await api(app).post(`${B}/admin/site-config/apply`).set(bearer(await login(app, 'admin')));
    expect(res.status).toBe(422);
    const paths = (res.body.errors as { path: string }[]).map((e) => e.path);
    expect(paths).toEqual(expect.arrayContaining(['payroll.pay_day', 'performance.rating_bands.0.min']));
    expect(await app.get(SettingsService).get('payroll.pay_day')).toBe(25);
    writeFileSync(file, '{ not json');
    expect((await api(app).post(`${B}/admin/site-config/apply`).set(bearer(await login(app, 'admin')))).status).toBe(422);
  });
});
