import { Controller, Delete, Get, HttpCode, Module, Param, ParseUUIDPipe, Post, Put, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBody, ApiConsumes, ApiProduces, ApiTags } from '@nestjs/swagger';
import { TypeOrmModule } from '@nestjs/typeorm';
import type { Response } from 'express';
import { z } from 'zod';
import {
  announcement, calendarEvent, calendarFeed, createAction, meeting, meetingAction, meetingMinutes, meetingResponse, meetingRoom, meetingSummary, myCalendarQuery, myPolicy, policy, policyAckRow, policyFields, policyVersionFields,
  roomAvailability, updateAction, updatePolicy, upsertAnnouncement, upsertMeeting, upsertRoom,
} from '@sil/hr-shared';
import { AccessProfile } from '../../common/access';
import { Access, Public, RequirePermissions } from '../../common/decorators';
import { ApiIfMatch, IfMatch } from '../../common/etag';
import { ZBody, ZQuery, ZResponse } from '../../common/zod';
import { loadEnv } from '../../config/env';
import { OrganisationModule } from '../organisation/organisation.module';
import { WORKPLACE_ENTITIES } from './workplace.entities';
import { WorkplaceService } from './workplace.service';

type Q<T extends z.ZodType> = z.infer<T>;
const Id = (n = 'id') => Param(n, ParseUUIDPipe);
const upload = (field: string) => FileInterceptor(field, { limits: { fileSize: loadEnv().maxUploadMb * 1024 * 1024, files: 1 } });
const sendFile = (res: Response, f: { body: Buffer; fileName: string; mimeType: string }) => {
  res.setHeader('content-type', f.mimeType);
  res.setHeader('content-disposition', `attachment; filename="${f.fileName.replace(/["\\\r\n]/g, '_')}"`);
  res.setHeader('cache-control', 'no-store');
  res.send(f.body);
};

@ApiTags('Workplace')
@Controller()
export class WorkplaceController {
  constructor(private readonly svc: WorkplaceService) {}

  // ---------------------------------------------------------------- announcements
  @Get('announcements')
  @ZResponse(z.array(announcement), 200, 'Live announcements for you; ?all=true (announcement:manage) lists every one')
  announcements(@Access() a: AccessProfile, @ZQuery(z.object({ all: z.enum(['true', 'false']).optional() })) q: { all?: string }) {
    return this.svc.announcements(a, q.all === 'true');
  }

  @Post('announcements')
  @RequirePermissions('announcement:manage')
  @ZResponse(announcement, 201, 'The audience is told when it goes live')
  createAnnouncement(@ZBody(upsertAnnouncement) dto: Q<typeof upsertAnnouncement>) {
    return this.svc.saveAnnouncement(dto);
  }

  @Put('announcements/:id')
  @RequirePermissions('announcement:manage')
  @ApiIfMatch()
  @ZResponse(announcement)
  updateAnnouncement(@Id() id: string, @ZBody(upsertAnnouncement) dto: Q<typeof upsertAnnouncement>, @IfMatch() v: number) {
    return this.svc.saveAnnouncement(dto, id, v);
  }

  // ---------------------------------------------------------------- policies
  @Get('policies')
  @RequirePermissions('policy:read')
  @ZResponse(z.array(policy), 200, 'Every policy, with acknowledgement counts for its current version')
  policies() {
    return this.svc.policies();
  }

  @Post('policies')
  @RequirePermissions('policy:manage')
  @ApiConsumes('multipart/form-data')
  @ApiBody({ schema: { type: 'object', required: ['code', 'title', 'category', 'effective_from', 'file'], properties: { code: { type: 'string' }, title: { type: 'string' }, category: { type: 'string' }, description: { type: 'string' }, department_ids: { type: 'string', description: 'Comma-separated; empty = all staff' }, requires_ack: { type: 'string', enum: ['true', 'false'] }, effective_from: { type: 'string', format: 'date' }, file: { type: 'string', format: 'binary' } } } as never })
  @UseInterceptors(upload('file'))
  @ZResponse(policy, 201, 'Version 1; staff in the audience are asked to read and acknowledge it')
  createPolicy(@Access() a: AccessProfile, @ZBody(policyFields) f: Q<typeof policyFields>, @UploadedFile() file: Express.Multer.File | undefined) {
    return this.svc.createPolicy(a, f, file);
  }

