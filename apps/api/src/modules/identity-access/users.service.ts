import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, In } from 'typeorm';
import { z } from 'zod';
import {
  PERMISSION_CODES,
  createIpAllowRule,
  createRole,
  createUser,
  loginHistoryQuery,
  updateRole,
  updateUser,
  userQuery,
  type ListQuery,
  type Page,
  type Role as RoleDto,
  type RoleAssignmentInput,
  type User as UserDto,
} from '@sil/hr-shared';
import { iso } from '../../common/base.entity';
import { assertVersion } from '../../common/etag';
import { likeTerm, mapPage, paginate } from '../../common/pagination';
import { conflict, notFound, unprocessable } from '../../common/problem';
import { writeAudit } from '../audit/audit.subscriber';
import { OrganisationService } from '../organisation/organisation.service';
import { AuthService } from './auth.service';
import { IpAllowRule, LoginHistory, Role, RoleAssignment, RolePermission, User } from './identity.entities';
import { PasswordService } from './password.service';

const stamps = (e: { createdAt: Date; updatedAt: Date; version: number }) => ({ created_at: e.createdAt.toISOString(), updated_at: e.updatedAt.toISOString(), version: e.version });

export function toUserDto(u: User): UserDto {
  return {
    id: u.id,
    username: u.username,
    display_name: u.displayName,
    email: u.email,
    phone: u.phone,
    employee_id: u.employeeId,
    status: u.lockedUntil && u.lockedUntil > new Date() ? 'locked' : u.status,
    mfa_enabled: u.mfaEnabled,
    must_change_password: u.mustChangePassword,
    last_login_at: iso(u.lastLoginAt),
    roles: (u.assignments ?? []).map((a) => ({ assignment_id: a.id, role_id: a.roleId, code: a.role?.code ?? '', name: a.role?.name ?? '', scope: a.scope, branch_id: a.branchId, department_id: a.departmentId })),
    deleted_at: iso(u.deletedAt),
    ...stamps(u),
  };
}

export function toRoleDto(r: Role): RoleDto {
  return { id: r.id, code: r.code, name: r.name, description: r.description, is_system: r.isSystem, permissions: (r.rolePermissions ?? []).map((p) => p.permissionCode).sort(), ...stamps(r) };
}

