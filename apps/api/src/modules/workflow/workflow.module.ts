import { Controller, Delete, Get, HttpCode, Module, Param, ParseUUIDPipe, Post, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { TypeOrmModule } from '@nestjs/typeorm';
import { z } from 'zod';
import { REQUEST_TYPES, createDelegation, delegation, inboxItem, inboxQuery, taskDecision, upsertWorkflowDefinition, workflowDefinition, workflowInstance } from '@sil/hr-shared';
import { AccessProfile } from '../../common/access';
import { Access, RequirePermissions, UsersOnly } from '../../common/decorators';
import { ApiIfMatch, IfMatch } from '../../common/etag';
import { ZBody, ZQuery, ZResponse } from '../../common/zod';
import { WORKFLOW_ENTITIES } from './workflow.entities';
import { WorkflowService } from './workflow.service';

type Q<T extends z.ZodType> = z.infer<T>;
const Id = () => Param('id', ParseUUIDPipe);

@ApiTags('Workflow')
@Controller('workflow')
export class WorkflowController {
  constructor(private readonly wf: WorkflowService) {}

  @Get('request-types')
  @ZResponse(z.array(z.object({ code: z.string(), name: z.string() })))
  types() {
    return Object.entries(REQUEST_TYPES).map(([code, name]) => ({ code, name }));
  }

  @Get('definitions')
  @RequirePermissions('workflow:read')
  @ZResponse(z.array(workflowDefinition))
  definitions() {
    return this.wf.definitions();
  }

  @Post('definitions')
  @RequirePermissions('workflow:manage')
  @ZResponse(workflowDefinition, 201)
  create(@ZBody(upsertWorkflowDefinition) dto: Q<typeof upsertWorkflowDefinition>) {
    return this.wf.saveDefinition(dto);
  }

  @Put('definitions/:id')
  @RequirePermissions('workflow:manage')
  @ApiIfMatch()
  @ZResponse(workflowDefinition)
  update(@Id() id: string, @ZBody(upsertWorkflowDefinition) dto: Q<typeof upsertWorkflowDefinition>, @IfMatch() v: number) {
    return this.wf.saveDefinition(dto, id, v);
  }

  /** Everything waiting for me (and my roles' pools). */
  @Get('inbox')
  @UsersOnly()
  @ZResponse(z.array(inboxItem))
  inbox(@Access() a: AccessProfile, @ZQuery(inboxQuery) q: Q<typeof inboxQuery>) {
    return this.wf.inbox(a, q.request_type);
  }

  @Post('tasks/:id/decision')
  @UsersOnly()
  @HttpCode(200)
  @ZResponse(workflowInstance)
  decide(@Access() a: AccessProfile, @Id() id: string, @ZBody(taskDecision) dto: Q<typeof taskDecision>) {
    return this.wf.decide(a, id, dto.decision, dto.comment ?? null);
  }

  @Get('instances/:id')
  @ZResponse(workflowInstance)
  instance(@Access() a: AccessProfile, @Id() id: string) {
    return this.wf.instance(id, a);
  }

  @Get('delegations')
  @UsersOnly()
  @ZResponse(z.array(delegation))
  delegations(@Access() a: AccessProfile) {
    return this.wf.delegations(a);
  }

  @Post('delegations')
  @UsersOnly()
  @ZResponse(delegation, 201)
  delegate(@Access() a: AccessProfile, @ZBody(createDelegation) dto: Q<typeof createDelegation>) {
    return this.wf.createDelegation(a, dto);
  }

  @Delete('delegations/:id')
  @UsersOnly()
  @HttpCode(204)
  @ZResponse(null, 204)
  remove(@Access() a: AccessProfile, @Id() id: string) {
    return this.wf.removeDelegation(a, id);
  }
}

@Module({
  imports: [TypeOrmModule.forFeature(WORKFLOW_ENTITIES)],
  providers: [WorkflowService],
  controllers: [WorkflowController],
  exports: [WorkflowService],
})
export class WorkflowModule {}
