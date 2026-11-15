import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { Document as DocxDocument, Packer, Paragraph, TextRun, AlignmentType, HeadingLevel } from 'docx';
import PDFDocument from 'pdfkit';
import { DataSource } from 'typeorm';
import { z } from 'zod';
import { formatDate, issueLetter, LETTER_FIELDS, upsertLetterTemplate } from '@sil/hr-shared';
import { AccessProfile, scopeAllows } from '../../common/access';
import { decrypt } from '../../common/crypto';
import { assertVersion } from '../../common/etag';
import { notFound, unprocessable } from '../../common/problem';
import { DocumentsService } from '../documents/documents.module';
import { ScopeService } from '../organisation/scope.service';
import { SettingsService } from '../settings/settings.module';
import { IssuedLetter, LetterTemplate } from './lifecycle.entities';

type Dto<T extends z.ZodType> = z.infer<T>;
const FIELD_RE = /\{\{\s*([a-z_.0-9]+)\s*\}\}/g;

/** Merge fields used by a template body. */
export function fieldsIn(body: string): string[] {
  return [...new Set([...body.matchAll(FIELD_RE)].map((x) => x[1]))];
}

/** Fills {{fields}}; unknown or empty fields are left visible as [field] so nothing is silently dropped. */
export function render(body: string, values: Record<string, string>): string {
  return body.replace(FIELD_RE, (_, k: string) => (values[k] !== undefined && values[k] !== '' ? values[k] : `[${k}]`));
}

/**
 * Letter templates with merge fields, rendered to PDF or Word. A template is plain text:
 * a line starting with "# " is a heading, a blank line starts a new paragraph. Every
 * issued letter is stored as a sensitive document on the employee.
 */
