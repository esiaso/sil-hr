import { Controller, Get, HttpCode, Injectable, Logger, Param, ParseUUIDPipe, Post, Query, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBody, ApiConsumes, ApiQuery, ApiTags } from '@nestjs/swagger';
import { InjectDataSource } from '@nestjs/typeorm';
import { parse as parseCsv } from 'csv-parse/sync';
import { stringify as toCsv } from 'csv-stringify/sync';
import ExcelJS from 'exceljs';
import { DataSource } from 'typeorm';
import { z } from 'zod';
import { AuditAction, EMPLOYMENT_TYPES, GENDERS, bulkJob, employeeQuery, isoDate, type BulkJob as BulkJobDto } from '@sil/hr-shared';
import { loadEnv } from '../../config/env';
import { AccessProfile } from '../../common/access';
import { iso } from '../../common/base.entity';
import { Access, RequirePermissions } from '../../common/decorators';
import { notFound, ProblemException, unprocessable } from '../../common/problem';
import { RequestContext } from '../../common/request-context';
import { ZQuery, ZResponse } from '../../common/zod';
import { writeAudit } from '../audit/audit.subscriber';
import { DocumentsService } from '../documents/documents.module';
import { AccessService } from '../identity-access/access.service';
import { BulkJob, Employee } from './employee.entities';
import { EmployeesService } from './employees.service';

/** Import columns, in template order. Codes stand in for ids so a spreadsheet can be filled by hand. */
export const IMPORT_COLUMNS = [
  'staff_number', 'first_name', 'middle_name', 'last_name', 'gender', 'date_of_birth', 'national_id', 'kra_pin', 'nssf_number', 'sha_number',
  'work_email', 'work_phone', 'personal_phone', 'employment_type', 'hire_date', 'position_code', 'manager_staff_number',
] as const;

const blank = (v: unknown) => (v === undefined || v === null || String(v).trim() === '' ? undefined : String(v).trim());
const row = z.object({
  staff_number: z.string().max(30).optional(),
  first_name: z.string().min(1, 'Required').max(100),
  middle_name: z.string().max(100).optional(),
  last_name: z.string().min(1, 'Required').max(100),
  gender: z.enum(GENDERS).optional(),
  date_of_birth: isoDate.optional(),
  national_id: z.string().regex(/^\d{6,9}$/, '6 to 9 digits').optional(),
  kra_pin: z.string().regex(/^[AP]\d{9}[A-Z]$/, 'A or P, 9 digits, a letter').optional(),
  nssf_number: z.string().max(30).optional(),
  sha_number: z.string().max(30).optional(),
  work_email: z.email().optional(),
  work_phone: z.string().max(30).optional(),
  personal_phone: z.string().max(30).optional(),
  employment_type: z.enum(EMPLOYMENT_TYPES),
  hire_date: isoDate,
  position_code: z.string().min(1, 'Required'),
  manager_staff_number: z.string().optional(),
});
type Row = z.infer<typeof row>;

/** Accepts DD/MM/YYYY (the hospital's format), YYYY-MM-DD and Excel dates. */
function normaliseDate(v: unknown): string | undefined {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = blank(v);
  if (!s) return undefined;
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : s;
}

export async function readSheet(body: Buffer, fileName: string): Promise<Record<string, unknown>[]> {
  if (/\.xlsx$/i.test(fileName)) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(body as never);
    const ws = wb.worksheets[0];
    if (!ws) return [];
    const header = (ws.getRow(1).values as unknown[]).slice(1).map((h) => String(h ?? '').trim().toLowerCase());
    const out: Record<string, unknown>[] = [];
    ws.eachRow((r, i) => {
      if (i === 1) return;
      const vals = (r.values as unknown[]).slice(1);
      const obj: Record<string, unknown> = {};
      header.forEach((h, j) => {
        const v = vals[j] as { text?: string; result?: unknown } | unknown;
        obj[h] = v && typeof v === 'object' && !(v instanceof Date) ? ((v as { text?: string }).text ?? (v as { result?: unknown }).result) : v;
      });
      if (Object.values(obj).some((x) => blank(x))) out.push(obj);
    });
    return out;
  }
  return parseCsv(body, { columns: (h: string[]) => h.map((x) => x.trim().toLowerCase()), skip_empty_lines: true, trim: true, bom: true }) as Record<string, unknown>[];
}