@Injectable()
export class UsersService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly passwords: PasswordService,
    private readonly auth: AuthService,
    private readonly org: OrganisationService,
  ) {}

  private load(id: string, m: EntityManager = this.dataSource.manager): Promise<User | null> {
    return m.getRepository(User).findOne({ where: { id }, relations: { assignments: { role: true } } });
  }

  async list(q: z.infer<typeof userQuery>): Promise<Page<UserDto>> {
    const qb = this.dataSource.getRepository(User).createQueryBuilder('u');
    if (q.status === 'locked') qb.andWhere('u.locked_until > now()');
    else if (q.status) qb.andWhere('u.status = :status', { status: q.status });
    if (q.role) qb.andWhere('EXISTS (SELECT 1 FROM role_assignment ra JOIN role r ON r.id = ra.role_id WHERE ra.user_id = u.id AND r.code = :role)', { role: q.role });
    if (q.search) qb.andWhere('(u.username ILIKE :s OR u.display_name ILIKE :s OR u.email ILIKE :s)', { s: likeTerm(q.search) });
    const page = await paginate(qb, q, { alias: 'u', defaultSort: 'username', sortable: { username: { prop: 'username', column: 'username' }, display_name: { prop: 'displayName', column: 'display_name' } } });
    const ids = page.data.map((u) => u.id);
    const assignments = ids.length ? await this.dataSource.getRepository(RoleAssignment).find({ where: { userId: In(ids) }, relations: { role: true } }) : [];
    for (const u of page.data) u.assignments = assignments.filter((a) => a.userId === u.id);
    return mapPage(page, toUserDto);
  }

  async get(id: string): Promise<UserDto> {
    const u = await this.load(id);
    if (!u) throw notFound('User');
    return toUserDto(u);
  }

  async create(dto: z.infer<typeof createUser>): Promise<UserDto> {
    await this.passwords.assertPolicy(dto.password, { username: dto.username });
    const hash = await this.passwords.hash(dto.password);
    return this.dataSource.transaction(async (m) => {
      const repo = m.getRepository(User);
      const u = await repo.save(repo.create({ username: dto.username, displayName: dto.display_name, email: dto.email ?? null, phone: dto.phone ?? null, passwordHash: hash, mustChangePassword: true }));
      await this.replaceRoles(m, u.id, dto.roles);
      return toUserDto((await this.load(u.id, m))!);
    });
  }

  async update(id: string, dto: z.infer<typeof updateUser>, version: number): Promise<UserDto> {
    return this.dataSource.transaction(async (m) => {
      const repo = m.getRepository(User);
      const u = await repo.findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
      if (!u) throw notFound('User');
      assertVersion(u.version, version);
      if (dto.display_name !== undefined) u.displayName = dto.display_name;
      if (dto.email !== undefined) u.email = dto.email ?? null;
      if (dto.phone !== undefined) u.phone = dto.phone ?? null;
      if (dto.status !== undefined) u.status = dto.status;
      await repo.save(u);
      if (dto.status === 'disabled') await this.auth.revokeAll(id, m);
      return toUserDto((await this.load(id, m))!);
    });
  }

  async setRoles(id: string, roles: RoleAssignmentInput[]): Promise<UserDto> {
    return this.dataSource.transaction(async (m) => {
      if (!(await m.getRepository(User).existsBy({ id }))) throw notFound('User');
      await this.replaceRoles(m, id, roles);
      return toUserDto((await this.load(id, m))!);
    });
  }

  private async replaceRoles(m: EntityManager, userId: string, roles: RoleAssignmentInput[]): Promise<void> {
    const roleIds = [...new Set(roles.map((r) => r.role_id))];
    const found = roleIds.length ? await m.getRepository(Role).findBy({ id: In(roleIds) }) : [];
    const missing = roleIds.filter((id) => !found.some((r) => r.id === id));
    if (missing.length) throw unprocessable('role_not_found', `Unknown role(s): ${missing.join(', ')}`);
    const branches = await this.org.existing('branch', roles.map((r) => r.branch_id).filter((x): x is string => !!x));
    const departments = await this.org.existing('department', roles.map((r) => r.department_id).filter((x): x is string => !!x));
    roles.forEach((r, i) => {
      if (r.branch_id && !branches.has(r.branch_id)) throw unprocessable('branch_not_found', 'Branch not found', [{ path: `roles.${i}.branch_id`, message: 'Not found' }]);
      if (r.department_id && !departments.has(r.department_id)) throw unprocessable('department_not_found', 'Department not found', [{ path: `roles.${i}.department_id`, message: 'Not found' }]);
    });
    const repo = m.getRepository(RoleAssignment);
    const before = await repo.find({ where: { userId }, relations: { role: true } });
    const key = (r: { roleId?: string; role_id?: string; scope: string; branchId?: string | null; branch_id?: string | null; departmentId?: string | null; department_id?: string | null }) =>
      [r.roleId ?? r.role_id, r.scope, r.branchId ?? r.branch_id ?? '', r.departmentId ?? r.department_id ?? ''].join('|');
    const wanted = new Map(roles.map((r) => [key(r), r]));
    const toRemove = before.filter((a) => !wanted.has(key(a)));
    if (toRemove.length) await repo.remove(toRemove);
    const existingKeys = new Set(before.map(key));
    for (const [k, r] of wanted) {
      if (existingKeys.has(k)) continue;
      await repo.save(repo.create({ userId, roleId: r.role_id, scope: r.scope as RoleAssignment['scope'], branchId: r.scope === 'branch' ? r.branch_id ?? null : null, departmentId: r.scope === 'department' ? r.department_id ?? null : null }));
    }
  }

  async resetPassword(id: string, password: string): Promise<void> {
    const u = await this.dataSource.getRepository(User).findOneBy({ id });
    if (!u) throw notFound('User');
    await this.passwords.assertPolicy(password, { username: u.username });
    await this.dataSource.transaction(async (m) => {
      Object.assign(u, { passwordHash: await this.passwords.hash(password), mustChangePassword: true, failedLoginCount: 0, lockedUntil: null, passwordChangedAt: new Date() });
      await m.getRepository(User).save(u);
      await this.auth.revokeAll(id, m);
    });
  }

  async unlock(id: string): Promise<void> {
    const res = await this.dataSource.getRepository(User).update({ id }, { lockedUntil: null, failedLoginCount: 0 });
    if (!res.affected) throw notFound('User');
    await writeAudit(this.dataSource.manager, { action: 'unlock', entityType: 'User', entityId: id });
  }

  async loginHistory(q: z.infer<typeof loginHistoryQuery>) {
    const qb = this.dataSource.getRepository(LoginHistory).createQueryBuilder('h');
    if (q.user_id) qb.andWhere('h.user_id = :u', { u: q.user_id });
    if (q.outcome) qb.andWhere('h.outcome = :o', { o: q.outcome });
    if (q.search) qb.andWhere('(h.username ILIKE :s OR h.ip ILIKE :s)', { s: likeTerm(q.search) });
    const page = await paginate(qb, { ...q, sort: q.sort ?? '-occurred_at' }, { alias: 'h', defaultSort: '-occurred_at', sortable: { occurred_at: { prop: 'occurredAt', column: 'occurred_at', cast: 'timestamptz' } } });
    return mapPage(page, (h) => ({ id: h.id, user_id: h.userId, username: h.username, outcome: h.outcome, method: h.method, ip: h.ip, user_agent: h.userAgent, occurred_at: h.occurredAt.toISOString() }));
  }

  // ------------------------------------------------------------------ roles
  async listRoles(): Promise<RoleDto[]> {
    const rows = await this.dataSource.getRepository(Role).find({ relations: { rolePermissions: true }, order: { name: 'ASC' } });
    return rows.map(toRoleDto);
  }

  private assertPermissions(codes: string[]): void {
    const unknown = codes.filter((c) => !(PERMISSION_CODES as string[]).includes(c));
    if (unknown.length) throw unprocessable('unknown_permission', `Unknown permission(s): ${unknown.join(', ')}`, [{ path: 'permissions', message: unknown.join(', ') }]);
  }

  private async setPermissions(m: EntityManager, role: Role, codes: string[]): Promise<void> {
    const repo = m.getRepository(RolePermission);
    const before = (await repo.findBy({ roleId: role.id })).map((p) => p.permissionCode).sort();
    const after = [...new Set(codes)].sort();
    if (JSON.stringify(before) === JSON.stringify(after)) return;
    await repo.delete({ roleId: role.id });
    if (after.length) await repo.insert(after.map((permissionCode) => ({ roleId: role.id, permissionCode })));
    // Join-table changes raise no entity events; audit them here.
    await writeAudit(m, { action: 'update', entityType: 'Role', entityId: role.id, before: { permissions: before }, after: { permissions: after } });
  }

  async createRole(dto: z.infer<typeof createRole>): Promise<RoleDto> {
    this.assertPermissions(dto.permissions);
    return this.dataSource.transaction(async (m) => {
      const repo = m.getRepository(Role);
      const r = await repo.save(repo.create({ code: dto.code, name: dto.name, description: dto.description ?? null }));
      await this.setPermissions(m, r, dto.permissions);
      return toRoleDto((await repo.findOne({ where: { id: r.id }, relations: { rolePermissions: true } }))!);
    });
  }

  async updateRole(id: string, dto: z.infer<typeof updateRole>, version: number): Promise<RoleDto> {
    if (dto.permissions) this.assertPermissions(dto.permissions);
    return this.dataSource.transaction(async (m) => {
      const repo = m.getRepository(Role);
      const r = await repo.findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
      if (!r) throw notFound('Role');
      assertVersion(r.version, version);
      if (r.code === 'system_admin' && dto.permissions && dto.permissions.length !== PERMISSION_CODES.length) {
        throw conflict('system_admin_fixed', 'System Admin always holds every permission');
      }
      if (dto.name !== undefined) r.name = dto.name;
      if (dto.description !== undefined) r.description = dto.description ?? null;
      await repo.save(r);
      if (dto.permissions) await this.setPermissions(m, r, dto.permissions);
      return toRoleDto((await repo.findOne({ where: { id }, relations: { rolePermissions: true } }))!);
    });
  }

  async deleteRole(id: string): Promise<void> {
    await this.dataSource.transaction(async (m) => {
      const r = await m.getRepository(Role).findOneBy({ id });
      if (!r) throw notFound('Role');
      if (r.isSystem) throw conflict('system_role', 'Built-in roles cannot be deleted');
      if (await m.getRepository(RoleAssignment).existsBy({ roleId: id })) throw conflict('role_in_use', 'Remove this role from every user first');
      await m.getRepository(Role).remove(r);
    });
  }

  // ------------------------------------------------------------------ IP allow-list
  async listIpRules(_q?: ListQuery) {
    const rows = await this.dataSource.getRepository(IpAllowRule).find({ order: { createdAt: 'ASC' } });
    return rows.map((r) => ({ id: r.id, cidr: r.cidr, description: r.description, applies_to: r.appliesTo, is_active: r.isActive, ...stamps(r) }));
  }

  async createIpRule(dto: z.infer<typeof createIpAllowRule>) {
    const repo = this.dataSource.getRepository(IpAllowRule);
    const r = await repo.save(repo.create({ cidr: dto.cidr, description: dto.description ?? null, appliesTo: dto.applies_to }));
    return { id: r.id, cidr: r.cidr, description: r.description, applies_to: r.appliesTo, is_active: r.isActive, ...stamps(r) };
  }

  async deleteIpRule(id: string): Promise<void> {
    const repo = this.dataSource.getRepository(IpAllowRule);
    const r = await repo.findOneBy({ id });
    if (!r) throw notFound('IP rule');
    await repo.remove(r);
  }
}
