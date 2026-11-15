import { Controller, Get, HttpCode, Module, Param, ParseUUIDPipe, Post, Put, Res } from '@nestjs/common';
import { ApiProduces, ApiTags } from '@nestjs/swagger';
import { TypeOrmModule } from '@nestjs/typeorm';
import type { Response } from 'express';
import { z } from 'zod';
import {
  addRelationsNote, checklist, checklistTask, checklistTemplate, completeExit, contract, contractQuery, createContract, createLifecycleRequest, createRelationsCase, exitClearance, issueLetter,
  issuedLetter, letterTemplate, lifecycleRequest, raiseComplaint, relationsCase, updateChecklistTask, updateRelationsCase, upsertChecklistTemplate, upsertLetterTemplate,
} from '@sil/hr-shared';
import { AccessProfile } from '../../common/access';
import { Access, RequirePermissions } from '../../common/decorators';
import { ApiIfMatch, IfMatch } from '../../common/etag';
import { ZBody, ZQuery, ZResponse } from '../../common/zod';
import { EmployeesModule } from '../employees/employees.module';
import { LeaveModule } from '../leave/leave.module';
import { OrganisationModule } from '../organisation/organisation.module';
import { PayrollModule } from '../payroll/payroll.module';
import { WorkflowModule } from '../workflow/workflow.module';
import { LettersService } from './letters.service';
import { LIFECYCLE_ENTITIES } from './lifecycle.entities';
import { LifecycleService } from './lifecycle.service';
import { ProcurementClient } from './procurement.client';
import { RelationsService } from './relations.service';

type Q<T extends z.ZodType> = z.infer<T>;
const Id = (n = 'id') => Param(n, ParseUUIDPipe);
const status = z.enum(['pending', 'approved', 'rejected', 'returned', 'cancelled']);

@ApiTags('Lifecycle')
@Controller()
export class LifecycleController {
  constructor(private readonly lc: LifecycleService) {}

  // ---------------------------------------------------------------- contracts
  @Get('contracts')
  @RequirePermissions('contract:read')
  @ZResponse(z.array(contract))
  contracts(@Access() a: AccessProfile, @ZQuery(contractQuery) q: Q<typeof contractQuery>) {
    return this.lc.contracts(a, q);
  }

  @Get('me/contracts')
  @ZResponse(z.array(contract))
  myContracts(@Access() a: AccessProfile) {
    return a.employeeId ? this.lc.contracts(a, { employee_id: a.employeeId }) : [];
  }

  @Post('contracts')
  @RequirePermissions('contract:manage')
  @ZResponse(contract, 201, 'A new contract; the one in force ends the day before it starts. Renewals go through POST /lifecycle-requests.')
  createContract(@Access() a: AccessProfile, @ZBody(createContract) dto: Q<typeof createContract>) {
    return this.lc.createContract(a, dto);
  }

  // ---------------------------------------------------------------- requests
  @Get('lifecycle-requests')
  @RequirePermissions('lifecycle:request')
  @ZResponse(z.array(lifecycleRequest))
  requests(@Access() a: AccessProfile, @ZQuery(z.object({ employee_id: z.uuid().optional(), status: status.optional() })) q: { employee_id?: string; status?: string }) {
    return this.lc.requests(a, q);
  }

  @Post('lifecycle-requests')
  @RequirePermissions('lifecycle:request')
  @ZResponse(lifecycleRequest, 201, 'Promotion, transfer, confirmation, contract renewal, resignation or termination; goes to the LIFECYCLE approval workflow')
  createRequest(@Access() a: AccessProfile, @ZBody(createLifecycleRequest) dto: Q<typeof createLifecycleRequest>) {
    return this.lc.createRequest(a, dto);
  }

  // ---------------------------------------------------------------- checklists
  @Get('checklist-templates')
  @RequirePermissions('checklist:manage')
  @ZResponse(z.array(checklistTemplate))
  templates() {
    return this.lc.templates();
  }

  @Post('checklist-templates')
  @RequirePermissions('checklist:manage')
  @ZResponse(checklistTemplate, 201)
  createTemplate(@ZBody(upsertChecklistTemplate) dto: Q<typeof upsertChecklistTemplate>) {
    return this.lc.saveTemplate(dto);
  }

