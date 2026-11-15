import { All, Controller, Get, HttpCode, Module, Param, ParseUUIDPipe, Post, Put, Query, Req, Res, UseInterceptors } from '@nestjs/common';
import { AnyFilesInterceptor } from '@nestjs/platform-express';
import { ApiExcludeEndpoint, ApiQuery, ApiTags } from '@nestjs/swagger';
import { TypeOrmModule } from '@nestjs/typeorm';
import type { Request, Response } from 'express';
import { z } from 'zod';
import {
  attendanceDay, attendanceQuery, clockEventBatch, clockEventBatchResult, connector, connectorRun, departmentShifts, deviceUserMapping, overtimeRule, pageOf, regularisation,
  requestRegularisation, rosterChange, rosterEntry, rosterPattern, rosterQuery, selfClock, setDepartmentShifts, shift, timesheet, upsertConnector, upsertDeviceUserMapping,
  upsertOvertimeRule, upsertShift,
} from '@sil/hr-shared';
import { AccessProfile } from '../../common/access';
import { Access, Public, RequirePermissions, UsersOnly } from '../../common/decorators';
import { ApiIfMatch, IfMatch } from '../../common/etag';
import { badRequest, forbidden } from '../../common/problem';
import { ZBody, ZQuery, ZResponse } from '../../common/zod';
import { LeaveModule } from '../leave/leave.module';
import { OrganisationModule } from '../organisation/organisation.module';
import { SettingsService } from '../settings/settings.module';
import { WorkflowModule } from '../workflow/workflow.module';
import { ATTENDANCE_ENTITIES } from './attendance.entities';
import { AttendanceService } from './attendance.service';
import { ConnectorsService } from './connectors.service';

type Q<T extends z.ZodType> = z.infer<T>;
const Id = (n = 'id') => Param(n, ParseUUIDPipe);
const date = z.iso.date();

@ApiTags('Time & attendance')
@Controller()
export class AttendanceController {
  constructor(
    private readonly att: AttendanceService,
    private readonly settings: SettingsService,
  ) {}

  // ---------------------------------------------------------------- shifts
  @Get('shifts')
  @ZResponse(z.array(shift))
  shifts() {
    return this.att.shifts();
  }

  @Post('shifts')
  @RequirePermissions('shift:manage')
  @ZResponse(shift, 201)
  createShift(@ZBody(upsertShift) dto: Q<typeof upsertShift>) {
    return this.att.saveShift(dto);
  }

  @Put('shifts/:id')
  @RequirePermissions('shift:manage')
  @ApiIfMatch()
  @ZResponse(shift)
  updateShift(@Id() id: string, @ZBody(upsertShift) dto: Q<typeof upsertShift>, @IfMatch() v: number) {
    return this.att.saveShift(dto, id, v);
  }

  @Get('departments/:id/shifts')
  @RequirePermissions('department:read')
  @ZResponse(departmentShifts)
  departmentShifts(@Id() id: string) {
    return this.att.departmentShifts(id);
  }

  @Put('departments/:id/shifts')
  @RequirePermissions('shift:manage')
  @ZResponse(departmentShifts)
  setDepartmentShifts(@Id() id: string, @ZBody(setDepartmentShifts) dto: Q<typeof setDepartmentShifts>) {
    return this.att.setDepartmentShifts(id, dto);
  }

  // ---------------------------------------------------------------- rosters
  @Get('rosters')
  @ZResponse(z.array(rosterEntry))
  roster(@Access() a: AccessProfile, @ZQuery(rosterQuery) q: Q<typeof rosterQuery>) {
    return this.att.roster(a, q);
  }

  @Put('rosters')
  @RequirePermissions('roster:manage')
  @ZResponse(z.object({ changed: z.number().int() }))
  changeRoster(@Access() a: AccessProfile, @ZBody(rosterChange) dto: Q<typeof rosterChange>) {
    return this.att.changeRoster(a, dto);
  }

  @Post('rosters/pattern')
  @RequirePermissions('roster:manage')
  @ZResponse(z.object({ changed: z.number().int() }), 201)
  pattern(@Access() a: AccessProfile, @ZBody(rosterPattern) dto: Q<typeof rosterPattern>) {
    return this.att.applyPattern(a, dto);
  }

  // ---------------------------------------------------------------- clock events
  /** Batch endpoint for any time source (scope attendance:write). Exactly-once by external_id. */
  @Post('clock-events')
  @RequirePermissions('clock_event:write')
  @HttpCode(200)
  @ZResponse(clockEventBatchResult)
  postEvents(@Access() a: AccessProfile, @ZBody(clockEventBatch) dto: Q<typeof clockEventBatch>) {
    return this.att.postBatch(a, dto);
  }

