import { Controller, Get, HttpCode, Module, Param, ParseUUIDPipe, Post, Put, Req, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBody, ApiConsumes, ApiProduces, ApiTags } from '@nestjs/swagger';
import { TypeOrmModule } from '@nestjs/typeorm';
import type { Request, Response } from 'express';
import { z } from 'zod';
import {
  addCandidate, application, applicationDetail, careersApplicationFields, careersApplicationResult, createAssessment, createOffer, createRequisition, interviewFeedback, moveApplication, myInterview, offer,
  posting, publicPosting, requisition, respondOffer, scheduleInterview, updateInterview, upsertPosting,
} from '@sil/hr-shared';
import { AccessProfile } from '../../common/access';
import { Access, Public, RequirePermissions } from '../../common/decorators';
import { ApiIfMatch, IfMatch } from '../../common/etag';
import { ZBody, ZQuery, ZResponse } from '../../common/zod';
import { loadEnv } from '../../config/env';
import { EmployeesModule } from '../employees/employees.module';
import { LifecycleModule } from '../lifecycle/lifecycle.module';
import { OrganisationModule } from '../organisation/organisation.module';
import { PayrollModule } from '../payroll/payroll.module';
import { WorkflowModule } from '../workflow/workflow.module';
import { RECRUITMENT_ENTITIES } from './recruitment.entities';
import { RecruitmentService } from './recruitment.service';

type Q<T extends z.ZodType> = z.infer<T>;
const Id = (n = 'id') => Param(n, ParseUUIDPipe);
const sendFile = (res: Response, f: { body: Buffer; fileName: string; mimeType: string }) => {
  res.setHeader('content-type', f.mimeType);
  res.setHeader('content-disposition', `attachment; filename="${f.fileName.replace(/["\\\r\n]/g, '_')}"`);
  res.setHeader('cache-control', 'no-store');
  res.send(f.body);
};

/** The public careers site: no sign-in. */
@ApiTags('Careers (public)')
@Controller('careers')
export class CareersController {
  constructor(private readonly rec: RecruitmentService) {}

  @Get('jobs')
  @Public()
  @ZResponse(z.array(publicPosting), 200, 'Open jobs (published, not internal, closing date not passed)')
  jobs() {
    return this.rec.publicJobs();
  }

  @Get('jobs/:slug')
  @Public()
  @ZResponse(publicPosting)
  job(@Param('slug') slug: string) {
    return this.rec.publicJob(slug);
  }

  @Post('jobs/:slug/applications')
  @Public()
  @ApiConsumes('multipart/form-data')
  @ApiBody({ schema: { type: 'object', required: ['first_name', 'last_name', 'email', 'phone', 'consent', 'cv'], properties: { first_name: { type: 'string' }, last_name: { type: 'string' }, email: { type: 'string' }, phone: { type: 'string' }, location: { type: 'string' }, cover_note: { type: 'string' }, answers: { type: 'string', description: 'JSON object of answers' }, consent: { type: 'string', enum: ['true'] }, cv: { type: 'string', format: 'binary' } } } as never })
  @UseInterceptors(FileInterceptor('cv', { limits: { fileSize: Math.min(loadEnv().maxUploadMb, 10) * 1024 * 1024, files: 1 } }))
  @ZResponse(careersApplicationResult, 201, 'At most five applications an hour from one address')
  apply(@Param('slug') slug: string, @ZBody(careersApplicationFields) fields: Q<typeof careersApplicationFields>, @UploadedFile() cv: Express.Multer.File | undefined, @Req() req: Request) {
    return this.rec.publicApply(slug, fields, cv, req.ip);
  }
}

@ApiTags('Recruitment')
@Controller()
export class RecruitmentController {
  constructor(private readonly rec: RecruitmentService) {}

  // ---------------------------------------------------------------- requisitions
  @Get('requisitions')
  @ZResponse(z.array(requisition), 200, 'Yours and those in your scope (requisition:read or requisition:request)')
  requisitions(@Access() a: AccessProfile, @ZQuery(z.object({ status: z.string().max(12).optional() })) q: { status?: string }) {
    return this.rec.requisitions(a, q);
  }

  @Post('requisitions')
  @RequirePermissions('requisition:request')
  @ZResponse(requisition, 201, 'Goes to the REQUISITION approval workflow')
  createRequisition(@Access() a: AccessProfile, @ZBody(createRequisition) dto: Q<typeof createRequisition>) {
    return this.rec.createRequisition(a, dto);
  }

  @Post('requisitions/:id/cancel')
  @RequirePermissions('recruitment:manage')
  @HttpCode(200)
  @ZResponse(requisition)
  cancel(@Id() id: string) {
    return this.rec.cancelRequisition(id);
  }

  // ---------------------------------------------------------------- postings
  @Get('job-postings')
  @RequirePermissions('recruitment:manage')
  @ZResponse(z.array(posting))
  postings(@ZQuery(z.object({ status: z.enum(['draft', 'published', 'closed']).optional() })) q: { status?: string }) {
    return this.rec.postings(q);
  }

  @Post('job-postings')
  @RequirePermissions('recruitment:manage')
  @ZResponse(posting, 201)
  createPosting(@ZBody(upsertPosting) dto: Q<typeof upsertPosting>) {
    return this.rec.savePosting(dto);
  }

