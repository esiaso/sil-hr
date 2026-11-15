import { All, Controller, Get, Injectable, Logger, Param, Query, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { InjectDataSource } from '@nestjs/typeorm';
import type { Response } from 'express';
import { DataSource } from 'typeorm';
import { loadEnv } from '../../config/env';
import { RequirePermissions } from '../../common/decorators';
import { Department } from '../organisation/organisation.entities';
import { Employee } from './employee.entities';

/**
 * SCIM 2.0 (RFC 7643/7644) provisioning view of HR data: employees are Users,
 * departments are Groups. It is read-only by design: HR is the system of record, so an
 * identity provider *pulls* from here (and deprovisions when `active` turns false on
 * exit or suspension) rather than writing into HR. Write methods answer 405 with a SCIM
 * error explaining that.
 *
 * Filters supported: `userName eq`, `externalId eq`, `employeeNumber eq`, `active eq`,
 * `meta.lastModified gt|ge` (incremental), joined with `and`. Groups: `displayName eq`.
 */
const SCIM_JSON = 'application/scim+json';
const USER = 'urn:ietf:params:scim:schemas:core:2.0:User';
const ENTERPRISE = 'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User';
const GROUP = 'urn:ietf:params:scim:schemas:core:2.0:Group';
const LIST = 'urn:ietf:params:scim:api:messages:2.0:ListResponse';
const ERROR = 'urn:ietf:params:scim:api:messages:2.0:Error';

class ScimError extends Error {
  constructor(readonly status: number, detail: string, readonly scimType?: string) {
    super(detail);
  }
}

interface Clause {
  attr: string;
  op: 'eq' | 'gt' | 'ge';
  value: string | boolean;
}

/** Parses the small filter subset above; anything else is a SCIM invalidFilter error. */
export function parseFilter(filter: string | undefined): Clause[] {
  if (!filter) return [];
  return filter.split(/\s+and\s+/i).map((part) => {
    const m = /^\s*([A-Za-z.:0-9]+)\s+(eq|gt|ge)\s+(?:"((?:[^"\\]|\\.)*)"|(true|false))\s*$/i.exec(part);
    if (!m) throw new ScimError(400, `Unsupported filter: ${part}`, 'invalidFilter');
    return { attr: m[1].replace(`${ENTERPRISE}:`, '').toLowerCase(), op: m[2].toLowerCase() as Clause['op'], value: m[4] !== undefined ? m[4] === 'true' : m[3].replace(/\\(.)/g, '$1') };
  });
}

@Injectable()
export class ScimService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  private base() {
    return `${loadEnv().publicBaseUrl}/scim/v2`;
  }

  user(e: Employee) {
    const active = !['exited', 'suspended'].includes(e.status);
    return {
      schemas: [USER, ENTERPRISE],
      id: e.id,
      externalId: e.staffNumber,
      userName: e.workEmail ?? e.staffNumber,
      name: { formatted: e.displayName, givenName: e.firstName, middleName: e.middleName ?? undefined, familyName: e.lastName },
      displayName: e.displayName,
      title: e.position?.title,
      userType: e.employmentType,
      active,
      emails: e.workEmail ? [{ value: e.workEmail, type: 'work', primary: true }] : [],
      phoneNumbers: e.workPhone ? [{ value: e.workPhone, type: 'work' }] : [],
      groups: e.departmentId ? [{ value: e.departmentId, display: e.department?.name, $ref: `${this.base()}/Groups/${e.departmentId}` }] : [],
      [ENTERPRISE]: {
        employeeNumber: e.staffNumber,
        costCenter: e.costCentre?.code,
        organization: undefined,
        department: e.department?.name,
        manager: e.managerId ? { value: e.managerId, $ref: `${this.base()}/Users/${e.managerId}` } : undefined,
      },
      meta: { resourceType: 'User', created: e.createdAt.toISOString(), lastModified: e.updatedAt.toISOString(), location: `${this.base()}/Users/${e.id}`, version: `W/"${e.version}"` },
    };
  }

  private userQuery() {
    return this.dataSource.getRepository(Employee).createQueryBuilder('e').leftJoinAndSelect('e.department', 'd').leftJoinAndSelect('e.position', 'p').leftJoinAndSelect('e.costCentre', 'c');
  }

  async users(filter: string | undefined, startIndex = 1, count = 100) {
    const qb = this.userQuery();
    parseFilter(filter).forEach((c, i) => {
      const p = `f${i}`;
      if (c.attr === 'username') qb.andWhere(`(lower(e.work_email) = lower(:${p}) OR lower(e.staff_number) = lower(:${p}))`, { [p]: c.value });
      else if (c.attr === 'externalid' || c.attr === 'employeenumber') qb.andWhere(`lower(e.staff_number) = lower(:${p})`, { [p]: c.value });
      else if (c.attr === 'active') qb.andWhere(c.value === true ? `e.status NOT IN ('exited', 'suspended')` : `e.status IN ('exited', 'suspended')`);
      else if (c.attr === 'meta.lastmodified' && c.op !== 'eq') qb.andWhere(`e.updated_at ${c.op === 'gt' ? '>' : '>='} :${p}`, { [p]: c.value });
      else throw new ScimError(400, `Filtering on ${c.attr} ${c.op} is not supported`, 'invalidFilter');
    });
    const start = Math.max(1, startIndex);
    const size = Math.min(Math.max(0, count), 500);
    const [rows, total] = await qb.orderBy('e.createdAt').addOrderBy('e.id').skip(start - 1).take(size).getManyAndCount();
    return { schemas: [LIST], totalResults: total, startIndex: start, itemsPerPage: rows.length, Resources: rows.map((e) => this.user(e)) };
  }

  async getUser(id: string) {
    const e = /^[0-9a-f-]{36}$/i.test(id) ? await this.userQuery().where('e.id = :id', { id }).getOne() : null;
    if (!e) throw new ScimError(404, `User ${id} not found`);
    return this.user(e);
  }

  private async group(d: Department, withMembers: boolean) {
    const members = withMembers
      ? ((await this.dataSource.query(`SELECT id, first_name || ' ' || last_name AS name FROM employee WHERE department_id = $1 AND deleted_at IS NULL AND status NOT IN ('exited', 'suspended') ORDER BY last_name`, [d.id])) as { id: string; name: string }[]).map((m) => ({ value: m.id, display: m.name, $ref: `${this.base()}/Users/${m.id}`, type: 'User' }))
      : undefined;
    return { schemas: [GROUP], id: d.id, externalId: d.code, displayName: d.name, members, meta: { resourceType: 'Group', created: d.createdAt.toISOString(), lastModified: d.updatedAt.toISOString(), location: `${this.base()}/Groups/${d.id}`, version: `W/"${d.version}"` } };
  }

  async groups(filter: string | undefined, startIndex = 1, count = 100, excludeMembers = false) {
    const qb = this.dataSource.getRepository(Department).createQueryBuilder('d').where(`d.status = 'active'`);
    parseFilter(filter).forEach((c, i) => {
      if (c.attr === 'displayname') qb.andWhere(`lower(d.name) = lower(:g${i})`, { [`g${i}`]: c.value });
      else if (c.attr === 'externalid') qb.andWhere(`lower(d.code) = lower(:g${i})`, { [`g${i}`]: c.value });
      else throw new ScimError(400, `Filtering on ${c.attr} is not supported`, 'invalidFilter');
    });
    const start = Math.max(1, startIndex);
    const [rows, total] = await qb.orderBy('d.name').skip(start - 1).take(Math.min(Math.max(0, count), 500)).getManyAndCount();
    return { schemas: [LIST], totalResults: total, startIndex: start, itemsPerPage: rows.length, Resources: await Promise.all(rows.map((d) => this.group(d, !excludeMembers))) };
  }

  async getGroup(id: string) {
    const d = /^[0-9a-f-]{36}$/i.test(id) ? await this.dataSource.getRepository(Department).findOneBy({ id }) : null;
    if (!d) throw new ScimError(404, `Group ${id} not found`);
    return this.group(d, true);
  }
}

