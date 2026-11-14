import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { AccessProfile, ScopeFilter, scopeAllows } from '../../common/access';
import { forbidden } from '../../common/problem';

/** Resolves employees a manager manages; registered by the employees module (slice 2). */
export type DirectReportsResolver = (managerEmployeeId: string) => Promise<string[]>;

/**
 * Turns a caller's grants for one permission into a ScopeFilter. Department scope
 * covers the department and all its descendants; branch scope covers the branch and
 * every department in it. Organisation scope (and every machine client) sees all.
 */
@Injectable()
export class ScopeService {
  private directReports: DirectReportsResolver = async () => [];

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  registerDirectReportsResolver(fn: DirectReportsResolver): void {
    this.directReports = fn;
  }

  async filterFor(access: AccessProfile, permission: string): Promise<ScopeFilter> {
    const grants = access.grants.get(permission) ?? [];
    if (grants.some((g) => g.scope === 'organisation')) return { all: true };
    const branchIds = new Set<string>();
    const departmentRoots = new Set<string>();
    const employeeIds = new Set<string>();
    for (const g of grants) {
      if (g.scope === 'branch' && g.branchId) branchIds.add(g.branchId);
      if (g.scope === 'department' && g.departmentId) departmentRoots.add(g.departmentId);
      if ((g.scope === 'own' || g.scope === 'direct_reports') && access.employeeId) {
        if (g.scope === 'own') employeeIds.add(access.employeeId);
        else for (const id of await this.directReports(access.employeeId)) employeeIds.add(id);
      }
    }
    const departmentIds = new Set<string>();
    if (branchIds.size || departmentRoots.size) {
      const rows: { id: string }[] = await this.dataSource.query(
        `SELECT id FROM department
          WHERE branch_id = ANY($1::uuid[]) OR id = ANY($2::uuid[]) OR path && $2::uuid[]`,
        [[...branchIds], [...departmentRoots]],
      );
      for (const r of rows) departmentIds.add(r.id);
    }
    return { all: false, branchIds: [...branchIds], departmentIds: [...departmentIds], employeeIds: [...employeeIds] };
  }

  /** Throws 403 unless the row is inside the caller's scope for the permission. */
  async assertAllows(access: AccessProfile, permission: string, row: { branchId?: string | null; departmentId?: string | null; employeeId?: string | null }): Promise<void> {
    const filter = await this.filterFor(access, permission);
    if (!scopeAllows(filter, row)) throw forbidden(`Outside your ${permission} scope`, 'out_of_scope');
  }
}
