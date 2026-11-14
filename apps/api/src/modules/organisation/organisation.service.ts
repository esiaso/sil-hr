import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, In } from 'typeorm';
import type {
  Branch as BranchDto,
  CostCentre as CostCentreDto,
  CreateBranch,
  CreateCostCentre,
  CreateDepartment,
  CreateJobGrade,
  CreatePosition,
  Department as DepartmentDto,
  DepartmentNode,
  JobGrade as JobGradeDto,
  ListQuery,
  Organisation as OrganisationDto,
  Page,
  Position as PositionDto,
  UpdateBranch,
  UpdateCostCentre,
  UpdateDepartment,
  UpdateJobGrade,
  UpdateOrganisation,
  UpdatePosition,
} from '@sil/hr-shared';
import { AccessProfile } from '../../common/access';
import { iso } from '../../common/base.entity';
import { assertVersion } from '../../common/etag';
import { likeTerm, mapPage, paginate } from '../../common/pagination';
import { conflict, notFound, unprocessable } from '../../common/problem';
import { writeAudit } from '../audit/audit.subscriber';
import { OutboxService } from '../events/events.module';
import { Branch, CostCentre, Department, JobGrade, Organisation, Position } from './organisation.entities';
import { ScopeService } from './scope.service';

const stamps = (e: { createdAt: Date; updatedAt: Date; version: number }) => ({
  created_at: e.createdAt.toISOString(),
  updated_at: e.updatedAt.toISOString(),
  version: e.version,
});

export const toOrganisationDto = (o: Organisation): OrganisationDto => ({
  id: o.id, code: o.code, name: o.name, legal_name: o.legalName, kra_pin: o.kraPin, nssf_employer_no: o.nssfEmployerNo,
  sha_employer_no: o.shaEmployerNo, address: o.address, phone: o.phone, email: o.email, website: o.website, ...stamps(o),
});
export const toBranchDto = (b: Branch): BranchDto => ({
  id: b.id, organisation_id: b.organisationId, code: b.code, name: b.name, address: b.address, city: b.city, county: b.county,
  phone: b.phone, email: b.email, timezone: b.timezone, status: b.status, deleted_at: iso(b.deletedAt), ...stamps(b),
});
export const toCostCentreDto = (c: CostCentre): CostCentreDto => ({
  id: c.id, organisation_id: c.organisationId, code: c.code, name: c.name, description: c.description, status: c.status, deleted_at: iso(c.deletedAt), ...stamps(c),
});
export const toDepartmentDto = (d: Department): DepartmentDto => ({
  id: d.id, organisation_id: d.organisationId, branch_id: d.branchId, parent_id: d.parentId, cost_centre_id: d.costCentreId, code: d.code,
  name: d.name, description: d.description, path: d.path, depth: d.path.length, status: d.status, deleted_at: iso(d.deletedAt), ...stamps(d),
});
export const toJobGradeDto = (g: JobGrade): JobGradeDto => ({
  id: g.id, organisation_id: g.organisationId, code: g.code, name: g.name, rank: g.rank, description: g.description, status: g.status, deleted_at: iso(g.deletedAt), ...stamps(g),
});
export const toPositionDto = (p: Position): PositionDto => ({
  id: p.id, organisation_id: p.organisationId, department_id: p.departmentId, job_grade_id: p.jobGradeId, reports_to_position_id: p.reportsToPositionId,
  code: p.code, title: p.title, description: p.description, headcount: p.headcount, is_clinical: p.isClinical, licence_required: p.licenceRequired,
  status: p.status, deleted_at: iso(p.deletedAt), ...stamps(p),
});

/** Incremental-sync consumers get `{id, deleted, deleted_at}` for soft-deleted rows. */
function orTombstone<E extends { id: string; deletedAt: Date | null }, D>(fn: (e: E) => D) {
  return (e: E): D => (e.deletedAt ? ({ id: e.id, deleted: true, deleted_at: e.deletedAt.toISOString() } as unknown as D) : fn(e));
}

const pick = <T extends object>(o: T, keys: (keyof T)[]) => keys.filter((k) => o[k] !== undefined);