  @Post('policies/:id/versions')
  @RequirePermissions('policy:manage')
  @ApiConsumes('multipart/form-data')
  @ApiBody({ schema: { type: 'object', required: ['effective_from', 'file'], properties: { effective_from: { type: 'string', format: 'date' }, changes: { type: 'string' }, file: { type: 'string', format: 'binary' } } } as never })
  @UseInterceptors(upload('file'))
  @ZResponse(policy, 201, 'A new version needs acknowledging again')
  addVersion(@Access() a: AccessProfile, @Id() id: string, @ZBody(policyVersionFields) f: Q<typeof policyVersionFields>, @UploadedFile() file: Express.Multer.File | undefined) {
    return this.svc.addPolicyVersion(a, id, f, file);
  }

  @Put('policies/:id')
  @RequirePermissions('policy:manage')
  @ApiIfMatch()
  @ZResponse(policy)
  updatePolicy(@Id() id: string, @ZBody(updatePolicy) dto: Q<typeof updatePolicy>, @IfMatch() v: number) {
    return this.svc.updatePolicy(id, dto, v);
  }

  @Get('policies/:id/acknowledgements')
  @RequirePermissions('policy:read')
  @ZResponse(z.array(policyAckRow), 200, 'Staff in the audience (and your scope), not yet acknowledged first')
  acks(@Access() a: AccessProfile, @Id() id: string, @ZQuery(z.object({ pending: z.enum(['true', 'false']).optional() })) q: { pending?: string }) {
    return this.svc.acknowledgements(a, id, q.pending === 'true');
  }

  @Get('policies/:id/document')
  @ApiProduces('application/pdf')
  async policyDocument(@Access() a: AccessProfile, @Id() id: string, @Res() res: Response) {
    sendFile(res, await this.svc.policyFile(a, id));
  }

  @Get('me/policies')
  @ZResponse(z.array(myPolicy), 200, 'Policies that apply to you, unacknowledged first')
  myPolicies(@Access() a: AccessProfile) {
    return this.svc.myPolicies(a);
  }

  @Post('policies/:id/acknowledge')
  @HttpCode(200)
  @ZResponse(myPolicy, 200, 'You have read the current version')
  acknowledge(@Access() a: AccessProfile, @Id() id: string) {
    return this.svc.acknowledgePolicy(a, id);
  }

  // ---------------------------------------------------------------- rooms and meetings
  @Get('meeting-rooms')
  @ZResponse(z.array(meetingRoom))
  rooms() {
    return this.svc.rooms();
  }

  @Post('meeting-rooms')
  @RequirePermissions('meeting_room:manage')
  @ZResponse(meetingRoom, 201)
  createRoom(@ZBody(upsertRoom) dto: Q<typeof upsertRoom>) {
    return this.svc.saveRoom(dto);
  }

  @Put('meeting-rooms/:id')
  @RequirePermissions('meeting_room:manage')
  @ApiIfMatch()
  @ZResponse(meetingRoom)
  updateRoom(@Id() id: string, @ZBody(upsertRoom) dto: Q<typeof upsertRoom>, @IfMatch() v: number) {
    return this.svc.saveRoom(dto, id, v);
  }

  @Get('meeting-rooms/availability')
  @ZResponse(roomAvailability, 200, 'Bookings per room for one day')
  availability(@ZQuery(z.object({ date: z.iso.date() })) q: { date: string }) {
    return this.svc.availability(q.date);
  }

  @Get('meetings/invitees')
  @RequirePermissions('directory:read')
  @ZResponse(z.array(z.object({ id: z.uuid(), display_name: z.string(), department_name: z.string().nullable() })), 200, 'Active users matching a name or staff number (at least two characters)')
  invitees(@ZQuery(z.object({ search: z.string().max(100) })) q: { search: string }) {
    return this.svc.invitees(q.search);
  }

  @Get('me/meetings')
  @ZResponse(z.array(meetingSummary), 200, 'Meetings you organise or are invited to')
  myMeetings(@Access() a: AccessProfile, @ZQuery(z.object({ from: z.iso.date().optional(), to: z.iso.date().optional() })) q: { from?: string; to?: string }) {
    return this.svc.myMeetings(a, q);
  }

  @Post('meetings')
  @ZResponse(meeting, 201, 'Anyone can organise a meeting; a room cannot be double-booked (409)')
  createMeeting(@Access() a: AccessProfile, @ZBody(upsertMeeting) dto: Q<typeof upsertMeeting>) {
    return this.svc.saveMeeting(a, dto);
  }