  @Post('me/clock')
  @UsersOnly()
  @HttpCode(200)
  async clock(@Access() a: AccessProfile, @Req() req: Request, @ZBody(selfClock) dto: Q<typeof selfClock>) {
    if (!(await this.settings.get('attendance.self_clock_enabled'))) throw forbidden('Clocking in from the app is turned off; use the device', 'self_clock_disabled');
    const mobile = /Mobi|Android|iPhone/i.test(req.get('user-agent') ?? '');
    return this.att.selfClock(a, dto.direction, mobile ? 'mobile' : 'web', { latitude: dto.latitude, longitude: dto.longitude });
  }

  @Get('me/attendance')
  @UsersOnly()
  @ApiQuery({ name: 'date', required: false })
  async myDay(@Access() a: AccessProfile, @Query('date') d?: string) {
    if (d && !date.safeParse(d).success) throw badRequest('invalid_date', 'date is YYYY-MM-DD');
    return this.att.myDay(a, d ?? (await this.settings.today()));
  }

  // ---------------------------------------------------------------- daily attendance
  @Get('attendance/days')
  @RequirePermissions('attendance:read')
  @ZResponse(pageOf(attendanceDay))
  days(@Access() a: AccessProfile, @ZQuery(attendanceQuery) q: Q<typeof attendanceQuery>) {
    return this.att.days(a, q);
  }

  @Post('attendance/recompute')
  @RequirePermissions('attendance:manage')
  @HttpCode(200)
  @ZResponse(z.object({ days: z.number().int() }))
  async recompute(@Access() a: AccessProfile, @ZBody(z.object({ from: date, to: date, department_id: z.uuid().optional() })) dto: { from: string; to: string; department_id?: string }) {
    return { days: await this.att.recompute(a, dto.from, dto.to, dto.department_id) };
  }

  @Get('attendance/timesheets/:id')
  @ApiQuery({ name: 'from', required: true })
  @ApiQuery({ name: 'to', required: true })
  @ZResponse(timesheet)
  timesheet(@Access() a: AccessProfile, @Id() id: string, @Query('from') from: string, @Query('to') to: string) {
    if (!date.safeParse(from).success || !date.safeParse(to).success) throw badRequest('invalid_date', 'from and to are YYYY-MM-DD');
    return this.att.timesheet(a, id, from, to);
  }

  @Get('attendance/overtime-rules')
  @RequirePermissions('attendance:read')
  @ZResponse(z.array(overtimeRule))
  overtimeRules() {
    return this.att.overtimeRules();
  }

  @Post('attendance/overtime-rules')
  @RequirePermissions('attendance:manage')
  @ZResponse(overtimeRule, 201)
  addOvertimeRule(@ZBody(upsertOvertimeRule) dto: Q<typeof upsertOvertimeRule>) {
    return this.att.saveOvertimeRule(dto);
  }

  @Put('attendance/overtime-rules/:id')
  @RequirePermissions('attendance:manage')
  @ZResponse(overtimeRule)
  updateOvertimeRule(@Id() id: string, @ZBody(upsertOvertimeRule) dto: Q<typeof upsertOvertimeRule>) {
    return this.att.saveOvertimeRule(dto, id);
  }

  @Post('attendance/regularisations')
  @ZResponse(regularisation, 201)
  regularise(@Access() a: AccessProfile, @ZBody(requestRegularisation) dto: Q<typeof requestRegularisation>) {
    return this.att.requestRegularisation(a, dto);
  }

  @Get('attendance/regularisations')
  @ApiQuery({ name: 'employee_id', required: false })
  @ZResponse(z.array(regularisation))
  regularisations(@Access() a: AccessProfile, @Query('employee_id') employeeId?: string) {
    return this.att.regularisations(a, employeeId);
  }
}

@ApiTags('Integration: device connectors')
@Controller()
export class ConnectorsController {
  constructor(private readonly connectors: ConnectorsService) {}

  @Get('connectors')
  @RequirePermissions('connector:manage')
  @ZResponse(z.array(connector))
  list() {
    return this.connectors.list();
  }

  @Post('connectors')
  @RequirePermissions('connector:manage')
  @ZResponse(connector, 201)
  create(@ZBody(upsertConnector) dto: Q<typeof upsertConnector>) {
    return this.connectors.save(dto);
  }

