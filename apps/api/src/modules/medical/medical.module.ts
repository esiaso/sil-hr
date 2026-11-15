import { Controller, Delete, Get, HttpCode, Module, Param, ParseUUIDPipe, Post, Put, Query, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBody, ApiConsumes, ApiProduces, ApiQuery, ApiTags } from '@nestjs/swagger';
import { TypeOrmModule } from '@nestjs/typeorm';
import type { Response } from 'express';
import { z } from 'zod';
import {
  adjustLimit, applyMedical, claimResult, eligibility, eligibilityQuery, facilityRow, fundingRow, MEDICAL_REPORTS, medicalApplication, medicalCategory, medicalContributionRate, medicalCover,
  medicalLedgerEntry, medicalLimitRule, medicalMember, medicalScheme, medicalSchemeDetail, nearLimitRow, placeHold, postClaim, reverseClaim, upsertMedicalCategory, upsertMedicalContributionRate,
  upsertMedicalLimitRule, upsertMedicalScheme, utilisationRow,
} from '@sil/hr-shared';
import { AccessProfile } from '../../common/access';
import { Access, RequirePermissions } from '../../common/decorators';
import { ApiIfMatch, IfMatch } from '../../common/etag';
import { ZBody, ZQuery, ZResponse } from '../../common/zod';
import { loadEnv } from '../../config/env';
import { badRequest } from '../../common/problem';
import { DocumentsService } from '../documents/documents.module';
import { OrganisationModule } from '../organisation/organisation.module';
import { PayrollModule } from '../payroll/payroll.module';
import { WorkflowModule } from '../workflow/workflow.module';
import { MEDICAL_ENTITIES } from './medical.entities';
import { MedicalReports } from './medical.reports';
import { MedicalService } from './medical.service';

type Q<T extends z.ZodType> = z.infer<T>;
const Id = (n = 'id') => Param(n, ParseUUIDPipe);
const src = (a: AccessProfile) => (a.actorType === 'client' ? 'api' : 'web') as 'api' | 'web';

@ApiTags('Medical scheme: setup')
@Controller('medical/schemes')
export class MedicalSetupController {
  constructor(private readonly medical: MedicalService) {}

  @Get()
  @ZResponse(z.array(medicalScheme), 200, 'Schemes staff can join (anyone signed in)')
  list() {
    return this.medical.schemes();
  }

  @Get(':id')
  @ZResponse(medicalSchemeDetail, 200, 'With categories, dated limits and contribution rates')
  get(@Id() id: string) {
    return this.medical.scheme(id);
  }

  @Post()
  @RequirePermissions('medical_setup:manage')
  @ZResponse(medicalScheme, 201)
  create(@ZBody(upsertMedicalScheme) dto: Q<typeof upsertMedicalScheme>) {
    return this.medical.saveScheme(dto);
  }

  @Put(':id')
  @RequirePermissions('medical_setup:manage')
  @ApiIfMatch()
  @ZResponse(medicalScheme)
  update(@Id() id: string, @ZBody(upsertMedicalScheme) dto: Q<typeof upsertMedicalScheme>, @IfMatch() v: number) {
    return this.medical.saveScheme(dto, id, v);
  }

  @Post(':id/categories')
  @RequirePermissions('medical_setup:manage')
  @ZResponse(medicalCategory, 201)
  addCategory(@Id() id: string, @ZBody(upsertMedicalCategory) dto: Q<typeof upsertMedicalCategory>) {
    return this.medical.saveCategory(id, dto);
  }

  @Put(':id/categories/:cid')
  @RequirePermissions('medical_setup:manage')
  @ApiIfMatch()
  @ZResponse(medicalCategory)
  updateCategory(@Id() id: string, @Id('cid') cid: string, @ZBody(upsertMedicalCategory) dto: Q<typeof upsertMedicalCategory>, @IfMatch() v: number) {
    return this.medical.saveCategory(id, dto, cid, v);
  }

