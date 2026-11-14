import { Controller, Delete, Get, HttpCode, Module, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiHeader, ApiQuery, ApiTags } from '@nestjs/swagger';
import { TypeOrmModule } from '@nestjs/typeorm';
import { z } from 'zod';
import {
  branch, branchQuery, costCentre, costCentreQuery, createBranch, createCostCentre, createDepartment, createJobGrade, createPosition,
  department, departmentQuery, jobGrade, jobGradeQuery, organisation, pageOf, position, positionQuery,
  updateBranch, updateCostCentre, updateDepartment, updateJobGrade, updateOrganisation, updatePosition,
} from '@sil/hr-shared';
import { AccessProfile } from '../../common/access';
import { Access, RequirePermissions } from '../../common/decorators';
import { ApiIfMatch, IfMatch } from '../../common/etag';
import { ZBody, ZQuery, ZResponse } from '../../common/zod';
import { ORGANISATION_ENTITIES } from './organisation.entities';
import { OrganisationService } from './organisation.service';
import { ScopeService } from './scope.service';

const Uuid = () => Param('id', ParseUUIDPipe);
const IdempotencyHeader = () => ApiHeader({ name: 'Idempotency-Key', required: false, description: 'Retries with the same key return the first response' });
type Q<T extends z.ZodType> = z.infer<T>;

/** Structure reads are organisation-wide: the org chart is directory data every system needs. */
@ApiTags('Organisation')
@Controller()
export class OrganisationController {
  constructor(private readonly org: OrganisationService) {}

  @Get('organisation')
  @RequirePermissions('organisation:read')
  @ZResponse(organisation)
  getOrganisation() {
    return this.org.getOrganisation();
  }

  @Patch('organisation')
  @RequirePermissions('organisation:update')
  @ApiIfMatch()
  @ZResponse(organisation)
  updateOrganisation(@ZBody(updateOrganisation) dto: Q<typeof updateOrganisation>, @IfMatch() v: number) {
    return this.org.updateOrganisation(dto, v);
  }

  // ---------------------------------------------------------------- branches
  @Get('branches')
  @RequirePermissions('branch:read')
  @ZResponse(pageOf(branch))
  listBranches(@ZQuery(branchQuery) q: Q<typeof branchQuery>) {
    return this.org.listBranches(q);
  }

  @Get('branches/:id')
  @RequirePermissions('branch:read')
  @ZResponse(branch)
  getBranch(@Uuid() id: string) {
    return this.org.getBranch(id);
  }

  @Post('branches')
  @RequirePermissions('branch:manage')
  @IdempotencyHeader()
  @ZResponse(branch, 201)
  createBranch(@ZBody(createBranch) dto: Q<typeof createBranch>) {
    return this.org.createBranch(dto);
  }

  @Patch('branches/:id')
  @RequirePermissions('branch:manage')
  @ApiIfMatch()
  @ZResponse(branch)
  updateBranch(@Uuid() id: string, @ZBody(updateBranch) dto: Q<typeof updateBranch>, @IfMatch() v: number) {
    return this.org.updateBranch(id, dto, v);
  }

  // ---------------------------------------------------------------- cost centres
  @Get('cost-centres')
  @RequirePermissions('cost_centre:read')
  @ZResponse(pageOf(costCentre))
  listCostCentres(@ZQuery(costCentreQuery) q: Q<typeof costCentreQuery>) {
    return this.org.listCostCentres(q);
  }

  @Get('cost-centres/:id')
  @RequirePermissions('cost_centre:read')
  @ZResponse(costCentre)
  getCostCentre(@Uuid() id: string) {
    return this.org.getCostCentre(id);
  }

  @Post('cost-centres')
  @RequirePermissions('cost_centre:manage')
  @IdempotencyHeader()
  @ZResponse(costCentre, 201)
  createCostCentre(@ZBody(createCostCentre) dto: Q<typeof createCostCentre>) {
    return this.org.createCostCentre(dto);
  }

  @Patch('cost-centres/:id')
  @RequirePermissions('cost_centre:manage')
  @ApiIfMatch()
  @ZResponse(costCentre)
  updateCostCentre(@Uuid() id: string, @ZBody(updateCostCentre) dto: Q<typeof updateCostCentre>, @IfMatch() v: number) {
    return this.org.updateCostCentre(id, dto, v);
  }

