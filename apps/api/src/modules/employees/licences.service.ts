import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { z } from 'zod';
import { createLicence, licenceQuery, updateLicence, type Licence as LicenceDto, type LicenceStatus } from '@sil/hr-shared';
import { AccessProfile, applyScope } from '../../common/access';
import { iso } from '../../common/base.entity';
import { assertVersion } from '../../common/etag';
import { mapPage, paginate } from '../../common/pagination';
import { notFound } from '../../common/problem';
import { OutboxService } from '../events/events.module';
import { NotificationsService } from '../notifications/notifications.module';
import { ScopeService } from '../organisation/scope.service';
import { SettingsService } from '../settings/settings.module';
import { Employee, ProfessionalLicence } from './employee.entities';
import { EmployeesService } from './employees.service';

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/**
 * A licence's status is derived, never typed in: suspended beats everything, then expired
 * (expiry date before today), then expiring (within the reminder window), then
 * not yet verified, else valid.
 */
export function licenceStatus(l: { suspended: boolean; expiryDate: string; verifiedAt: Date | null }, today: string, reminderDays: number): LicenceStatus {
  if (l.suspended) return 'suspended';
  if (l.expiryDate < today) return 'expired';
  if (l.expiryDate <= addDays(today, reminderDays)) return 'expiring';
  if (!l.verifiedAt) return 'not_verified';
  return 'valid';
}

const SEVERITY: LicenceStatus[] = ['expired', 'suspended', 'expiring', 'not_verified', 'valid'];

/** The employee-level flag other systems read: the worst status among their licences. */
export function worstStatus(statuses: LicenceStatus[]): LicenceStatus | null {
  if (!statuses.length) return null;
  return SEVERITY.find((s) => statuses.includes(s)) ?? null;
}

