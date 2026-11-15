import { Controller, Get, HttpCode, Module, Param, ParseUUIDPipe, Post, Put, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBody, ApiConsumes, ApiProduces, ApiTags } from '@nestjs/swagger';
import { TypeOrmModule } from '@nestjs/typeorm';
import type { Response } from 'express';
import { z } from 'zod';
import {
  cpdClaimFields, cpdComplianceRow, cpdDecision, cpdEntry, cpdRequirement, enrolment, enrolStaff, mandatoryCompliance, myCpd, myTraining, programme, recordAttendance, requestPlace, session, sessionDetail, setCpdRequirements,
  trainingFeedback, upsertProgramme, upsertSession,
} from '@sil/hr-shared';
import { AccessProfile } from '../../common/access';
import { Access, RequirePermissions } from '../../common/decorators';
import { ApiIfMatch, IfMatch } from '../../common/etag';
import { ZBody, ZQuery, ZResponse } from '../../common/zod';
import { loadEnv } from '../../config/env';
import { OrganisationModule } from '../organisation/organisation.module';
import { WorkflowModule } from '../workflow/workflow.module';
import { TRAINING_ENTITIES } from './training.entities';
import { TrainingService } from './training.service';

type Q<T extends z.ZodType> = z.infer<T>;
const Id = (n = 'id') => Param(n, ParseUUIDPipe);
const yearQ = z.object({ year: z.coerce.number().int().min(2000).max(2100).optional() });
const thisYear = () => new Date().getFullYear();

@ApiTags('Training')
@Controller()
export class TrainingController {
  constructor(private readonly training: TrainingService) {}

  // ---------------------------------------------------------------- programmes
  @Get('training/programmes')
  @ZResponse(z.array(programme), 200, 'The training catalogue (anyone signed in)')
  programmes(@ZQuery(z.object({ status: z.enum(['active', 'inactive']).optional() })) q: { status?: string }) {
    return this.training.programmes(q);
  }

  @Post('training/programmes')
  @RequirePermissions('training:manage')
  @ZResponse(programme, 201)
  createProgramme(@ZBody(upsertProgramme) dto: Q<typeof upsertProgramme>) {
    return this.training.saveProgramme(dto);
  }

  @Put('training/programmes/:id')
  @RequirePermissions('training:manage')
  @ApiIfMatch()
  @ZResponse(programme)
  updateProgramme(@Id() id: string, @ZBody(upsertProgramme) dto: Q<typeof upsertProgramme>, @IfMatch() v: number) {
    return this.training.saveProgramme(dto, id, v);
  }

  // ---------------------------------------------------------------- sessions
  @Get('training/sessions')
  @RequirePermissions('training:read')
  @ZResponse(z.array(session))
  sessions(@ZQuery(z.object({ programme_id: z.uuid().optional(), status: z.enum(['scheduled', 'completed', 'cancelled']).optional(), from: z.iso.date().optional() })) q: { programme_id?: string; status?: string; from?: string }) {
    return this.training.sessions(q);
  }

  @Post('training/sessions')
  @RequirePermissions('training:manage')
  @ZResponse(session, 201)
  createSession(@ZBody(upsertSession) dto: Q<typeof upsertSession>) {
    return this.training.saveSession(dto);
  }

  @Get('training/sessions/:id')
  @RequirePermissions('training:read')
  @ZResponse(sessionDetail, 200, 'Attendees are limited to your training:read scope')
  session(@Access() a: AccessProfile, @Id() id: string) {
    return this.training.session(a, id);
  }

  @Put('training/sessions/:id')
  @RequirePermissions('training:manage')
  @ApiIfMatch()
  @ZResponse(session)
  updateSession(@Id() id: string, @ZBody(upsertSession) dto: Q<typeof upsertSession>, @IfMatch() v: number) {
    return this.training.saveSession(dto, id, v);
  }

  @Post('training/sessions/:id/cancel')
  @RequirePermissions('training:manage')
  @HttpCode(200)
  @ZResponse(session, 200, 'Everyone enrolled is told')
  cancel(@Id() id: string) {
    return this.training.cancelSession(id);
  }

  @Post('training/sessions/:id/enrol')
  @RequirePermissions('training:manage')
  @HttpCode(200)
  @ZResponse(sessionDetail, 200, 'Enrols staff directly (no approval); they are notified')
  enrol(@Access() a: AccessProfile, @Id() id: string, @ZBody(enrolStaff) dto: Q<typeof enrolStaff>) {
    return this.training.enrol(a, id, dto.employee_ids);
  }

  @Post('training/sessions/:id/attendance')
  @RequirePermissions('training:manage')
  @HttpCode(200)
  @ZResponse(sessionDetail, 200, 'Attended (and passed, when there is a pass mark) completes the training and credits CPD points')
  attendance(@Access() a: AccessProfile, @Id() id: string, @ZBody(recordAttendance) dto: Q<typeof recordAttendance>) {
    return this.training.recordAttendance(a, id, dto);
  }

  @Post('training/sessions/:id/complete')
  @RequirePermissions('training:manage')
  @HttpCode(200)
  @ZResponse(sessionDetail, 200, 'Closes the session once everyone’s attendance is recorded')
  complete(@Access() a: AccessProfile, @Id() id: string) {
    return this.training.completeSession(a, id);
  }

