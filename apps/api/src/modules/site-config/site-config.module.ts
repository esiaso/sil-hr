import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Controller, Get, HttpCode, Injectable, Logger, Module, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { InjectDataSource } from '@nestjs/typeorm';
import Decimal from 'decimal.js';
import { DataSource } from 'typeorm';
import { z } from 'zod';
import { CONNECTOR_TYPES, EMPLOYMENT_TYPES, fileColumn } from '@sil/hr-shared';
import { RequirePermissions } from '../../common/decorators';
import { unprocessable } from '../../common/problem';
import { ZResponse } from '../../common/zod';
import { AttendanceModule } from '../attendance/attendance.module';
import { ConnectorsService } from '../attendance/connectors.service';
import { writeAudit } from '../audit/audit.subscriber';
import { MedicalModule } from '../medical/medical.module';
import { MedicalCategory, MedicalContributionRate, MedicalLimitRule, MedicalScheme } from '../medical/medical.entities';
import { MedicalService } from '../medical/medical.service';
import { GlAccountMap, PaymentFileFormat } from '../payroll/payroll.entities';
import { SettingsService } from '../settings/settings.module';
import { TrainingModule } from '../training/training.module';
import { TrainingProgramme } from '../training/training.entities';
import { TrainingService } from '../training/training.service';

/**
 * Hospital-specific facts in one file (config/site.json), so they can be filled in as they
 * become known and applied without code changes: pay day, payment file layouts, the chart of
 * accounts, medical scheme limits, CPD requirements, the appraisal rating scale, mandatory
 * training, the SMS account and the clocking devices. Every section is optional; leave a
 * section out (or a value null) to keep what is in the system. Secrets never go in the file:
 * name the environment variable that holds them.
 *
 * The file is applied on start-up when its contents change (its SHA-256 is remembered), and
 * on demand from Administration. Edits made later on screen stay until the file changes again.
 */
const money = z.union([z.string(), z.number()]).transform((v) => new Decimal(v).toFixed(2));
const pts = z.union([z.string(), z.number()]).transform((v) => new Decimal(v).toFixed(1));
const note = z.string().optional();

const fileFormat = z.object({
  _note: note,
  code: z.string().min(2).max(30),
  name: z.string().min(2).max(200).optional(),
  file_type: z.enum(['xlsx', 'csv']).optional(),
  columns: z.array(fileColumn).min(1).max(30).optional(),
  is_default: z.boolean().optional(),
  note: z.string().max(500).optional(),
});

