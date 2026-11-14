import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { CLIENT_SCOPES, type DataScope } from '@sil/hr-shared';
import { AccessProfile, Grant } from '../../common/access';

/** Builds the caller's AccessProfile on every request, so role changes apply at once. */
@Injectable()
export class AccessService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async forUser(user: { id: string; displayName: string; employeeId: string | null }): Promise<AccessProfile> {
    const rows: { permission_code: string; scope: DataScope; branch_id: string | null; department_id: string | null }[] = await this.dataSource.query(
      `SELECT rp.permission_code, ra.scope, ra.branch_id, ra.department_id
         FROM role_assignment ra
         JOIN role_permission rp ON rp.role_id = ra.role_id
        WHERE ra.user_id = $1`,
      [user.id],
    );
    const grants = new Map<string, Grant[]>();
    for (const r of rows) {
      const list = grants.get(r.permission_code) ?? [];
      list.push({ scope: r.scope, branchId: r.branch_id, departmentId: r.department_id });
      grants.set(r.permission_code, list);
    }
    return new AccessProfile('user', user.id, user.displayName, user.employeeId, grants);
  }

  /** Machine clients act organisation-wide, limited to the permissions their scopes confer. */
  forClient(client: { id: string; name: string; scopes: string[] }): AccessProfile {
    const grants = new Map<string, Grant[]>();
    for (const scope of client.scopes) {
      for (const p of CLIENT_SCOPES[scope]?.permissions ?? []) grants.set(p, [{ scope: 'organisation', branchId: null, departmentId: null }]);
    }
    return new AccessProfile('client', client.id, client.name, null, grants, client.scopes);
  }
}
