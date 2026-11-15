import { Controller, Get, HttpCode, Injectable, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiQuery, ApiTags } from '@nestjs/swagger';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, In } from 'typeorm';
import { z } from 'zod';
import {
  AuditAction, CONTACT_FIELDS, approversResponse, contactChangeRequest, decideContactChange, directoryEntry, directoryQuery, employee, pageOf, submitContactChange,
  type DirectoryEntry, type Page,
} from '@sil/hr-shared';
import { AccessProfile, applyScope } from '../../common/access';
import { iso } from '../../common/base.entity';
import { Access, RequirePermissions, UsersOnly } from '../../common/decorators';
import { mapPage, paginate } from '../../common/pagination';
import { badRequest, conflict, notFound, ProblemException } from '../../common/problem';
import { ZBody, ZQuery, ZResponse } from '../../common/zod';
import { writeAudit } from '../audit/audit.subscriber';
import { OutboxService } from '../events/events.module';
import { NotificationsService } from '../notifications/notifications.module';
import { ScopeService } from '../organisation/scope.service';
import { SettingsService } from '../settings/settings.module';
import { ContactChangeRequest, Employee, ProfessionalLicence } from './employee.entities';
import { employeeEventData, SENSITIVE_COLUMNS, toEmployeeDto } from './employee.mapper';

type Q<T extends z.ZodType> = z.infer<T>;

/**
 * Consumer-shaped reads for procurement, the HMIS, the lab systems and finance: a lean,
 * non-sensitive projection. The directory is organisation-wide by design (names, roles and
 * work contacts are what other systems need); anything personal stays behind employee:read
 * and its data scope.
 */