  // ---------------------------------------------------------------- departments
  @Get('departments')
  @RequirePermissions('department:read')
  @ZResponse(pageOf(department))
  listDepartments(@ZQuery(departmentQuery) q: Q<typeof departmentQuery>) {
    return this.org.listDepartments(q);
  }

  @Get('departments/tree')
  @RequirePermissions('department:read')
  @ApiQuery({ name: 'branch_id', required: false })
  @ApiQuery({ name: 'include_inactive', required: false, enum: ['true', 'false'] })
  @ZResponse(z.array(department.extend({ children: z.array(z.any()) })))
  tree(@Query('branch_id') branchId?: string, @Query('include_inactive') includeInactive?: string) {
    return this.org.departmentTree({ branchId: branchId && z.uuid().safeParse(branchId).success ? branchId : undefined, includeInactive: includeInactive === 'true' });
  }

  @Get('departments/:id')
  @RequirePermissions('department:read')
  @ZResponse(department)
  getDepartment(@Uuid() id: string) {
    return this.org.getDepartment(id);
  }

  @Post('departments')
  @RequirePermissions('department:manage')
  @IdempotencyHeader()
  @ZResponse(department, 201)
  createDepartment(@Access() access: AccessProfile, @ZBody(createDepartment) dto: Q<typeof createDepartment>) {
    return this.org.createDepartment(access, dto);
  }

  @Patch('departments/:id')
  @RequirePermissions('department:manage')
  @ApiIfMatch()
  @ZResponse(department)
  updateDepartment(@Access() access: AccessProfile, @Uuid() id: string, @ZBody(updateDepartment) dto: Q<typeof updateDepartment>, @IfMatch() v: number) {
    return this.org.updateDepartment(access, id, dto, v);
  }

  @Delete('departments/:id')
  @HttpCode(204)
  @RequirePermissions('department:manage')
  @ApiIfMatch()
  @ZResponse(null, 204, 'Soft-deleted')
  deleteDepartment(@Access() access: AccessProfile, @Uuid() id: string, @IfMatch() v: number) {
    return this.org.deleteDepartment(access, id, v);
  }

  // ---------------------------------------------------------------- job grades
  @Get('job-grades')
  @RequirePermissions('job_grade:read')
  @ZResponse(pageOf(jobGrade))
  listJobGrades(@ZQuery(jobGradeQuery) q: Q<typeof jobGradeQuery>) {
    return this.org.listJobGrades(q);
  }

  @Post('job-grades')
  @RequirePermissions('job_grade:manage')
  @IdempotencyHeader()
  @ZResponse(jobGrade, 201)
  createJobGrade(@ZBody(createJobGrade) dto: Q<typeof createJobGrade>) {
    return this.org.createJobGrade(dto);
  }

  @Patch('job-grades/:id')
  @RequirePermissions('job_grade:manage')
  @ApiIfMatch()
  @ZResponse(jobGrade)
  updateJobGrade(@Uuid() id: string, @ZBody(updateJobGrade) dto: Q<typeof updateJobGrade>, @IfMatch() v: number) {
    return this.org.updateJobGrade(id, dto, v);
  }

  // ---------------------------------------------------------------- positions
  @Get('positions')
  @RequirePermissions('position:read')
  @ZResponse(pageOf(position))
  listPositions(@ZQuery(positionQuery) q: Q<typeof positionQuery>) {
    return this.org.listPositions(q);
  }

  @Get('positions/:id')
  @RequirePermissions('position:read')
  @ZResponse(position)
  getPosition(@Uuid() id: string) {
    return this.org.getPosition(id);
  }

  @Post('positions')
  @RequirePermissions('position:manage')
  @IdempotencyHeader()
  @ZResponse(position, 201)
  createPosition(@Access() access: AccessProfile, @ZBody(createPosition) dto: Q<typeof createPosition>) {
    return this.org.createPosition(access, dto);
  }

  @Patch('positions/:id')
  @RequirePermissions('position:manage')
  @ApiIfMatch()
  @ZResponse(position)
  updatePosition(@Access() access: AccessProfile, @Uuid() id: string, @ZBody(updatePosition) dto: Q<typeof updatePosition>, @IfMatch() v: number) {
    return this.org.updatePosition(access, id, dto, v);
  }
}

@Module({
  imports: [TypeOrmModule.forFeature(ORGANISATION_ENTITIES)],
  providers: [OrganisationService, ScopeService],
  controllers: [OrganisationController],
  exports: [OrganisationService, ScopeService],
})
export class OrganisationModule {}