  @Put('checklist-templates/:id')
  @RequirePermissions('checklist:manage')
  @ApiIfMatch()
  @ZResponse(checklistTemplate)
  updateTemplate(@Id() id: string, @ZBody(upsertChecklistTemplate) dto: Q<typeof upsertChecklistTemplate>, @IfMatch() v: number) {
    return this.lc.saveTemplate(dto, id, v);
  }

  @Get('checklists')
  @RequirePermissions('checklist:manage')
  @ZResponse(z.array(checklist))
  checklists(@Access() a: AccessProfile, @ZQuery(z.object({ status: z.enum(['open', 'completed', 'cancelled']).optional(), kind: z.enum(['onboarding', 'offboarding']).optional(), employee_id: z.uuid().optional() })) q: { status?: string; kind?: string; employee_id?: string }) {
    return this.lc.checklists(a, q);
  }

  @Post('employees/:id/checklists/:kind')
  @RequirePermissions('checklist:manage')
  @ZResponse(z.object({ id: z.uuid() }), 201, 'Starts a checklist by hand (onboarding starts by itself for new hires; offboarding when an exit is approved)')
  async start(@Access() a: AccessProfile, @Id() id: string, @Param('kind') kind: string) {
    return { id: await this.lc.startChecklistManually(a, id, kind === 'offboarding' ? 'offboarding' : 'onboarding') };
  }

  @Get('me/checklist-tasks')
  @ZResponse(z.array(checklistTask), 200, 'Open tasks for your teams, your direct reports and yourself')
  myTasks(@Access() a: AccessProfile) {
    return this.lc.myTasks(a);
  }

  @Put('checklist-tasks/:id')
  @ZResponse(checklistTask)
  updateTask(@Access() a: AccessProfile, @Id() id: string, @ZBody(updateChecklistTask) dto: Q<typeof updateChecklistTask>) {
    return this.lc.updateTask(a, id, dto);
  }

  // ---------------------------------------------------------------- exits
  @Get('exit-clearances')
  @RequirePermissions('exit:manage')
  @ZResponse(z.array(exitClearance))
  clearances(@Access() a: AccessProfile, @ZQuery(z.object({ open: z.enum(['true', 'false']).optional() })) q: { open?: string }) {
    return this.lc.clearances(a, { open: q.open === 'true' });
  }

  @Get('employees/:id/exit-clearance')
  @RequirePermissions('exit:manage')
  @ZResponse(exitClearance)
  clearance(@Access() a: AccessProfile, @Id() id: string) {
    return this.lc.clearance(a, id);
  }

  @Post('employees/:id/exit-clearance/procurement-check')
  @RequirePermissions('exit:manage')
  @HttpCode(200)
  @ZResponse(exitClearance, 200, 'Asks sil_procurement what the person still holds')
  check(@Access() a: AccessProfile, @Id() id: string) {
    return this.lc.checkProcurement(a, id);
  }

  @Post('employees/:id/exit-clearance/final-dues')
  @RequirePermissions('exit:manage')
  @HttpCode(200)
  @ZResponse(exitClearance, 200, 'Freezes leave pay, notice pay and loan recovery and sends them for approval')
  finalDues(@Access() a: AccessProfile, @Id() id: string) {
    return this.lc.submitFinalDues(a, id);
  }

  @Post('employees/:id/exit-clearance/complete')
  @RequirePermissions('exit:manage')
  @HttpCode(200)
  @ZResponse(exitClearance, 200, 'Ends employment on the exit date: access ends at once (SCIM, events)')
  complete(@Access() a: AccessProfile, @Id() id: string, @ZBody(completeExit) dto: Q<typeof completeExit>) {
    return this.lc.completeExit(a, id, dto);
  }
}

@ApiTags('Employee relations')
@Controller()
export class RelationsController {
  constructor(private readonly rel: RelationsService) {}

  @Get('relations-cases')
  @ZResponse(z.array(relationsCase), 200, 'Cases you may see: in your relations:read scope, about you, raised by you, or naming you')
  list(@Access() a: AccessProfile, @ZQuery(z.object({ employee_id: z.uuid().optional(), kind: z.string().max(20).optional(), status: z.enum(['open', 'closed', 'withdrawn']).optional() })) q: { employee_id?: string; kind?: string; status?: string }) {
    return this.rel.list(a, q);
  }