  @Get('training/compliance')
  @RequirePermissions('training:read')
  @ZResponse(mandatoryCompliance, 200, 'Mandatory training: who is current, due within 60 days, overdue or has never done it')
  compliance(@Access() a: AccessProfile) {
    return this.training.mandatoryCompliance(a);
  }

  // ---------------------------------------------------------------- self-service
  @Get('me/training')
  @ZResponse(myTraining, 200, 'Your sessions, your mandatory training and sessions you can ask to join')
  mine(@Access() a: AccessProfile) {
    return this.training.myTraining(a);
  }

  @Post('training/sessions/:id/request')
  @ZResponse(enrolment, 201, 'Asks for a place; goes to the TRAINING approval workflow (funded sessions also need HR)')
  request(@Access() a: AccessProfile, @Id() id: string, @ZBody(requestPlace) dto: Q<typeof requestPlace>) {
    return this.training.requestPlace(a, id, dto.reason ?? null);
  }

  @Post('training/enrolments/:id/withdraw')
  @HttpCode(200)
  @ZResponse(enrolment, 200, 'Your own place (or anyone’s, with training:manage) before the session')
  withdraw(@Access() a: AccessProfile, @Id() id: string) {
    return this.training.withdraw(a, id);
  }

  @Put('training/enrolments/:id/feedback')
  @ZResponse(enrolment, 200, 'Your rating of a session you attended')
  feedback(@Access() a: AccessProfile, @Id() id: string, @ZBody(trainingFeedback) dto: Q<typeof trainingFeedback>) {
    return this.training.feedback(a, id, dto);
  }

  // ---------------------------------------------------------------- CPD
  @Get('me/cpd')
  @ZResponse(myCpd, 200, 'Your CPD points for a calendar year (default: this year)')
  myCpd(@Access() a: AccessProfile, @ZQuery(yearQ) q: { year?: number }) {
    return this.training.myCpd(a, q.year ?? thisYear());
  }

  @Post('me/cpd')
  @ApiConsumes('multipart/form-data')
  @ApiBody({ schema: { type: 'object', required: ['title', 'activity_date', 'points'], properties: { title: { type: 'string' }, provider: { type: 'string' }, activity_date: { type: 'string', format: 'date' }, points: { type: 'string' }, licensing_body: { type: 'string' }, evidence: { type: 'string', format: 'binary' } } } as never })
  @UseInterceptors(FileInterceptor('evidence', { limits: { fileSize: Math.min(loadEnv().maxUploadMb, 10) * 1024 * 1024, files: 1 } }))
  @ZResponse(cpdEntry, 201, 'Claims points for an outside activity (conference, CME, online course); HR verifies it')
  claim(@Access() a: AccessProfile, @ZBody(cpdClaimFields) fields: Q<typeof cpdClaimFields>, @UploadedFile() file: Express.Multer.File | undefined) {
    return this.training.claimCpd(a, fields, file);
  }

  @Get('training/cpd')
  @RequirePermissions('training:read')
  @ZResponse(z.array(cpdEntry))
  cpd(@Access() a: AccessProfile, @ZQuery(z.object({ status: z.enum(['pending', 'verified', 'rejected']).optional(), employee_id: z.uuid().optional() })) q: { status?: string; employee_id?: string }) {
    return this.training.cpdEntries(a, q);
  }

  @Post('training/cpd/:id/decision')
  @RequirePermissions('cpd:verify')
  @HttpCode(200)
  @ZResponse(cpdEntry)
  decide(@Access() a: AccessProfile, @Id() id: string, @ZBody(cpdDecision) dto: Q<typeof cpdDecision>) {
    return this.training.decideCpd(a, id, dto);
  }

  @Get('training/cpd/:id/evidence')
  @ApiProduces('application/pdf', 'image/png', 'image/jpeg')
  async evidence(@Access() a: AccessProfile, @Id() id: string, @Res() res: Response) {
    const f = await this.training.cpdEvidence(a, id);
    res.setHeader('content-type', f.mimeType);
    res.setHeader('content-disposition', `attachment; filename="${f.fileName.replace(/["\\\r\n]/g, '_')}"`);
    res.setHeader('cache-control', 'no-store');
    res.send(f.body);
  }

  @Get('training/cpd-compliance')
  @RequirePermissions('training:read')
  @ZResponse(z.array(cpdComplianceRow), 200, 'Licensed staff: verified points for the year against their licensing body’s requirement')
  cpdCompliance(@Access() a: AccessProfile, @ZQuery(yearQ) q: { year?: number }) {
    return this.training.cpdCompliance(a, q.year ?? thisYear());
  }

  @Get('training/cpd-requirements')
  @RequirePermissions('training:read')
  @ZResponse(z.array(cpdRequirement))
  requirements() {
    return this.training.requirements();
  }

  @Put('training/cpd-requirements')
  @RequirePermissions('training:manage')
  @ZResponse(z.array(cpdRequirement), 200, 'Replaces the list (audited)')
  setRequirements(@ZBody(setCpdRequirements) dto: Q<typeof setCpdRequirements>) {
    return this.training.setRequirements(dto);
  }
}

@Module({
  imports: [TypeOrmModule.forFeature(TRAINING_ENTITIES), OrganisationModule, WorkflowModule],
  providers: [TrainingService],
  controllers: [TrainingController],
  exports: [TrainingService],
})
export class TrainingModule {}
