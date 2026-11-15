import { Controller, Get, HttpCode, Module, Param, ParseUUIDPipe, Post, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { TypeOrmModule } from '@nestjs/typeorm';
import { z } from 'zod';
import {
  acknowledgeReview, calibrate, createCycle, cycleReport, cycleStatusChange, goalProgress, indicator, managerReview, reassignReviewer, review, reviewCycle, reviewSummary, selfReview, upsertGoal, upsertIndicator,
} from '@sil/hr-shared';
import { AccessProfile } from '../../common/access';
import { Access, RequirePermissions } from '../../common/decorators';
import { ApiIfMatch, IfMatch } from '../../common/etag';
import { ZBody, ZQuery, ZResponse } from '../../common/zod';
import { OrganisationModule } from '../organisation/organisation.module';
import { WorkflowModule } from '../workflow/workflow.module';
import { PERFORMANCE_ENTITIES } from './performance.entities';
import { PerformanceService } from './performance.service';

type Q<T extends z.ZodType> = z.infer<T>;
const Id = (n = 'id') => Param(n, ParseUUIDPipe);

@ApiTags('Performance')
@Controller()
export class PerformanceController {
  constructor(private readonly perf: PerformanceService) {}

  // ---------------------------------------------------------------- indicators
  @Get('performance/indicators')
  @ZResponse(z.array(indicator), 200, 'The indicator (KPI) library; anyone signed in can read it to pick goals')
  indicators(@ZQuery(z.object({ status: z.enum(['active', 'inactive']).optional() })) q: { status?: string }) {
    return this.perf.indicators(q);
  }

  @Post('performance/indicators')
  @RequirePermissions('performance:manage')
  @ZResponse(indicator, 201)
  createIndicator(@ZBody(upsertIndicator) dto: Q<typeof upsertIndicator>) {
    return this.perf.saveIndicator(dto);
  }

  @Put('performance/indicators/:id')
  @RequirePermissions('performance:manage')
  @ApiIfMatch()
  @ZResponse(indicator)
  updateIndicator(@Id() id: string, @ZBody(upsertIndicator) dto: Q<typeof upsertIndicator>, @IfMatch() v: number) {
    return this.perf.saveIndicator(dto, id, v);
  }

  // ---------------------------------------------------------------- cycles
  @Get('performance/cycles')
  @RequirePermissions('performance:read')
  @ZResponse(z.array(reviewCycle))
  cycles() {
    return this.perf.cycles();
  }

  @Post('performance/cycles')
  @RequirePermissions('performance:manage')
  @ZResponse(reviewCycle, 201, 'Created as a draft; launch it to create the reviews')
  createCycle(@ZBody(createCycle) dto: Q<typeof createCycle>) {
    return this.perf.createCycle(dto);
  }

  @Get('performance/cycles/:id')
  @RequirePermissions('performance:read')
  @ZResponse(reviewCycle)
  cycle(@Id() id: string) {
    return this.perf.cycle(id);
  }

  @Post('performance/cycles/:id/status')
  @RequirePermissions('performance:manage')
  @HttpCode(200)
  @ZResponse(reviewCycle, 200, 'goal_setting launches the cycle (one review per active employee); reviewing opens self-reviews; closed stops new submissions')
  cycleStatus(@Id() id: string, @ZBody(cycleStatusChange) dto: Q<typeof cycleStatusChange>) {
    return this.perf.changeCycleStatus(id, dto.status);
  }

  @Post('performance/cycles/:id/reviews')
  @RequirePermissions('performance:manage')
  @ZResponse(z.object({ id: z.uuid() }), 201, 'Adds a review for someone who joined after the launch')
  async addReview(@Id() id: string, @ZBody(z.object({ employee_id: z.uuid() })) dto: { employee_id: string }) {
    return { id: await this.perf.addReview(id, dto.employee_id) };
  }

  @Get('performance/cycles/:id/report')
  @RequirePermissions('performance:read')
  @ZResponse(cycleReport, 200, 'Rating distribution (approved reviews) and completion by department')
  report(@Id() id: string) {
    return this.perf.cycleReport(id);
  }

  // ---------------------------------------------------------------- reviews
  @Get('performance/reviews')
  @RequirePermissions('performance:read')
  @ZResponse(z.array(reviewSummary), 200, 'Reviews of staff in your performance:read scope')
  reviews(@Access() a: AccessProfile, @ZQuery(z.object({ cycle_id: z.uuid().optional(), status: z.string().max(16).optional() })) q: { cycle_id?: string; status?: string }) {
    return this.perf.reviews(a, q);
  }

  @Get('me/reviews')
  @ZResponse(z.array(reviewSummary), 200, 'Your own appraisals')
  mine(@Access() a: AccessProfile) {
    return this.perf.myReviews(a);
  }

  @Get('me/team-reviews')
  @ZResponse(z.array(reviewSummary), 200, 'Appraisals you write as the reviewer')
  team(@Access() a: AccessProfile) {
    return this.perf.teamReviews(a);
  }

  @Get('performance/reviews/:id')
  @ZResponse(review, 200, 'The employee, their reviewer and performance:read holders in scope. The employee sees the manager’s assessment once approved.')
  review(@Access() a: AccessProfile, @Id() id: string) {
    return this.perf.review(a, id);
  }

  @Put('performance/reviews/:id/reviewer')
  @RequirePermissions('performance:manage')
  @ZResponse(review)
  reassign(@Access() a: AccessProfile, @Id() id: string, @ZBody(reassignReviewer) dto: Q<typeof reassignReviewer>) {
    return this.perf.reassign(a, id, dto.reviewer_user_id);
  }

  @Post('performance/reviews/:id/goals')
  @ZResponse(review, 201, 'The employee or the reviewer proposes a goal (goal setting only)')
  addGoal(@Access() a: AccessProfile, @Id() id: string, @ZBody(upsertGoal) dto: Q<typeof upsertGoal>) {
    return this.perf.addGoal(a, id, dto);
  }

  @Put('performance/goals/:id')
  @ApiIfMatch()
  @ZResponse(review, 200, 'A changed goal needs agreeing again')
  updateGoal(@Access() a: AccessProfile, @Id() id: string, @ZBody(upsertGoal) dto: Q<typeof upsertGoal>, @IfMatch() v: number) {
    return this.perf.updateGoal(a, id, dto, v);
  }

  @Post('performance/goals/:id/drop')
  @HttpCode(200)
  @ZResponse(review)
  dropGoal(@Access() a: AccessProfile, @Id() id: string) {
    return this.perf.dropGoal(a, id);
  }

  @Post('performance/goals/:id/progress')
  @HttpCode(200)
  @ZResponse(review)
  progress(@Access() a: AccessProfile, @Id() id: string, @ZBody(goalProgress) dto: Q<typeof goalProgress>) {
    return this.perf.goalProgress(a, id, dto);
  }

  @Post('performance/reviews/:id/agree-goals')
  @HttpCode(200)
  @ZResponse(review, 200, 'The reviewer agrees the goals; their weights must add up to 100')
  agree(@Access() a: AccessProfile, @Id() id: string) {
    return this.perf.agreeGoals(a, id);
  }

  @Put('performance/reviews/:id/self')
  @ZResponse(review, 200, 'Saves the self-review; submit=true sends it to the reviewer')
  self(@Access() a: AccessProfile, @Id() id: string, @ZBody(selfReview) dto: Q<typeof selfReview>) {
    return this.perf.saveSelf(a, id, dto);
  }

  @Put('performance/reviews/:id/manager')
  @ZResponse(review, 200, 'Saves the manager assessment; submit=true sends it to the PERFORMANCE approval workflow')
  manager(@Access() a: AccessProfile, @Id() id: string, @ZBody(managerReview) dto: Q<typeof managerReview>) {
    return this.perf.saveManager(a, id, dto);
  }

  @Put('performance/reviews/:id/calibration')
  @RequirePermissions('performance:manage')
  @ZResponse(review, 200, 'Sets the final rating while the review is with the approvers (audited)')
  calibrate(@Access() a: AccessProfile, @Id() id: string, @ZBody(calibrate) dto: Q<typeof calibrate>) {
    return this.perf.calibrate(a, id, dto);
  }

  @Post('performance/reviews/:id/acknowledge')
  @HttpCode(200)
  @ZResponse(review, 200, 'The employee has read the approved review, and agrees or says why not')
  acknowledge(@Access() a: AccessProfile, @Id() id: string, @ZBody(acknowledgeReview) dto: Q<typeof acknowledgeReview>) {
    return this.perf.acknowledge(a, id, dto);
  }
}

@Module({
  imports: [TypeOrmModule.forFeature(PERFORMANCE_ENTITIES), OrganisationModule, WorkflowModule],
  providers: [PerformanceService],
  controllers: [PerformanceController],
  exports: [PerformanceService],
})
export class PerformanceModule {}