  @Put('job-postings/:id')
  @RequirePermissions('recruitment:manage')
  @ApiIfMatch()
  @ZResponse(posting)
  updatePosting(@Id() id: string, @ZBody(upsertPosting) dto: Q<typeof upsertPosting>, @IfMatch() v: number) {
    return this.rec.savePosting(dto, id, v);
  }

  // ---------------------------------------------------------------- applications
  @Get('job-applications')
  @RequirePermissions('recruitment:manage')
  @ZResponse(z.array(application))
  applications(@ZQuery(z.object({ posting_id: z.uuid().optional(), stage: z.string().max(12).optional() })) q: { posting_id?: string; stage?: string }) {
    return this.rec.applications(q);
  }

  @Post('job-applications')
  @RequirePermissions('recruitment:manage')
  @ZResponse(application, 201, 'Adds an internal, referred or agency candidate')
  add(@ZBody(addCandidate) dto: Q<typeof addCandidate>) {
    return this.rec.addCandidate(dto);
  }

  @Get('job-applications/:id')
  @RequirePermissions('recruitment:manage')
  @ZResponse(applicationDetail)
  application(@Id() id: string) {
    return this.rec.application(id);
  }

  @Get('job-applications/:id/cv')
  @RequirePermissions('recruitment:manage')
  @ApiProduces('application/pdf')
  async cv(@Id() id: string, @Res() res: Response) {
    sendFile(res, await this.rec.cv(id));
  }

  @Post('job-applications/:id/stage')
  @RequirePermissions('recruitment:manage')
  @HttpCode(200)
  @ZResponse(application)
  move(@Id() id: string, @ZBody(moveApplication) dto: Q<typeof moveApplication>) {
    return this.rec.move(id, dto);
  }

  @Post('job-applications/:id/interviews')
  @RequirePermissions('recruitment:manage')
  @ZResponse(z.object({ id: z.uuid() }), 201, 'The panel is notified')
  async schedule(@Id() id: string, @ZBody(scheduleInterview) dto: Q<typeof scheduleInterview>) {
    return { id: await this.rec.schedule(id, dto) };
  }

  @Get('recruitment/panel-members')
  @RequirePermissions('recruitment:manage')
  @ZResponse(z.array(z.object({ id: z.uuid(), display_name: z.string() })), 200, 'Active users who can sit on an interview panel')
  panelMembers() {
    return this.rec.panelMembers();
  }

  @Put('interviews/:id')
  @RequirePermissions('recruitment:manage')
  @ZResponse(applicationDetail)
  updateInterview(@Id() id: string, @ZBody(updateInterview) dto: Q<typeof updateInterview>) {
    return this.rec.updateInterview(id, dto.status);
  }

  @Post('job-applications/:id/assessments')
  @RequirePermissions('recruitment:manage')
  @ZResponse(applicationDetail, 201)
  assessment(@Id() id: string, @ZBody(createAssessment) dto: Q<typeof createAssessment>) {
    return this.rec.addAssessment(id, dto);
  }

  // ---------------------------------------------------------------- panel members
  @Get('me/interviews')
  @ZResponse(z.array(myInterview), 200, 'Interviews you sit on (last 30 days and upcoming)')
  myInterviews(@Access() a: AccessProfile) {
    return this.rec.myInterviews(a);
  }

  @Put('interviews/:id/feedback')
  @ZResponse(z.object({ ok: z.boolean() }), 200, 'Panel members only')
  feedback(@Access() a: AccessProfile, @Id() id: string, @ZBody(interviewFeedback) dto: Q<typeof interviewFeedback>) {
    return this.rec.feedback(a, id, dto);
  }

  @Get('interviews/:id/cv')
  @ApiProduces('application/pdf')
  async panelCv(@Access() a: AccessProfile, @Id() id: string, @Res() res: Response) {
    sendFile(res, await this.rec.panelCv(a, id));
  }

  // ---------------------------------------------------------------- offers
  @Post('job-applications/:id/offers')
  @RequirePermissions('offer:manage')
  @ZResponse(offer, 201, 'Goes to the OFFER approval workflow; approval produces the offer letter')
  createOffer(@Access() a: AccessProfile, @Id() id: string, @ZBody(createOffer) dto: Q<typeof createOffer>) {
    return this.rec.createOffer(a, id, dto);
  }

  @Get('job-offers/:id/letter')
  @RequirePermissions('offer:manage')
  @ApiProduces('application/pdf')
  async letter(@Id() id: string, @Res() res: Response) {
    sendFile(res, await this.rec.offerLetter(id));
  }

  @Post('job-offers/:id/response')
  @RequirePermissions('offer:manage')
  @HttpCode(200)
  @ZResponse(offer, 200, 'Accepted: the candidate becomes an employee from the start date (record, contract, salary, onboarding)')
  respond(@Access() a: AccessProfile, @Id() id: string, @ZBody(respondOffer) dto: Q<typeof respondOffer>) {
    return this.rec.respond(a, id, dto);
  }

}

@Module({
  imports: [TypeOrmModule.forFeature(RECRUITMENT_ENTITIES), OrganisationModule, WorkflowModule, EmployeesModule, LifecycleModule, PayrollModule],
  providers: [RecruitmentService],
  controllers: [CareersController, RecruitmentController],
})
export class RecruitmentModule {}