@Injectable()
export class DirectoryService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  private query() {
    return this.dataSource
      .getRepository(Employee)
      .createQueryBuilder('e')
      .leftJoinAndSelect('e.department', 'd')
      .leftJoinAndSelect('e.position', 'p')
      .leftJoinAndSelect('e.costCentre', 'c');
  }

  private async licenceExpiry(ids: string[]): Promise<Map<string, string>> {
    if (!ids.length) return new Map();
    const rows: { employee_id: string; expiry: string }[] = await this.dataSource.query(
      `SELECT employee_id, to_char(min(expiry_date), 'YYYY-MM-DD') AS expiry FROM professional_licence WHERE employee_id = ANY($1::uuid[]) AND deleted_at IS NULL AND NOT suspended GROUP BY employee_id`,
      [ids],
    );
    return new Map(rows.map((r) => [r.employee_id, r.expiry]));
  }

  private entry(e: Employee, expiry: Map<string, string>): DirectoryEntry {
    return {
      id: e.id, staff_number: e.staffNumber, display_name: e.displayName, first_name: e.firstName, last_name: e.lastName, status: e.status,
      employment_type: e.employmentType, branch_id: e.branchId, department_id: e.departmentId, department_code: e.department?.code ?? null,
      department_name: e.department?.name ?? null, position_id: e.positionId, position_title: e.position?.title ?? null, cost_centre_id: e.costCentreId,
      cost_centre_code: e.costCentre?.code ?? null, manager_id: e.managerId, work_email: e.workEmail, work_phone: e.workPhone,
      is_clinical: e.position?.isClinical ?? false, licence_status: e.licenceStatus, licence_expiry_date: expiry.get(e.id) ?? null, updated_at: e.updatedAt.toISOString(),
    };
  }

  async staff(q: Q<typeof directoryQuery>): Promise<Page<DirectoryEntry>> {
    const qb = this.query();
    if (q.status) qb.andWhere('e.status = :status', { status: q.status });
    else if (!q.updated_since) qb.andWhere(`e.status <> 'exited'`);
    if (q.branch_id) qb.andWhere('e.branch_id = :b', { b: q.branch_id });
    if (q.cost_centre_id) qb.andWhere('e.cost_centre_id = :c', { c: q.cost_centre_id });
    if (q.department_id) {
      if (q.include_sub_departments === 'true') qb.andWhere('e.department_id IN (SELECT id FROM department WHERE id = :dep OR :dep = ANY(path))', { dep: q.department_id });
      else qb.andWhere('e.department_id = :dep', { dep: q.department_id });
    }
    if (q.is_clinical) qb.andWhere('p.is_clinical = :clin', { clin: q.is_clinical === 'true' });
    if (q.staff_number) qb.andWhere('lower(e.staff_number) = lower(:sn)', { sn: q.staff_number });
    if (q.work_email) qb.andWhere('lower(e.work_email) = lower(:we)', { we: q.work_email });
    if (q.search) qb.andWhere(`((e.first_name || ' ' || e.last_name) ILIKE :s OR e.staff_number ILIKE :s OR e.work_email ILIKE :s)`, { s: `%${q.search}%` });
    const page = await paginate(qb, q, { alias: 'e', defaultSort: 'last_name', sortable: { last_name: { prop: 'lastName', column: 'last_name' }, staff_number: { prop: 'staffNumber', column: 'staff_number' } } });
    const expiry = await this.licenceExpiry(page.data.map((e) => e.id));
    return mapPage(page, (e) => (e.deletedAt ? ({ id: e.id, deleted: true, deleted_at: e.deletedAt.toISOString() } as never) : this.entry(e, expiry)));
  }

  async one(id: string): Promise<DirectoryEntry> {
    const e = await this.query().where('e.id = :id', { id }).getOne();
    if (!e) throw notFound('Staff member');
    return this.entry(e, await this.licenceExpiry([e.id]));
  }

  /**
   * Who approves for a person or a department. Line manager = the employee's manager;
   * department head = the active holder of the department's top position (the one whose
   * reporting line leaves the department), searching up the tree if it is vacant.
   */
  async approvers(target: { employeeId?: string; departmentId?: string }) {
    let departmentId = target.departmentId ?? null;
    let lineManager: Employee | null = null;
    const chain: Employee[] = [];
    if (target.employeeId) {
      const e = await this.query().where('e.id = :id', { id: target.employeeId }).getOne();
      if (!e) throw notFound('Employee');
      departmentId = e.departmentId;
      let cursor = e.managerId;
      const seen = new Set<string>();
      while (cursor && !seen.has(cursor) && chain.length < 10) {
        seen.add(cursor);
        const mgr = await this.query().where('e.id = :id', { id: cursor }).getOne();
        if (!mgr) break;
        chain.push(mgr);
        cursor = mgr.managerId;
      }
      lineManager = chain[0] ?? null;
    }
    let head: Employee | null = null;
    if (departmentId) {
      const [dept] = await this.dataSource.query(`SELECT id, path FROM department WHERE id = $1`, [departmentId]);
      if (!dept) throw notFound('Department');
      for (const depId of [dept.id, ...[...dept.path].reverse()]) {
        const [row] = await this.dataSource.query(
          `SELECT e.id FROM employee e JOIN position p ON p.id = e.position_id
             LEFT JOIN position up ON up.id = p.reports_to_position_id
            WHERE p.department_id = $1 AND e.status NOT IN ('exited', 'suspended') AND e.deleted_at IS NULL
              AND (up.id IS NULL OR up.department_id <> $1)
            ORDER BY e.hire_date LIMIT 1`,
          [depId],
        );
        if (row && row.id !== target.employeeId) {
          head = await this.query().where('e.id = :id', { id: row.id }).getOne();
          break;
        }
      }
    }
    const brief = (e: Employee | null) => (e ? { id: e.id, staff_number: e.staffNumber, display_name: e.displayName, work_email: e.workEmail } : null);
    return {
      subject: target.employeeId ? { type: 'employee' as const, id: target.employeeId } : { type: 'department' as const, id: departmentId! },
      line_manager: brief(lineManager),
      department_head: brief(head),
      chain: chain.map((e) => ({ ...brief(e)!, position_title: e.position?.title ?? null })),
    };
  }
}

@ApiTags('Integration: directory')
@Controller('directory')
export class DirectoryController {
  constructor(private readonly directory: DirectoryService) {}

  @Get('staff')
  @RequirePermissions('directory:read')
  @ZResponse(pageOf(directoryEntry))
  staff(@ZQuery(directoryQuery) q: Q<typeof directoryQuery>) {
    return this.directory.staff(q);
  }

  @Get('staff/:id')
  @RequirePermissions('directory:read')
  @ZResponse(directoryEntry)
  one(@Param('id', ParseUUIDPipe) id: string) {
    return this.directory.one(id);
  }

  @Get('approvers')
  @RequirePermissions('directory:read')
  @ApiQuery({ name: 'employee_id', required: false })
  @ApiQuery({ name: 'department_id', required: false })
  @ZResponse(approversResponse)
  approvers(@Query('employee_id') employeeId?: string, @Query('department_id') departmentId?: string) {
    const uuid = z.uuid();
    if (!employeeId === !departmentId) throw badRequest('one_target', 'Pass exactly one of employee_id or department_id');
    if ((employeeId && !uuid.safeParse(employeeId).success) || (departmentId && !uuid.safeParse(departmentId).success)) throw badRequest('invalid_input', 'Not a valid id');
    return this.directory.approvers({ employeeId, departmentId });
  }
}

// ---------------------------------------------------------------- self-service

