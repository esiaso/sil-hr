import { Controller, Get, Module, Param, ParseUUIDPipe, Res } from '@nestjs/common';
import { ApiProduces, ApiTags } from '@nestjs/swagger';
import { InjectDataSource } from '@nestjs/typeorm';
import type { Response } from 'express';
import { DataSource } from 'typeorm';
import { z } from 'zod';
import { RequirePermissions } from '../../common/decorators';
import { notFound } from '../../common/problem';
import { ZQuery } from '../../common/zod';
import { loadEnv } from '../../config/env';
import { SettingsService } from '../settings/settings.module';

/**
 * The practitioner registry for the HMIS, as FHIR R4 `Practitioner` and `PractitionerRole`
 * resources (JSON). Clinical staff and anyone holding a professional licence are listed;
 * the resource id is the HR employee id. Read-only: HR owns this data.
 */
export const STAFF_SYSTEM = 'urn:sil:hr:staff-number';
export const LICENCE_SYSTEM = (body: string) => `urn:sil:hr:licence:${body.toLowerCase()}`;
export const LICENCE_STATUS_EXT = 'urn:sil:hr:fhir:licence-status';

interface Row {
  id: string; staff_number: string; first_name: string; middle_name: string | null; last_name: string; gender: string | null; work_email: string | null; work_phone: string | null;
  status: string; hire_date: string; exit_date: string | null; licence_status: string | null; updated_at: Date; position_title: string | null; position_code: string | null; department_name: string | null; department_code: string | null; is_clinical: boolean | null;
  licences: { body: string; number: string; category: string | null; issue: string | null; expiry: string; verified: boolean; suspended: boolean }[] | null;
}

const searchQuery = z.object({
  identifier: z.string().max(200).optional(),
  active: z.enum(['true', 'false']).optional(),
  name: z.string().max(100).optional(),
  _count: z.coerce.number().int().min(1).max(500).default(100),
  _offset: z.coerce.number().int().min(0).default(0),
});
const roleQuery = searchQuery.extend({ practitioner: z.string().max(100).optional() });

@ApiTags('Integration: HMIS (FHIR R4)')
@Controller('fhir')
export class FhirController {
  constructor(@InjectDataSource() private readonly dataSource: DataSource, private readonly settings: SettingsService) {}

  private base() {
    return `${loadEnv().publicBaseUrl}/api/v1/fhir`;
  }

  private async rows(q: { id?: string; identifier?: string; active?: string; name?: string; _count: number; _offset: number }): Promise<{ rows: Row[]; total: number }> {
    const where: string[] = [`e.deleted_at IS NULL`, `e.status <> 'onboarding'`, `(p.is_clinical OR EXISTS (SELECT 1 FROM professional_licence l WHERE l.employee_id = e.id AND l.deleted_at IS NULL))`];
    const params: unknown[] = [];
    const add = (sql: string, v: unknown) => { params.push(v); where.push(sql.replace('?', `$${params.length}`)); };
    if (q.id) add('e.id = ?', q.id);
    if (q.active) where.push(q.active === 'true' ? `e.status <> 'exited'` : `e.status = 'exited'`);
    if (q.name) add(`(e.first_name || ' ' || e.last_name) ILIKE ?`, `%${q.name.replace(/[%_]/g, '')}%`);
    if (q.identifier) {
      const [system, value] = q.identifier.includes('|') ? q.identifier.split('|', 2) : [null, q.identifier];
      if (!system || system === STAFF_SYSTEM) add(`(e.staff_number = ?${system ? '' : ` OR EXISTS (SELECT 1 FROM professional_licence l WHERE l.employee_id = e.id AND l.deleted_at IS NULL AND l.licence_number = $${params.length + 1})`})`, value);
      else if (system.startsWith('urn:sil:hr:licence:')) {
        params.push(value, system.slice('urn:sil:hr:licence:'.length).toUpperCase());
        where.push(`EXISTS (SELECT 1 FROM professional_licence l WHERE l.employee_id = e.id AND l.deleted_at IS NULL AND l.licence_number = $${params.length - 1} AND l.licensing_body = $${params.length})`);
      } else where.push('false');
    }
    const from = `FROM employee e LEFT JOIN position p ON p.id = e.position_id LEFT JOIN department d ON d.id = e.department_id WHERE ${where.join(' AND ')}`;
    const [{ n }] = await this.dataSource.query(`SELECT count(*)::int AS n ${from}`, params);
    const rows: Row[] = await this.dataSource.query(
      `SELECT e.id, e.staff_number, e.first_name, e.middle_name, e.last_name, e.gender, e.work_email, e.work_phone, e.status, e.hire_date::text, e.exit_date::text, e.licence_status, e.updated_at,
              p.title AS position_title, p.code AS position_code, d.name AS department_name, d.code AS department_code, p.is_clinical,
              (SELECT json_agg(json_build_object('body', l.licensing_body, 'number', l.licence_number, 'category', l.category, 'issue', l.issue_date, 'expiry', l.expiry_date, 'verified', l.verified_at IS NOT NULL, 'suspended', l.suspended) ORDER BY l.expiry_date DESC)
                 FROM professional_licence l WHERE l.employee_id = e.id AND l.deleted_at IS NULL) AS licences
       ${from} ORDER BY e.staff_number LIMIT ${q._count} OFFSET ${q._offset}`,
      params,
    );
    return { rows, total: n };
  }