function jobDto(j: BulkJob): BulkJobDto {
  return {
    id: j.id, kind: j.kind, status: j.status, dry_run: j.dryRun, total_rows: j.totalRows, processed_rows: j.processedRows, created_count: j.createdCount,
    updated_count: j.updatedCount, error_count: j.errorCount, errors: j.errors.slice(0, 500), result_document_id: j.resultDocumentId, created_at: j.createdAt.toISOString(), finished_at: iso(j.finishedAt),
  };
}

/**
 * Bulk import and export run as jobs (a bulk_job row with a status resource), processed
 * by the worker. Import is validated row by row and is all-or-nothing: any error leaves
 * the database untouched. A dry run validates and reports without writing.
 */
@Injectable()
export class BulkService {
  private readonly logger = new Logger('Bulk');

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly documents: DocumentsService,
    private readonly employees: EmployeesService,
    private readonly accessService: AccessService,
  ) {}

  async template(): Promise<Buffer> {
    return Buffer.from(toCsv([IMPORT_COLUMNS as unknown as string[], ['', 'Jane', '', 'Doe', 'female', '15/04/1990', '12345678', 'A123456789B', '', '', 'jane.doe@example.org', '', '', 'permanent', '01/12/2026', 'RN-MED', '']]));
  }

  async enqueueImport(access: AccessProfile, file: Express.Multer.File, dryRun: boolean): Promise<BulkJobDto> {
    if (!file?.buffer?.length) throw unprocessable('file_required', 'Attach a .csv or .xlsx file in the "file" field');
    if (!/\.(csv|xlsx)$/i.test(file.originalname)) throw new ProblemException(415, 'unsupported_file_type', 'Use a .csv or .xlsx file');
    const doc = await this.documents.createFromBuffer({ ownerType: 'bulk_import', title: `Employee import ${file.originalname}`, isSensitive: true, fileName: file.originalname, mimeType: file.originalname.endsWith('.csv') ? 'text/csv' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }, file.buffer);
    const repo = this.dataSource.getRepository(BulkJob);
    const job = await repo.save(repo.create({ kind: 'employee_import', dryRun, inputDocumentId: doc.id, requestedBy: access.actorId }));
    if (loadEnv().jobsMode !== 'queue') void this.processQueued().catch((err) => this.logger.error({ err }, 'Bulk job failed'));
    return jobDto(job);
  }

  async enqueueExport(access: AccessProfile, format: 'csv' | 'xlsx', filters: z.infer<typeof employeeQuery>): Promise<BulkJobDto> {
    const repo = this.dataSource.getRepository(BulkJob);
    const job = await repo.save(repo.create({ kind: 'employee_export', params: { format, filters }, requestedBy: access.actorId }));
    await writeAudit(this.dataSource.manager, { action: AuditAction.EXPORT, entityType: 'Employee', entityId: null, after: { format, filters } });
    if (loadEnv().jobsMode !== 'queue') void this.processQueued().catch((err) => this.logger.error({ err }, 'Bulk job failed'));
    return jobDto(job);
  }

  async get(access: AccessProfile, id: string): Promise<BulkJobDto> {
    const j = await this.dataSource.getRepository(BulkJob).findOneBy({ id });
    if (!j || (j.requestedBy !== access.actorId && !access.has('import_export:run'))) throw notFound('Job');
    return jobDto(j);
  }

  /** Worker entry point: claims queued jobs one at a time (SKIP LOCKED) and runs them as their requester. */
  async processQueued(): Promise<number> {
    let done = 0;
    for (;;) {
      const [[claimed]] = (await this.dataSource.query(
        `UPDATE bulk_job SET status = 'running', started_at = now() WHERE id = (SELECT id FROM bulk_job WHERE status = 'queued' ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING id`,
      )) as [{ id: string }[], number];
      if (!claimed) return done;
      const job = await this.dataSource.getRepository(BulkJob).findOneByOrFail({ id: claimed.id });
      const [user] = await this.dataSource.query(`SELECT id, display_name, employee_id FROM user_account WHERE id = $1`, [job.requestedBy]);
      if (!user) {
        await this.finish(job, 'failed', [{ row: 0, column: null, message: 'The requesting user no longer exists' }]);
        continue;
      }
      const access = await this.accessService.forUser({ id: user.id, displayName: user.display_name, employeeId: user.employee_id });
      await RequestContext.run({ actorType: 'user', actorId: user.id, actorName: user.display_name, access }, async () => {
        try {
          if (job.kind === 'employee_import') await this.runImport(job, access);
          else await this.runExport(job, access);
        } catch (err) {
          this.logger.error({ err, jobId: job.id }, 'Bulk job crashed');
          await this.finish(job, 'failed', [{ row: 0, column: null, message: (err as Error).message.slice(0, 300) }]);
        }
      });
      done++;
    }
  }

  private async finish(job: BulkJob, status: 'succeeded' | 'failed', errors: BulkJob['errors'] = job.errors): Promise<void> {
    Object.assign(job, { status, errors, errorCount: errors.length, finishedAt: new Date() });
    await this.dataSource.getRepository(BulkJob).save(job);
  }

  private async runImport(job: BulkJob, access: AccessProfile): Promise<void> {
    const file = await this.documents.read(job.inputDocumentId!);
    const raw = await readSheet(file.body, file.fileName);
    job.totalRows = raw.length;
    const errors: BulkJob['errors'] = [];
    const positions = new Map<string, string>((await this.dataSource.query(`SELECT id, lower(code) AS code FROM position WHERE deleted_at IS NULL`)).map((r: { id: string; code: string }) => [r.code, r.id]));
    const parsed: { line: number; data: Row }[] = [];
    const seen = new Set<string>();
    raw.forEach((r, i) => {
      const line = i + 2; // spreadsheet row (after the header)
      const candidate = Object.fromEntries(IMPORT_COLUMNS.map((c) => [c, c.endsWith('_date') || c === 'date_of_birth' ? normaliseDate(r[c]) : blank(r[c])]));
      const res = row.safeParse(candidate);
      if (!res.success) {
        for (const iss of res.error.issues) errors.push({ row: line, column: String(iss.path[0] ?? ''), message: iss.message });
        return;
      }
      if (!positions.has(res.data.position_code.toLowerCase())) errors.push({ row: line, column: 'position_code', message: `Unknown position ${res.data.position_code}` });
      for (const key of ['national_id', 'kra_pin', 'work_email', 'staff_number'] as const) {
        const v = res.data[key]?.toLowerCase();
        if (!v) continue;
        if (seen.has(`${key}:${v}`)) errors.push({ row: line, column: key, message: 'Repeated in this file' });
        seen.add(`${key}:${v}`);
      }
      parsed.push({ line, data: res.data });
    });
    job.processedRows = raw.length;
    if (errors.length || job.dryRun) {
      job.createdCount = job.dryRun && !errors.length ? parsed.length : 0;
      return this.finish(job, errors.length ? 'failed' : 'succeeded', errors);
    }
    // All or nothing: one transaction; the first failing row rolls everything back.
    let created = 0;
    let updated = 0;
    try {
      await this.dataSource.transaction(async (m) => {
        const byStaff = new Map<string, string>();
        for (const { line, data } of parsed) {
          try {
            const existing = data.staff_number ? await m.getRepository(Employee).findOneBy({ staffNumber: data.staff_number }) : null;
            const managerId = data.manager_staff_number ? (byStaff.get(data.manager_staff_number) ?? (await m.getRepository(Employee).findOneBy({ staffNumber: data.manager_staff_number }))?.id) : undefined;
            if (data.manager_staff_number && !managerId) throw unprocessable('manager_not_found', `Unknown manager ${data.manager_staff_number}`, [{ path: 'manager_staff_number', message: 'Not found' }]);
            const person = { first_name: data.first_name, middle_name: data.middle_name, last_name: data.last_name, gender: data.gender, date_of_birth: data.date_of_birth, national_id: data.national_id, kra_pin: data.kra_pin, nssf_number: data.nssf_number, sha_number: data.sha_number, work_email: data.work_email, work_phone: data.work_phone, personal_phone: data.personal_phone };
            if (existing) {
              await this.employees.update(access, existing.id, { ...person, employment_type: data.employment_type }, existing.version, m);
              updated++;
            } else {
              const e = await this.employees.hire(access, { ...person, staff_number: data.staff_number, employment_type: data.employment_type, status: 'active', hire_date: data.hire_date, position_id: positions.get(data.position_code.toLowerCase())!, manager_id: managerId }, m);
              byStaff.set(e.staff_number, e.id);
              created++;
            }
          } catch (err) {
            const p = err as ProblemException;
            const detail = p instanceof ProblemException ? ((p.getResponse() as { detail?: string }).detail ?? p.code) : (err as Error).message;
            errors.push({ row: line, column: p.errors?.[0]?.path ?? null, message: detail });
            throw err;
          }
        }
      });
    } catch {
      return this.finish(job, 'failed', errors.length ? errors : [{ row: 0, column: null, message: 'Import failed; nothing was saved' }]);
    }
    job.createdCount = created;
    job.updatedCount = updated;
    return this.finish(job, 'succeeded', []);
  }

  private async runExport(job: BulkJob, access: AccessProfile): Promise<void> {
    const params = job.params as { format: 'csv' | 'xlsx'; filters: z.infer<typeof employeeQuery> };
    const rows: string[][] = [];
    let cursor: string | undefined;
    do {
      const page = await this.employees.list(access, { ...params.filters, limit: 500, cursor });
      for (const e of page.data) {
        if ('deleted' in e) continue;
        rows.push([e.staff_number, e.first_name, e.middle_name ?? '', e.last_name, e.gender ?? '', e.employment_type, e.status, e.hire_date, e.exit_date ?? '', e.work_email ?? '', e.work_phone ?? '', e.department_id ?? '', e.position_id ?? '', e.manager_id ?? '', e.licence_status ?? '']);
      }
      cursor = page.next_cursor ?? undefined;
    } while (cursor);
    const header = ['staff_number', 'first_name', 'middle_name', 'last_name', 'gender', 'employment_type', 'status', 'hire_date', 'exit_date', 'work_email', 'work_phone', 'department_id', 'position_id', 'manager_id', 'licence_status'];
    let body: Buffer;
    if (params.format === 'xlsx') {
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('Employees');
      ws.addRow(header);
      rows.forEach((r) => ws.addRow(r));
      body = Buffer.from(await wb.xlsx.writeBuffer());
    } else {
      body = Buffer.from(toCsv([header, ...rows]));
    }
    const stamp = new Date().toISOString().slice(0, 10);
    const doc = await this.documents.createFromBuffer({ ownerType: 'bulk_export', title: `Employee export ${stamp}`, fileName: `employees-${stamp}.${params.format}`, mimeType: params.format === 'csv' ? 'text/csv' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }, body);
    Object.assign(job, { totalRows: rows.length, processedRows: rows.length, resultDocumentId: doc.id });
    return this.finish(job, 'succeeded', []);
  }
}

