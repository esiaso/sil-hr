import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { IdentityAccessModule } from '../identity-access/identity-access.module';
import { OrganisationModule } from '../organisation/organisation.module';
import { ContactChangesController, DirectoryController, DirectoryService, SelfServiceController, SelfServiceService } from './directory';
import { EMPLOYEE_ENTITIES } from './employee.entities';
import { DocumentTypesController, EmployeesController, LicencesController } from './employees.controller';
import { EmployeesService } from './employees.service';
import { LicencesService } from './licences.service';
import { EmployeeRecordsService } from './records.service';

@Module({
  imports: [TypeOrmModule.forFeature(EMPLOYEE_ENTITIES), OrganisationModule, IdentityAccessModule],
  providers: [EmployeesService, EmployeeRecordsService, LicencesService, DirectoryService, SelfServiceService],
  controllers: [EmployeesController, LicencesController, DocumentTypesController, DirectoryController, SelfServiceController, ContactChangesController],
  exports: [EmployeesService, LicencesService, DirectoryService],
})
export class EmployeesModule {}