  @Get('relations-cases/:id')
  @ZResponse(relationsCase)
  get(@Access() a: AccessProfile, @Id() id: string) {
    return this.rel.get(a, id);
  }

  @Post('relations-cases')
  @RequirePermissions('relations:manage')
  @ZResponse(relationsCase, 201, 'Complaints are always restricted to the people named on them')
  create(@Access() a: AccessProfile, @ZBody(createRelationsCase) dto: Q<typeof createRelationsCase>) {
    return this.rel.create(a, dto);
  }

  @Put('relations-cases/:id')
  @ZResponse(relationsCase)
  update(@Access() a: AccessProfile, @Id() id: string, @ZBody(updateRelationsCase) dto: Q<typeof updateRelationsCase>) {
    return this.rel.update(a, id, dto);
  }

  @Post('relations-cases/:id/notes')
  @ZResponse(relationsCase, 201)
  note(@Access() a: AccessProfile, @Id() id: string, @ZBody(addRelationsNote) dto: Q<typeof addRelationsNote>) {
    return this.rel.addNote(a, id, dto);
  }

  @Post('relations-cases/:id/acknowledge')
  @HttpCode(200)
  @ZResponse(relationsCase, 200, 'The employee confirms receipt of a warning, plan or award')
  ack(@Access() a: AccessProfile, @Id() id: string) {
    return this.rel.acknowledge(a, id);
  }

  @Post('me/complaints')
  @ZResponse(relationsCase, 201, 'Raise a grievance: only the HR managers (and people they add) see it')
  raise(@Access() a: AccessProfile, @ZBody(raiseComplaint) dto: Q<typeof raiseComplaint>) {
    return this.rel.raise(a, dto);
  }
}

@ApiTags('Letters')
@Controller()
export class LettersController {
  constructor(private readonly letters: LettersService) {}

  @Get('letter-templates')
  @RequirePermissions('letter:issue')
  @ZResponse(z.array(letterTemplate))
  templates() {
    return this.letters.templates();
  }

  @Post('letter-templates')
  @RequirePermissions('letter_template:manage')
  @ZResponse(letterTemplate, 201)
  create(@ZBody(upsertLetterTemplate) dto: Q<typeof upsertLetterTemplate>) {
    return this.letters.save(dto);
  }

  @Put('letter-templates/:id')
  @RequirePermissions('letter_template:manage')
  @ApiIfMatch()
  @ZResponse(letterTemplate)
  update(@Id() id: string, @ZBody(upsertLetterTemplate) dto: Q<typeof upsertLetterTemplate>, @IfMatch() v: number) {
    return this.letters.save(dto, id, v);
  }

  @Get('letters')
  @RequirePermissions('letter:issue')
  @ZResponse(z.array(issuedLetter))
  issued(@ZQuery(z.object({ employee_id: z.uuid().optional() })) q: { employee_id?: string }) {
    return this.letters.issued(q.employee_id);
  }

  @Post('letters')
  @RequirePermissions('letter:issue')
  @ApiProduces('application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
  async issue(@Access() a: AccessProfile, @ZBody(issueLetter) dto: Q<typeof issueLetter>, @Res() res: Response) {
    const { letter, file } = await this.letters.issue(a, dto);
    res.status(201);
    res.setHeader('content-type', file.mimeType);
    res.setHeader('content-disposition', `attachment; filename="${file.fileName}"`);
    res.setHeader('x-letter-number', letter.number);
    res.setHeader('x-document-id', letter.document_id);
    res.send(file.body);
  }
}

@Module({
  imports: [TypeOrmModule.forFeature(LIFECYCLE_ENTITIES), OrganisationModule, WorkflowModule, LeaveModule, PayrollModule, EmployeesModule],
  providers: [LifecycleService, RelationsService, LettersService, ProcurementClient],
  controllers: [LifecycleController, RelationsController, LettersController],
  exports: [LifecycleService],
})
export class LifecycleModule {}
