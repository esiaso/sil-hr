import { Module } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EtagInterceptor } from './common/etag';
import { IdempotencyInterceptor } from './common/idempotency';
import { ProblemFilter } from './common/problem';
import { RedisModule } from './common/redis';
import { typeOrmOptions } from './database/typeorm-options';
import { loadEnv } from './config/env';
import { AuditModule } from './modules/audit/audit.module';
import { DocumentsModule } from './modules/documents/documents.module';
import { EmployeesModule } from './modules/employees/employees.module';
import { AttendanceModule } from './modules/attendance/attendance.module';
import { PayrollModule } from './modules/payroll/payroll.module';
import { MedicalModule } from './modules/medical/medical.module';
import { LeaveModule } from './modules/leave/leave.module';
import { WorkflowModule } from './modules/workflow/workflow.module';
import { EventsModule } from './modules/events/events.module';
import { ExternalRefsModule } from './modules/external-refs/external-refs.module';
import { HealthModule } from './modules/health/health.module';
import { IdentityAccessModule } from './modules/identity-access/identity-access.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { NumberingModule } from './modules/numbering/numbering.module';
import { OrganisationModule } from './modules/organisation/organisation.module';
import { SettingsModule } from './modules/settings/settings.module';
import { WebhooksModule } from './modules/webhooks/webhooks.module';

@Module({
  imports: [
    TypeOrmModule.forRootAsync({ useFactory: () => ({ ...typeOrmOptions(), migrationsRun: loadEnv().dbMigrationsRun }) }),
    RedisModule,
    AuditModule,
    SettingsModule,
    NumberingModule,
    EventsModule,
    ExternalRefsModule,
    NotificationsModule,
    DocumentsModule,
    OrganisationModule,
    IdentityAccessModule,
    WebhooksModule,
    EmployeesModule,
    WorkflowModule,
    LeaveModule,
    AttendanceModule,
    PayrollModule,
    MedicalModule,
    HealthModule,
  ],
  providers: [
    { provide: APP_FILTER, useClass: ProblemFilter },
    { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
    { provide: APP_INTERCEPTOR, useClass: EtagInterceptor },
  ],
})
export class AppModule {}
