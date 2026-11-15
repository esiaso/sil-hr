import { Controller, Delete, Get, HttpCode, Module, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { ApiQuery, ApiTags } from '@nestjs/swagger';
import { TypeOrmModule } from '@nestjs/typeorm';
import { z } from 'zod';
import {
  applyLeave, calendarEntry, calendarQuery, leaveAdjustment, leaveBalance, leavePolicy, leaveQuote, leaveRequest, leaveRequestQuery, leaveType, ledgerEntry,
  pageOf, publicHoliday, upsertLeavePolicy, upsertLeaveType, upsertPublicHoliday,
} from '@sil/hr-shared';
import { AccessProfile } from '../../common/access';
import { Access, RequirePermissions, UsersOnly } from '../../common/decorators';
import { ApiIfMatch, IfMatch } from '../../common/etag';
import { badRequest, ProblemException } from '../../common/problem';
import { ZBody, ZQuery, ZResponse } from '../../common/zod';
import { OrganisationModule } from '../organisation/organisation.module';
import { WorkflowModule } from '../workflow/workflow.module';
import { LEAVE_ENTITIES } from './leave.entities';
import { LeaveService } from './leave.service';

type Q<T extends z.ZodType> = z.infer<T>;
const Id = (n = 'id') => Param(n, ParseUUIDPipe);
const resubmit = z.object({ start_date: z.iso.date().optional(), end_date: z.iso.date().optional(), start_half_day: z.boolean().optional(), end_half_day: z.boolean().optional(), reason: z.string().max(1000).nullish(), document_id: z.uuid().nullish() });
const year = (v?: string) => {
  if (v === undefined) return undefined;
  if (!/^\d{4}$/.test(v)) throw badRequest('invalid_year', 'year is a 4-digit leave year');
  return Number(v);
};

@ApiTags('Leave')
@Controller('leave')
export class LeaveController {
  constructor(private readonly leave: LeaveService) {}

  // ---------------------------------------------------------------- setup
  @Get('types')
  @ApiQuery({ name: 'include_inactive', required: false, enum: ['true', 'false'] })
  @ZResponse(z.array(leaveType))
  types(@Query('include_inactive') all?: string) {
    return this.leave.types(all === 'true');
  }

  @Post('types')
  @RequirePermissions('leave_setup:manage')
  @ZResponse(leaveType, 201)
  createType(@ZBody(upsertLeaveType) dto: Q<typeof upsertLeaveType>) {
    return this.leave.saveType(dto);
  }

  @Put('types/:id')
  @RequirePermissions('leave_setup:manage')
  @ApiIfMatch()
  @ZResponse(leaveType)
  updateType(@Id() id: string, @ZBody(upsertLeaveType) dto: Q<typeof upsertLeaveType>, @IfMatch() v: number) {
    return this.leave.saveType(dto, id, v);
  }

  @Get('policies')
  @RequirePermissions('leave:read')
  @ZResponse(z.array(leavePolicy))
  policies() {
    return this.leave.policies();
  }

  @Post('policies')
  @RequirePermissions('leave_setup:manage')
  @ZResponse(leavePolicy, 201)
  createPolicy(@ZBody(upsertLeavePolicy) dto: Q<typeof upsertLeavePolicy>) {
    return this.leave.savePolicy(dto);
  }

  @Put('policies/:id')
  @RequirePermissions('leave_setup:manage')
  @ZResponse(leavePolicy)
  updatePolicy(@Id() id: string, @ZBody(upsertLeavePolicy) dto: Q<typeof upsertLeavePolicy>) {
    return this.leave.savePolicy(dto, id);
  }

  @Get('holidays')
  @ApiQuery({ name: 'year', required: false })
  @ZResponse(z.array(publicHoliday))
  holidays(@Query('year') y?: string) {
    return this.leave.holidays(year(y));
  }

  @Post('holidays')
  @RequirePermissions('leave_setup:manage')
  @ZResponse(publicHoliday, 201)
  addHoliday(@ZBody(upsertPublicHoliday) dto: Q<typeof upsertPublicHoliday>) {
    return this.leave.saveHoliday(dto);
  }

  @Delete('holidays/:id')
  @RequirePermissions('leave_setup:manage')
  @HttpCode(204)
  @ZResponse(null, 204)
  removeHoliday(@Id() id: string) {
    return this.leave.removeHoliday(id);
  }

  // ---------------------------------------------------------------- requests
  @Post('quote')
  @HttpCode(200)
  @ZResponse(leaveQuote)
  quote(@Access() a: AccessProfile, @ZBody(applyLeave) dto: Q<typeof applyLeave>) {
    return this.leave.quote(a, dto);
  }

  @Post('requests')
  @ZResponse(leaveRequest, 201)
  apply(@Access() a: AccessProfile, @ZBody(applyLeave) dto: Q<typeof applyLeave>) {
    return this.leave.apply(a, dto);
  }

  @Get('requests')
  @RequirePermissions('leave:read')
  @ZResponse(pageOf(leaveRequest))
  list(@Access() a: AccessProfile, @ZQuery(leaveRequestQuery) q: Q<typeof leaveRequestQuery>) {
    return this.leave.list(a, q);
  }

  @Get('requests/:id')
  @ZResponse(leaveRequest)
  get(@Access() a: AccessProfile, @Id() id: string) {
    return this.leave.get(a, id);
  }

  @Post('requests/:id/submit')
  @HttpCode(200)
  @ZResponse(leaveRequest)
  submit(@Access() a: AccessProfile, @Id() id: string, @ZBody(resubmit) dto: Q<typeof resubmit>) {
    return this.leave.submit(a, id, dto);
  }

  @Post('requests/:id/cancel')
  @HttpCode(200)
  @ZResponse(leaveRequest)
  cancel(@Access() a: AccessProfile, @Id() id: string, @ZBody(z.object({ reason: z.string().max(500).nullish() })) dto: { reason?: string | null }) {
    return this.leave.cancel(a, id, dto.reason ?? null);
  }

  @Get('calendar')
  @ZResponse(z.array(calendarEntry))
  calendar(@Access() a: AccessProfile, @ZQuery(calendarQuery) q: Q<typeof calendarQuery>) {
    return this.leave.calendar(a, q.from, q.to, q.department_id, q.include_sub_departments !== 'false');
  }

  // ---------------------------------------------------------------- balances
  @Get('employees/:id/balances')
  @ApiQuery({ name: 'year', required: false })
  @ZResponse(z.array(leaveBalance))
  balances(@Access() a: AccessProfile, @Id() id: string, @Query('year') y?: string) {
    return this.leave.balances(a, id, year(y));
  }

  @Get('employees/:id/ledger')
  @ApiQuery({ name: 'year', required: true })
  @ZResponse(z.array(ledgerEntry))
  ledger(@Access() a: AccessProfile, @Id() id: string, @Query('year') y?: string) {
    return this.leave.ledger(a, id, year(y) ?? new Date().getFullYear());
  }

  @Post('employees/:id/adjustments')
  @RequirePermissions('leave:adjust')
  @ZResponse(z.array(leaveBalance), 201)
  adjust(@Access() a: AccessProfile, @Id() id: string, @ZBody(leaveAdjustment) dto: Q<typeof leaveAdjustment>) {
    return this.leave.adjust(a, id, dto);
  }
}

/** Self-service shortcuts for the signed-in employee. */
@ApiTags('Self-service')
@Controller('me/leave')
export class MyLeaveController {
  constructor(private readonly leave: LeaveService) {}

  private me(a: AccessProfile): string {
    if (!a.employeeId) throw new ProblemException(404, 'no_employee_record', 'Your account is not linked to an employee record');
    return a.employeeId;
  }

  @Get('balances')
  @UsersOnly()
  @ZResponse(z.array(leaveBalance))
  balances(@Access() a: AccessProfile) {
    return this.leave.balances(a, this.me(a));
  }

  @Get('requests')
  @UsersOnly()
  @ZResponse(pageOf(leaveRequest))
  requests(@Access() a: AccessProfile, @ZQuery(leaveRequestQuery) q: Q<typeof leaveRequestQuery>) {
    this.me(a);
    return this.leave.list(a, q, true);
  }
}

@Module({
  imports: [TypeOrmModule.forFeature(LEAVE_ENTITIES), WorkflowModule, OrganisationModule],
  providers: [LeaveService],
  controllers: [LeaveController, MyLeaveController],
  exports: [LeaveService],
})
export class LeaveModule {}
