import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, IsNull, LessThanOrEqual } from 'typeorm';
import { z } from 'zod';
import {
  AuditAction, STATUS_TRANSITIONS, employeeQuery,
  type ChangeStatus, type Employee as EmployeeDto, type HireEmployee, type Page, type PositionAssignment as AssignmentDto, type TransferEmployee, type UpdateEmployee,
} from '@sil/hr-shared';
import { AccessProfile, applyScope, scopeAllows } from '../../common/access';
import { blindIndex, encrypt } from '../../common/crypto';
import { assertVersion } from '../../common/etag';
import { mapPage, paginate } from '../../common/pagination';
import { conflict, notFound, ProblemException, unprocessable } from '../../common/problem';
import { writeAudit } from '../audit/audit.subscriber';
import { OutboxService } from '../events/events.module';
import { UsersService } from '../identity-access/users.service';
import { NumberingService } from '../numbering/numbering.module';
import { OrganisationService } from '../organisation/organisation.service';
import { ScopeService } from '../organisation/scope.service';
import { SettingsService } from '../settings/settings.module';
import { Employee, PositionAssignment, StatusHistory } from './employee.entities';
import { employeeEventData, SENSITIVE_COLUMNS, toEmployeeDto } from './employee.mapper';

const SENSITIVE = 'employee.sensitive:read';

/** Plain (non-encrypted) personal fields: API name → entity property. */
const PLAIN_FIELDS: Record<string, keyof Employee> = {
  first_name: 'firstName', middle_name: 'middleName', last_name: 'lastName', gender: 'gender', date_of_birth: 'dateOfBirth',
  marital_status: 'maritalStatus', nationality: 'nationality', nssf_number: 'nssfNumber', sha_number: 'shaNumber',
  personal_email: 'personalEmail', personal_phone: 'personalPhone', work_email: 'workEmail', work_phone: 'workPhone',
  postal_address: 'postalAddress', residential_address: 'residentialAddress', employment_type: 'employmentType', probation_end_date: 'probationEndDate',
};
/** Encrypted fields: API name → [enc property, blind-index property]. */
const SECRET_FIELDS: Record<string, [keyof Employee, keyof Employee]> = {
  national_id: ['nationalIdEnc', 'nationalIdBidx'],
  passport_number: ['passportEnc', 'passportBidx'],
  kra_pin: ['kraPinEnc', 'kraPinBidx'],
};

