import type { ObjectLiteral, SelectQueryBuilder } from 'typeorm';
import type { DataScope } from '@sil/hr-shared';

/** One role assignment's contribution to a permission. */
export interface Grant {
  scope: DataScope;
  branchId: string | null;
  departmentId: string | null;
}

/** The caller's permissions, each with the data scopes it was granted under. */
export class AccessProfile {
  constructor(
    readonly actorType: 'user' | 'client',
    readonly actorId: string,
    readonly actorName: string,
    /** Set when the user is linked to an employee record (slice 2). */
    readonly employeeId: string | null,
    readonly grants: ReadonlyMap<string, Grant[]>,
    /** OAuth scopes for machine clients; empty for users. */
    readonly scopes: readonly string[] = [],
  ) {}

  has(permission: string): boolean {
    return this.grants.has(permission);
  }

  get permissions(): string[] {
    return [...this.grants.keys()].sort();
  }
}

/**
 * The rows a caller may see for one permission. `all` short-circuits; otherwise a row is
 * visible when its branch, department or employee column matches one of the lists.
 */
export type ScopeFilter =
  | { all: true }
  | { all: false; branchIds: string[]; departmentIds: string[]; employeeIds: string[] };

export interface ScopeColumns {
  /** SQL expression of the row's branch id, e.g. `d.branch_id`. */
  branch?: string;
  department?: string;
  employee?: string;
}

let paramSeq = 0;

/**
 * The only place data-scope SQL is written. Adds the scope predicate to a query.
 * A filter with nothing in it matches no rows.
 */
export function applyScope<T extends ObjectLiteral>(qb: SelectQueryBuilder<T>, filter: ScopeFilter, columns: ScopeColumns): SelectQueryBuilder<T> {
  if (filter.all) return qb;
  const ors: string[] = [];
  const params: Record<string, string[]> = {};
  const add = (column: string | undefined, ids: string[]) => {
    if (!column || !ids.length) return;
    const p = `scope_${++paramSeq}`;
    ors.push(`${column} = ANY(:${p}::uuid[])`);
    params[p] = ids;
  };
  add(columns.branch, filter.branchIds);
  add(columns.department, filter.departmentIds);
  add(columns.employee, filter.employeeIds);
  if (!ors.length) return qb.andWhere('1 = 0');
  return qb.andWhere(`(${ors.join(' OR ')})`, params);
}

/** Same rule as applyScope, for one row already loaded. */
export function scopeAllows(filter: ScopeFilter, row: { branchId?: string | null; departmentId?: string | null; employeeId?: string | null }): boolean {
  if (filter.all) return true;
  return (
    (!!row.branchId && filter.branchIds.includes(row.branchId)) ||
    (!!row.departmentId && filter.departmentIds.includes(row.departmentId)) ||
    (!!row.employeeId && filter.employeeIds.includes(row.employeeId))
  );
}

/**
 * Organisation-wide access for work done on someone's behalf after an approval (the
 * approver's decision is the authority; the engine has already checked who may approve).
 */
export function systemAccess(actorId: string, actorName = 'approval', permissions: readonly string[]): AccessProfile {
  const grants = new Map<string, Grant[]>(permissions.map((p) => [p, [{ scope: 'organisation' as DataScope, branchId: null, departmentId: null }]]));
  return new AccessProfile('user', actorId, actorName, null, grants);
}