export const siteConfig = z.object({
  _note: note,
  version: z.literal(1),
  payroll: z.object({
    _note: note,
    pay_day: z.number().int().min(0).max(31).nullish(),
    proration_basis: z.enum(['working_days', 'calendar_days']).nullish(),
    monthly_hours: z.number().min(100).max(300).nullish(),
    bank_file: fileFormat.nullish(),
    mpesa: fileFormat.extend({ method: z.enum(['b2c_portal', 'bank_bulk', 'other']).optional() }).nullish(),
    chart_of_accounts: z.record(z.string().regex(/^[A-Z][A-Z0-9_]*$/), z.object({ debit: z.string().max(40).nullish(), credit: z.string().max(40).nullish(), description: z.string().max(200).optional() })).nullish(),
  }).nullish(),
  medical: z.object({
    _note: note,
    effective_from: z.iso.date(),
    schemes: z.array(z.object({
      _note: note,
      code: z.string().regex(/^[A-Z][A-Z0-9_-]*$/),
      name: z.string().min(2).max(200),
      year_start_month: z.number().int().min(1).max(12).optional(),
      unused_limit_policy: z.enum(['reset', 'carry_over']).optional(),
      max_dependants: z.number().int().min(0).max(20).optional(),
      over_limit_action: z.enum(['block', 'approval']).optional(),
      contributions_enabled: z.boolean().optional(),
      categories: z.array(z.object({
        code: z.string().regex(/^[a-z][a-z0-9_]*$/),
        name: z.string().min(2).max(200),
        sharing: z.enum(['shared', 'per_person']).optional(),
        co_pay_pct: z.number().min(0).max(100).optional(),
        per_visit_cap: money.nullish(),
        waiting_days: z.number().int().min(0).max(730).optional(),
        principal_and_spouse_only: z.boolean().optional(),
        limits: z.array(z.object({ job_grade: z.string().nullish(), employment_type: z.enum(EMPLOYMENT_TYPES).nullish(), annual_limit: money, dependant_limit: money.nullish() })).default([]),
      })).default([]),
      contribution_rates: z.array(z.object({ job_grade: z.string().nullish(), employment_type: z.enum(EMPLOYMENT_TYPES).nullish(), method: z.enum(['fixed', 'percent_basic']), value: z.number().min(0), per_dependant: money.optional() })).default([]),
    })).default([]),
  }).nullish(),
  cpd_requirements: z.array(z.object({ licensing_body: z.string().trim().toUpperCase().min(2).max(20), points_per_year: pts, description: z.string().max(300).optional() })).nullish(),
  performance: z.object({
    _note: note,
    rating_bands: z.array(z.object({ min: z.number().min(0).max(5), label: z.string().min(2).max(60) })).min(2).max(10).nullish(),
    low_rating: z.number().min(1).max(5).nullish(),
  }).nullish(),
  mandatory_training: z.array(z.object({
    code: z.string().trim().toUpperCase().regex(/^[A-Z0-9][A-Z0-9_-]{1,29}$/),
    title: z.string().min(3).max(200),
    category: z.enum(['clinical', 'mandatory', 'compliance', 'induction', 'leadership', 'technical', 'soft_skills']).default('mandatory'),
    delivery: z.enum(['classroom', 'online', 'on_the_job', 'external', 'conference']).default('classroom'),
    mandatory_for: z.enum(['all', 'clinical', 'none']).default('all'),
    refresh_months: z.number().int().min(1).max(120).nullish(),
    pass_mark: z.number().int().min(1).max(100).nullish(),
    duration_hours: z.union([z.string(), z.number()]).optional(),
    cpd_points: pts.optional(),
    cpd_bodies: z.array(z.string()).optional(),
    provider: z.string().max(200).optional(),
    description: z.string().max(4000).optional(),
  })).nullish(),
  sms: z.object({
    _note: note,
    enabled: z.boolean().optional(),
    username: z.string().max(100).optional(),
    sender_id: z.string().max(11).optional(),
  }).nullish(),
  devices: z.array(z.object({
    _note: note,
    code: z.string().regex(/^[a-z][a-z0-9_]*$/),
    name: z.string().min(2).max(200),
    type: z.enum(Object.keys(CONNECTOR_TYPES) as [keyof typeof CONNECTOR_TYPES, ...(keyof typeof CONNECTOR_TYPES)[]]),
    model: z.string().max(100).optional(),
    firmware: z.string().max(100).optional(),
    base_url: z.string().url().optional(),
    device_id: z.string().max(60).optional(),
    timezone: z.string().optional(),
    allowed_ips: z.array(z.string()).optional(),
    match_by: z.enum(['staff_number', 'mapping']).default('staff_number'),
    schedule_minutes: z.number().int().min(1).max(1440).nullish(),
    active: z.boolean().default(true),
    /** Names of environment variables holding the device credentials (never the values). */
    username_env: z.string().regex(/^[A-Z][A-Z0-9_]*$/).optional(),
    password_env: z.string().regex(/^[A-Z][A-Z0-9_]*$/).optional(),
  })).nullish(),
});
export type SiteConfig = z.infer<typeof siteConfig>;

const HASH_KEY = 'site_config.applied';
export const siteConfigPath = () => process.env.SITE_CONFIG_FILE || resolve(process.cwd(), '../../config/site.json');

/** Strips "_note" keys (and other keys starting with "_") so comments can live in the JSON. */
function stripNotes(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stripNotes);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([k]) => !k.startsWith('_')).map(([k, x]) => [k, stripNotes(x)]));
  return v;
}

