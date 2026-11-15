import { Controller, Delete, Get, HttpCode, Module, Param, ParseUUIDPipe, Post, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBody, ApiConsumes, ApiProduces, ApiTags } from '@nestjs/swagger';
import { TypeOrmModule } from '@nestjs/typeorm';
import type { Response } from 'express';
import { z } from 'zod';
import { createClaim, createTravel, expenseClaim, expenseItemFields, travelQuery, travelRequest } from '@sil/hr-shared';
import { AccessProfile } from '../../common/access';
import { Access, RequirePermissions } from '../../common/decorators';
import { ZBody, ZQuery, ZResponse } from '../../common/zod';
import { loadEnv } from '../../config/env';
import { OrganisationModule } from '../organisation/organisation.module';
import { WorkflowModule } from '../workflow/workflow.module';
import { EXPENSE_ENTITIES } from './expenses.entities';
import { ExpensesService } from './expenses.service';

type Q<T extends z.ZodType> = z.infer<T>;
const Id = (n = 'id') => Param(n, ParseUUIDPipe);

@ApiTags('Travel and expenses')
@Controller()
export class ExpensesController {
  constructor(private readonly svc: ExpensesService) {}

  @Post('travel-requests')
  @ZResponse(travelRequest, 201, 'Your trip; goes to the TRAVEL approval workflow. An approved advance is paid through payroll.')
  travel(@Access() a: AccessProfile, @ZBody(createTravel) dto: Q<typeof createTravel>) {
    return this.svc.requestTravel(a, dto);
  }

  @Get('me/travel-requests')
  @ZResponse(z.array(travelRequest))
  myTravel(@Access() a: AccessProfile) {
    return this.svc.travelRequests(a, {}, true);
  }

  @Get('travel-requests')
  @RequirePermissions('expense:read')
  @ZResponse(z.array(travelRequest), 200, 'In your expense:read scope')
  allTravel(@Access() a: AccessProfile, @ZQuery(travelQuery) q: Q<typeof travelQuery>) {
    return this.svc.travelRequests(a, q, false);
  }

  @Post('travel-requests/:id/cancel')
  @HttpCode(200)
  @ZResponse(travelRequest)
  cancelTravel(@Access() a: AccessProfile, @Id() id: string) {
    return this.svc.cancelTravel(a, id);
  }

  @Post('expense-claims')
  @ZResponse(expenseClaim, 201, 'A draft; add items with receipts, then submit')
  create(@Access() a: AccessProfile, @ZBody(createClaim) dto: Q<typeof createClaim>) {
    return this.svc.createClaim(a, dto);
  }

  @Get('me/expense-claims')
  @ZResponse(z.array(expenseClaim))
  myClaims(@Access() a: AccessProfile) {
    return this.svc.claims(a, {}, true);
  }

  @Get('expense-claims')
  @RequirePermissions('expense:read')
  @ZResponse(z.array(expenseClaim), 200, 'In your expense:read scope')
  allClaims(@Access() a: AccessProfile, @ZQuery(travelQuery) q: Q<typeof travelQuery>) {
    return this.svc.claims(a, q, false);
  }

  @Get('expense-claims/:id')
  @ZResponse(expenseClaim)
  claim(@Access() a: AccessProfile, @Id() id: string) {
    return this.svc.claim(a, id);
  }

  @Post('expense-claims/:id/items')
  @ApiConsumes('multipart/form-data')
  @ApiBody({ schema: { type: 'object', required: ['spent_on', 'category', 'description', 'amount'], properties: { spent_on: { type: 'string', format: 'date' }, category: { type: 'string' }, description: { type: 'string' }, amount: { type: 'string' }, receipt: { type: 'string', format: 'binary' } } } as never })
  @UseInterceptors(FileInterceptor('receipt', { limits: { fileSize: Math.min(loadEnv().maxUploadMb, 10) * 1024 * 1024, files: 1 } }))
  @ZResponse(expenseClaim, 201)
  addItem(@Access() a: AccessProfile, @Id() id: string, @ZBody(expenseItemFields) f: Q<typeof expenseItemFields>, @UploadedFile() receipt: Express.Multer.File | undefined) {
    return this.svc.addItem(a, id, f, receipt);
  }

  @Delete('expense-claims/:id/items/:itemId')
  @ZResponse(expenseClaim)
  removeItem(@Access() a: AccessProfile, @Id() id: string, @Id('itemId') itemId: string) {
    return this.svc.removeItem(a, id, itemId);
  }

  @Post('expense-claims/:id/submit')
  @HttpCode(200)
  @ZResponse(expenseClaim, 200, 'Goes to the EXPENSE approval workflow; approval pays the net through payroll')
  submit(@Access() a: AccessProfile, @Id() id: string) {
    return this.svc.submit(a, id);
  }

  @Post('expense-claims/:id/cancel')
  @HttpCode(200)
  @ZResponse(expenseClaim)
  cancel(@Access() a: AccessProfile, @Id() id: string) {
    return this.svc.cancelClaim(a, id);
  }

  @Get('expense-items/:id/receipt')
  @ApiProduces('application/pdf', 'image/png', 'image/jpeg')
  async receipt(@Access() a: AccessProfile, @Id() id: string, @Res() res: Response) {
    const f = await this.svc.receipt(a, id);
    res.setHeader('content-type', f.mimeType);
    res.setHeader('content-disposition', `attachment; filename="${f.fileName.replace(/["\\\r\n]/g, '_')}"`);
    res.setHeader('cache-control', 'no-store');
    res.send(f.body);
  }
}

@Module({
  imports: [TypeOrmModule.forFeature(EXPENSE_ENTITIES), OrganisationModule, WorkflowModule],
  providers: [ExpensesService],
  controllers: [ExpensesController],
})
export class ExpensesModule {}
