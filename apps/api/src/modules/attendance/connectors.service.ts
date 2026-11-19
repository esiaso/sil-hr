import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { z } from 'zod';
import { upsertConnector, upsertDeviceUserMapping, type Connector as ConnectorDto } from '@sil/hr-shared';
import { loadEnv } from '../../config/env';
import { decrypt, encrypt } from '../../common/crypto';
import { assertVersion } from '../../common/etag';
import { notFound, ProblemException, unprocessable } from '../../common/problem';
import { NotificationsService } from '../notifications/notifications.module';
import { SettingsService } from '../settings/settings.module';
import { ScopeService } from '../organisation/scope.service';
import type { AccessProfile } from '../../common/access';
import { zonedToUtc } from './attendance.rules';
import { ADAPTERS, parseHikvisionEvent, parseZkAttlog } from './adapters';
import { Connector, ConnectorRun, DeviceUserMapping } from './attendance.entities';
import { AttendanceService, type IncomingPunch } from './attendance.service';

/** Re-read this much before the cursor on every pull, so late-arriving punches are not missed (duplicates are ignored). */
const OVERLAP_MS = 15 * 60_000;
/** First pull of a new connector goes back this far. */
const FIRST_PULL_MS = 7 * 86_400_000;

@Injectable()
export class ConnectorsService {
  private readonly logger = new Logger('Connectors');

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly attendance: AttendanceService,
    private readonly notifications: NotificationsService,
    private readonly settings: SettingsService,
    private readonly scope: ScopeService,
  ) {}

  dto(c: Connector & { credentialsEnc?: string | null }, hasCredentials?: boolean): ConnectorDto {
    const base = loadEnv().publicBaseUrl;
    const push = c.type === 'zkteco_push' ? `${base}/iclock/cdata (set the device's server to ${base.replace(/^https?:\/\//, '')}; serials must be listed here)` : c.type === 'hikvision_push' ? `${base}/api/v1/integrations/hikvision/${c.code}/events` : null;
    return {
      id: c.id, code: c.code, name: c.name, type: c.type, config: c.config, has_credentials: hasCredentials ?? !!c.credentialsEnc, match_by: c.matchBy, schedule_minutes: c.scheduleMinutes,
      is_active: c.isActive, last_run_at: c.lastRunAt?.toISOString() ?? null, last_success_at: c.lastSuccessAt?.toISOString() ?? null, health: c.health, health_message: c.healthMessage, push_url: push,
      created_at: c.createdAt.toISOString(), updated_at: c.updatedAt.toISOString(), version: c.version,
    };
  }

  private load(id: string) {
    return this.dataSource.getRepository(Connector).createQueryBuilder('c').addSelect('c.credentialsEnc').where('c.id = :id', { id }).getOne();
  }

  async list() {
    const rows = await this.dataSource.getRepository(Connector).createQueryBuilder('c').addSelect('c.credentialsEnc').orderBy('c.name').getMany();
    return rows.map((c) => this.dto(c));
  }

  async save(dto: z.infer<typeof upsertConnector>, id?: string, version?: number) {
    const repo = this.dataSource.getRepository(Connector);
    const c = id ? await this.load(id) : repo.create();
    if (!c) throw notFound('Connector');
    if (id && version !== undefined) assertVersion(c.version, version);
    const adapter = ADAPTERS[dto.type];
    const hasCreds = dto.credentials ? Object.keys(dto.credentials).length > 0 : !!c.credentialsEnc;
    const problems = adapter.validate(dto.config, hasCreds);
    if (problems.length) throw unprocessable('invalid_connector', problems.join('; '), problems.map((p) => ({ path: p.startsWith('credentials') ? 'credentials' : `config.${p.split(':')[0]}`, message: p })));
    const matchBefore = id ? c.matchBy : null;
    Object.assign(c, { code: dto.code, name: dto.name, type: dto.type, config: dto.config, matchBy: dto.match_by, scheduleMinutes: dto.schedule_minutes ?? null, isActive: dto.is_active });
    if (dto.credentials) c.credentialsEnc = encrypt(JSON.stringify(dto.credentials));
    const saved = await repo.save(c);
    // A new way of matching may place punches that arrived unmatched.
    if (matchBefore !== null && matchBefore !== dto.match_by) await this.attendance.rematch(saved.id);
    return this.dto(saved, hasCreds);
  }

  private creds(c: Connector): Record<string, string> {
    return c.credentialsEnc ? (JSON.parse(decrypt(c.credentialsEnc) ?? '{}') as Record<string, string>) : {};
  }

  async test(id: string): Promise<{ ok: boolean; message: string }> {
    const c = await this.load(id);
    if (!c) throw notFound('Connector');
    const adapter = ADAPTERS[c.type];
    if (!adapter.test) return { ok: true, message: 'Push connector: it is ready when devices send to the push URL' };
    try {
      const message = await adapter.test(c, this.creds(c));
      await this.dataSource.getRepository(Connector).update({ id }, { health: 'ok', healthMessage: message });
      return { ok: true, message };
    } catch (err) {
      const message = String((err as Error).message).slice(0, 500);
      await this.dataSource.getRepository(Connector).update({ id }, { health: 'failing', healthMessage: message });
      return { ok: false, message };
    }
  }

  private async record(c: Connector, trigger: ConnectorRun['trigger'], from: Date | null, to: Date | null, fn: () => Promise<IncomingPunch[]>, moveCursor = true) {
    const runs = this.dataSource.getRepository(ConnectorRun);
    const run = await runs.save(runs.create({ connectorId: c.id, trigger, windowFrom: from, windowTo: to }));
    try {
      const punches = await fn();
      const r = await this.attendance.ingest(punches);
      Object.assign(run, { status: r.errors.length ? 'partial' : 'succeeded', finishedAt: new Date(), received: punches.length, accepted: r.accepted, duplicates: r.duplicates, unmatched: r.unmatched, error: r.errors.length ? r.errors.slice(0, 5).map((e) => `#${e.index}: ${e.message}`).join('; ') : null });
      await runs.save(run);
      await this.dataSource.getRepository(Connector).update({ id: c.id }, { lastRunAt: new Date(), lastSuccessAt: new Date(), ...(to && moveCursor ? { cursorAt: to } : {}) });
      await this.refreshHealth(c.id);
      return run;
    } catch (err) {
      const message = String((err as Error).message).slice(0, 2000);
      Object.assign(run, { status: 'failed', finishedAt: new Date(), error: message });
      await runs.save(run);
      const wasFailing = c.health === 'failing';
      await this.dataSource.getRepository(Connector).update({ id: c.id }, { lastRunAt: new Date(), health: 'failing', healthMessage: message.slice(0, 500) });
      if (!wasFailing) await this.notifications.notifyPermissionHolders('connector:manage', 'connector_failing', { connector: c.name, error: message.slice(0, 300) }, '/integrations/connectors', this.dataSource.manager);
      this.logger.warn({ connector: c.code, err: message }, 'Connector run failed');
      return run;
    }
  }

  /** Health reflects every punch still unmatched, not just the latest run. */
  private async refreshHealth(connectorId: string) {
    const [{ n }] = await this.dataSource.query(`SELECT count(*)::int AS n FROM clock_event WHERE connector_id = $1 AND employee_id IS NULL`, [connectorId]);
    await this.dataSource.getRepository(Connector).update({ id: connectorId }, { health: n > 0 ? 'degraded' : 'ok', healthMessage: n > 0 ? `${n} punch(es) from device users not matched to anyone` : null });
  }

  /** Pulls from the cursor (minus an overlap) to now. */
  async runPull(id: string, trigger: 'schedule' | 'manual' = 'manual') {
    const c = await this.load(id);
    if (!c) throw notFound('Connector');
    const adapter = ADAPTERS[c.type];
    if (!adapter.pull) throw new ProblemException(409, 'push_connector', 'This connector receives pushes; there is nothing to pull');
    const to = new Date();
    const from = new Date((c.cursorAt?.getTime() ?? to.getTime() - FIRST_PULL_MS) - OVERLAP_MS);
    return this.runDto(await this.record(c, trigger, from, to, () => adapter.pull!(c, this.creds(c), from, to)));
  }

  /**
   * Fetches one person's punches for a date range from every active pull connector now,
   * instead of waiting for the schedule (a missing day, a late device, a payroll query).
   * The person is looked up on each device by their mapped device id, or by staff number
   * when the connector matches by staff number. The connectors' own cursors do not move.
   */
  async pullForEmployeeChecked(access: AccessProfile, employeeId: string, fromDate: string, toDate: string) {
    const [e] = await this.dataSource.query(`SELECT id, staff_number, branch_id, department_id FROM employee WHERE id = $1 AND deleted_at IS NULL`, [employeeId]);
    if (!e) throw notFound('Employee');
    await this.scope.assertAllows(access, 'attendance:manage', { branchId: e.branch_id, departmentId: e.department_id, employeeId: e.id });
    const days = (Date.parse(toDate) - Date.parse(fromDate)) / 86_400_000;
    if (days < 0 || days > 62) throw unprocessable('range', 'Choose up to 62 days, with the end on or after the start', [{ path: 'to', message: 'Range' }]);
    const connectors = await this.pullForEmployee({ id: e.id, staffNumber: e.staff_number }, fromDate, toDate);
    return { employee_id: e.id, from: fromDate, to: toDate, connectors, accepted: connectors.reduce((s, c) => s + c.accepted, 0) };
  }

  async pullForEmployee(employee: { id: string; staffNumber: string }, fromDate: string, toDate: string) {
    const timeZone = await this.settings.get('locale.timezone');
    const from = zonedToUtc(fromDate, '00:00', timeZone);
    const to = new Date(zonedToUtc(toDate, '00:00', timeZone).getTime() + 86_400_000);
    const connectors = await this.dataSource.getRepository(Connector).find({ where: { isActive: true } });
    const out: { connector_id: string; connector: string; device_user_ids: string[]; status: string; received: number; accepted: number; duplicates: number; error: string | null }[] = [];
    for (const c of connectors) {
      const adapter = ADAPTERS[c.type];
      if (!adapter.pull) continue;
      const mapped: { device_user_id: string }[] = await this.dataSource.query(`SELECT device_user_id FROM device_user_mapping WHERE connector_id = $1 AND employee_id = $2`, [c.id, employee.id]);
      const ids = [...new Set([...mapped.map((x) => x.device_user_id), ...(c.matchBy === 'staff_number' ? [employee.staffNumber] : [])])];
      if (!ids.length) {
        out.push({ connector_id: c.id, connector: c.name, device_user_ids: [], status: 'skipped', received: 0, accepted: 0, duplicates: 0, error: 'This person is not mapped to a user on these devices' });
        continue;
      }
      const wanted = new Set(ids.map((x) => x.toLowerCase()));
      const run = await this.record(c, 'manual', from, to, async () => (await adapter.pull!(c, this.creds(c), from, to, ids)).filter((p) => p.deviceUserId && wanted.has(p.deviceUserId.toLowerCase())), false);
      out.push({ connector_id: c.id, connector: c.name, device_user_ids: ids, status: run.status, received: run.received, accepted: run.accepted, duplicates: run.duplicates, error: run.error });
    }
    return out;
  }

  /** Worker: runs every active pull connector whose schedule is due. */
  async runDue(): Promise<number> {
    const due = await this.dataSource.getRepository(Connector).createQueryBuilder('c')
      .where(`c.is_active AND c.schedule_minutes IS NOT NULL AND c.type IN ('zkteco_biotime', 'hikvision_isapi')`)
      .andWhere(`(c.last_run_at IS NULL OR c.last_run_at < now() - make_interval(mins => c.schedule_minutes))`).getMany();
    for (const c of due) await this.runPull(c.id, 'schedule');
    return due.length;
  }

  runDto(r: ConnectorRun) {
    return { id: r.id, connector_id: r.connectorId, trigger: r.trigger, status: r.status, started_at: r.startedAt.toISOString(), finished_at: r.finishedAt?.toISOString() ?? null, window_from: r.windowFrom?.toISOString() ?? null, window_to: r.windowTo?.toISOString() ?? null, received: r.received, accepted: r.accepted, duplicates: r.duplicates, unmatched: r.unmatched, error: r.error };
  }

  async runs(id: string) {
    return (await this.dataSource.getRepository(ConnectorRun).find({ where: { connectorId: id }, order: { startedAt: 'DESC' }, take: 50 })).map((r) => this.runDto(r));
  }

  // ------------------------------------------------------------------ pushes
  private ipAllowed(c: Connector, ip: string | undefined): boolean {
    const allowed = (c.config.allowed_ips as string[] | undefined) ?? [];
    if (!allowed.length) return true;
    const clean = (ip ?? '').replace(/^::ffff:/, '');
    return allowed.includes('*') || allowed.includes(clean);
  }

  /** ZKTeco ADMS: find the connector that lists this serial number. */
  async zkConnectorFor(sn: string, ip: string | undefined): Promise<Connector | null> {
    const rows = await this.dataSource.getRepository(Connector).find({ where: { type: 'zkteco_push', isActive: true } });
    const c = rows.find((r) => ((r.config.serial_numbers as string[] | undefined) ?? []).includes(sn));
    return c && this.ipAllowed(c, ip) ? c : null;
  }

  async zkPush(c: Connector, sn: string, body: string) {
    return this.record(c, 'push', null, null, async () => parseZkAttlog(body, c, sn));
  }

  async hikPush(code: string, ip: string | undefined, payload: unknown) {
    const c = await this.dataSource.getRepository(Connector).findOneBy({ code, type: 'hikvision_push', isActive: true });
    if (!c || !this.ipAllowed(c, ip)) throw new ProblemException(403, 'unknown_device', 'This device is not registered to push to PeopleTrack');
    const run = await this.record(c, 'push', null, null, async () => parseHikvisionEvent(payload, c));
    return this.runDto(run);
  }

  // ------------------------------------------------------------------ device user mapping
  async mappings(connectorId: string) {
    const rows: { id: string; connector_id: string; device_user_id: string; employee_id: string; name: string | null }[] = await this.dataSource.query(
      `SELECT m.id, m.connector_id, m.device_user_id, m.employee_id, e.first_name || ' ' || e.last_name AS name FROM device_user_mapping m JOIN employee e ON e.id = m.employee_id WHERE m.connector_id = $1 ORDER BY m.device_user_id`,
      [connectorId],
    );
    return rows.map((r) => ({ id: r.id, connector_id: r.connector_id, device_user_id: r.device_user_id, employee_id: r.employee_id, employee_name: r.name }));
  }

  async map(connectorId: string, dto: z.infer<typeof upsertDeviceUserMapping>) {
    const repo = this.dataSource.getRepository(DeviceUserMapping);
    const row = (await repo.findOneBy({ connectorId, deviceUserId: dto.device_user_id })) ?? repo.create({ connectorId, deviceUserId: dto.device_user_id });
    row.employeeId = dto.employee_id;
    await repo.save(row);
    // Punches that arrived before the mapping now find their person.
    const rematched = await this.attendance.rematch(connectorId);
    await this.refreshHealth(connectorId);
    return { mappings: await this.mappings(connectorId), rematched };
  }

  async unmatched(connectorId: string) {
    const rows: { device_user_id: string; n: string; last: Date }[] = await this.dataSource.query(
      `SELECT device_user_id, count(*)::text AS n, max(occurred_at) AS last FROM clock_event WHERE connector_id = $1 AND employee_id IS NULL GROUP BY 1 ORDER BY 3 DESC LIMIT 200`,
      [connectorId],
    );
    return rows.map((r) => ({ device_user_id: r.device_user_id, punches: Number(r.n), last_seen: new Date(r.last).toISOString() }));
  }
}