const changeDto = (r: ContactChangeRequest) => ({
  id: r.id, employee_id: r.employeeId, changes: r.changes, status: r.status, submitted_at: r.createdAt.toISOString(), decided_at: iso(r.decidedAt), decided_by: r.decidedBy, decision_note: r.decisionNote,
});
const FIELD_PROP: Record<(typeof CONTACT_FIELDS)[number], keyof Employee> = {
  personal_email: 'personalEmail', personal_phone: 'personalPhone', postal_address: 'postalAddress', residential_address: 'residentialAddress', marital_status: 'maritalStatus',
};

@Injectable()
export class SelfServiceService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly scope: ScopeService,
    private readonly outbox: OutboxService,
    private readonly settings: SettingsService,
    private readonly notifications: NotificationsService,
  ) {}

  private async me(access: AccessProfile, m = this.dataSource.manager): Promise<Employee> {
    if (!access.employeeId) throw new ProblemException(404, 'no_employee_record', 'Your account is not linked to an employee record; ask HR');
    const e = await m.getRepository(Employee).createQueryBuilder('e').addSelect(SENSITIVE_COLUMNS).where('e.id = :id', { id: access.employeeId }).getOne();
    if (!e) throw notFound('Employee');
    return e;
  }

  /** Your own record, unmasked: the data subject may see their own data (the read is audited). */
  async profile(access: AccessProfile) {
    const e = await this.me(access);
    await writeAudit(this.dataSource.manager, { action: AuditAction.SENSITIVE_READ, entityType: 'Employee', entityId: e.id, after: { self: true } });
    return toEmployeeDto(e, { sensitive: true, userId: access.actorId });
  }

  async licences(access: AccessProfile) {
    const e = await this.me(access);
    return (await this.dataSource.getRepository(ProfessionalLicence).find({ where: { employeeId: e.id }, order: { expiryDate: 'DESC' } })).map((l) => ({
      id: l.id, licensing_body: l.licensingBody, licence_number: l.licenceNumber, expiry_date: l.expiryDate, verified: !!l.verifiedAt, suspended: l.suspended,
    }));
  }

  async team(access: AccessProfile) {
    const e = await this.me(access);
    const rows = await this.dataSource.getRepository(Employee).find({ where: { managerId: e.id, status: In(['onboarding', 'probation', 'active', 'on_notice', 'suspended']) }, relations: { position: true, department: true }, order: { lastName: 'ASC' } });
    return rows.map((r) => ({ id: r.id, staff_number: r.staffNumber, display_name: r.displayName, position_title: r.position?.title ?? null, department_name: r.department?.name ?? null, status: r.status, work_email: r.workEmail, work_phone: r.workPhone, licence_status: r.licenceStatus }));
  }

  async myChanges(access: AccessProfile) {
    const e = await this.me(access);
    return (await this.dataSource.getRepository(ContactChangeRequest).find({ where: { employeeId: e.id }, order: { createdAt: 'DESC' }, take: 20 })).map(changeDto);
  }

  /** Contact changes wait for HR (setting employees.contact_changes_need_approval). */
  async submitChange(access: AccessProfile, dto: Q<typeof submitContactChange>) {
    return this.dataSource.transaction(async (m) => {
      const e = await this.me(access, m);
      const changes = Object.fromEntries(Object.entries(dto).filter(([, v]) => v !== undefined));
      if (await m.getRepository(ContactChangeRequest).existsBy({ employeeId: e.id, status: 'pending' })) throw conflict('change_pending', 'You already have a change waiting for HR; cancel it or wait for a decision');
      const repo = m.getRepository(ContactChangeRequest);
      const req = await repo.save(repo.create({ employeeId: e.id, changes }));
      if (!(await this.settings.get('employees.contact_changes_need_approval', m))) {
        await this.apply(m, req, access.actorId, 'Applied automatically');
      } else {
        await this.notifications.notifyPermissionHolders('contact_change:decide', 'contact_change_submitted', { employee: e.displayName, staff_number: e.staffNumber }, '/people/contact-changes', m);
      }
      return changeDto(req);
    });
  }

  async cancel(access: AccessProfile, id: string) {
    const e = await this.me(access);
    const res = await this.dataSource.getRepository(ContactChangeRequest).update({ id, employeeId: e.id, status: 'pending' }, { status: 'cancelled' });
    if (!res.affected) throw notFound('Pending change');
  }

  async pending(access: AccessProfile) {
    const qb = this.dataSource.getRepository(ContactChangeRequest).createQueryBuilder('r').innerJoin(Employee, 'e', 'e.id = r.employee_id').where(`r.status = 'pending'`);
    applyScope(qb, await this.scope.filterFor(access, 'contact_change:decide'), { branch: 'e.branch_id', department: 'e.department_id', employee: 'e.id' });
    return (await qb.orderBy('r.created_at').getMany()).map(changeDto);
  }

  private async apply(m: import('typeorm').EntityManager, req: ContactChangeRequest, deciderId: string, note: string | null) {
    const e = await m.getRepository(Employee).findOneByOrFail({ id: req.employeeId });
    for (const [field, value] of Object.entries(req.changes)) (e as unknown as Record<string, unknown>)[FIELD_PROP[field as keyof typeof FIELD_PROP]] = value ?? null;
    const saved = await m.getRepository(Employee).save(e);
    Object.assign(req, { status: 'approved', decidedAt: new Date(), decidedBy: deciderId, decisionNote: note });
    await m.getRepository(ContactChangeRequest).save(req);
    const [u] = await m.query(`SELECT id FROM user_account WHERE employee_id = $1`, [e.id]);
    await this.outbox.record(m, 'hr.employee.updated.v1', e.id, { ...employeeEventData(saved, u?.id ?? null), changed_fields: Object.keys(req.changes) });
  }

  async decide(access: AccessProfile, id: string, dto: Q<typeof decideContactChange>) {
    return this.dataSource.transaction(async (m) => {
      const req = await m.getRepository(ContactChangeRequest).findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
      if (!req || req.status !== 'pending') throw notFound('Pending change');
      const e = await m.getRepository(Employee).findOneByOrFail({ id: req.employeeId });
      await this.scope.assertAllows(access, 'contact_change:decide', { branchId: e.branchId, departmentId: e.departmentId, employeeId: e.id });
      if (e.id === access.employeeId) throw new ProblemException(403, 'own_request', 'You cannot decide your own change');
      if (dto.decision === 'approved') await this.apply(m, req, access.actorId, dto.note ?? null);
      else {
        Object.assign(req, { status: 'rejected', decidedAt: new Date(), decidedBy: access.actorId, decisionNote: dto.note ?? null });
        await m.getRepository(ContactChangeRequest).save(req);
      }
      return changeDto(req);
    });
  }
}

