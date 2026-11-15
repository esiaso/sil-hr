import { Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiHeader, ApiQuery, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import {
  attachEmployeeDocument, bankAccount, changeStatus, contactPerson, createLicence, dependant, documentChecklistItem, documentType, employee, employeeDocument,
  employeeQuery, hireEmployee, licence, licenceQuery, pageOf, positionAssignment, qualification, setManager, statusHistoryEntry, transferEmployee,
  updateEmployee, updateLicence, upsertBankAccount, upsertContactPerson, upsertDependant, upsertDocumentType, upsertQualification, verifyEmployeeDocument,
} from '@sil/hr-shared';
import { AccessProfile } from '../../common/access';
import { Access, RequirePermissions } from '../../common/decorators';
import { ApiIfMatch, IfMatch } from '../../common/etag';
import { ZBody, ZQuery, ZResponse } from '../../common/zod';
import { EmployeesService } from './employees.service';
import { LicencesService } from './licences.service';
import { EmployeeRecordsService } from './records.service';

type Q<T extends z.ZodType> = z.infer<T>;
const Id = (name = 'id') => Param(name, ParseUUIDPipe);
const Idem = () => ApiHeader({ name: 'Idempotency-Key', required: false });
const SensitiveQuery = () => ApiQuery({ name: 'include_sensitive', required: false, enum: ['true', 'false'], description: 'Unmask national ID, passport and KRA PIN (needs employee.sensitive:read; audited)' });

@ApiTags('People: employees')
@Controller('employees')
export class EmployeesController {
  constructor(
    private readonly employees: EmployeesService,
    private readonly records: EmployeeRecordsService,
    private readonly licences: LicencesService,
  ) {}

  @Get()
  @RequirePermissions('employee:read')
  @ZResponse(pageOf(employee))
  list(@Access() a: AccessProfile, @ZQuery(employeeQuery) q: Q<typeof employeeQuery>) {
    return this.employees.list(a, q);
  }

  @Post()
  @RequirePermissions('employee:hire')
  @Idem()
  @ZResponse(employee, 201)
  hire(@Access() a: AccessProfile, @ZBody(hireEmployee) dto: Q<typeof hireEmployee>) {
    return this.employees.hire(a, dto);
  }

  @Get(':id')
  @RequirePermissions('employee:read')
  @SensitiveQuery()
  @ZResponse(employee)
  get(@Access() a: AccessProfile, @Id() id: string, @Query('include_sensitive') s?: string) {
    return this.employees.get(a, id, s === 'true');
  }

  @Patch(':id')
  @RequirePermissions('employee:update')
  @ApiIfMatch()
  @ZResponse(employee)
  update(@Access() a: AccessProfile, @Id() id: string, @ZBody(updateEmployee) dto: Q<typeof updateEmployee>, @IfMatch() v: number) {
    return this.employees.update(a, id, dto, v);
  }

  @Post(':id/status')
  @RequirePermissions('employee:lifecycle')
  @HttpCode(200)
  @ZResponse(employee)
  status(@Access() a: AccessProfile, @Id() id: string, @ZBody(changeStatus) dto: Q<typeof changeStatus>) {
    return this.employees.changeStatus(a, id, dto);
  }

  @Post(':id/transfers')
  @RequirePermissions('employee:lifecycle')
  @HttpCode(200)
  @ZResponse(employee)
  transfer(@Access() a: AccessProfile, @Id() id: string, @ZBody(transferEmployee) dto: Q<typeof transferEmployee>) {
    return this.employees.transfer(a, id, dto);
  }

  @Put(':id/manager')
  @RequirePermissions('employee:lifecycle')
  @ZResponse(employee)
  manager(@Access() a: AccessProfile, @Id() id: string, @ZBody(setManager) dto: Q<typeof setManager>) {
    return this.employees.setManager(a, id, dto.manager_id);
  }

  @Put(':id/user')
  @RequirePermissions('employee:update', 'user:manage')
  @ZResponse(employee)
  linkUser(@Access() a: AccessProfile, @Id() id: string, @ZBody(z.object({ user_id: z.uuid().nullable() })) dto: { user_id: string | null }) {
    return this.employees.linkUser(a, id, dto.user_id);
  }

  @Get(':id/history')
  @RequirePermissions('employee:read')
  @ZResponse(z.object({ assignments: z.array(positionAssignment), statuses: z.array(statusHistoryEntry) }))
  history(@Access() a: AccessProfile, @Id() id: string) {
    return this.employees.history(a, id);
  }

  // ---------------------------------------------------------------- contacts
  @Get(':id/contacts')
  @RequirePermissions('employee:read')
  @ZResponse(z.array(contactPerson))
  contacts(@Access() a: AccessProfile, @Id() id: string) {
    return this.records.contacts(a, id);
  }

  @Post(':id/contacts')
  @RequirePermissions('employee:update')
  @ZResponse(contactPerson, 201)
  addContact(@Access() a: AccessProfile, @Id() id: string, @ZBody(upsertContactPerson) dto: Q<typeof upsertContactPerson>) {
    return this.records.saveContact(a, id, dto);
  }

  @Put(':id/contacts/:rid')
  @RequirePermissions('employee:update')
  @ZResponse(contactPerson)
  putContact(@Access() a: AccessProfile, @Id() id: string, @Id('rid') rid: string, @ZBody(upsertContactPerson) dto: Q<typeof upsertContactPerson>) {
    return this.records.saveContact(a, id, dto, rid);
  }

  @Delete(':id/contacts/:rid')
  @RequirePermissions('employee:update')
  @HttpCode(204)
  @ZResponse(null, 204)
  removeContact(@Access() a: AccessProfile, @Id() id: string, @Id('rid') rid: string) {
    return this.records.removeContact(a, id, rid);
  }

  // ---------------------------------------------------------------- dependants
  @Get(':id/dependants')
  @RequirePermissions('employee:read')
  @ZResponse(z.array(dependant))
  dependants(@Access() a: AccessProfile, @Id() id: string) {
    return this.records.dependants(a, id);
  }

  @Post(':id/dependants')
  @RequirePermissions('employee:update')
  @ZResponse(dependant, 201)
  addDependant(@Access() a: AccessProfile, @Id() id: string, @ZBody(upsertDependant) dto: Q<typeof upsertDependant>) {
    return this.records.saveDependant(a, id, dto);
  }

  @Put(':id/dependants/:rid')
  @RequirePermissions('employee:update')
  @ZResponse(dependant)
  putDependant(@Access() a: AccessProfile, @Id() id: string, @Id('rid') rid: string, @ZBody(upsertDependant) dto: Q<typeof upsertDependant>) {
    return this.records.saveDependant(a, id, dto, rid);
  }

  @Delete(':id/dependants/:rid')
  @RequirePermissions('employee:update')
  @HttpCode(204)
  @ZResponse(null, 204)
  removeDependant(@Access() a: AccessProfile, @Id() id: string, @Id('rid') rid: string) {
    return this.records.removeDependant(a, id, rid);
  }

  // ---------------------------------------------------------------- qualifications
  @Get(':id/qualifications')
  @RequirePermissions('employee:read')
  @ZResponse(z.array(qualification))
  qualifications(@Access() a: AccessProfile, @Id() id: string) {
    return this.records.qualifications(a, id);
  }

  @Post(':id/qualifications')
  @RequirePermissions('employee:update')
  @ZResponse(qualification, 201)
  addQualification(@Access() a: AccessProfile, @Id() id: string, @ZBody(upsertQualification) dto: Q<typeof upsertQualification>) {
    return this.records.saveQualification(a, id, dto);
  }

  @Delete(':id/qualifications/:rid')
  @RequirePermissions('employee:update')
  @HttpCode(204)
  @ZResponse(null, 204)
  removeQualification(@Access() a: AccessProfile, @Id() id: string, @Id('rid') rid: string) {
    return this.records.removeQualification(a, id, rid);
  }

  // ---------------------------------------------------------------- payment details
  @Get(':id/bank-accounts')
  @RequirePermissions('employee:read')
  @SensitiveQuery()
  @ZResponse(z.array(bankAccount))
  bankAccounts(@Access() a: AccessProfile, @Id() id: string, @Query('include_sensitive') s?: string) {
    return this.records.bankAccounts(a, id, s === 'true');
  }

  @Post(':id/bank-accounts')
  @RequirePermissions('employee:update')
  @ZResponse(bankAccount, 201)
  addBankAccount(@Access() a: AccessProfile, @Id() id: string, @ZBody(upsertBankAccount) dto: Q<typeof upsertBankAccount>) {
    return this.records.saveBankAccount(a, id, dto);
  }

  @Delete(':id/bank-accounts/:rid')
  @RequirePermissions('employee:update')
  @HttpCode(204)
  @ZResponse(null, 204)
  removeBankAccount(@Access() a: AccessProfile, @Id() id: string, @Id('rid') rid: string) {
    return this.records.removeBankAccount(a, id, rid);
  }

  // ---------------------------------------------------------------- documents
  @Get(':id/documents')
  @RequirePermissions('employee:read', 'document:read')
  @ZResponse(z.array(employeeDocument))
  documents(@Access() a: AccessProfile, @Id() id: string) {
    return this.records.documents(a, id);
  }

  @Get(':id/documents/checklist')
  @RequirePermissions('employee:read')
  @ZResponse(z.array(documentChecklistItem))
  checklist(@Access() a: AccessProfile, @Id() id: string) {
    return this.records.checklist(a, id);
  }

  @Post(':id/documents')
  @RequirePermissions('employee:update', 'document:write')
  @ZResponse(employeeDocument, 201)
  attach(@Access() a: AccessProfile, @Id() id: string, @ZBody(attachEmployeeDocument) dto: Q<typeof attachEmployeeDocument>) {
    return this.records.attachDocument(a, id, dto);
  }

  @Post(':id/documents/:rid/verification')
  @RequirePermissions('employee_document:verify')
  @HttpCode(200)
  @ZResponse(employeeDocument)
  verifyDocument(@Access() a: AccessProfile, @Id() id: string, @Id('rid') rid: string, @ZBody(verifyEmployeeDocument) dto: Q<typeof verifyEmployeeDocument>) {
    return this.records.verifyDocument(a, id, rid, dto);
  }

  // ---------------------------------------------------------------- licences
  @Get(':id/licences')
  @RequirePermissions('licence:read')
  @ZResponse(z.array(licence))
  employeeLicences(@Access() a: AccessProfile, @Id() id: string) {
    return this.licences.forEmployee(a, id);
  }

  @Post(':id/licences')
  @RequirePermissions('licence:manage')
  @ZResponse(licence, 201)
  addLicence(@Access() a: AccessProfile, @Id() id: string, @ZBody(createLicence) dto: Q<typeof createLicence>) {
    return this.licences.create(a, id, dto);
  }
}

@ApiTags('People: licences')
@Controller('licences')
export class LicencesController {
  constructor(private readonly licences: LicencesService) {}

  @Get()
  @RequirePermissions('licence:read')
  @ZResponse(pageOf(licence))
  list(@Access() a: AccessProfile, @ZQuery(licenceQuery) q: Q<typeof licenceQuery>) {
    return this.licences.list(a, q);
  }

  @Patch(':id')
  @RequirePermissions('licence:manage')
  @ApiIfMatch()
  @ZResponse(licence)
  update(@Access() a: AccessProfile, @Id() id: string, @ZBody(updateLicence) dto: Q<typeof updateLicence>, @IfMatch() v: number) {
    return this.licences.update(a, id, dto, v);
  }

  @Post(':id/verification')
  @RequirePermissions('licence:verify')
  @HttpCode(200)
  @ZResponse(licence)
  verify(@Access() a: AccessProfile, @Id() id: string) {
    return this.licences.verify(a, id);
  }
}

@ApiTags('People: document types')
@Controller('document-types')
export class DocumentTypesController {
  constructor(private readonly records: EmployeeRecordsService) {}

  @Get()
  @RequirePermissions('employee:read')
  @ZResponse(z.array(documentType))
  list() {
    return this.records.documentTypes();
  }

  @Post()
  @RequirePermissions('document_type:manage')
  @ZResponse(documentType, 201)
  create(@ZBody(upsertDocumentType) dto: Q<typeof upsertDocumentType>) {
    return this.records.saveDocumentType(dto);
  }

  @Put(':id')
  @RequirePermissions('document_type:manage')
  @ZResponse(documentType)
  update(@Id() id: string, @ZBody(upsertDocumentType) dto: Q<typeof upsertDocumentType>) {
    return this.records.saveDocumentType(dto, id);
  }
}