@Injectable()
export class LicencesService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly employees: EmployeesService,
    private readonly scope: ScopeService,
    private readonly outbox: OutboxService,
    private readonly settings: SettingsService,
    private readonly notifications: NotificationsService,
  ) {}

  private async ctx(m?: EntityManager) {
    return { today: await this.settings.today(m), window: await this.settings.get('licences.reminder_days', m) };
  }

  private dto(l: ProfessionalLicence, today: string, window: number): LicenceDto {
    return {
      id: l.id, employee_id: l.employeeId, licensing_body: l.licensingBody, licence_number: l.licenceNumber, category: l.category, issue_date: l.issueDate,
      expiry_date: l.expiryDate, status: licenceStatus(l, today, window), verified_at: iso(l.verifiedAt), verified_by: l.verifiedBy, suspended: l.suspended,
      document_id: l.documentId, notes: l.notes, created_at: l.createdAt.toISOString(), updated_at: l.updatedAt.toISOString(), version: l.version,
    };
  }

  /** Recomputes the employee's licence flag inside the caller's transaction. */
  async refreshEmployeeFlag(m: EntityManager, employeeId: string): Promise<void> {
    const { today, window } = await this.ctx(m);
    const licences = await m.getRepository(ProfessionalLicence).findBy({ employeeId });
    const flag = worstStatus(licences.map((l) => licenceStatus(l, today, window)));
    // Bookkeeping (derived): raw SQL so the employee's version/ETag is not bumped.
    await m.query(`UPDATE employee SET licence_status = $2 WHERE id = $1 AND licence_status IS DISTINCT FROM $2`, [employeeId, flag]);
  }

  private async announce(m: EntityManager, l: ProfessionalLicence, today: string, window: number): Promise<void> {
    const e = await m.getRepository(Employee).findOneByOrFail({ id: l.employeeId });
    await this.outbox.record(m, 'hr.licence.updated.v1', l.id, { id: l.id, employee_id: l.employeeId, staff_number: e.staffNumber, licensing_body: l.licensingBody, licence_number: l.licenceNumber, expiry_date: l.expiryDate, status: licenceStatus(l, today, window) });
  }

  async list(access: AccessProfile, q: z.infer<typeof licenceQuery>) {
    const { today, window } = await this.ctx();
    const qb = this.dataSource.getRepository(ProfessionalLicence).createQueryBuilder('l').innerJoin('l.employee', 'e');
    applyScope(qb, await this.scope.filterFor(access, 'licence:read'), { branch: 'e.branch_id', department: 'e.department_id', employee: 'e.id' });
    if (q.employee_id) qb.andWhere('l.employee_id = :e', { e: q.employee_id });
    if (q.licensing_body) qb.andWhere('lower(l.licensing_body) = lower(:b)', { b: q.licensing_body });
    if (q.expiring_within_days !== undefined) qb.andWhere('l.expiry_date <= :until', { until: addDays(today, q.expiring_within_days) });
    if (q.status === 'expired') qb.andWhere('l.expiry_date < :today AND NOT l.suspended', { today });
    if (q.status === 'suspended') qb.andWhere('l.suspended');
    if (q.status === 'expiring') qb.andWhere('NOT l.suspended AND l.expiry_date >= :today AND l.expiry_date <= :w', { today, w: addDays(today, window) });
    if (q.status === 'not_verified') qb.andWhere('NOT l.suspended AND l.verified_at IS NULL AND l.expiry_date > :w', { w: addDays(today, window) });
    if (q.status === 'valid') qb.andWhere('NOT l.suspended AND l.verified_at IS NOT NULL AND l.expiry_date > :w', { w: addDays(today, window) });
    if (q.search) qb.andWhere('(l.licence_number ILIKE :s OR l.licensing_body ILIKE :s OR e.staff_number ILIKE :s)', { s: `%${q.search}%` });
    const page = await paginate(qb, q, { alias: 'l', defaultSort: 'expiry_date', sortable: { expiry_date: { prop: 'expiryDate', column: 'expiry_date', cast: 'date' } } });
    return mapPage(page, (l) => this.dto(l, today, window));
  }

  async forEmployee(access: AccessProfile, employeeId: string) {
    await this.employees.load(access, employeeId, 'licence:read');
    const { today, window } = await this.ctx();
    return (await this.dataSource.getRepository(ProfessionalLicence).find({ where: { employeeId }, order: { expiryDate: 'DESC' } })).map((l) => this.dto(l, today, window));
  }

  async create(access: AccessProfile, employeeId: string, dto: z.infer<typeof createLicence>): Promise<LicenceDto> {
    return this.dataSource.transaction(async (m) => {
      await this.employees.load(access, employeeId, 'licence:manage', m);
      const repo = m.getRepository(ProfessionalLicence);
      const l = await repo.save(repo.create({ employeeId, licensingBody: dto.licensing_body, licenceNumber: dto.licence_number, category: dto.category ?? null, issueDate: dto.issue_date ?? null, expiryDate: dto.expiry_date, documentId: dto.document_id ?? null, notes: dto.notes ?? null }));
      const { today, window } = await this.ctx(m);
      await this.refreshEmployeeFlag(m, employeeId);
      await this.announce(m, l, today, window);
      return this.dto(l, today, window);
    });
  }

  private async loadLicence(access: AccessProfile, id: string, permission: string, m: EntityManager): Promise<ProfessionalLicence> {
    const l = await m.getRepository(ProfessionalLicence).findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
    if (!l) throw notFound('Licence');
    await this.employees.load(access, l.employeeId, permission, m);
    return l;
  }

  async update(access: AccessProfile, id: string, dto: z.infer<typeof updateLicence>, version: number): Promise<LicenceDto> {
    return this.dataSource.transaction(async (m) => {
      const l = await this.loadLicence(access, id, 'licence:manage', m);
      assertVersion(l.version, version);
      const renewed = dto.expiry_date !== undefined && dto.expiry_date !== l.expiryDate;
      Object.assign(l, {
        ...(dto.licensing_body !== undefined && { licensingBody: dto.licensing_body }),
        ...(dto.licence_number !== undefined && { licenceNumber: dto.licence_number }),
        ...(dto.category !== undefined && { category: dto.category ?? null }),
        ...(dto.issue_date !== undefined && { issueDate: dto.issue_date ?? null }),
        ...(dto.expiry_date !== undefined && { expiryDate: dto.expiry_date }),
        ...(dto.document_id !== undefined && { documentId: dto.document_id ?? null }),
        ...(dto.notes !== undefined && { notes: dto.notes ?? null }),
        ...(dto.suspended !== undefined && { suspended: dto.suspended }),
      });
      // A renewal needs fresh verification.
      if (renewed) Object.assign(l, { verifiedAt: null, verifiedBy: null });
      const saved = await m.getRepository(ProfessionalLicence).save(l);
      const { today, window } = await this.ctx(m);
      await this.refreshEmployeeFlag(m, l.employeeId);
      await this.announce(m, saved, today, window);
      return this.dto(saved, today, window);
    });
  }

  async verify(access: AccessProfile, id: string): Promise<LicenceDto> {
    return this.dataSource.transaction(async (m) => {
      const l = await this.loadLicence(access, id, 'licence:verify', m);
      Object.assign(l, { verifiedAt: new Date(), verifiedBy: access.actorId });
      const saved = await m.getRepository(ProfessionalLicence).save(l);
      const { today, window } = await this.ctx(m);
      await this.refreshEmployeeFlag(m, l.employeeId);
      await this.announce(m, saved, today, window);
      return this.dto(saved, today, window);
    });
  }

  /**
   * Daily job: refreshes every employee's licence flag and, once per licence and expiry
   * date, publishes hr.licence.expiring.v1 / hr.licence.expired.v1 and notifies licence
   * managers. Idempotent: re-running the same day sends nothing new.
   */
  async sweep(): Promise<{ expiring: number; expired: number }> {
    let expiring = 0;
    let expired = 0;
    await this.dataSource.transaction(async (m) => {
      const { today, window } = await this.ctx(m);
      const rows = await m.getRepository(ProfessionalLicence).find({ relations: { employee: true } });
      const employees = new Set<string>();
      for (const l of rows) {
        employees.add(l.employeeId);
        if (!l.employee || l.employee.status === 'exited') continue;
        const status = licenceStatus(l, today, window);
        const data = { id: l.id, employee_id: l.employeeId, staff_number: l.employee.staffNumber, licensing_body: l.licensingBody, licence_number: l.licenceNumber, expiry_date: l.expiryDate, status };
        if (status === 'expiring' && l.expiringNotifiedFor !== l.expiryDate) {
          const days = daysBetween(today, l.expiryDate);
          await this.outbox.record(m, 'hr.licence.expiring.v1', l.id, { ...data, days_to_expiry: days });
          await this.notifications.notifyPermissionHolders('licence:manage', 'licence_expiring', { employee: l.employee.displayName, staff_number: l.employee.staffNumber, body: l.licensingBody, number: l.licenceNumber, expiry: l.expiryDate, days }, `/people/${l.employeeId}?tab=licences`, m);
          await m.query(`UPDATE professional_licence SET expiring_notified_for = expiry_date WHERE id = $1`, [l.id]);
          expiring++;
        }
        if (status === 'expired' && l.expiredNotifiedFor !== l.expiryDate) {
          await this.outbox.record(m, 'hr.licence.expired.v1', l.id, data);
          await this.notifications.notifyPermissionHolders('licence:manage', 'licence_expired', { employee: l.employee.displayName, staff_number: l.employee.staffNumber, body: l.licensingBody, number: l.licenceNumber, expiry: l.expiryDate }, `/people/${l.employeeId}?tab=licences`, m);
          await m.query(`UPDATE professional_licence SET expired_notified_for = expiry_date WHERE id = $1`, [l.id]);
          expired++;
        }
      }
      for (const id of employees) await this.refreshEmployeeFlag(m, id);
    });
    return { expiring, expired };
  }
}