@ApiExcludeController()
@Controller('scim/v2')
export class ScimController {
  constructor(private readonly scim: ScimService) {}

  private async send(res: Response, fn: () => Promise<unknown>) {
    try {
      res.status(200).type(SCIM_JSON).send(JSON.stringify(await fn()));
    } catch (err) {
      if (!(err instanceof ScimError)) new Logger('Scim').error({ err }, 'SCIM request failed');
      const e = err instanceof ScimError ? err : new ScimError(500, 'Internal error');
      res.status(e.status).type(SCIM_JSON).send(JSON.stringify({ schemas: [ERROR], status: String(e.status), scimType: e.scimType, detail: e.message }));
    }
  }

  @Get('ServiceProviderConfig')
  @RequirePermissions('scim:provision')
  config(@Res() res: Response) {
    return this.send(res, async () => ({
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'],
      documentationUri: `${loadEnv().publicBaseUrl}/api/v1/docs`,
      patch: { supported: false },
      bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
      filter: { supported: true, maxResults: 500 },
      changePassword: { supported: false },
      sort: { supported: false },
      etag: { supported: true },
      authenticationSchemes: [{ type: 'oauthbearertoken', name: 'OAuth 2.0 client credentials', description: 'Token from /api/v1/oauth/token with the scim scope', primary: true }],
    }));
  }

  @Get('ResourceTypes')
  @RequirePermissions('scim:provision')
  types(@Res() res: Response) {
    return this.send(res, async () => ({
      schemas: [LIST],
      totalResults: 2,
      Resources: [
        { schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'], id: 'User', name: 'User', endpoint: '/Users', schema: USER, schemaExtensions: [{ schema: ENTERPRISE, required: true }] },
        { schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'], id: 'Group', name: 'Group', endpoint: '/Groups', schema: GROUP },
      ],
    }));
  }

  @Get('Users')
  @RequirePermissions('scim:provision')
  users(@Res() res: Response, @Query('filter') filter?: string, @Query('startIndex') start?: string, @Query('count') count?: string) {
    return this.send(res, () => this.scim.users(filter, Number(start ?? 1) || 1, Number(count ?? 100)));
  }

  @Get('Users/:id')
  @RequirePermissions('scim:provision')
  user(@Res() res: Response, @Param('id') id: string) {
    return this.send(res, () => this.scim.getUser(id));
  }

  @Get('Groups')
  @RequirePermissions('scim:provision')
  groups(@Res() res: Response, @Query('filter') filter?: string, @Query('startIndex') start?: string, @Query('count') count?: string, @Query('excludedAttributes') excluded?: string) {
    return this.send(res, () => this.scim.groups(filter, Number(start ?? 1) || 1, Number(count ?? 100), excluded?.includes('members')));
  }

  @Get('Groups/:id')
  @RequirePermissions('scim:provision')
  group(@Res() res: Response, @Param('id') id: string) {
    return this.send(res, () => this.scim.getGroup(id));
  }

  /** Writes are refused: identities come from HR records, not the other way round. */
  @All(['Users', 'Users/:id', 'Groups', 'Groups/:id', 'Bulk'])
  @RequirePermissions('scim:provision')
  readOnly(@Res() res: Response) {
    res.status(405).type(SCIM_JSON).send(JSON.stringify({ schemas: [ERROR], status: '405', scimType: 'mutability', detail: 'HR is the system of record: change people in SIL HR, not through SCIM' }));
  }
}
