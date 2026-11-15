import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { z } from 'zod';
import {
  AuditAction, attachEmployeeDocument, upsertBankAccount, upsertContactPerson, upsertDependant, upsertDocumentType, upsertQualification, verifyEmployeeDocument,
} from '@sil/hr-shared';
import { AccessProfile, scopeAllows } from '../../common/access';
import { iso } from '../../common/base.entity';
import { decrypt, encrypt, mask } from '../../common/crypto';
import { conflict, notFound, unprocessable } from '../../common/problem';
import { writeAudit } from '../audit/audit.subscriber';
import { ScopeService } from '../organisation/scope.service';
import { SettingsService } from '../settings/settings.module';
import { DocumentType, EmployeeBankAccount, EmployeeContact, EmployeeDependant, EmployeeDocument, EmployeeQualification } from './employee.entities';
import { EmployeesService } from './employees.service';

type Contact = z.infer<typeof upsertContactPerson>;
type Dependant = z.infer<typeof upsertDependant>;
type Qualification = z.infer<typeof upsertQualification>;
type Bank = z.infer<typeof upsertBankAccount>;

const contactDto = (c: EmployeeContact) => ({ id: c.id, kind: c.kind, name: c.name, relationship: c.relationship as Contact['relationship'], phone: c.phone, email: c.email, address: c.address, is_primary: c.isPrimary });
const dependantDto = (d: EmployeeDependant) => ({ id: d.id, name: d.name, relationship: d.relationship as Dependant['relationship'], date_of_birth: d.dateOfBirth, gender: d.gender as Dependant['gender'] ?? null, is_beneficiary: d.isBeneficiary });
const qualificationDto = (q: EmployeeQualification) => ({ id: q.id, level: q.level as Qualification['level'], title: q.title, institution: q.institution, year_awarded: q.yearAwarded, document_id: q.documentId });
export const documentTypeDto = (t: DocumentType) => ({ id: t.id, code: t.code, name: t.name, description: t.description, required_for: t.requiredFor as never, has_expiry: t.hasExpiry, is_sensitive: t.isSensitive, status: t.status });

/**
 * Child records of an employee: contacts, dependants, qualifications, payment details
 * and documents. Each operation first loads the employee under the caller's scope.
 */