  private async practitioner(r: Row) {
    const today = await this.settings.today();
    return {
      resourceType: 'Practitioner',
      id: r.id,
      meta: { lastUpdated: new Date(r.updated_at).toISOString() },
      identifier: [{ use: 'official', system: STAFF_SYSTEM, value: r.staff_number }, ...(r.licences ?? []).map((l) => ({ use: 'secondary', system: LICENCE_SYSTEM(l.body), value: l.number }))],
      active: r.status !== 'exited',
      name: [{ use: 'official', family: r.last_name, given: [r.first_name, ...(r.middle_name ? [r.middle_name] : [])], text: [r.first_name, r.middle_name, r.last_name].filter(Boolean).join(' ') }],
      telecom: [...(r.work_phone ? [{ system: 'phone', value: r.work_phone, use: 'work' }] : []), ...(r.work_email ? [{ system: 'email', value: r.work_email, use: 'work' }] : [])],
      ...(r.gender && ['female', 'male', 'other'].includes(r.gender) ? { gender: r.gender } : { gender: 'unknown' }),
      qualification: (r.licences ?? []).map((l) => {
        const state = l.suspended ? 'suspended' : l.expiry < today ? 'expired' : !l.verified ? 'not_verified' : 'valid';
        return {
          extension: [{ url: LICENCE_STATUS_EXT, valueCode: state }],
          identifier: [{ system: LICENCE_SYSTEM(l.body), value: l.number }],
          code: { text: `${l.body} practising licence${l.category ? ` (${l.category})` : ''}` },
          period: { ...(l.issue ? { start: l.issue } : {}), end: l.expiry },
          issuer: { display: l.body },
        };
      }),
      extension: r.licence_status ? [{ url: LICENCE_STATUS_EXT, valueCode: r.licence_status }] : [],
    };
  }

  private role(r: Row, orgName: string) {
    return {
      resourceType: 'PractitionerRole',
      id: r.id,
      meta: { lastUpdated: new Date(r.updated_at).toISOString() },
      identifier: [{ system: STAFF_SYSTEM, value: r.staff_number }],
      active: r.status !== 'exited' && !['expired', 'suspended'].includes(r.licence_status ?? ''),
      period: { start: r.hire_date, ...(r.exit_date ? { end: r.exit_date } : {}) },
      practitioner: { reference: `Practitioner/${r.id}`, display: `${r.first_name} ${r.last_name}` },
      organization: { display: orgName },
      code: r.position_title ? [{ coding: r.position_code ? [{ system: 'urn:sil:hr:position', code: r.position_code, display: r.position_title }] : [], text: r.position_title }] : [],
      specialty: r.department_name ? [{ coding: r.department_code ? [{ system: 'urn:sil:hr:department', code: r.department_code, display: r.department_name }] : [], text: r.department_name }] : [],
    };
  }