@ApiTags('People: import and export')
@Controller()
export class BulkController {
  constructor(private readonly bulk: BulkService) {}

  @Get('employees/import/template')
  @RequirePermissions('import_export:run')
  async template(@Query() _q: unknown) {
    return { columns: IMPORT_COLUMNS, csv: (await this.bulk.template()).toString('utf8'), notes: 'Dates as DD/MM/YYYY or YYYY-MM-DD. Leave staff_number blank to allocate one; a known staff_number updates that employee. position_code and manager_staff_number refer to existing records or rows above.' };
  }

  @Post('employees/import')
  @RequirePermissions('import_export:run', 'employee:hire', 'employee:update')
  @HttpCode(202)
  @ApiConsumes('multipart/form-data')
  @ApiBody({ schema: { type: 'object', required: ['file'], properties: { file: { type: 'string', format: 'binary' } } } as never })
  @ApiQuery({ name: 'dry_run', required: false, enum: ['true', 'false'] })
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 20 * 1024 * 1024, files: 1 } }))
  @ZResponse(bulkJob, 202, 'Queued; poll GET /bulk-jobs/{id}')
  import(@Access() a: AccessProfile, @UploadedFile() file: Express.Multer.File, @Query('dry_run') dryRun?: string) {
    return this.bulk.enqueueImport(a, file, dryRun === 'true');
  }

  @Post('employees/export')
  @RequirePermissions('import_export:run', 'employee:read')
  @HttpCode(202)
  @ApiQuery({ name: 'format', required: false, enum: ['csv', 'xlsx'] })
  @ZResponse(bulkJob, 202, 'Queued; poll GET /bulk-jobs/{id}, then download result_document_id')
  export(@Access() a: AccessProfile, @ZQuery(employeeQuery.extend({ format: z.enum(['csv', 'xlsx']).default('csv') })) q: z.infer<typeof employeeQuery> & { format: 'csv' | 'xlsx' }) {
    const { format, ...filters } = q;
    return this.bulk.enqueueExport(a, format, filters);
  }

  @Get('bulk-jobs/:id')
  @ZResponse(bulkJob)
  job(@Access() a: AccessProfile, @Param('id', ParseUUIDPipe) id: string) {
    return this.bulk.get(a, id);
  }
}