  @Get('meetings/:id')
  @ZResponse(meeting, 200, 'The organiser and attendees only')
  meeting(@Access() a: AccessProfile, @Id() id: string) {
    return this.svc.meeting(a, id);
  }

  @Put('meetings/:id')
  @ApiIfMatch()
  @ZResponse(meeting, 200, 'The organiser only; new attendees are invited')
  updateMeeting(@Access() a: AccessProfile, @Id() id: string, @ZBody(upsertMeeting) dto: Q<typeof upsertMeeting>, @IfMatch() v: number) {
    return this.svc.saveMeeting(a, dto, id, v);
  }

  @Post('meetings/:id/cancel')
  @HttpCode(200)
  @ZResponse(meeting)
  cancelMeeting(@Access() a: AccessProfile, @Id() id: string) {
    return this.svc.cancelMeeting(a, id);
  }

  @Post('meetings/:id/response')
  @HttpCode(200)
  @ZResponse(meeting)
  respond(@Access() a: AccessProfile, @Id() id: string, @ZBody(meetingResponse) dto: Q<typeof meetingResponse>) {
    return this.svc.respond(a, id, dto.response);
  }

  @Put('meetings/:id/minutes')
  @ZResponse(meeting, 200, 'Records the minutes and who attended; attendees are told')
  minutes(@Access() a: AccessProfile, @Id() id: string, @ZBody(meetingMinutes) dto: Q<typeof meetingMinutes>) {
    return this.svc.recordMinutes(a, id, dto);
  }

  @Post('meetings/:id/actions')
  @ZResponse(meeting, 201)
  addAction(@Access() a: AccessProfile, @Id() id: string, @ZBody(createAction) dto: Q<typeof createAction>) {
    return this.svc.addAction(a, id, dto);
  }

  @Put('meeting-actions/:id')
  @ZResponse(meetingAction, 200, 'The owner or the organiser')
  setAction(@Access() a: AccessProfile, @Id() id: string, @ZBody(updateAction) dto: Q<typeof updateAction>) {
    return this.svc.setAction(a, id, dto.status);
  }

  @Get('me/actions')
  @ZResponse(z.array(meetingAction), 200, 'Meeting actions assigned to you')
  myActions(@Access() a: AccessProfile) {
    return this.svc.myActions(a);
  }

  @Get('meetings/:id/ics')
  @ApiProduces('text/calendar')
  async ics(@Access() a: AccessProfile, @Id() id: string, @Res() res: Response) {
    res.setHeader('content-type', 'text/calendar; charset=utf-8');
    res.setHeader('content-disposition', 'attachment; filename="meeting.ics"');
    res.send(await this.svc.meetingIcs(a, id));
  }

  // ---------------------------------------------------------------- calendar
  @Get('me/calendar')
  @ZResponse(z.array(calendarEvent), 200, 'Your leave, shifts, public holidays, meetings, training and interviews, and your team’s approved leave when you can see it')
  calendar(@Access() a: AccessProfile, @ZQuery(myCalendarQuery) q: Q<typeof myCalendarQuery>) {
    return this.svc.calendar(a.actorId, a.employeeId, q.from, q.to, a);
  }

  @Post('me/calendar-feed')
  @HttpCode(200)
  @ZResponse(calendarFeed, 200, 'A secret ICS address for Outlook, Google or Apple calendars; a new one replaces the old')
  feed(@Access() a: AccessProfile) {
    return this.svc.rotateFeed(a);
  }

  @Delete('me/calendar-feed')
  @HttpCode(204)
  async removeFeed(@Access() a: AccessProfile) {
    await this.svc.removeFeed(a);
  }
}

/** The ICS feed is fetched by calendar apps, which cannot sign in: the secret URL is the credential. */
@ApiTags('Workplace')
@Controller('calendar-feeds')
export class CalendarFeedController {
  constructor(private readonly svc: WorkplaceService) {}

  @Get(':token')
  @Public()
  @ApiProduces('text/calendar')
  async feed(@Param('token') token: string, @Res() res: Response) {
    const body = await this.svc.feed(token.replace(/\.ics$/, '').slice(0, 100));
    res.setHeader('content-type', 'text/calendar; charset=utf-8');
    res.setHeader('cache-control', 'private, max-age=900');
    res.send(body);
  }
}

@Module({
  imports: [TypeOrmModule.forFeature(WORKPLACE_ENTITIES), OrganisationModule],
  providers: [WorkplaceService],
  controllers: [WorkplaceController, CalendarFeedController],
  exports: [WorkplaceService],
})
export class WorkplaceModule {}