export interface ApplyReport { file: string; hash: string; applied: boolean; reason?: string; changes: string[]; warnings: string[] }

@Injectable()
export class SiteConfigService {
  private readonly logger = new Logger('SiteConfig');
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly settings: SettingsService,
    private readonly medical: MedicalService,
    private readonly training: TrainingService,
    private readonly connectors: ConnectorsService,
  ) {}

  parse(text: string): SiteConfig {
    let raw: unknown;
    try { raw = JSON.parse(text); } catch (e) { throw unprocessable('site_config_json', `config/site.json is not valid JSON: ${(e as Error).message}`); }
    const r = siteConfig.safeParse(stripNotes(raw));
    if (!r.success) throw unprocessable('site_config_invalid', 'config/site.json has errors', r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
    return r.data;
  }

  async status() {
    const file = siteConfigPath();
    const [row] = await this.dataSource.query(`SELECT value FROM setting WHERE key = $1`, [HASH_KEY]);
    const last = (row?.value ?? null) as { hash: string; at: string; changes: string[]; warnings: string[] } | null;
    const exists = existsSync(file);
    const hash = exists ? createHash('sha256').update(readFileSync(file)).digest('hex') : null;
    return { file, exists, hash, last_applied: last, pending: exists && hash !== last?.hash };
  }

  /** Applies the file if it changed since it was last applied (or always, with force). */
  async apply(force = false): Promise<ApplyReport> {
    const file = siteConfigPath();
    if (!existsSync(file)) return { file, hash: '', applied: false, reason: 'No config/site.json (copy config/site.example.json to start)', changes: [], warnings: [] };
    const text = readFileSync(file, 'utf8');
    const hash = createHash('sha256').update(text).digest('hex');
    const st = await this.status();
    if (!force && st.last_applied?.hash === hash) return { file, hash, applied: false, reason: 'Unchanged since it was last applied', changes: [], warnings: [] };
    const cfg = this.parse(text);
    const changes: string[] = [];
    const warnings: string[] = [];
    const set = async (key: string, value: unknown, label: string) => {
      if (value === null || value === undefined) return;
      const before = await this.settings.get(key as never);
      if (JSON.stringify(before) === JSON.stringify(value)) return;
      await this.settings.set(key, value);
      changes.push(`${label}: ${JSON.stringify(before)} → ${JSON.stringify(value)}`);
    };

    // ------------------------------------------------------------ payroll
    if (cfg.payroll) {
      await set('payroll.pay_day', cfg.payroll.pay_day, 'Pay day');
      await set('payroll.proration_basis', cfg.payroll.proration_basis, 'Proration basis');
      await set('payroll.monthly_hours', cfg.payroll.monthly_hours, 'Monthly hours');
      for (const [f, channel] of [[cfg.payroll.bank_file, 'bank'], [cfg.payroll.mpesa, 'mobile_money']] as const) {
        if (!f) continue;
        const repo = this.dataSource.getRepository(PaymentFileFormat);
        const row = (await repo.findOneBy({ code: f.code })) ?? repo.create({ code: f.code, channel, name: f.name ?? f.code, fileType: f.file_type ?? 'xlsx', columns: f.columns ?? [], isDefault: false });
        const methodNote = 'method' in f && f.method ? `Method: ${f.method.replace('_', ' ')}. ` : '';
        Object.assign(row, { name: f.name ?? row.name, fileType: f.file_type ?? row.fileType, columns: f.columns ?? row.columns, note: f.note !== undefined || methodNote ? `${methodNote}${f.note ?? ''}`.trim() : row.note, isDefault: f.is_default ?? row.isDefault });
        if (row.isDefault) await this.dataSource.query(`UPDATE payment_file_format SET is_default = false WHERE channel = $1 AND code <> $2`, [channel, f.code]);
        await repo.save(row);
        changes.push(`Payment file ${f.code} (${channel === 'bank' ? 'bank' : 'M-Pesa'}) set from the file`);
      }
      for (const [key, acc] of Object.entries(cfg.payroll.chart_of_accounts ?? {})) {
        const repo = this.dataSource.getRepository(GlAccountMap);
        const row = (await repo.findOneBy({ key })) ?? repo.create({ key, description: acc.description ?? key });
        const before = `${row.debitAccount ?? '–'}/${row.creditAccount ?? '–'}`;
        if (acc.debit !== undefined) row.debitAccount = acc.debit ?? null;
        if (acc.credit !== undefined) row.creditAccount = acc.credit ?? null;
        if (acc.description) row.description = acc.description;
        const after = `${row.debitAccount ?? '–'}/${row.creditAccount ?? '–'}`;
        if (before !== after || !row.id) { await repo.save(row); changes.push(`Account ${key}: ${before} → ${after}`); }
      }
      const tbd: { key: string }[] = await this.dataSource.query(`SELECT key FROM gl_account_map WHERE debit_account LIKE 'TBD%' OR credit_account LIKE 'TBD%' ORDER BY key`);
      if (tbd.length) warnings.push(`Accounts still placeholders: ${tbd.map((t) => t.key).join(', ')}`);
    }

    // ------------------------------------------------------------ medical
    if (cfg.medical) {
      const from = cfg.medical.effective_from;
      const grades = new Map<string, string>((await this.dataSource.query(`SELECT code, id FROM job_grade`)).map((g: { code: string; id: string }) => [g.code, g.id]));
      const grade = (code?: string | null) => {
        if (!code) return null;
        const id = grades.get(code);
        if (!id) throw unprocessable('unknown_grade', `Medical: job grade ${code} does not exist`);
        return id;
      };
      for (const s of cfg.medical.schemes) {
        const existing = await this.dataSource.getRepository(MedicalScheme).findOneBy({ code: s.code });
        const scheme = await this.medical.saveScheme({
          code: s.code, name: s.name, description: existing?.description ?? null, year_start_month: s.year_start_month ?? existing?.yearStartMonth ?? 1, unused_limit_policy: s.unused_limit_policy ?? existing?.unusedLimitPolicy ?? 'reset',
          carry_over_max_pct: Number(existing?.carryOverMaxPct ?? 100), max_dependants: s.max_dependants ?? existing?.maxDependants ?? 5, over_limit_action: s.over_limit_action ?? existing?.overLimitAction ?? 'approval',
          contributions_enabled: s.contributions_enabled ?? existing?.contributionsEnabled ?? false, status: 'active',
        }, existing?.id);
        if (!existing) changes.push(`Medical scheme ${s.code} created`);
        for (const c of s.categories) {
          const cat = await this.dataSource.getRepository(MedicalCategory).findOneBy({ schemeId: scheme.id, code: c.code });
          const saved = await this.medical.saveCategory(scheme.id, {
            code: c.code, name: c.name, sharing: c.sharing ?? cat?.sharing ?? 'shared', co_pay_pct: c.co_pay_pct ?? Number(cat?.coPayPct ?? 0), per_visit_cap: c.per_visit_cap !== undefined ? c.per_visit_cap : cat?.perVisitCap ?? null,
            waiting_days: c.waiting_days ?? cat?.waitingDays ?? 0, principal_and_spouse_only: c.principal_and_spouse_only ?? cat?.principalAndSpouseOnly ?? false, sort_order: cat?.sortOrder ?? 100, status: 'active',
          }, cat?.id);
          for (const l of c.limits) {
            const gid = grade(l.job_grade);
            const current: MedicalLimitRule | null = await this.dataSource.getRepository(MedicalLimitRule).createQueryBuilder('r')
              .where('r.category_id = :c AND r.job_grade_id IS NOT DISTINCT FROM :g AND r.employment_type IS NOT DISTINCT FROM :t AND r.effective_from <= :f AND (r.effective_to IS NULL OR r.effective_to >= :f)', { c: saved.id, g: gid, t: l.employment_type ?? null, f: from })
              .orderBy('r.effectiveFrom', 'DESC').getOne();
            if (current && new Decimal(current.annualLimit).eq(l.annual_limit) && String(current.dependantLimit ?? '') === String(l.dependant_limit ?? '')) continue;
            if (current && current.effectiveFrom === from) {
              await this.medical.saveLimitRule(scheme.id, { category_id: saved.id, job_grade_id: gid, employment_type: l.employment_type ?? null, annual_limit: l.annual_limit, dependant_limit: l.dependant_limit ?? null, effective_from: from, effective_to: current.effectiveTo }, current.id, current.version);
            } else {
              await this.medical.saveLimitRule(scheme.id, { category_id: saved.id, job_grade_id: gid, employment_type: l.employment_type ?? null, annual_limit: l.annual_limit, dependant_limit: l.dependant_limit ?? null, effective_from: from, effective_to: null });
            }
            changes.push(`Medical ${s.code}/${c.code}${l.job_grade ? ` grade ${l.job_grade}` : ''}${l.employment_type ? ` ${l.employment_type}` : ''}: limit ${current ? current.annualLimit : 'none'} → ${l.annual_limit} from ${from}`);
          }
        }
        for (const r of s.contribution_rates) {
          const gid = grade(r.job_grade);
          const current = await this.dataSource.getRepository(MedicalContributionRate).createQueryBuilder('r')
            .where('r.scheme_id = :s AND r.job_grade_id IS NOT DISTINCT FROM :g AND r.employment_type IS NOT DISTINCT FROM :t AND r.effective_from <= :f AND (r.effective_to IS NULL OR r.effective_to >= :f)', { s: scheme.id, g: gid, t: r.employment_type ?? null, f: from })
            .orderBy('r.effectiveFrom', 'DESC').getOne();
          if (current && current.method === r.method && new Decimal(current.value).eq(r.value) && new Decimal(current.perDependant).eq(r.per_dependant ?? '0')) continue;
          await this.medical.saveRate(scheme.id, { job_grade_id: gid, employment_type: r.employment_type ?? null, method: r.method, value: r.value, per_dependant: r.per_dependant ?? '0.00', effective_from: from, effective_to: null }, current && current.effectiveFrom === from ? current.id : undefined, current && current.effectiveFrom === from ? current.version : undefined);
          changes.push(`Medical ${s.code} contribution${r.job_grade ? ` grade ${r.job_grade}` : ''}: ${r.method} ${r.value} from ${from}`);
        }
      }
    }

    // ------------------------------------------------------------ CPD, performance, training
    if (cfg.cpd_requirements) {
      const before = await this.training.requirements();
      const next = cfg.cpd_requirements.map((r) => ({ licensing_body: r.licensing_body, points_per_year: r.points_per_year, description: r.description ?? null }));
      if (JSON.stringify(before.map((b) => [b.licensing_body, b.points_per_year])) !== JSON.stringify([...next].sort((a, b) => a.licensing_body.localeCompare(b.licensing_body)).map((b) => [b.licensing_body, b.points_per_year]))) {
        await this.training.setRequirements({ requirements: next });
        changes.push(`CPD requirements: ${next.map((n) => `${n.licensing_body} ${n.points_per_year}`).join(', ')}`);
      }
    }
    if (cfg.performance) {
      await set('performance.rating_bands', cfg.performance.rating_bands ? [...cfg.performance.rating_bands].sort((a, b) => b.min - a.min) : null, 'Rating bands');
      await set('performance.low_rating', cfg.performance.low_rating, 'Low rating flag');
    }
    for (const t of cfg.mandatory_training ?? []) {
      const existing = await this.dataSource.getRepository(TrainingProgramme).findOneBy({ code: t.code });
      await this.training.saveProgramme({
        code: t.code, title: t.title, description: t.description ?? existing?.description ?? null, category: t.category, delivery: t.delivery, provider: t.provider ?? existing?.provider ?? null,
        duration_hours: String(t.duration_hours ?? existing?.durationHours ?? '0'), cpd_points: t.cpd_points ?? existing?.cpdPoints ?? '0', cpd_bodies: t.cpd_bodies ?? existing?.cpdBodies ?? [],
        mandatory_for: t.mandatory_for, refresh_months: t.mandatory_for === 'none' ? null : t.refresh_months ?? null, pass_mark: t.pass_mark ?? null, status: 'active',
      }, existing?.id);
      changes.push(`Mandatory training ${t.code}: ${t.mandatory_for}${t.refresh_months ? `, every ${t.refresh_months} months` : ''}${existing ? ' (updated)' : ' (added)'}`);
    }

    // ------------------------------------------------------------ SMS and devices
    if (cfg.sms) {
      await set('sms.username', cfg.sms.username, 'SMS username');
      await set('sms.sender_id', cfg.sms.sender_id, 'SMS sender ID');
      await set('sms.enabled', cfg.sms.enabled, 'SMS enabled');
      if (cfg.sms.enabled && !process.env.SMS_API_KEY) warnings.push('SMS is enabled but SMS_API_KEY is not set in the environment');
    }
    for (const d of cfg.devices ?? []) {
      const existing = await this.connectors.list().then((l) => l.find((c) => c.code === d.code));
      const creds: Record<string, string> = {};
      for (const [k, envName] of [['username', d.username_env], ['password', d.password_env]] as const) {
        if (!envName) continue;
        const v = process.env[envName];
        if (v) creds[k] = v;
        else warnings.push(`Device ${d.code}: environment variable ${envName} is not set`);
      }
      const config: Record<string, unknown> = { ...(existing?.config ?? {}), ...(d.base_url ? { base_url: d.base_url } : {}), ...(d.device_id ? { device_id: d.device_id } : {}), ...(d.timezone ? { timezone: d.timezone } : {}), ...(d.allowed_ips ? { allowed_ips: d.allowed_ips } : {}), ...(d.model ? { model: d.model } : {}), ...(d.firmware ? { firmware: d.firmware } : {}) };
      try {
        await this.connectors.save({ code: d.code, name: d.name, type: d.type, config, ...(Object.keys(creds).length === 2 ? { credentials: creds } : {}), match_by: d.match_by, schedule_minutes: d.schedule_minutes ?? null, is_active: d.active }, existing?.id, existing?.version);
        changes.push(`Device connector ${d.code} (${d.type}${d.model ? `, ${d.model}` : ''}) ${existing ? 'updated' : 'added'}`);
      } catch (e) {
        warnings.push(`Device ${d.code}: ${(e as Error).message}`);
      }
    }

    const record = { hash, at: new Date().toISOString(), changes, warnings };
    await this.dataSource.query(`INSERT INTO setting (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [HASH_KEY, JSON.stringify(record)]);
    await writeAudit(this.dataSource.manager, { action: 'update', entityType: 'SiteConfig', entityId: '00000000-0000-0000-0000-000000000000', after: record });
    this.logger.log(`Applied ${file}: ${changes.length} change(s), ${warnings.length} warning(s)`);
    return { file, hash, applied: true, changes, warnings };
  }
}

const report = z.object({ file: z.string(), hash: z.string(), applied: z.boolean(), reason: z.string().optional(), changes: z.array(z.string()), warnings: z.array(z.string()) });

@ApiTags('Administration')
@Controller('admin/site-config')
export class SiteConfigController {
  constructor(private readonly svc: SiteConfigService) {}

  @Get()
  @RequirePermissions('setting:manage')
  @ZResponse(z.object({ file: z.string(), exists: z.boolean(), hash: z.string().nullable(), pending: z.boolean(), last_applied: z.object({ hash: z.string(), at: z.string(), changes: z.array(z.string()), warnings: z.array(z.string()) }).nullable() }), 200, 'Whether config/site.json exists and has changes not yet applied')
  status() {
    return this.svc.status();
  }

  @Post('apply')
  @RequirePermissions('setting:manage')
  @HttpCode(200)
  @ZResponse(report, 200, 'Applies config/site.json now (even if unchanged) and reports what changed')
  apply() {
    return this.svc.apply(true);
  }
}

@Module({
  imports: [MedicalModule, TrainingModule, AttendanceModule],
  providers: [SiteConfigService],
  controllers: [SiteConfigController],
  exports: [SiteConfigService],
})
export class SiteConfigModule {}