  @Post(':id/limit-rules')
  @RequirePermissions('medical_setup:manage')
  @ZResponse(medicalLimitRule, 201, 'A dated limit; an open-ended limit for the same grade and type closes the day before')
  addRule(@Id() id: string, @ZBody(upsertMedicalLimitRule) dto: Q<typeof upsertMedicalLimitRule>) {
    return this.medical.saveLimitRule(id, dto);
  }

  @Put(':id/limit-rules/:rid')
  @RequirePermissions('medical_setup:manage')
  @ApiIfMatch()
  @ZResponse(medicalLimitRule)
  updateRule(@Id() id: string, @Id('rid') rid: string, @ZBody(upsertMedicalLimitRule) dto: Q<typeof upsertMedicalLimitRule>, @IfMatch() v: number) {
    return this.medical.saveLimitRule(id, dto, rid, v);
  }

  @Delete(':id/limit-rules/:rid')
  @RequirePermissions('medical_setup:manage')
  @HttpCode(204)
  @ZResponse(null, 204)
  async deleteRule(@Id('rid') rid: string) {
    await this.medical.deleteLimitRule(rid);
  }

  @Post(':id/contribution-rates')
  @RequirePermissions('medical_setup:manage')
  @ZResponse(medicalContributionRate, 201)
  addRate(@Id() id: string, @ZBody(upsertMedicalContributionRate) dto: Q<typeof upsertMedicalContributionRate>) {
    return this.medical.saveRate(id, dto);
  }

  @Put(':id/contribution-rates/:rid')
  @RequirePermissions('medical_setup:manage')
  @ApiIfMatch()
  @ZResponse(medicalContributionRate)
  updateRate(@Id() id: string, @Id('rid') rid: string, @ZBody(upsertMedicalContributionRate) dto: Q<typeof upsertMedicalContributionRate>, @IfMatch() v: number) {
    return this.medical.saveRate(id, dto, rid, v);
  }

  @Delete(':id/contribution-rates/:rid')
  @RequirePermissions('medical_setup:manage')
  @HttpCode(204)
  @ZResponse(null, 204)
  async deleteRate(@Id('rid') rid: string) {
    await this.medical.deleteRate(rid);
  }
}

@ApiTags('Medical scheme')
@Controller()
export class MedicalController {
  constructor(
    private readonly medical: MedicalService,
    private readonly reports: MedicalReports,
    private readonly docs: DocumentsService,
  ) {}