/** Fields of `after` that differ from `before`, in API (snake_case) names. */
function changedFields(before: Record<string, unknown>, after: Record<string, unknown>): string[] {
  return Object.keys(after).filter((k) => !['updated_at', 'version', 'created_at'].includes(k) && JSON.stringify(before[k]) !== JSON.stringify(after[k]));
}

@Injectable()
export class OrganisationService {
  private orgId: string | null = null;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly outbox: OutboxService,
    private readonly scope: ScopeService,
  ) {}

  async organisationId(manager: EntityManager = this.dataSource.manager): Promise<string> {
    if (this.orgId) return this.orgId;
    const org = await manager.getRepository(Organisation).findOne({ where: {}, order: { createdAt: 'ASC' } });
    if (!org) throw notFound('Organisation (run the seed)');
    this.orgId = org.id;
    return org.id;
  }

  // ------------------------------------------------------------------ organisation
  async getOrganisation(): Promise<OrganisationDto> {
    const org = await this.dataSource.getRepository(Organisation).findOneByOrFail({ id: await this.organisationId() });
    return toOrganisationDto(org);
  }

  async updateOrganisation(dto: UpdateOrganisation, version: number): Promise<OrganisationDto> {
    return this.dataSource.transaction(async (m) => {
      const repo = m.getRepository(Organisation);
      const org = await repo.findOne({ where: { id: await this.organisationId(m) }, lock: { mode: 'pessimistic_write' } });
      if (!org) throw notFound('Organisation');
      assertVersion(org.version, version);
      Object.assign(org, {
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.legal_name !== undefined && { legalName: dto.legal_name }),
        ...(dto.kra_pin !== undefined && { kraPin: dto.kra_pin }),
        ...(dto.nssf_employer_no !== undefined && { nssfEmployerNo: dto.nssf_employer_no }),
        ...(dto.sha_employer_no !== undefined && { shaEmployerNo: dto.sha_employer_no }),
        ...(dto.address !== undefined && { address: dto.address }),
        ...(dto.phone !== undefined && { phone: dto.phone }),
        ...(dto.email !== undefined && { email: dto.email }),
        ...(dto.website !== undefined && { website: dto.website }),
      });
      return toOrganisationDto(await repo.save(org));
    });
  }

  // ------------------------------------------------------------------ branches
  async listBranches(q: ListQuery & { status?: string }): Promise<Page<BranchDto>> {
    const qb = this.dataSource.getRepository(Branch).createQueryBuilder('b');
    if (q.status) qb.andWhere('b.status = :status', { status: q.status });
    if (q.search) qb.andWhere('(b.name ILIKE :s OR b.code ILIKE :s)', { s: likeTerm(q.search) });
    const page = await paginate(qb, q, { alias: 'b', defaultSort: 'name', sortable: { name: { prop: 'name', column: 'name' }, code: { prop: 'code', column: 'code' } } });
    return mapPage(page, orTombstone(toBranchDto));
  }

  async getBranch(id: string): Promise<BranchDto> {
    const b = await this.dataSource.getRepository(Branch).findOneBy({ id });
    if (!b) throw notFound('Branch');
    return toBranchDto(b);
  }

  async createBranch(dto: CreateBranch): Promise<BranchDto> {
    return this.dataSource.transaction(async (m) => {
      const repo = m.getRepository(Branch);
      const b = await repo.save(repo.create({ organisationId: await this.organisationId(m), code: dto.code, name: dto.name, address: dto.address ?? null, city: dto.city ?? null, county: dto.county ?? null, phone: dto.phone ?? null, email: dto.email ?? null, timezone: dto.timezone ?? null }));
      await this.outbox.record(m, 'hr.organisation.branch.created.v1', b.id, { id: b.id, code: b.code, name: b.name, status: b.status });
      return toBranchDto(b);
    });
  }

  async updateBranch(id: string, dto: UpdateBranch, version: number): Promise<BranchDto> {
    return this.dataSource.transaction(async (m) => {
      const repo = m.getRepository(Branch);
      const b = await repo.findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
      if (!b) throw notFound('Branch');
      assertVersion(b.version, version);
      const before = toBranchDto(b);
      for (const k of pick(dto, ['code', 'name', 'address', 'city', 'county', 'phone', 'email', 'timezone', 'status'])) (b as unknown as Record<string, unknown>)[k] = dto[k] ?? null;
      if (dto.status === 'inactive') await this.assertNoActiveChildren(m, 'branch_id', id, 'branch');
      const after = toBranchDto(await repo.save(b));
      const changed = changedFields(before, after);
      if (changed.length) await this.outbox.record(m, 'hr.organisation.branch.updated.v1', b.id, { id: b.id, code: b.code, name: b.name, status: b.status, changed_fields: changed });
      return after;
    });
  }

  private async assertNoActiveChildren(m: EntityManager, column: 'branch_id' | 'parent_id' | 'cost_centre_id', id: string, what: string): Promise<void> {
    const [row] = await m.query(`SELECT count(*)::int AS n FROM department WHERE ${column} = $1 AND status = 'active' AND deleted_at IS NULL`, [id]);
    if (row.n > 0) throw conflict('has_active_departments', `This ${what} still has ${row.n} active department(s); move or deactivate them first`);
  }

  // ------------------------------------------------------------------ cost centres
  async listCostCentres(q: ListQuery & { status?: string }): Promise<Page<CostCentreDto>> {
    const qb = this.dataSource.getRepository(CostCentre).createQueryBuilder('c');
    if (q.status) qb.andWhere('c.status = :status', { status: q.status });
    if (q.search) qb.andWhere('(c.name ILIKE :s OR c.code ILIKE :s)', { s: likeTerm(q.search) });
    const page = await paginate(qb, q, { alias: 'c', defaultSort: 'code', sortable: { name: { prop: 'name', column: 'name' }, code: { prop: 'code', column: 'code' } } });
    return mapPage(page, orTombstone(toCostCentreDto));
  }

  async getCostCentre(id: string): Promise<CostCentreDto> {
    const c = await this.dataSource.getRepository(CostCentre).findOneBy({ id });
    if (!c) throw notFound('Cost centre');
    return toCostCentreDto(c);
  }

  async createCostCentre(dto: CreateCostCentre): Promise<CostCentreDto> {
    return this.dataSource.transaction(async (m) => {
      const repo = m.getRepository(CostCentre);
      const c = await repo.save(repo.create({ organisationId: await this.organisationId(m), code: dto.code, name: dto.name, description: dto.description ?? null }));
      await this.outbox.record(m, 'hr.organisation.cost_centre.created.v1', c.id, { id: c.id, code: c.code, name: c.name, status: c.status });
      return toCostCentreDto(c);
    });
  }

  async updateCostCentre(id: string, dto: UpdateCostCentre, version: number): Promise<CostCentreDto> {
    return this.dataSource.transaction(async (m) => {
      const repo = m.getRepository(CostCentre);
      const c = await repo.findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
      if (!c) throw notFound('Cost centre');
      assertVersion(c.version, version);
      const before = toCostCentreDto(c);
      for (const k of pick(dto, ['code', 'name', 'description', 'status'])) (c as unknown as Record<string, unknown>)[k] = dto[k] ?? null;
      if (dto.status === 'inactive') await this.assertNoActiveChildren(m, 'cost_centre_id', id, 'cost centre');
      const after = toCostCentreDto(await repo.save(c));
      const changed = changedFields(before, after);
      if (changed.length) await this.outbox.record(m, 'hr.organisation.cost_centre.updated.v1', c.id, { id: c.id, code: c.code, name: c.name, status: c.status, changed_fields: changed });
      return after;
    });
  }

  // ------------------------------------------------------------------ departments
  async listDepartments(q: ListQuery & { status?: string; branch_id?: string; parent_id?: string }): Promise<Page<DepartmentDto>> {
    const qb = this.dataSource.getRepository(Department).createQueryBuilder('d');
    if (q.status) qb.andWhere('d.status = :status', { status: q.status });
    if (q.branch_id) qb.andWhere('d.branch_id = :branch', { branch: q.branch_id });
    if (q.parent_id) qb.andWhere('d.parent_id = :parent', { parent: q.parent_id });
    if (q.search) qb.andWhere('(d.name ILIKE :s OR d.code ILIKE :s)', { s: likeTerm(q.search) });
    const page = await paginate(qb, q, { alias: 'd', defaultSort: 'name', sortable: { name: { prop: 'name', column: 'name' }, code: { prop: 'code', column: 'code' } } });
    return mapPage(page, orTombstone(toDepartmentDto));
  }

  /** The whole active tree, nested; what directory consumers and the org screen use. */
  async departmentTree(opts: { branchId?: string; includeInactive?: boolean } = {}): Promise<DepartmentNode[]> {
    const where: Record<string, unknown> = {};
    if (opts.branchId) where.branchId = opts.branchId;
    if (!opts.includeInactive) where.status = 'active';
    const rows = await this.dataSource.getRepository(Department).find({ where, order: { name: 'ASC' } });
    const nodes = new Map<string, DepartmentNode>(rows.map((d) => [d.id, { ...toDepartmentDto(d), children: [] }]));
    const roots: DepartmentNode[] = [];
    for (const n of nodes.values()) {
      const parent = n.parent_id ? nodes.get(n.parent_id) : undefined;
      if (parent) parent.children.push(n);
      else roots.push(n);
    }
    return roots;
  }

  async getDepartment(id: string): Promise<DepartmentDto> {
    const d = await this.dataSource.getRepository(Department).findOneBy({ id });
    if (!d) throw notFound('Department');
    return toDepartmentDto(d);
  }

  private async resolveParent(m: EntityManager, parentId: string | null | undefined, branchId: string): Promise<Department | null> {
    if (!parentId) return null;
    const parent = await m.getRepository(Department).findOneBy({ id: parentId });
    if (!parent) throw unprocessable('parent_not_found', 'Parent department not found', [{ path: 'parent_id', message: 'Not found' }]);
    if (parent.branchId !== branchId) throw unprocessable('parent_other_branch', 'A sub-department must be in the same branch as its parent', [{ path: 'parent_id', message: 'Different branch' }]);
    return parent;
  }

  private async assertBranch(m: EntityManager, id: string): Promise<void> {
    if (!(await m.getRepository(Branch).existsBy({ id }))) throw unprocessable('branch_not_found', 'Branch not found', [{ path: 'branch_id', message: 'Not found' }]);
  }

  private async assertCostCentre(m: EntityManager, id: string | null | undefined): Promise<void> {
    if (id && !(await m.getRepository(CostCentre).existsBy({ id }))) throw unprocessable('cost_centre_not_found', 'Cost centre not found', [{ path: 'cost_centre_id', message: 'Not found' }]);
  }

  async createDepartment(access: AccessProfile, dto: CreateDepartment): Promise<DepartmentDto> {
    return this.dataSource.transaction(async (m) => {
      await this.assertBranch(m, dto.branch_id);
      const parent = await this.resolveParent(m, dto.parent_id, dto.branch_id);
      await this.assertCostCentre(m, dto.cost_centre_id);
      // A scoped manager can only add departments under what they manage.
      await this.scope.assertAllows(access, 'department:manage', parent ? { departmentId: parent.id, branchId: parent.branchId } : { branchId: dto.branch_id });
      const repo = m.getRepository(Department);
      const d = await repo.save(
        repo.create({
          organisationId: await this.organisationId(m),
          branchId: dto.branch_id,
          parentId: parent?.id ?? null,
          costCentreId: dto.cost_centre_id ?? null,
          code: dto.code,
          name: dto.name,
          description: dto.description ?? null,
          path: parent ? [...parent.path, parent.id] : [],
        }),
      );
      await this.outbox.record(m, 'hr.organisation.department.created.v1', d.id, this.departmentEvent(d));
      return toDepartmentDto(d);
    });
  }

  private departmentEvent(d: Department) {
    return { id: d.id, code: d.code, name: d.name, branch_id: d.branchId, parent_id: d.parentId, cost_centre_id: d.costCentreId, status: d.status, path: d.path };
  }

  async updateDepartment(access: AccessProfile, id: string, dto: UpdateDepartment, version: number): Promise<DepartmentDto> {
    return this.dataSource.transaction(async (m) => {
      const repo = m.getRepository(Department);
      const d = await repo.findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
      if (!d) throw notFound('Department');
      assertVersion(d.version, version);
      await this.scope.assertAllows(access, 'department:manage', { departmentId: d.id, branchId: d.branchId });
      const before = toDepartmentDto(d);

      const moving = (dto.parent_id !== undefined && (dto.parent_id ?? null) !== d.parentId) || (dto.branch_id !== undefined && dto.branch_id !== d.branchId);
      if (moving) {
        const branchId = dto.branch_id ?? d.branchId;
        if (dto.branch_id) await this.assertBranch(m, dto.branch_id);
        const parentId = dto.parent_id !== undefined ? dto.parent_id : branchId === d.branchId ? d.parentId : null;
        const parent = await this.resolveParent(m, parentId, branchId);
        if (parent && (parent.id === d.id || parent.path.includes(d.id))) {
          throw unprocessable('cycle', 'A department cannot be moved under itself or its own sub-department', [{ path: 'parent_id', message: 'Would create a cycle' }]);
        }
        await this.scope.assertAllows(access, 'department:manage', parent ? { departmentId: parent.id, branchId: parent.branchId } : { branchId });
        const newPath = parent ? [...parent.path, parent.id] : [];
        // Re-root the subtree: replace the old prefix (old path + self) with the new one, and move its branch.
        const [moved] = (await m.query(
          `UPDATE department SET path = $1::uuid[] || $2::uuid || path[$3::int + 2 :], branch_id = $4, updated_at = now(), version = version + 1
            WHERE $2::uuid = ANY(path)
          RETURNING id, code, name, branch_id, parent_id, cost_centre_id, status, path`,
          [newPath, d.id, d.path.length, branchId],
        )) as [{ id: string; code: string; name: string; branch_id: string; parent_id: string | null; cost_centre_id: string | null; status: 'active' | 'inactive'; path: string[] }[], number];
        // Bulk updates raise no entity events: audit and announce each moved descendant explicitly.
        for (const r of moved ?? []) {
          await writeAudit(m, { action: 'update', entityType: 'Department', entityId: r.id, after: { path: r.path, branchId: r.branch_id }, before: null });
          await this.outbox.record(m, 'hr.organisation.department.updated.v1', r.id, { ...r, changed_fields: ['path', ...(branchId !== before.branch_id ? ['branch_id'] : [])] });
        }
        d.path = newPath;
        d.parentId = parent?.id ?? null;
        d.branchId = branchId;
      }
      if (dto.cost_centre_id !== undefined) {
        await this.assertCostCentre(m, dto.cost_centre_id);
        d.costCentreId = dto.cost_centre_id ?? null;
      }
      for (const k of pick(dto, ['code', 'name', 'description', 'status'])) (d as unknown as Record<string, unknown>)[k] = dto[k] ?? null;
      if (dto.status === 'inactive') await this.assertNoActiveChildren(m, 'parent_id', id, 'department');
      const after = toDepartmentDto(await repo.save(d));
      const changed = changedFields(before, after);
      if (changed.length) await this.outbox.record(m, 'hr.organisation.department.updated.v1', d.id, { ...this.departmentEvent(d), changed_fields: changed });
      return after;
    });
  }

  async deleteDepartment(access: AccessProfile, id: string, version: number): Promise<void> {
    await this.dataSource.transaction(async (m) => {
      const repo = m.getRepository(Department);
      const d = await repo.findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
      if (!d) throw notFound('Department');
      assertVersion(d.version, version);
      await this.scope.assertAllows(access, 'department:manage', { departmentId: d.id, branchId: d.branchId });
      const [children] = await m.query(`SELECT count(*)::int AS n FROM department WHERE parent_id = $1 AND deleted_at IS NULL`, [id]);
      if (children.n) throw conflict('has_children', 'Move or delete its sub-departments first');
      const [positions] = await m.query(`SELECT count(*)::int AS n FROM position WHERE department_id = $1 AND deleted_at IS NULL`, [id]);
      if (positions.n) throw conflict('has_positions', 'Move or delete its positions first');
      await repo.softRemove(d);
      await this.outbox.record(m, 'hr.organisation.department.deleted.v1', d.id, { id: d.id, code: d.code });
    });
  }

  // ------------------------------------------------------------------ job grades
  async listJobGrades(q: ListQuery & { status?: string }): Promise<Page<JobGradeDto>> {
    const qb = this.dataSource.getRepository(JobGrade).createQueryBuilder('g');
    if (q.status) qb.andWhere('g.status = :status', { status: q.status });
    if (q.search) qb.andWhere('(g.name ILIKE :s OR g.code ILIKE :s)', { s: likeTerm(q.search) });
    const page = await paginate(qb, q, { alias: 'g', defaultSort: 'rank', sortable: { rank: { prop: 'rank', column: 'rank', cast: 'int' }, code: { prop: 'code', column: 'code' }, name: { prop: 'name', column: 'name' } } });
    return mapPage(page, orTombstone(toJobGradeDto));
  }

  async createJobGrade(dto: CreateJobGrade): Promise<JobGradeDto> {
    const repo = this.dataSource.getRepository(JobGrade);
    return toJobGradeDto(await repo.save(repo.create({ organisationId: await this.organisationId(), code: dto.code, name: dto.name, rank: dto.rank, description: dto.description ?? null })));
  }

  async updateJobGrade(id: string, dto: UpdateJobGrade, version: number): Promise<JobGradeDto> {
    return this.dataSource.transaction(async (m) => {
      const repo = m.getRepository(JobGrade);
      const g = await repo.findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
      if (!g) throw notFound('Job grade');
      assertVersion(g.version, version);
      for (const k of pick(dto, ['code', 'name', 'rank', 'description', 'status'])) (g as unknown as Record<string, unknown>)[k] = dto[k] ?? null;
      return toJobGradeDto(await repo.save(g));
    });
  }

  // ------------------------------------------------------------------ positions
  async listPositions(q: ListQuery & { status?: string; department_id?: string; job_grade_id?: string }): Promise<Page<PositionDto>> {
    const qb = this.dataSource.getRepository(Position).createQueryBuilder('p');
    if (q.status) qb.andWhere('p.status = :status', { status: q.status });
    if (q.department_id) qb.andWhere('p.department_id = :dep', { dep: q.department_id });
    if (q.job_grade_id) qb.andWhere('p.job_grade_id = :g', { g: q.job_grade_id });
    if (q.search) qb.andWhere('(p.title ILIKE :s OR p.code ILIKE :s)', { s: likeTerm(q.search) });
    const page = await paginate(qb, q, { alias: 'p', defaultSort: 'title', sortable: { title: { prop: 'title', column: 'title' }, code: { prop: 'code', column: 'code' } } });
    return mapPage(page, orTombstone(toPositionDto));
  }

  async getPosition(id: string): Promise<PositionDto> {
    const p = await this.dataSource.getRepository(Position).findOneBy({ id });
    if (!p) throw notFound('Position');
    return toPositionDto(p);
  }

  private async validatePositionRefs(m: EntityManager, p: { id?: string; departmentId: string; jobGradeId: string | null; reportsToPositionId: string | null }): Promise<Department> {
    const dep = await m.getRepository(Department).findOneBy({ id: p.departmentId });
    if (!dep) throw unprocessable('department_not_found', 'Department not found', [{ path: 'department_id', message: 'Not found' }]);
    if (p.jobGradeId && !(await m.getRepository(JobGrade).existsBy({ id: p.jobGradeId }))) {
      throw unprocessable('job_grade_not_found', 'Job grade not found', [{ path: 'job_grade_id', message: 'Not found' }]);
    }
    // Walk up the reporting chain to reject cycles.
    let cursor = p.reportsToPositionId;
    const seen = new Set<string>(p.id ? [p.id] : []);
    while (cursor) {
      if (seen.has(cursor)) throw unprocessable('cycle', 'This reporting line would loop back to the position itself', [{ path: 'reports_to_position_id', message: 'Cycle' }]);
      seen.add(cursor);
      const up = await m.getRepository(Position).findOne({ where: { id: cursor }, select: { id: true, reportsToPositionId: true } });
      if (!up) throw unprocessable('position_not_found', 'Reports-to position not found', [{ path: 'reports_to_position_id', message: 'Not found' }]);
      cursor = up.reportsToPositionId;
    }
    return dep;
  }

  private positionEvent(p: Position) {
    return { id: p.id, code: p.code, title: p.title, department_id: p.departmentId, job_grade_id: p.jobGradeId, reports_to_position_id: p.reportsToPositionId, headcount: p.headcount, status: p.status };
  }

  async createPosition(access: AccessProfile, dto: CreatePosition): Promise<PositionDto> {
    return this.dataSource.transaction(async (m) => {
      const draft = { departmentId: dto.department_id, jobGradeId: dto.job_grade_id ?? null, reportsToPositionId: dto.reports_to_position_id ?? null };
      const dep = await this.validatePositionRefs(m, draft);
      await this.scope.assertAllows(access, 'position:manage', { departmentId: dep.id, branchId: dep.branchId });
      const repo = m.getRepository(Position);
      const p = await repo.save(
        repo.create({
          ...draft,
          organisationId: await this.organisationId(m),
          code: dto.code,
          title: dto.title,
          description: dto.description ?? null,
          headcount: dto.headcount,
          isClinical: dto.is_clinical,
          licenceRequired: dto.licence_required ?? null,
        }),
      );
      await this.outbox.record(m, 'hr.organisation.position.created.v1', p.id, this.positionEvent(p));
      return toPositionDto(p);
    });
  }

  async updatePosition(access: AccessProfile, id: string, dto: UpdatePosition, version: number): Promise<PositionDto> {
    return this.dataSource.transaction(async (m) => {
      const repo = m.getRepository(Position);
      const p = await repo.findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
      if (!p) throw notFound('Position');
      assertVersion(p.version, version);
      const current = await m.getRepository(Department).findOneByOrFail({ id: p.departmentId });
      await this.scope.assertAllows(access, 'position:manage', { departmentId: current.id, branchId: current.branchId });
      const before = toPositionDto(p);
      if (dto.department_id !== undefined) p.departmentId = dto.department_id;
      if (dto.job_grade_id !== undefined) p.jobGradeId = dto.job_grade_id ?? null;
      if (dto.reports_to_position_id !== undefined) p.reportsToPositionId = dto.reports_to_position_id ?? null;
      if (dto.code !== undefined) p.code = dto.code;
      if (dto.title !== undefined) p.title = dto.title;
      if (dto.description !== undefined) p.description = dto.description ?? null;
      if (dto.headcount !== undefined) p.headcount = dto.headcount;
      if (dto.is_clinical !== undefined) p.isClinical = dto.is_clinical;
      if (dto.licence_required !== undefined) p.licenceRequired = dto.licence_required ?? null;
      if (dto.status !== undefined) p.status = dto.status;
      const dep = await this.validatePositionRefs(m, p);
      if (dep.id !== current.id) await this.scope.assertAllows(access, 'position:manage', { departmentId: dep.id, branchId: dep.branchId });
      const after = toPositionDto(await repo.save(p));
      const changed = changedFields(before, after);
      if (changed.length) await this.outbox.record(m, 'hr.organisation.position.updated.v1', p.id, { ...this.positionEvent(p), changed_fields: changed });
      return after;
    });
  }

  /** Lookup used by other modules (identity-access) to validate references. */
  async existing(kind: 'branch' | 'department', ids: string[]): Promise<Set<string>> {
    if (!ids.length) return new Set();
    const repo = kind === 'branch' ? this.dataSource.getRepository(Branch) : this.dataSource.getRepository(Department);
    const rows = await repo.find({ where: { id: In(ids) }, select: { id: true } });
    return new Set(rows.map((r) => r.id));
  }
}
