import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { IdentityAccessModule } from '../identity-access/identity-access.module';
import { OrganisationModule } from '../organisation/organisation.module';
import { WorkflowModule } from '../workflow/workflow.module';
import { BulkController, BulkService } from './bulk';
import { ScimController, ScimService } from './scim';
import { ContactChangesController, DirectoryController, DirectoryService, SelfServiceController, SelfServiceService } from './directory';
import { EMPLOYEE_ENTITIES } from './employee.entities';
import { DocumentTypesController, EmployeesController, LicencesController } from './employees.controller';
import { EmployeesService } from './employees.service';
import { LicencesService } from './licences.service';
import { EmployeeRecordsService } from './records.service';

@Module({
  imports: [TypeOrmModule.forFeature(EMPLOYEE_ENTITIES), OrganisationModule, IdentityAccessModule, WorkflowModule],
  providers: [ScimService, BulkService, EmployeesService, EmployeeRecordsService, LicencesService, DirectoryService, SelfServiceService],
  controllers: [ScimController, BulkController, EmployeesController, LicencesController, DocumentTypesController, DirectoryController, SelfServiceController, ContactChangesController],
  exports: [BulkService, EmployeesService, LicencesService, DirectoryService],
})
export class EmployeesModule {}