  /** Staff attach birth or marriage certificates, or a quote for a planned procedure, to an application. */
  @Post('me/medical/documents')
  @ApiConsumes('multipart/form-data')
  @ApiBody({ schema: { type: 'object', required: ['file'], properties: { file: { type: 'string', format: 'binary' }, title: { type: 'string' } } } as never })
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: loadEnv().maxUploadMb * 1024 * 1024, files: 1 } }))
  @ZResponse(z.object({ id: z.uuid(), title: z.string() }), 201, 'A sensitive document owned by you; quote its id in document_ids')
  async myDocument(@Access() a: AccessProfile, @UploadedFile() file: Express.Multer.File, @Query('title') title?: string) {
    if (!a.employeeId) throw badRequest('no_employee', 'Your account is not linked to an employee record');
    const d = await this.docs.create({ owner_type: 'medical_employee', owner_id: a.employeeId, category: 'medical', title: (title || file?.originalname || 'Medical document').slice(0, 200), is_sensitive: 'true' }, file, a.actorId);
    return { id: d.id, title: d.title };
  }

  /** Billing staff attach the invoice to a claim. */
  @Post('medical/documents')
  @RequirePermissions('medical_claim:write')
  @ApiConsumes('multipart/form-data')
  @ApiBody({ schema: { type: 'object', required: ['file'], properties: { file: { type: 'string', format: 'binary' }, title: { type: 'string' } } } as never })
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: loadEnv().maxUploadMb * 1024 * 1024, files: 1 } }))
  @ZResponse(z.object({ id: z.uuid(), title: z.string() }), 201, 'Quote the id as document_id on the claim')
  async invoice(@Access() a: AccessProfile, @UploadedFile() file: Express.Multer.File, @Query('title') title?: string) {
    const d = await this.docs.create({ owner_type: 'medical_invoice', category: 'medical', title: (title || file?.originalname || 'Invoice').slice(0, 200), is_sensitive: 'true' }, file, a.actorId);
    return { id: d.id, title: d.title };
  }

  // ---------------------------------------------------------------- self-service
  @Get('me/medical')
  @ZResponse(z.object({ memberships: z.array(medicalCover), applications: z.array(medicalApplication) }))
  mine(@Access() a: AccessProfile) {
    return this.medical.myCover(a);
  }

  @Post('me/medical/applications')
  @ZResponse(medicalApplication, 201, 'Goes to the medical scheme approval workflow (HR officer, then HR manager)')
  apply(@Access() a: AccessProfile, @ZBody(applyMedical) dto: Q<typeof applyMedical>) {
    return this.medical.apply(a, dto);
  }

  // ---------------------------------------------------------------- HR
  @Get('medical/members')
  @RequirePermissions('medical:read')
  @ZResponse(z.array(medicalMember))
  members(@Access() a: AccessProfile, @ZQuery(z.object({ scheme_id: z.uuid().optional(), search: z.string().max(100).optional(), status: z.enum(['active', 'ended']).optional() })) q: { scheme_id?: string; search?: string; status?: string }) {
    return this.medical.members(a, q);
  }

  @Get('medical/members/:id/ledger')
  @RequirePermissions('medical:lookup')
  @ZResponse(z.array(medicalLedgerEntry), 200, 'Usage of the member and their family, newest first')
  async ledger(@Access() a: AccessProfile, @Id() id: string) {
    await this.medical.coverAudited(a, id);
    return this.medical.ledger(id);
  }

  @Post('medical/members/:id/adjustments')
  @RequirePermissions('medical_setup:manage')
  @ZResponse(medicalLedgerEntry, 201, 'A positive amount uses limit, a negative one gives it back; the reason is required')
  adjust(@Access() a: AccessProfile, @Id() id: string, @ZBody(adjustLimit) dto: Q<typeof adjustLimit>) {
    return this.medical.adjust(a, id, dto);
  }

  @Get('medical/applications')
  @RequirePermissions('medical:read')
  @ZResponse(z.array(medicalApplication))
  applications(@ZQuery(z.object({ status: z.enum(['pending', 'approved', 'rejected', 'returned', 'cancelled']).optional(), employee_id: z.uuid().optional() })) q: { status?: string; employee_id?: string }) {
    return this.medical.applications(q);
  }

  // ---------------------------------------------------------------- billing and HMIS
  @Get('medical/lookup')
  @RequirePermissions('medical:lookup')
  @ZResponse(z.array(medicalMember), 200, 'By member number, staff number or name (staff or dependant). Audited.')
  lookup(@Access() a: AccessProfile, @Query('q') q: string) {
    return this.medical.lookup(a, q ?? '');
  }

  @Get('medical/members/:id/cover')
  @RequirePermissions('medical:lookup')
  @ZResponse(medicalCover, 200, 'Cover, remaining limits and active holds. No pay or HR data. Audited.')
  cover(@Access() a: AccessProfile, @Id() id: string) {
    return this.medical.coverAudited(a, id);
  }

  @Get('medical/eligibility')
  @RequirePermissions('medical:lookup')
  @ZResponse(eligibility, 200, 'For billing systems: is this member covered (for this category) on this date, and how much is left?')
  eligibility(@ZQuery(eligibilityQuery) q: Q<typeof eligibilityQuery>) {
    return this.medical.eligibility(q);
  }

  @Post('medical/claims')
  @RequirePermissions('medical_claim:write')
  @ZResponse(claimResult, 201, 'Posted, or sent for approval when over the limit or inside a waiting period (scheme setting). Send an Idempotency-Key.')
  claim(@Access() a: AccessProfile, @ZBody(postClaim) dto: Q<typeof postClaim>) {
    return this.medical.postClaim(a, dto, src(a));
  }

  @Post('medical/claims/:id/reverse')
  @RequirePermissions('medical_claim:write')
  @ZResponse(medicalLedgerEntry, 201, 'A reversal entry; the claim itself never changes')
  reverse(@Access() a: AccessProfile, @Id() id: string, @ZBody(reverseClaim) dto: Q<typeof reverseClaim>) {
    return this.medical.reverse(a, id, dto.reason, src(a));
  }

  @Post('medical/holds')
  @RequirePermissions('medical_claim:write')
  @ZResponse(medicalLedgerEntry, 201, 'Holds an amount of the limit until it is claimed, released or expires')
  hold(@Access() a: AccessProfile, @ZBody(placeHold) dto: Q<typeof placeHold>) {
    return this.medical.placeHold(a, dto, src(a));
  }

  @Post('medical/holds/:id/release')
  @RequirePermissions('medical_claim:write')
  @ZResponse(medicalLedgerEntry, 201)
  release(@Access() a: AccessProfile, @Id() id: string, @ZBody(reverseClaim) dto: Q<typeof reverseClaim>) {
    return this.medical.releaseHold(a, id, dto.reason, src(a));
  }

  // ---------------------------------------------------------------- reports
  @Get('medical/reports/utilisation')
  @RequirePermissions('medical:read')
  @ZResponse(z.array(utilisationRow))
  utilisation(@Query('scheme_id') schemeId?: string) {
    return this.reports.utilisation(schemeId || undefined);
  }

  @Get('medical/reports/near-limit')
  @RequirePermissions('medical:read')
  @ZResponse(z.array(nearLimitRow))
  nearLimit(@ZQuery(z.object({ threshold: z.coerce.number().min(0).max(100).default(80), scheme_id: z.uuid().optional() })) q: { threshold: number; scheme_id?: string }) {
    return this.reports.nearLimit(q.threshold, q.scheme_id);
  }

  @Get('medical/reports/facilities')
  @RequirePermissions('medical:read')
  @ZResponse(z.array(facilityRow))
  facilities(@ZQuery(z.object({ from: z.iso.date(), to: z.iso.date() })) q: { from: string; to: string }) {
    return this.reports.facilities(q.from, q.to);
  }

  @Get('medical/reports/funding')
  @RequirePermissions('medical:read')
  @ZResponse(z.array(fundingRow), 200, 'Per month: claims paid by the hospital and staff contributions from approved payrolls')
  funding(@ZQuery(z.object({ from: z.string().regex(/^\d{4}-\d{2}$/), to: z.string().regex(/^\d{4}-\d{2}$/) })) q: { from: string; to: string }) {
    return this.reports.funding(q.from, q.to);
  }

  @Get('medical/reports/export')
  @RequirePermissions('medical:read')
  @ApiProduces('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  @ApiQuery({ name: 'report', enum: Object.keys(MEDICAL_REPORTS) })
  async export(@Query('report') report: string, @Query('scheme_id') schemeId: string | undefined, @Query('from') from: string | undefined, @Query('to') to: string | undefined, @Res() res: Response) {
    const f = await this.reports.export(report, { scheme_id: schemeId || undefined, from, to });
    res.setHeader('content-type', f.mimeType);
    res.setHeader('content-disposition', `attachment; filename="${f.fileName}"`);
    res.setHeader('cache-control', 'no-store');
    res.send(f.body);
  }
}

@Module({
  imports: [TypeOrmModule.forFeature(MEDICAL_ENTITIES), OrganisationModule, WorkflowModule, PayrollModule],
  providers: [MedicalService, MedicalReports],
  controllers: [MedicalSetupController, MedicalController],
  exports: [MedicalService],
})
export class MedicalModule {}
