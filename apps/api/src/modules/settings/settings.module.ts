import { Controller, Get, Global, Injectable, Module, Param, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { InjectDataSource, TypeOrmModule } from '@nestjs/typeorm';
import { Column, DataSource, Entity, EntityManager, PrimaryColumn, UpdateDateColumn } from 'typeorm';
import { z } from 'zod';
import { publicSettings, setting, updateSetting, type PublicSettings, type Setting as SettingDto } from '@sil/hr-shared';
import { Public, RequirePermissions } from '../../common/decorators';
import { notFound, ProblemException, zodErrors } from '../../common/problem';
import { RequestContext } from '../../common/request-context';
import { ZBody, ZResponse } from '../../common/zod';

/** A stored override of a setting's default. Settings not stored use the code default. */
@Entity('setting')
export class Setting {
  @PrimaryColumn({ type: 'varchar', length: 100 })
  key: string;

  @Column({ type: 'jsonb' })
  value: unknown;

  @UpdateDateColumn({ type: 'timestamptz', precision: 3 })
  updatedAt: Date;

  @Column({ type: 'uuid', nullable: true })
  updatedBy: string | null;
}

interface SettingDef<T> {
  schema: z.ZodType<T>;
  default: T;
  description: string;
  type: SettingDto['type'];
  /** Exposed unauthenticated at GET /settings/public (login screen, formatting). */
  isPublic?: boolean;
}
const def = <T>(d: SettingDef<T>) => d;
const tz = z.string().refine((v) => {
  try {
    new Intl.DateTimeFormat('en', { timeZone: v });
    return true;
  } catch {
    return false;
  }
}, 'Unknown IANA timezone');

/** Every configurable setting, with its default. Nothing of this kind is hardcoded elsewhere. */
export const SETTINGS = {
  'organisation.currency': def({ schema: z.string().regex(/^[A-Z]{3}$/), default: 'KES', type: 'string', description: 'ISO 4217 currency for money amounts', isPublic: true }),
  'locale.timezone': def({ schema: tz, default: 'Africa/Nairobi', type: 'string', description: 'Timezone used to display times and to decide "today"', isPublic: true }),
  'locale.date_format': def({ schema: z.enum(['DD/MM/YYYY', 'YYYY-MM-DD', 'MM/DD/YYYY', 'DD-MM-YYYY']), default: 'DD/MM/YYYY', type: 'string', description: 'Date display format', isPublic: true }),
  'locale.language': def({ schema: z.string().min(2).max(10), default: 'en', type: 'string', description: 'UI language', isPublic: true }),
  'calendar.working_days': def({ schema: z.array(z.number().int().min(1).max(7)).min(1).max(7), default: [1, 2, 3, 4, 5], type: 'json', description: 'Working days of the week, ISO numbering (1 = Monday)' }),
  'leave.year_start_month': def({ schema: z.number().int().min(1).max(12), default: 1, type: 'number', description: 'First month of the leave year (1 = January)' }),
  'security.password_min_length': def({ schema: z.number().int().min(8).max(128), default: 10, type: 'number', description: 'Minimum password length' }),
  'security.password_require_upper': def({ schema: z.boolean(), default: true, type: 'boolean', description: 'Passwords need an upper-case letter' }),
  'security.password_require_lower': def({ schema: z.boolean(), default: true, type: 'boolean', description: 'Passwords need a lower-case letter' }),
  'security.password_require_digit': def({ schema: z.boolean(), default: true, type: 'boolean', description: 'Passwords need a digit' }),
  'security.password_require_symbol': def({ schema: z.boolean(), default: false, type: 'boolean', description: 'Passwords need a symbol' }),
  'security.lockout_threshold': def({ schema: z.number().int().min(3).max(50), default: 5, type: 'number', description: 'Failed logins before the account locks' }),
  'security.lockout_minutes': def({ schema: z.number().int().min(1).max(1440), default: 15, type: 'number', description: 'How long a locked account stays locked' }),
  'security.mfa_issuer': def({ schema: z.string().min(1).max(60), default: 'SIL HR', type: 'string', description: 'Name shown in authenticator apps' }),
  'security.ip_allow_list_enabled': def({ schema: z.boolean(), default: false, type: 'boolean', description: 'Enforce the IP allow-list at login' }),
  'webhooks.max_attempts': def({ schema: z.number().int().min(1).max(20), default: 8, type: 'number', description: 'Delivery attempts before a webhook delivery is dead-lettered' }),
  'webhooks.pause_after_dead_letters': def({ schema: z.number().int().min(1).max(100), default: 5, type: 'number', description: 'Consecutive dead-lettered deliveries before a subscription is paused' }),
  'webhooks.timeout_seconds': def({ schema: z.number().int().min(1).max(60), default: 10, type: 'number', description: 'Timeout for one delivery attempt' }),
  'licences.reminder_days': def({ schema: z.number().int().min(1).max(365), default: 60, type: 'number', description: 'Days before a professional licence expires that reminders start' }),
  'employees.contact_changes_need_approval': def({ schema: z.boolean(), default: true, type: 'boolean', description: 'Self-service contact changes wait for HR approval' }),
  'attendance.late_grace_minutes': def({ schema: z.number().int().min(0).max(240), default: 30, type: 'number', description: 'Minutes after the shift start before someone counts as late (a shift may override it)' }),
  'attendance.early_leave_grace_minutes': def({ schema: z.number().int().min(0).max(240), default: 0, type: 'number', description: 'Minutes before the shift end someone may leave without counting as early' }),
  'attendance.half_day_min_hours': def({ schema: z.number().min(1).max(12), default: 4, type: 'number', description: 'Worked hours below which a day counts as a half day' }),
  'attendance.self_clock_enabled': def({ schema: z.boolean(), default: true, type: 'boolean', description: 'Staff may clock in and out from the web app or a phone' }),
  'recruitment.retention_months': def({ schema: z.number().int().min(1).max(120), default: 24, type: 'number', description: 'Months an unsuccessful candidate\u2019s details are kept (they consented to this) before they are removed' }),
  'expenses.receipt_required_above': def({ schema: z.number().min(0).max(1_000_000), default: 500, type: 'number', description: 'Expense items above this amount (KES) need a receipt attached' }),
  'sms.enabled': def({ schema: z.boolean(), default: false, type: 'boolean', description: 'Send SMS for notification templates that list the sms channel (needs an SMS gateway)' }),
  'contracts.reminder_days': def({ schema: z.number().int().min(1).max(365), default: 60, type: 'number', description: 'Days before a fixed-term contract ends that HR is reminded to renew or end it' }),
  'lifecycle.leave_pay_days_divisor': def({ schema: z.number().min(20).max(31), default: 22, type: 'number', description: 'Working days in a month used to pay out unused leave at exit (basic ÷ this × days)' }),
  'payroll.proration_basis': def({ schema: z.enum(['working_days', 'calendar_days']), default: 'working_days', type: 'string', description: 'How joiners, leavers and unpaid leave are prorated: working days in the month (less public holidays) or calendar days' }),
  'payroll.monthly_hours': def({ schema: z.number().min(100).max(300), default: 195, type: 'number', description: 'Hours in a month for the overtime hourly rate (basic ÷ hours); 195 = 45 hours a week' }),
  'payroll.pay_day': def({ schema: z.number().int().min(0).max(31), default: 0, type: 'number', description: 'Day of the month salaries are paid; 0 = the last working day' }),
  'payroll.variance_threshold_pct': def({ schema: z.number().min(0).max(100), default: 10, type: 'number', description: 'Net pay changes above this percentage are flagged in the variance report' }),
  'payroll.notify_payslips': def({ schema: z.boolean(), default: true, type: 'boolean', description: 'Tell staff by email and in the app when their payslip is ready' }),
  'documents.download_url_ttl_seconds': def({ schema: z.number().int().min(30).max(3600), default: 300, type: 'number', description: 'Lifetime of signed download links' }),
  'documents.allowed_mime_types': def({
    schema: z.array(z.string()).min(1),
    default: ['application/pdf', 'image/png', 'image/jpeg', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'text/csv', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    type: 'json',
    description: 'File types accepted for upload',
  }),
} as const;

export type SettingKey = keyof typeof SETTINGS;
export type SettingValue<K extends SettingKey> = z.infer<(typeof SETTINGS)[K]['schema']>;

@Injectable()
export class SettingsService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async get<K extends SettingKey>(key: K, manager: EntityManager = this.dataSource.manager): Promise<SettingValue<K>> {
    const row = await manager.getRepository(Setting).findOneBy({ key });
    return (row ? row.value : SETTINGS[key].default) as SettingValue<K>;
  }

  async list(): Promise<SettingDto[]> {
    const rows = new Map((await this.dataSource.getRepository(Setting).find()).map((r) => [r.key, r]));
    return (Object.keys(SETTINGS) as SettingKey[]).map((key) => {
      const d = SETTINGS[key];
      const row = rows.get(key);
      return { key, value: row ? row.value : d.default, description: d.description, type: d.type, is_public: !!(d as { isPublic?: boolean }).isPublic, updated_at: row?.updatedAt.toISOString() ?? null };
    });
  }

  async set(key: string, value: unknown): Promise<SettingDto> {
    const d = SETTINGS[key as SettingKey];
    if (!d) throw notFound('Setting');
    const parsed = (d.schema as z.ZodType).safeParse(value);
    if (!parsed.success) throw new ProblemException(422, 'validation_failed', `Invalid value for ${key}`, zodErrors(parsed.error));
    await this.dataSource.transaction(async (m) => {
      const repo = m.getRepository(Setting);
      const existing = await repo.findOneBy({ key });
      if (existing) {
        existing.value = parsed.data;
        existing.updatedBy = RequestContext.get()?.actorId ?? null;
        await repo.save(existing);
      } else {
        await repo.save(repo.create({ key, value: parsed.data, updatedBy: RequestContext.get()?.actorId ?? null }));
      }
    });
    return (await this.list()).find((s) => s.key === key)!;
  }

  /** Today's date (YYYY-MM-DD) in the organisation's timezone. */
  async today(manager?: EntityManager): Promise<string> {
    const timeZone = await this.get('locale.timezone', manager);
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  }

  async publicSettings(): Promise<PublicSettings> {
    const [org] = await this.dataSource.query(`SELECT name FROM organisation ORDER BY created_at LIMIT 1`);
    return {
      organisation_name: org?.name ?? 'SIL HR',
      currency: await this.get('organisation.currency'),
      timezone: await this.get('locale.timezone'),
      date_format: await this.get('locale.date_format'),
      locale: await this.get('locale.language'),
      password_policy: await this.passwordPolicy(),
    };
  }

  async passwordPolicy(manager?: EntityManager): Promise<PublicSettings['password_policy']> {
    return {
      min_length: await this.get('security.password_min_length', manager),
      require_upper: await this.get('security.password_require_upper', manager),
      require_lower: await this.get('security.password_require_lower', manager),
      require_digit: await this.get('security.password_require_digit', manager),
      require_symbol: await this.get('security.password_require_symbol', manager),
    };
  }
}

@ApiTags('Settings')
@Controller('settings')
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  @Get('public')
  @Public()
  @ZResponse(publicSettings)
  publicSettings() {
    return this.settings.publicSettings();
  }

  @Get()
  @RequirePermissions('setting:read')
  @ZResponse(z.array(setting))
  list() {
    return this.settings.list();
  }

  @Put(':key')
  @RequirePermissions('setting:manage')
  @ZResponse(setting)
  set(@Param('key') key: string, @ZBody(updateSetting) body: z.infer<typeof updateSetting>) {
    return this.settings.set(key, body.value);
  }
}

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([Setting])],
  providers: [SettingsService],
  controllers: [SettingsController],
  exports: [SettingsService],
})
export class SettingsModule {}