@Injectable()
export class EmployeeRecordsService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly employees: EmployeesService,
    private readonly scope: ScopeService,
    private readonly settings: SettingsService,
  ) {}

  private async child<T extends { employeeId: string; id: string }>(m: EntityManager, entity: new () => T, employeeId: string, id: string): Promise<T> {
    const row = await m.getRepository(entity).findOneBy({ id, employeeId } as never);
    if (!row) throw notFound('Record');
    return row as T;
  }

  // ------------------------------------------------------------------ contacts
  async contacts(access: AccessProfile, employeeId: string) {
    await this.employees.load(access, employeeId);
    return (await this.dataSource.getRepository(EmployeeContact).find({ where: { employeeId }, order: { kind: 'ASC', isPrimary: 'DESC', createdAt: 'ASC' } })).map(contactDto);
  }

  async saveContact(access: AccessProfile, employeeId: string, dto: Contact, id?: string) {
    return this.dataSource.transaction(async (m) => {
      await this.employees.load(access, employeeId, 'employee:update', m);
      const repo = m.getRepository(EmployeeContact);
      const row = id ? await this.child(m, EmployeeContact, employeeId, id) : repo.create({ employeeId });
      Object.assign(row, { kind: dto.kind, name: dto.name, relationship: dto.relationship, phone: dto.phone ?? null, email: dto.email ?? null, address: dto.address ?? null, isPrimary: dto.is_primary });
      if (row.isPrimary) await m.query(`UPDATE employee_contact SET is_primary = false WHERE employee_id = $1 AND kind = $2 AND id IS DISTINCT FROM $3`, [employeeId, row.kind, row.id ?? null]);
      return contactDto(await repo.save(row));
    });
  }

  async removeContact(access: AccessProfile, employeeId: string, id: string) {
    await this.dataSource.transaction(async (m) => {
      await this.employees.load(access, employeeId, 'employee:update', m);
      await m.getRepository(EmployeeContact).remove(await this.child(m, EmployeeContact, employeeId, id));
    });
  }

  // ------------------------------------------------------------------ dependants
  async dependants(access: AccessProfile, employeeId: string) {
    await this.employees.load(access, employeeId);
    return (await this.dataSource.getRepository(EmployeeDependant).find({ where: { employeeId }, order: { createdAt: 'ASC' } })).map(dependantDto);
  }

  async saveDependant(access: AccessProfile, employeeId: string, dto: Dependant, id?: string) {
    return this.dataSource.transaction(async (m) => {
      await this.employees.load(access, employeeId, 'employee:update', m);
      const repo = m.getRepository(EmployeeDependant);
      const row = id ? await this.child(m, EmployeeDependant, employeeId, id) : repo.create({ employeeId });
      Object.assign(row, { name: dto.name, relationship: dto.relationship, dateOfBirth: dto.date_of_birth ?? null, gender: dto.gender ?? null, isBeneficiary: dto.is_beneficiary });
      return dependantDto(await repo.save(row));
    });
  }

  async removeDependant(access: AccessProfile, employeeId: string, id: string) {
    await this.dataSource.transaction(async (m) => {
      await this.employees.load(access, employeeId, 'employee:update', m);
      await m.getRepository(EmployeeDependant).remove(await this.child(m, EmployeeDependant, employeeId, id));
    });
  }

  // ------------------------------------------------------------------ qualifications
  async qualifications(access: AccessProfile, employeeId: string) {
    await this.employees.load(access, employeeId);
    return (await this.dataSource.getRepository(EmployeeQualification).find({ where: { employeeId }, order: { yearAwarded: 'DESC' } })).map(qualificationDto);
  }

  async saveQualification(access: AccessProfile, employeeId: string, dto: Qualification, id?: string) {
    return this.dataSource.transaction(async (m) => {
      await this.employees.load(access, employeeId, 'employee:update', m);
      const repo = m.getRepository(EmployeeQualification);
      const row = id ? await this.child(m, EmployeeQualification, employeeId, id) : repo.create({ employeeId });
      Object.assign(row, { level: dto.level, title: dto.title, institution: dto.institution ?? null, yearAwarded: dto.year_awarded ?? null, documentId: dto.document_id ?? null });
      return qualificationDto(await repo.save(row));
    });
  }

  async removeQualification(access: AccessProfile, employeeId: string, id: string) {
    await this.dataSource.transaction(async (m) => {
      await this.employees.load(access, employeeId, 'employee:update', m);
      await m.getRepository(EmployeeQualification).remove(await this.child(m, EmployeeQualification, employeeId, id));
    });
  }

  // ------------------------------------------------------------------ payment details (sensitive)
  async bankAccounts(access: AccessProfile, employeeId: string, wantSensitive: boolean) {
    const e = await this.employees.load(access, employeeId);
    let sensitive = false;
    if (wantSensitive && access.has('employee.sensitive:read')) {
      sensitive = scopeAllows(await this.scope.filterFor(access, 'employee.sensitive:read'), { branchId: e.branchId, departmentId: e.departmentId, employeeId: e.id });
    }
    const rows = await this.dataSource.getRepository(EmployeeBankAccount).createQueryBuilder('b').addSelect('b.accountNumberEnc').where('b.employee_id = :id', { id: employeeId }).orderBy('b.is_primary', 'DESC').getMany();
    if (sensitive && rows.length) await writeAudit(this.dataSource.manager, { action: AuditAction.SENSITIVE_READ, entityType: 'EmployeeBankAccount', entityId: employeeId, after: { accounts: rows.length } });
    return rows.map((b) => ({
      id: b.id, kind: b.kind, bank_name: b.bankName, bank_code: b.bankCode, branch_name: b.branchName, branch_code: b.branchCode, account_name: b.accountName,
      account_number: sensitive ? decrypt(b.accountNumberEnc)! : mask(decrypt(b.accountNumberEnc))!, is_primary: b.isPrimary, sensitive_visible: sensitive,
    }));
  }

  async saveBankAccount(access: AccessProfile, employeeId: string, dto: Bank, id?: string) {
    return this.dataSource.transaction(async (m) => {
      await this.employees.load(access, employeeId, 'employee:update', m);
      const repo = m.getRepository(EmployeeBankAccount);
      const row = id ? await this.child(m, EmployeeBankAccount, employeeId, id) : repo.create({ employeeId });
      const number = dto.account_number.replace(/\s+/g, '');
      Object.assign(row, {
        kind: dto.kind, bankName: dto.bank_name ?? null, bankCode: dto.bank_code ?? null, branchName: dto.branch_name ?? null, branchCode: dto.branch_code ?? null,
        accountName: dto.account_name, accountNumberEnc: encrypt(number), accountLast4: number.slice(-4), isPrimary: dto.is_primary,
      });
      if (row.isPrimary) await m.query(`UPDATE employee_bank_account SET is_primary = false WHERE employee_id = $1 AND id IS DISTINCT FROM $2`, [employeeId, row.id ?? null]);
      const saved = await repo.save(row);
      return { id: saved.id, kind: saved.kind, bank_name: saved.bankName, bank_code: saved.bankCode, branch_name: saved.branchName, branch_code: saved.branchCode, account_name: saved.accountName, account_number: mask(number)!, is_primary: saved.isPrimary, sensitive_visible: false };
    });
  }

  async removeBankAccount(access: AccessProfile, employeeId: string, id: string) {
    await this.dataSource.transaction(async (m) => {
      await this.employees.load(access, employeeId, 'employee:update', m);
      await m.getRepository(EmployeeBankAccount).remove(await this.child(m, EmployeeBankAccount, employeeId, id));
    });
  }

  // ------------------------------------------------------------------ document types and checklist
  async documentTypes() {
    return (await this.dataSource.getRepository(DocumentType).find({ order: { name: 'ASC' } })).map(documentTypeDto);
  }

  async saveDocumentType(dto: z.infer<typeof upsertDocumentType>, id?: string) {
    const repo = this.dataSource.getRepository(DocumentType);
    const row = id ? await repo.findOneBy({ id }) : repo.create();
    if (!row) throw notFound('Document type');
    Object.assign(row, { code: dto.code, name: dto.name, description: dto.description ?? null, requiredFor: dto.required_for, hasExpiry: dto.has_expiry, isSensitive: dto.is_sensitive, ...(dto.status ? { status: dto.status } : {}) });
    return documentTypeDto(await repo.save(row));
  }

  private docDto(d: EmployeeDocument) {
    return { id: d.id, document_type_id: d.documentTypeId, document_type: d.documentType?.name ?? '', document_id: d.documentId, expiry_date: d.expiryDate, verification: d.verification, verified_by: d.verifiedBy, verified_at: iso(d.verifiedAt), notes: d.notes, created_at: d.createdAt.toISOString() };
  }

  async documents(access: AccessProfile, employeeId: string) {
    await this.employees.load(access, employeeId);
    const rows = await this.dataSource.getRepository(EmployeeDocument).find({ where: { employeeId }, relations: { documentType: true }, order: { createdAt: 'DESC' } });
    return rows.map((d) => this.docDto(d));
  }

  /** Attaches an uploaded document (POST /documents first) to the employee's file. */
  async attachDocument(access: AccessProfile, employeeId: string, dto: z.infer<typeof attachEmployeeDocument>) {
    return this.dataSource.transaction(async (m) => {
      await this.employees.load(access, employeeId, 'employee:update', m);
      const type = await m.getRepository(DocumentType).findOneBy({ id: dto.document_type_id });
      if (!type) throw unprocessable('document_type_not_found', 'Unknown document type', [{ path: 'document_type_id', message: 'Not found' }]);
      if (type.hasExpiry && !dto.expiry_date) throw unprocessable('expiry_required', `${type.name} needs an expiry date`, [{ path: 'expiry_date', message: 'Required' }]);
      const [doc] = await m.query(`SELECT id, owner_type, owner_id FROM document WHERE id = $1 AND deleted_at IS NULL`, [dto.document_id]);
      if (!doc) throw unprocessable('document_not_found', 'Upload the file first', [{ path: 'document_id', message: 'Not found' }]);
      if (doc.owner_id && doc.owner_id !== employeeId) throw conflict('document_owned', 'That document belongs to someone else');
      await m.query(`UPDATE document SET owner_type = 'employee', owner_id = $2, is_sensitive = is_sensitive OR $3 WHERE id = $1`, [dto.document_id, employeeId, type.isSensitive]);
      const repo = m.getRepository(EmployeeDocument);
      const saved = await repo.save(repo.create({ employeeId, documentTypeId: type.id, documentId: dto.document_id, expiryDate: dto.expiry_date ?? null, notes: dto.notes ?? null }));
      saved.documentType = type;
      return this.docDto(saved);
    });
  }

  async verifyDocument(access: AccessProfile, employeeId: string, id: string, dto: z.infer<typeof verifyEmployeeDocument>) {
    return this.dataSource.transaction(async (m) => {
      await this.employees.load(access, employeeId, 'employee_document:verify', m);
      const row = await m.getRepository(EmployeeDocument).findOne({ where: { id, employeeId }, relations: { documentType: true } });
      if (!row) throw notFound('Document');
      Object.assign(row, { verification: dto.verification, verifiedBy: access.actorId, verifiedAt: new Date(), notes: dto.notes ?? row.notes });
      return this.docDto(await m.getRepository(EmployeeDocument).save(row));
    });
  }

  /** Which required documents are on file, verified, rejected or expired. */
  async checklist(access: AccessProfile, employeeId: string) {
    const e = await this.employees.load(access, employeeId);
    const today = await this.settings.today();
    const types = await this.dataSource.getRepository(DocumentType).findBy({ status: 'active' });
    const docs = await this.dataSource.getRepository(EmployeeDocument).find({ where: { employeeId }, order: { createdAt: 'DESC' } });
    return types
      .filter((t) => t.requiredFor.includes(e.employmentType) || docs.some((d) => d.documentTypeId === t.id))
      .map((t) => {
        const latest = docs.find((d) => d.documentTypeId === t.id);
        const state = !latest ? 'missing' : latest.expiryDate && latest.expiryDate < today ? 'expired' : latest.verification;
        return { document_type_id: t.id, code: t.code, name: t.name, required: t.requiredFor.includes(e.employmentType), state: state as 'missing' | 'pending' | 'verified' | 'rejected' | 'expired', employee_document_id: latest?.id ?? null };
      });
  }
}