  @Put('connectors/:id')
  @RequirePermissions('connector:manage')
  @ApiIfMatch()
  @ZResponse(connector)
  update(@Id() id: string, @ZBody(upsertConnector) dto: Q<typeof upsertConnector>, @IfMatch() v: number) {
    return this.connectors.save(dto, id, v);
  }

  @Post('connectors/:id/test')
  @RequirePermissions('connector:manage')
  @HttpCode(200)
  @ZResponse(z.object({ ok: z.boolean(), message: z.string() }))
  test(@Id() id: string) {
    return this.connectors.test(id);
  }

  @Post('connectors/:id/run')
  @RequirePermissions('connector:manage')
  @HttpCode(200)
  @ZResponse(connectorRun)
  run(@Id() id: string) {
    return this.connectors.runPull(id, 'manual');
  }

  @Get('connectors/:id/runs')
  @RequirePermissions('connector:manage')
  @ZResponse(z.array(connectorRun))
  runs(@Id() id: string) {
    return this.connectors.runs(id);
  }

  @Get('connectors/:id/mappings')
  @RequirePermissions('connector:manage')
  @ZResponse(z.array(deviceUserMapping))
  mappings(@Id() id: string) {
    return this.connectors.mappings(id);
  }

  @Put('connectors/:id/mappings')
  @RequirePermissions('connector:manage')
  @ZResponse(z.object({ mappings: z.array(deviceUserMapping), rematched: z.number().int() }))
  map(@Id() id: string, @ZBody(upsertDeviceUserMapping) dto: Q<typeof upsertDeviceUserMapping>) {
    return this.connectors.map(id, dto);
  }

  @Get('connectors/:id/unmatched')
  @RequirePermissions('connector:manage')
  @ZResponse(z.array(z.object({ device_user_id: z.string(), punches: z.number().int(), last_seen: z.string() })))
  unmatched(@Id() id: string) {
    return this.connectors.unmatched(id);
  }

  /** Hikvision terminals push events here (JSON, or multipart with an event_log field). */
  @Post('integrations/hikvision/:code/events')
  @Public()
  @HttpCode(200)
  @UseInterceptors(AnyFilesInterceptor({ limits: { fileSize: 2 * 1024 * 1024 } }))
  hikvision(@Param('code') code: string, @Req() req: Request) {
    const body = req.body as Record<string, unknown>;
    const payload = typeof body?.event_log === 'string' ? JSON.parse(body.event_log) : body;
    return this.connectors.hikPush(code, req.ip, payload);
  }
}

/**
 * ZKTeco ADMS ("push") protocol, served at /iclock (outside /api/v1: devices use fixed
 * paths). Only serial numbers registered on a zkteco_push connector are answered.
 */
@Controller('iclock')
export class ZktecoPushController {
  constructor(private readonly connectors: ConnectorsService) {}

  @All(['cdata', 'getrequest', 'devicecmd'])
  @Public()
  @ApiExcludeEndpoint()
  async cdata(@Req() req: Request, @Res() res: Response) {
    const sn = String(req.query.SN ?? '');
    const c = sn ? await this.connectors.zkConnectorFor(sn, req.ip) : null;
    if (!c) return void res.status(403).type('text/plain').send('UNKNOWN DEVICE');
    if (req.method === 'POST' && req.path.endsWith('/cdata') && String(req.query.table ?? '').toUpperCase() === 'ATTLOG') {
      const run = await this.connectors.zkPush(c, sn, typeof req.body === 'string' ? req.body : '');
      return void res.type('text/plain').send(`OK: ${run.received}`);
    }
    if (req.method === 'GET' && req.path.endsWith('/cdata')) {
      // Registration handshake: ask for attendance logs in real time.
      return void res.type('text/plain').send(`GET OPTION FROM: ${sn}\nATTLOGStamp=None\nOPERLOGStamp=9999\nErrorDelay=60\nDelay=30\nTransTimes=00:00;14:05\nTransInterval=1\nTransFlag=1000000000\nRealtime=1\nEncrypt=0`);
    }
    return void res.type('text/plain').send('OK');
  }
}

@Module({
  imports: [TypeOrmModule.forFeature(ATTENDANCE_ENTITIES), OrganisationModule, WorkflowModule, LeaveModule],
  providers: [AttendanceService, ConnectorsService],
  controllers: [AttendanceController, ConnectorsController, ZktecoPushController],
  exports: [AttendanceService, ConnectorsService],
})
export class AttendanceModule {}