  private bundle(type: string, total: number, entries: { id: string }[]) {
    return { resourceType: 'Bundle', type: 'searchset', total, link: [{ relation: 'self', url: `${this.base()}/${type}` }], entry: entries.map((resource) => ({ fullUrl: `${this.base()}/${type}/${resource.id}`, resource, search: { mode: 'match' } })) };
  }

  private send(res: Response, body: unknown) {
    res.setHeader('content-type', 'application/fhir+json; charset=utf-8');
    res.send(JSON.stringify(body));
  }

  private async orgName() {
    const [o] = await this.dataSource.query(`SELECT name FROM organisation ORDER BY created_at LIMIT 1`);
    return (o?.name as string) ?? 'Hospital';
  }

  @Get('metadata')
  @RequirePermissions('fhir:read')
  @ApiProduces('application/fhir+json')
  metadata(@Res() res: Response) {
    this.send(res, {
      resourceType: 'CapabilityStatement', status: 'active', date: '2026-11-15', kind: 'instance', fhirVersion: '4.0.1', format: ['json'],
      rest: [{ mode: 'server', resource: ['Practitioner', 'PractitionerRole'].map((type) => ({ type, interaction: [{ code: 'read' }, { code: 'search-type' }], searchParam: [{ name: 'identifier', type: 'token' }, { name: 'active', type: 'token' }, { name: 'name', type: 'string' }, ...(type === 'PractitionerRole' ? [{ name: 'practitioner', type: 'reference' }] : [])] })) }],
    });
  }

  @Get('Practitioner')
  @RequirePermissions('fhir:read')
  @ApiProduces('application/fhir+json')
  async searchPractitioners(@ZQuery(searchQuery) q: z.infer<typeof searchQuery>, @Res() res: Response) {
    const { rows, total } = await this.rows(q);
    this.send(res, this.bundle('Practitioner', total, await Promise.all(rows.map((r) => this.practitioner(r)))));
  }

  @Get('Practitioner/:id')
  @RequirePermissions('fhir:read')
  @ApiProduces('application/fhir+json')
  async readPractitioner(@Param('id', ParseUUIDPipe) id: string, @Res() res: Response) {
    const { rows } = await this.rows({ id, _count: 1, _offset: 0 });
    if (!rows.length) throw notFound('Practitioner');
    this.send(res, await this.practitioner(rows[0]));
  }

  @Get('PractitionerRole')
  @RequirePermissions('fhir:read')
  @ApiProduces('application/fhir+json')
  async searchRoles(@ZQuery(roleQuery) q: z.infer<typeof roleQuery>, @Res() res: Response) {
    const id = q.practitioner?.replace(/^Practitioner\//, '');
    if (id && !/^[0-9a-f-]{36}$/i.test(id)) return this.send(res, this.bundle('PractitionerRole', 0, []));
    const { rows, total } = await this.rows({ ...q, id });
    const org = await this.orgName();
    this.send(res, this.bundle('PractitionerRole', total, rows.map((r) => this.role(r, org))));
  }

  @Get('PractitionerRole/:id')
  @RequirePermissions('fhir:read')
  @ApiProduces('application/fhir+json')
  async readRole(@Param('id', ParseUUIDPipe) id: string, @Res() res: Response) {
    const { rows } = await this.rows({ id, _count: 1, _offset: 0 });
    if (!rows.length) throw notFound('PractitionerRole');
    this.send(res, this.role(rows[0], await this.orgName()));
  }
}

@Module({ controllers: [FhirController] })
export class FhirModule {}