const teamMember = z.object({ id: z.uuid(), staff_number: z.string(), display_name: z.string(), position_title: z.string().nullable(), department_name: z.string().nullable(), status: z.string(), work_email: z.string().nullable(), work_phone: z.string().nullable(), licence_status: z.string().nullable() });

/** Everything an employee needs about themselves. Requires a login linked to an employee. */
@ApiTags('Self-service')
@Controller('me')
export class SelfServiceController {
  constructor(private readonly self: SelfServiceService) {}

  @Get('employee')
  @UsersOnly()
  @ZResponse(employee)
  profile(@Access() a: AccessProfile) {
    return this.self.profile(a);
  }

  @Get('licences')
  @UsersOnly()
  @ZResponse(z.array(z.object({ id: z.uuid(), licensing_body: z.string(), licence_number: z.string(), expiry_date: z.string(), verified: z.boolean(), suspended: z.boolean() })))
  licences(@Access() a: AccessProfile) {
    return this.self.licences(a);
  }

  @Get('team')
  @UsersOnly()
  @ZResponse(z.array(teamMember))
  team(@Access() a: AccessProfile) {
    return this.self.team(a);
  }

  @Get('contact-changes')
  @UsersOnly()
  @ZResponse(z.array(contactChangeRequest))
  changes(@Access() a: AccessProfile) {
    return this.self.myChanges(a);
  }

  @Post('contact-changes')
  @UsersOnly()
  @ZResponse(contactChangeRequest, 201)
  submit(@Access() a: AccessProfile, @ZBody(submitContactChange) dto: Q<typeof submitContactChange>) {
    return this.self.submitChange(a, dto);
  }

  @Post('contact-changes/:id/cancel')
  @UsersOnly()
  @HttpCode(204)
  @ZResponse(null, 204)
  cancel(@Access() a: AccessProfile, @Param('id', ParseUUIDPipe) id: string) {
    return this.self.cancel(a, id);
  }
}

@ApiTags('People: contact changes')
@Controller('contact-change-requests')
export class ContactChangesController {
  constructor(private readonly self: SelfServiceService) {}

  @Get()
  @RequirePermissions('contact_change:decide')
  @ZResponse(z.array(contactChangeRequest))
  pending(@Access() a: AccessProfile) {
    return this.self.pending(a);
  }

  @Post(':id/decision')
  @RequirePermissions('contact_change:decide')
  @HttpCode(200)
  @ZResponse(contactChangeRequest)
  decide(@Access() a: AccessProfile, @Param('id', ParseUUIDPipe) id: string, @ZBody(decideContactChange) dto: Q<typeof decideContactChange>) {
    return this.self.decide(a, id, dto);
  }
}