function dayBefore(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

@Injectable()
export class EmployeesService implements OnModuleInit {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly scope: ScopeService,
    private readonly outbox: OutboxService,
    private readonly numbering: NumberingService,
    private readonly org: OrganisationService,
    private readonly users: UsersService,
    private readonly settings: SettingsService,
  ) {}

  /** Teaches the scope service who a manager's direct reports are. */
  onModuleInit(): void {
    this.scope.registerDirectReportsResolver(async (managerId) => {
      const rows: { id: string }[] = await this.dataSource.query(`SELECT id FROM employee WHERE manager_id = $1 AND deleted_at IS NULL`, [managerId]);
      return rows.map((r) => r.id);
    });
  }

  // ------------------------------------------------------------------ reading
  private base(m: EntityManager = this.dataSource.manager) {
    return m.getRepository(Employee).createQueryBuilder('e').addSelect(SENSITIVE_COLUMNS);
  }

  /** Loads one employee the caller may see for `permission`, else 404 (existence is not revealed). */
  async load(access: AccessProfile, id: string, permission = 'employee:read', m: EntityManager = this.dataSource.manager, lock = false): Promise<Employee> {
    const qb = this.base(m).where('e.id = :id', { id });
    if (lock) qb.setLock('pessimistic_write');
    const e = await qb.getOne();
    const filter = await this.scope.filterFor(access, permission);
    if (!e || !scopeAllows(filter, { branchId: e.branchId, departmentId: e.departmentId, employeeId: e.id })) throw notFound('Employee');
    return e;
  }

  /** Sensitive fields in clear only with the permission (under the same data scope), and every such read is audited. */
  private async present(access: AccessProfile, e: Employee, wantSensitive: boolean, m: EntityManager = this.dataSource.manager): Promise<EmployeeDto> {
    let sensitive = false;
    if (wantSensitive && access.has(SENSITIVE)) {
      const f = await this.scope.filterFor(access, SENSITIVE);
      sensitive = scopeAllows(f, { branchId: e.branchId, departmentId: e.departmentId, employeeId: e.id });
      if (sensitive) await writeAudit(m, { action: AuditAction.SENSITIVE_READ, entityType: 'Employee', entityId: e.id, after: { fields: Object.keys(SECRET_FIELDS) } });
    }
    return toEmployeeDto(e, { sensitive, userId: await this.users.userIdForEmployee(e.id, m) });
  }

  async get(access: AccessProfile, id: string, wantSensitive: boolean): Promise<EmployeeDto> {
    return this.present(access, await this.load(access, id), wantSensitive);
  }

  async list(access: AccessProfile, q: z.infer<typeof employeeQuery>): Promise<Page<EmployeeDto>> {
    const qb = this.base();
    applyScope(qb, await this.scope.filterFor(access, 'employee:read'), { branch: 'e.branch_id', department: 'e.department_id', employee: 'e.id' });
    if (q.status) qb.andWhere('e.status = :status', { status: q.status });
    if (q.employment_type) qb.andWhere('e.employment_type = :et', { et: q.employment_type });
    if (q.branch_id) qb.andWhere('e.branch_id = :b', { b: q.branch_id });
    if (q.department_id) {
      if (q.include_sub_departments === 'true') qb.andWhere('e.department_id IN (SELECT id FROM department WHERE id = :d OR :d = ANY(path))', { d: q.department_id });
      else qb.andWhere('e.department_id = :d', { d: q.department_id });
    }
    if (q.position_id) qb.andWhere('e.position_id = :p', { p: q.position_id });
    if (q.manager_id) qb.andWhere('e.manager_id = :mgr', { mgr: q.manager_id });
    if (q.licence_status) qb.andWhere('e.licence_status = :ls', { ls: q.licence_status });
    if (q.search) {
      const term = q.search.trim();
      const bidx = blindIndex(term);
      qb.andWhere(
        `((e.first_name || ' ' || coalesce(e.middle_name, '') || ' ' || e.last_name) ILIKE :s OR e.staff_number ILIKE :s OR e.work_email ILIKE :s OR e.national_id_bidx = :bidx OR e.kra_pin_bidx = :bidx)`,
        { s: `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`, bidx },
      );
    }
    const page = await paginate(qb, q, {
      alias: 'e',
      defaultSort: 'last_name',
      sortable: {
        last_name: { prop: 'lastName', column: 'last_name' },
        staff_number: { prop: 'staffNumber', column: 'staff_number' },
        hire_date: { prop: 'hireDate', column: 'hire_date', cast: 'date' },
      },
    });
    const userIds = await this.userIdsFor(page.data.map((e) => e.id));
    return mapPage(page, (e) => (e.deletedAt ? ({ id: e.id, deleted: true, deleted_at: e.deletedAt.toISOString() } as never) : toEmployeeDto(e, { sensitive: false, userId: userIds.get(e.id) ?? null })));
  }

  private async userIdsFor(ids: string[]): Promise<Map<string, string>> {
    if (!ids.length) return new Map();
    const rows: { id: string; employee_id: string }[] = await this.dataSource.query(`SELECT id, employee_id FROM user_account WHERE employee_id = ANY($1::uuid[]) AND deleted_at IS NULL`, [ids]);
    return new Map(rows.map((r) => [r.employee_id, r.id]));
  }

  // ------------------------------------------------------------------ hiring
  private async placement(m: EntityManager, positionId: string) {
    const [p] = await m.query(
      `SELECT p.id, p.department_id, d.branch_id, d.cost_centre_id, p.status FROM position p JOIN department d ON d.id = p.department_id WHERE p.id = $1 AND p.deleted_at IS NULL`,
      [positionId],
    );
    if (!p) throw unprocessable('position_not_found', 'Position not found', [{ path: 'position_id', message: 'Not found' }]);
    if (p.status !== 'active') throw unprocessable('position_inactive', 'That position is inactive', [{ path: 'position_id', message: 'Inactive' }]);
    return { positionId: p.id as string, departmentId: p.department_id as string, branchId: p.branch_id as string, costCentreId: (p.cost_centre_id as string | null) ?? null };
  }

  private async assertManager(m: EntityManager, managerId: string | null | undefined, employeeId?: string): Promise<void> {
    if (!managerId) return;
    if (managerId === employeeId) throw unprocessable('cycle', 'An employee cannot manage themselves', [{ path: 'manager_id', message: 'Self' }]);
    // Walk up the chain: the employee must not appear above their new manager.
    let cursor: string | null = managerId;
    const seen = new Set<string>();
    while (cursor) {
      if (seen.has(cursor)) break;
      seen.add(cursor);
      const [row]: { id: string; manager_id: string | null; status: string }[] = await m.query(`SELECT id, manager_id, status FROM employee WHERE id = $1 AND deleted_at IS NULL`, [cursor]);
      if (!row) throw unprocessable('manager_not_found', 'Manager not found', [{ path: 'manager_id', message: 'Not found' }]);
      if (cursor === managerId && row.status === 'exited') throw unprocessable('manager_exited', 'That person has left', [{ path: 'manager_id', message: 'Exited' }]);
      if (employeeId && row.manager_id === employeeId) throw unprocessable('cycle', 'This reporting line would loop back to the employee', [{ path: 'manager_id', message: 'Cycle' }]);
      cursor = row.manager_id;
    }
  }

  private setSecrets(e: Employee, dto: Partial<Record<string, string | null | undefined>>): string[] {
    const changed: string[] = [];
    for (const [field, [enc, bidx]] of Object.entries(SECRET_FIELDS)) {
      if (dto[field] === undefined) continue;
      const value = dto[field] ? String(dto[field]).trim().toUpperCase() : null;
      const newIdx = blindIndex(value);
      if (newIdx === (e[bidx] as string | null)) continue;
      (e as unknown as Record<string, unknown>)[enc] = encrypt(value);
      (e as unknown as Record<string, unknown>)[bidx] = newIdx;
      changed.push(field);
    }
    return changed;
  }

  private duplicateSecret(err: unknown): never {
    const c = (err as { driverError?: { constraint?: string } }).driverError?.constraint;
    const field = c === 'ux_employee_national_id' ? 'national_id' : c === 'ux_employee_kra_pin' ? 'kra_pin' : c === 'ux_employee_passport' ? 'passport_number' : null;
    if (field) throw new ProblemException(409, 'duplicate', `Another employee already has this ${field.replace('_', ' ')}`, [{ path: field, message: 'Already in use' }]);
    throw err;
  }

  async hire(access: AccessProfile, dto: HireEmployee): Promise<EmployeeDto> {
    try {
      return await this.dataSource.transaction(async (m) => {
        const place = await this.placement(m, dto.position_id);
        await this.scope.assertAllows(access, 'employee:hire', { branchId: place.branchId, departmentId: place.departmentId });
        await this.assertManager(m, dto.manager_id);
        const repo = m.getRepository(Employee);
        const e = repo.create({
          organisationId: await this.org.organisationId(m),
          staffNumber: dto.staff_number?.trim() || (await this.numbering.next('staff_number', { manager: m, date: dto.hire_date })),
          employmentType: dto.employment_type,
          status: dto.status,
          hireDate: dto.hire_date,
          probationEndDate: dto.probation_end_date ?? null,
          ...place,
          managerId: dto.manager_id ?? null,
          licenceStatus: null,
        });
        for (const [api, prop] of Object.entries(PLAIN_FIELDS)) {
          const v = (dto as Record<string, unknown>)[api];
          if (v !== undefined) (e as unknown as Record<string, unknown>)[prop] = v ?? null;
        }
        this.setSecrets(e, dto as never);
        const saved = await repo.save(e);
        await m.getRepository(PositionAssignment).save(
          m.getRepository(PositionAssignment).create({ employeeId: saved.id, ...place, managerId: saved.managerId, effectiveFrom: dto.hire_date, effectiveTo: null, reason: 'Hired' }),
        );
        await m.getRepository(StatusHistory).insert({ employeeId: saved.id, fromStatus: null, toStatus: saved.status, effectiveDate: dto.hire_date, reason: 'Hired', createdBy: access.actorId });
        await this.outbox.record(m, 'hr.employee.hired.v1', saved.id, { ...employeeEventData(saved, null), hire_date: saved.hireDate });
        return this.present(access, (await this.base(m).where('e.id = :id', { id: saved.id }).getOne())!, false, m);
      });
    } catch (err) {
      return this.duplicateSecret(err);
    }
  }

  // ------------------------------------------------------------------ editing
  async update(access: AccessProfile, id: string, dto: UpdateEmployee, version: number): Promise<EmployeeDto> {
    try {
      return await this.dataSource.transaction(async (m) => {
        const e = await this.load(access, id, 'employee:update', m, true);
        assertVersion(e.version, version);
        if (e.status === 'exited') throw conflict('employee_exited', 'This person has left; their record is read-only');
        const changed: string[] = [];
        for (const [api, prop] of Object.entries(PLAIN_FIELDS)) {
          const v = (dto as Record<string, unknown>)[api];
          if (v === undefined) continue;
          const next = v ?? null;
          if ((e as unknown as Record<string, unknown>)[prop] !== next) {
            (e as unknown as Record<string, unknown>)[prop] = next;
            changed.push(api);
          }
        }
        changed.push(...this.setSecrets(e, dto as never));
        if (!changed.length) return this.present(access, e, false, m);
        const saved = await m.getRepository(Employee).save(e);
        const userId = await this.users.userIdForEmployee(e.id, m);
        await this.outbox.record(m, 'hr.employee.updated.v1', e.id, { ...employeeEventData(saved, userId), changed_fields: changed });
        return this.present(access, saved, false, m);
      });
    } catch (err) {
      return this.duplicateSecret(err);
    }
  }

  async changeStatus(access: AccessProfile, id: string, dto: ChangeStatus): Promise<EmployeeDto> {
    return this.dataSource.transaction(async (m) => {
      const e = await this.load(access, id, 'employee:lifecycle', m, true);
      const from = e.status;
      if (from === dto.status) throw conflict('no_change', `Already ${from}`);
      if (!STATUS_TRANSITIONS[from].includes(dto.status)) throw unprocessable('invalid_transition', `Cannot go from ${from} to ${dto.status}`, [{ path: 'status', message: `Allowed: ${STATUS_TRANSITIONS[from].join(', ') || 'none'}` }]);
      if (dto.effective_date < e.hireDate) throw unprocessable('before_hire', 'The date is before the hire date', [{ path: 'effective_date', message: 'Before hire date' }]);
      e.status = dto.status;
      let userId = await this.users.userIdForEmployee(e.id, m);
      if (dto.status === 'exited') {
        e.exitDate = dto.effective_date;
        e.exitReason = dto.reason;
        // Close the open assignment on the exit date.
        await m.getRepository(PositionAssignment).update({ employeeId: e.id, effectiveTo: IsNull() }, { effectiveTo: dto.effective_date });
        // HR is the system of record: leaving ends access here at once; SCIM consumers see active=false.
        userId = (await this.users.deactivateForEmployee(e.id, m)) ?? userId;
      }
      const saved = await m.getRepository(Employee).save(e);
      await m.getRepository(StatusHistory).insert({ employeeId: e.id, fromStatus: from, toStatus: dto.status, effectiveDate: dto.effective_date, reason: dto.reason, createdBy: access.actorId });
      const data = employeeEventData(saved, userId);
      await this.outbox.record(m, 'hr.employee.status_changed.v1', e.id, { ...data, previous_status: from, effective_date: dto.effective_date });
      if (dto.status === 'exited') await this.outbox.record(m, 'hr.employee.exited.v1', e.id, { ...data, exit_date: dto.effective_date });
      return this.present(access, saved, false, m);
    });
  }

  /**
   * Records a move to another position from a date: the open assignment ends the day
   * before, a new one starts. The current fields follow at once if the date has come,
   * otherwise when the daily job reaches it.
   */
  async transfer(access: AccessProfile, id: string, dto: TransferEmployee): Promise<EmployeeDto> {
    return this.dataSource.transaction(async (m) => {
      const e = await this.load(access, id, 'employee:lifecycle', m, true);
      if (e.status === 'exited') throw conflict('employee_exited', 'This person has left');
      const place = await this.placement(m, dto.position_id);
      await this.scope.assertAllows(access, 'employee:lifecycle', { branchId: place.branchId, departmentId: place.departmentId });
      const managerId = dto.manager_id !== undefined ? (dto.manager_id ?? null) : e.managerId;
      await this.assertManager(m, managerId, e.id);
      const assignments = m.getRepository(PositionAssignment);
      const open = await assignments.findOne({ where: { employeeId: e.id, effectiveTo: IsNull() }, order: { effectiveFrom: 'DESC' } });
      if (open && dto.effective_from <= open.effectiveFrom) {
        throw unprocessable('before_current', `The current assignment started on ${open.effectiveFrom}; a transfer must start after it`, [{ path: 'effective_from', message: 'Too early' }]);
      }
      if (open) {
        open.effectiveTo = dayBefore(dto.effective_from);
        await assignments.save(open);
      }
      await assignments.save(assignments.create({ employeeId: e.id, ...place, managerId, effectiveFrom: dto.effective_from, effectiveTo: null, reason: dto.reason }));
      const previous = { position_id: e.positionId, department_id: e.departmentId, branch_id: e.branchId, cost_centre_id: e.costCentreId, manager_id: e.managerId };
      const today = await this.settings.today(m);
      if (dto.effective_from <= today) Object.assign(e, place, { managerId });
      const saved = await m.getRepository(Employee).save(e);
      const after = { ...employeeEventData(saved, await this.users.userIdForEmployee(e.id, m)), ...(dto.effective_from > today ? { position_id: place.positionId, department_id: place.departmentId, branch_id: place.branchId, cost_centre_id: place.costCentreId, manager_id: managerId } : {}) };
      await this.outbox.record(m, 'hr.employee.transferred.v1', e.id, { ...after, effective_from: dto.effective_from, previous });
      return this.present(access, saved, false, m);
    });
  }

  async setManager(access: AccessProfile, id: string, managerId: string | null): Promise<EmployeeDto> {
    return this.dataSource.transaction(async (m) => {
      const e = await this.load(access, id, 'employee:lifecycle', m, true);
      if (e.managerId === managerId) return this.present(access, e, false, m);
      await this.assertManager(m, managerId, e.id);
      const previous = e.managerId;
      e.managerId = managerId;
      const saved = await m.getRepository(Employee).save(e);
      await m.getRepository(PositionAssignment).update({ employeeId: e.id, effectiveTo: IsNull() }, { managerId });
      await this.outbox.record(m, 'hr.employee.manager_changed.v1', e.id, { ...employeeEventData(saved, await this.users.userIdForEmployee(e.id, m)), previous_manager_id: previous });
      return this.present(access, saved, false, m);
    });
  }

  async linkUser(access: AccessProfile, id: string, userId: string | null): Promise<EmployeeDto> {
    return this.dataSource.transaction(async (m) => {
      const e = await this.load(access, id, 'employee:update', m);
      const current = await this.users.userIdForEmployee(e.id, m);
      if (current && current !== userId) await this.users.linkEmployee(current, null, m);
      if (userId) await this.users.linkEmployee(userId, e.id, m);
      return this.present(access, e, false, m);
    });
  }

  async history(access: AccessProfile, id: string) {
    await this.load(access, id);
    const assignments = await this.dataSource.getRepository(PositionAssignment).find({ where: { employeeId: id }, order: { effectiveFrom: 'DESC' } });
    const statuses = await this.dataSource.getRepository(StatusHistory).find({ where: { employeeId: id }, order: { createdAt: 'DESC' } });
    return {
      assignments: assignments.map((a): AssignmentDto => ({ id: a.id, employee_id: a.employeeId, position_id: a.positionId, department_id: a.departmentId, branch_id: a.branchId, cost_centre_id: a.costCentreId, manager_id: a.managerId, effective_from: a.effectiveFrom, effective_to: a.effectiveTo, reason: a.reason, created_at: a.createdAt.toISOString() })),
      statuses: statuses.map((s) => ({ id: s.id, from_status: s.fromStatus, to_status: s.toStatus, effective_date: s.effectiveDate, reason: s.reason, created_at: s.createdAt.toISOString(), created_by: s.createdBy })),
    };
  }

  /** Daily: future-dated transfers take effect (current fields follow the assignment covering today). */
  async applyDueAssignments(): Promise<number> {
    const today = await this.settings.today();
    let n = 0;
    await this.dataSource.transaction(async (m) => {
      const due = await m.getRepository(PositionAssignment).find({ where: { effectiveFrom: LessThanOrEqual(today), effectiveTo: IsNull() } });
      for (const a of due) {
        const e = await m.getRepository(Employee).findOneBy({ id: a.employeeId });
        if (!e || e.status === 'exited' || e.positionId === a.positionId && e.managerId === a.managerId) continue;
        Object.assign(e, { positionId: a.positionId, departmentId: a.departmentId, branchId: a.branchId, costCentreId: a.costCentreId, managerId: a.managerId });
        await m.getRepository(Employee).save(e);
        n++;
      }
    });
    return n;
  }
}