@Injectable()
export class LettersService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly docs: DocumentsService,
    private readonly scope: ScopeService,
    private readonly settings: SettingsService,
  ) {}

  dto(t: LetterTemplate) {
    return { id: t.id, code: t.code, name: t.name, body: t.body, status: t.status, fields: fieldsIn(t.body), version: t.version };
  }

  async templates() {
    return (await this.dataSource.getRepository(LetterTemplate).find({ order: { name: 'ASC' } })).map((t) => this.dto(t));
  }

  async save(dto: Dto<typeof upsertLetterTemplate>, id?: string, version?: number) {
    const unknown = fieldsIn(dto.body).filter((f) => !(f in LETTER_FIELDS) && !f.startsWith('extra.'));
    if (unknown.length) throw unprocessable('unknown_fields', `Unknown merge fields: ${unknown.join(', ')}`, [{ path: 'body', message: `Unknown: ${unknown.join(', ')}` }]);
    const repo = this.dataSource.getRepository(LetterTemplate);
    const t = id ? await repo.findOneBy({ id }) : repo.create();
    if (!t) throw notFound('Letter template');
    if (id && version !== undefined) assertVersion(t.version, version);
    Object.assign(t, { code: dto.code, name: dto.name, body: dto.body, status: dto.status });
    return this.dto(await repo.save(t));
  }

  private async values(employeeId: string, number: string, extra: Record<string, string>, actorName: string): Promise<Record<string, string>> {
    const fmt = await this.settings.get('locale.date_format');
    const d = (x: string | null) => (x ? formatDate(x, fmt) : '');
    const [e] = await this.dataSource.query(
      `SELECT e.first_name, e.middle_name, e.last_name, e.staff_number, e.employment_type, to_char(e.hire_date, 'YYYY-MM-DD') AS hire, to_char(e.exit_date, 'YYYY-MM-DD') AS exit, e.national_id_enc,
              p.title AS position, dp.name AS department, b.name AS branch,
              (SELECT basic FROM employee_salary s WHERE s.employee_id = e.id AND (s.effective_to IS NULL OR s.effective_to >= current_date) ORDER BY s.effective_from DESC LIMIT 1) AS basic
         FROM employee e LEFT JOIN position p ON p.id = e.position_id LEFT JOIN department dp ON dp.id = e.department_id LEFT JOIN branch b ON b.id = e.branch_id WHERE e.id = $1`,
      [employeeId],
    );
    if (!e) throw notFound('Employee');
    const [c] = await this.dataSource.query(`SELECT number, to_char(start_date, 'YYYY-MM-DD') AS s, to_char(end_date, 'YYYY-MM-DD') AS en, notice_days FROM employee_contract WHERE employee_id = $1 ORDER BY (status = 'active') DESC, start_date DESC LIMIT 1`, [employeeId]);
    const [o] = await this.dataSource.query(`SELECT coalesce(legal_name, name) AS name, address FROM organisation ORDER BY created_at LIMIT 1`);
    const id = decrypt(e.national_id_enc);
    const v: Record<string, string> = {
      'employee.full_name': [e.first_name, e.middle_name, e.last_name].filter(Boolean).join(' '), 'employee.first_name': e.first_name, 'employee.staff_number': e.staff_number, 'employee.position': e.position ?? '',
      'employee.department': e.department ?? '', 'employee.branch': e.branch ?? '', 'employee.hire_date': d(e.hire), 'employee.exit_date': d(e.exit), 'employee.employment_type': e.employment_type,
      'employee.basic_salary': e.basic ? Number(e.basic).toLocaleString('en-KE', { minimumFractionDigits: 2 }) : '', 'employee.national_id_last4': id ? id.slice(-4) : '',
      'contract.number': c?.number ?? '', 'contract.start_date': d(c?.s ?? null), 'contract.end_date': d(c?.en ?? null), 'contract.notice_days': c ? String(c.notice_days) : '',
      'organisation.name': o?.name ?? '', 'organisation.address': o?.address ?? '', today: d(await this.settings.today()), 'letter.number': number,
      'signatory.name': actorName, 'signatory.title': 'Human Resources',
    };
    for (const [k, x] of Object.entries(extra)) v[k.startsWith('extra.') ? k : k in LETTER_FIELDS ? k : `extra.${k}`] = x;
    return v;
  }

  private pdf(title: string, text: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({ size: 'A4', margin: 60, info: { Title: title, Producer: 'SIL HR' } });
      const chunks: Buffer[] = [];
      doc.on('data', (c: Buffer) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
      for (const para of text.split(/\n\s*\n/)) {
        const t = para.trim();
        if (!t) continue;
        if (t.startsWith('# ')) doc.font('Helvetica-Bold').fontSize(13).text(t.slice(2));
        else doc.font('Helvetica').fontSize(11).text(t, { align: 'left', lineGap: 2 });
        doc.moveDown(0.8);
      }
      doc.end();
    });
  }

  private docx(title: string, text: string): Promise<Buffer> {
    const children = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean).map((t) =>
      t.startsWith('# ') ? new Paragraph({ text: t.slice(2), heading: HeadingLevel.HEADING_2, spacing: { after: 160 } })
        : new Paragraph({ alignment: AlignmentType.LEFT, spacing: { after: 200 }, children: t.split('\n').flatMap((line, i) => (i ? [new TextRun({ text: line, break: 1 })] : [new TextRun(line)])) }),
    );
    return Packer.toBuffer(new DocxDocument({ title, creator: 'SIL HR', sections: [{ children }] }));
  }

  async issue(access: AccessProfile, dto: Dto<typeof issueLetter>) {
    const t = await this.dataSource.getRepository(LetterTemplate).findOneBy({ id: dto.template_id, status: 'active' });
    if (!t) throw notFound('Letter template');
    const [e] = await this.dataSource.query(`SELECT branch_id, department_id, staff_number FROM employee WHERE id = $1`, [dto.employee_id]);
    if (!e || !scopeAllows(await this.scope.filterFor(access, 'letter:issue'), { branchId: e.branch_id, departmentId: e.department_id, employeeId: dto.employee_id })) throw notFound('Employee');
    const [{ n }] = await this.dataSource.query(`SELECT count(*)::int + 1 AS n FROM issued_letter WHERE created_at >= date_trunc('year', now())`);
    const number = `LT/${new Date().getUTCFullYear()}/${String(n).padStart(5, '0')}`;
    const values = await this.values(dto.employee_id, number, dto.extra, access.actorName);
    const text = render(t.body, values);
    const body = dto.format === 'pdf' ? await this.pdf(t.name, text) : await this.docx(t.name, text);
    const fileName = `${t.code.toLowerCase()}-${e.staff_number}.${dto.format}`;
    const doc = await this.docs.createFromBuffer({ ownerType: 'employee', ownerId: dto.employee_id, title: `${t.name} (${number})`, isSensitive: true, fileName, mimeType: dto.format === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }, body);
    const row = await this.dataSource.getRepository(IssuedLetter).save(this.dataSource.getRepository(IssuedLetter).create({ createdBy: access.actorId, number, templateId: t.id, employeeId: dto.employee_id, format: dto.format, documentId: doc.id, fields: values }));
    return { letter: { id: row.id, number, template_id: t.id, template_name: t.name, employee_id: dto.employee_id, employee_name: values['employee.full_name'], format: dto.format, document_id: doc.id, created_at: row.createdAt.toISOString() }, file: { fileName, body, mimeType: dto.format === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' } };
  }

  async issued(employeeId?: string) {
    const rows: Record<string, unknown>[] = await this.dataSource.query(
      `SELECT l.id, l.number, l.template_id, t.name AS template_name, l.employee_id, e.first_name || ' ' || e.last_name AS employee_name, l.format, l.document_id, l.created_at
         FROM issued_letter l JOIN letter_template t ON t.id = l.template_id JOIN employee e ON e.id = l.employee_id WHERE ($1::uuid IS NULL OR l.employee_id = $1) ORDER BY l.created_at DESC LIMIT 500`,
      [employeeId ?? null],
    );
    return rows.map((r) => ({ ...r, created_at: new Date(r.created_at as string).toISOString() }));
  }
}
