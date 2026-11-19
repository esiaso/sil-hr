import { Controller, Delete, Get, HttpCode, Module, Param, ParseUUIDPipe, Post, Put, Query, Res } from '@nestjs/common';
import { ApiProduces, ApiQuery, ApiTags } from '@nestjs/swagger';
import { TypeOrmModule } from '@nestjs/typeorm';
import type { Response } from 'express';
import { z } from 'zod';
import {
  createOneOff, createRun, employeeLoan, employeePay, formulaCheck, glAccountMap, journal, LOAN_STATUSES, oneOffItem, PAYROLL_EXPORTS, payComponent, paymentFileFormat, payrollRun, payslip,
  period, runAction, setSalary, statutoryRate, upsertGlAccountMap, upsertLoan, upsertPayComponent, upsertPayItem, upsertPaymentFileFormat, upsertStatutoryRate, variance,
} from '@sil/hr-shared';
import { AccessProfile } from '../../common/access';
import { Access, RequirePermissions } from '../../common/decorators';
import { ApiIfMatch, IfMatch } from '../../common/etag';
import { badRequest } from '../../common/problem';
import { ZBody, ZQuery, ZResponse } from '../../common/zod';
import { LeaveModule } from '../leave/leave.module';
import { OrganisationModule } from '../organisation/organisation.module';
import { WorkflowModule } from '../workflow/workflow.module';
import { PAYROLL_ENTITIES } from './payroll.entities';
import { PayrollOutputs, type FileOut } from './payroll.outputs';
import { PayrollService } from './payroll.service';

type Q<T extends z.ZodType> = z.infer<T>;
const Id = (n = 'id') => Param(n, ParseUUIDPipe);

function send(res: Response, f: FileOut) {
  res.setHeader('content-type', f.mimeType);
  res.setHeader('content-disposition', `attachment; filename="${f.fileName.replace(/["\\\r\n]/g, '_')}"`);
  res.setHeader('cache-control', 'no-store');
  res.send(f.body);
}

@ApiTags('Payroll setup')
@Controller('payroll')
export class PayrollSetupController {
  constructor(private readonly payroll: PayrollService) {}

  @Get('components')
  @RequirePermissions('salary:read')
  @ZResponse(z.array(payComponent))
  components() {
    return this.payroll.components();
  }

  @Post('components')
  @RequirePermissions('payroll_setup:manage')
  @ZResponse(payComponent, 201)
  createComponent(@ZBody(upsertPayComponent) dto: Q<typeof upsertPayComponent>) {
    return this.payroll.saveComponent(dto);
  }

  @Put('components/:id')
  @RequirePermissions('payroll_setup:manage')
  @ApiIfMatch()
  @ZResponse(payComponent)
  updateComponent(@Id() id: string, @ZBody(upsertPayComponent) dto: Q<typeof upsertPayComponent>, @IfMatch() v: number) {
    return this.payroll.saveComponent(dto, id, v);
  }

  @Post('components/check-formula')
  @RequirePermissions('payroll_setup:manage')
  @HttpCode(200)
  @ZResponse(z.object({ ok: z.boolean(), value: z.number().nullable(), message: z.string().nullable() }))
  checkFormula(@ZBody(formulaCheck) dto: Q<typeof formulaCheck>) {
    return this.payroll.checkFormula(dto.formula, { basic: dto.basic, basic_full: dto.basic, gross: dto.gross, days_paid: 22, days_in_period: 22, overtime_hours: 0 });
  }

  @Get('statutory-rates')
  @RequirePermissions('salary:read')
  @ZResponse(z.array(statutoryRate))
  rates() {
    return this.payroll.rates();
  }

  @Post('statutory-rates')
  @RequirePermissions('payroll_setup:manage')
  @ZResponse(statutoryRate, 201, 'Created. An open-ended table of the same kind is closed the day before this one starts.')
  createRate(@ZBody(upsertStatutoryRate) dto: Q<typeof upsertStatutoryRate>) {
    return this.payroll.saveRate(dto);
  }

  @Put('statutory-rates/:id')
  @RequirePermissions('payroll_setup:manage')
  @ApiIfMatch()
  @ZResponse(statutoryRate)
  updateRate(@Id() id: string, @ZBody(upsertStatutoryRate) dto: Q<typeof upsertStatutoryRate>, @IfMatch() v: number) {
    return this.payroll.saveRate(dto, id, v);
  }

  @Delete('statutory-rates/:id')
  @RequirePermissions('payroll_setup:manage')
  @HttpCode(204)
  @ZResponse(null, 204)
  async deleteRate(@Id() id: string) {
    await this.payroll.deleteRate(id);
  }

  @Get('payment-formats')
  @RequirePermissions('payroll:read')
  @ZResponse(z.array(paymentFileFormat))
  formats() {
    return this.payroll.formats();
  }

  @Post('payment-formats')
  @RequirePermissions('payroll_setup:manage')
  @ZResponse(paymentFileFormat, 201)
  createFormat(@ZBody(upsertPaymentFileFormat) dto: Q<typeof upsertPaymentFileFormat>) {
    return this.payroll.saveFormat(dto);
  }

  @Put('payment-formats/:id')
  @RequirePermissions('payroll_setup:manage')
  @ApiIfMatch()
  @ZResponse(paymentFileFormat)
  updateFormat(@Id() id: string, @ZBody(upsertPaymentFileFormat) dto: Q<typeof upsertPaymentFileFormat>, @IfMatch() v: number) {
    return this.payroll.saveFormat(dto, id, v);
  }

  @Get('account-map')
  @RequirePermissions('payroll:read')
  @ZResponse(z.array(glAccountMap))
  accountMap() {
    return this.payroll.accountMap();
  }

  @Put('account-map')
  @RequirePermissions('payroll_setup:manage')
  @ZResponse(z.array(glAccountMap), 200, 'Rows are matched by key; keys not sent are left as they are')
  saveAccountMap(@ZBody(z.object({ rows: z.array(upsertGlAccountMap).min(1).max(500) })) dto: { rows: Q<typeof upsertGlAccountMap>[] }) {
    return this.payroll.saveAccountMap(dto.rows);
  }
}

@ApiTags('Payroll: people')
@Controller()
export class PayController {
  constructor(private readonly payroll: PayrollService) {}

  @Get('employees/:id/pay')
  @RequirePermissions('salary:read')
  @ZResponse(employeePay)
  pay(@Access() a: AccessProfile, @Id() id: string) {
    return this.payroll.employeePay(a, id);
  }

  @Put('employees/:id/salary')
  @RequirePermissions('salary:manage')
  @ZResponse(employeePay, 200, 'A new basic salary from a date; the one in force is closed the day before')
  setSalary(@Access() a: AccessProfile, @Id() id: string, @ZBody(setSalary) dto: Q<typeof setSalary>) {
    return this.payroll.setSalary(a, id, dto);
  }

  @Post('employees/:id/pay-items')
  @RequirePermissions('salary:manage')
  @ZResponse(employeePay, 201)
  addItem(@Access() a: AccessProfile, @Id() id: string, @ZBody(upsertPayItem) dto: Q<typeof upsertPayItem>) {
    return this.payroll.savePayItem(a, id, dto);
  }

  @Put('employees/:id/pay-items/:itemId')
  @RequirePermissions('salary:manage')
  @ZResponse(employeePay)
  updateItem(@Access() a: AccessProfile, @Id() id: string, @Id('itemId') itemId: string, @ZBody(upsertPayItem) dto: Q<typeof upsertPayItem>) {
    return this.payroll.savePayItem(a, id, dto, itemId);
  }

  @Delete('employees/:id/pay-items/:itemId')
  @RequirePermissions('salary:manage')
  @ZResponse(employeePay)
  deleteItem(@Access() a: AccessProfile, @Id() id: string, @Id('itemId') itemId: string) {
    return this.payroll.deletePayItem(a, id, itemId);
  }

  @Get('payroll/loans')
  @RequirePermissions('salary:read')
  @ZResponse(z.array(employeeLoan))
  loans(@ZQuery(z.object({ employee_id: z.uuid().optional(), status: z.enum(LOAN_STATUSES).optional() })) q: { employee_id?: string; status?: string }) {
    return this.payroll.loans(q);
  }

  @Post('payroll/loans')
  @RequirePermissions('salary:manage')
  @ZResponse(employeeLoan, 201)
  createLoan(@Access() a: AccessProfile, @ZBody(upsertLoan) dto: Q<typeof upsertLoan>) {
    return this.payroll.saveLoan(a, dto);
  }

  @Put('payroll/loans/:id')
  @RequirePermissions('salary:manage')
  @ApiIfMatch()
  @ZResponse(employeeLoan)
  updateLoan(@Access() a: AccessProfile, @Id() id: string, @ZBody(upsertLoan) dto: Q<typeof upsertLoan>, @IfMatch() v: number) {
    return this.payroll.saveLoan(a, dto, id, v);
  }

  @Get('payroll/one-offs')
  @RequirePermissions('salary:read')
  @ZResponse(z.array(oneOffItem))
  oneOffs(@ZQuery(z.object({ employee_id: z.uuid().optional(), period: period.optional() })) q: { employee_id?: string; period?: string }) {
    return this.payroll.oneOffs(q);
  }

  @Post('payroll/one-offs')
  @RequirePermissions('salary:manage')
  @ZResponse(oneOffItem, 201)
  createOneOff(@Access() a: AccessProfile, @ZBody(createOneOff) dto: Q<typeof createOneOff>) {
    return this.payroll.createOneOff(a, dto);
  }

  @Delete('payroll/one-offs/:id')
  @RequirePermissions('salary:manage')
  @HttpCode(204)
  @ZResponse(null, 204)
  async deleteOneOff(@Id() id: string) {
    await this.payroll.deleteOneOff(id);
  }
}

@ApiTags('Payroll runs')
@Controller()
export class PayrollRunController {
  constructor(
    private readonly payroll: PayrollService,
    private readonly outputs: PayrollOutputs,
  ) {}

  @Get('payroll/runs')
  @RequirePermissions('payroll:read')
  @ZResponse(z.array(payrollRun))
  runs() {
    return this.payroll.runs();
  }

  @Post('payroll/runs')
  @RequirePermissions('payroll:prepare')
  @ZResponse(payrollRun, 201, 'A draft run for the month. The pay date defaults to Settings → payroll.pay_day.')
  create(@ZBody(createRun) dto: Q<typeof createRun>) {
    return this.payroll.createRun(dto);
  }

  @Get('payroll/runs/:id')
  @RequirePermissions('payroll:read')
  @ZResponse(payrollRun)
  async get(@Id() id: string) {
    return this.payroll.runDto(await this.payroll.run(id));
  }

  @Delete('payroll/runs/:id')
  @RequirePermissions('payroll:prepare')
  @HttpCode(204)
  @ZResponse(null, 204)
  async remove(@Id() id: string) {
    await this.payroll.deleteRun(id);
  }

  @Post('payroll/runs/:id/calculate')
  @RequirePermissions('payroll:prepare')
  @HttpCode(200)
  @ZResponse(payrollRun, 200, 'Recalculates every payslip from the current inputs (draft or calculated runs only)')
  calculate(@Access() a: AccessProfile, @Id() id: string) {
    return this.payroll.calculate(a, id);
  }

  @Post('payroll/runs/:id/submit')
  @RequirePermissions('payroll:prepare')
  @HttpCode(200)
  @ZResponse(payrollRun, 200, 'Sends the run to the PAYROLL approval workflow; approval locks it')
  submit(@Access() a: AccessProfile, @Id() id: string, @ZBody(runAction) dto: Q<typeof runAction>) {
    return this.payroll.submit(a, id, dto.comment);
  }

  @Post('payroll/runs/:id/mark-paid')
  @RequirePermissions('payroll:pay')
  @HttpCode(200)
  @ZResponse(payrollRun)
  markPaid(@Id() id: string) {
    return this.payroll.markPaid(id);
  }

  @Post('payroll/runs/:id/close')
  @RequirePermissions('payroll:pay')
  @HttpCode(200)
  @ZResponse(payrollRun)
  close(@Id() id: string) {
    return this.payroll.close(id);
  }

  @Get('payroll/runs/:id/payslips')
  @RequirePermissions('payroll:read')
  @ZResponse(z.array(payslip))
  payslips(@Access() a: AccessProfile, @Id() id: string) {
    return this.payroll.payslips(a, id);
  }

  @Get('payroll/runs/:id/variance')
  @RequirePermissions('payroll:read')
  @ZResponse(variance)
  variance(@Id() id: string) {
    return this.payroll.variance(id);
  }

  @Get('payroll/runs/:id/journal')
  @RequirePermissions('payroll.journal:read')
  @ZResponse(journal, 200, 'Double entry by cost centre, from the account mapping')
  journal(@Id() id: string) {
    return this.payroll.journal(id);
  }

  @Get('payroll/runs/:id/export')
  @RequirePermissions('payroll:prepare')
  @ApiProduces('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'text/csv')
  @ApiQuery({ name: 'file', enum: Object.keys(PAYROLL_EXPORTS) })
  @ApiQuery({ name: 'channel', required: false, enum: ['bank', 'mobile_money'] })
  @ApiQuery({ name: 'format_code', required: false })
  async export(@Id() id: string, @Query('file') file: string, @Query('channel') channel: string | undefined, @Query('format_code') formatCode: string | undefined, @Res() res: Response) {
    if (!(file in PAYROLL_EXPORTS)) throw badRequest('unknown_file', `file must be one of ${Object.keys(PAYROLL_EXPORTS).join(', ')}`);
    if (channel && channel !== 'bank' && channel !== 'mobile_money') throw badRequest('bad_channel', 'channel must be bank or mobile_money');
    send(res, await this.outputs.export(id, file, { channel: channel as 'bank' | 'mobile_money' | undefined, format_code: formatCode }));
  }

  @Get('payroll/payslips/:id')
  @ZResponse(payslip, 200, 'Payroll staff: any payslip in scope. Anyone: their own, once approved.')
  payslip(@Access() a: AccessProfile, @Id() id: string) {
    return this.payroll.payslip(a, id);
  }

  @Get('payroll/payslips/:id/pdf')
  @ApiProduces('application/pdf')
  async payslipPdf(@Access() a: AccessProfile, @Id() id: string, @Res() res: Response) {
    send(res, await this.outputs.payslipPdf(a, id));
  }

  @Get('payroll/p9')
  @RequirePermissions('payroll:read')
  @ApiProduces('application/pdf')
  async p9(@Access() a: AccessProfile, @ZQuery(z.object({ employee_id: z.uuid(), year: z.coerce.number().int().min(2000).max(2100) })) q: { employee_id: string; year: number }, @Res() res: Response) {
    send(res, await this.outputs.p9(a, q.employee_id, q.year));
  }

  @Get('payroll/p9/employees')
  @RequirePermissions('payroll:read')
  @ZResponse(z.array(z.object({ employee_id: z.uuid(), staff_number: z.string(), employee_name: z.string(), department: z.string().nullable(), months: z.number().int(), paye: z.string() })), 200, 'Everyone with an approved payslip in the year: who gets a P9')
  p9Employees(@Access() a: AccessProfile, @ZQuery(z.object({ year: z.coerce.number().int().min(2000).max(2100) })) q: { year: number }) {
    return this.outputs.p9Employees(a, q.year);
  }

  @Get('payroll/p9/bulk')
  @RequirePermissions('payroll:read')
  @ApiProduces('application/zip')
  async p9Bulk(@Access() a: AccessProfile, @ZQuery(z.object({ year: z.coerce.number().int().min(2000).max(2100), department_id: z.uuid().optional() })) q: { year: number; department_id?: string }, @Res() res: Response) {
    send(res, await this.outputs.p9Bulk(a, q.year, q.department_id));
  }

  @Get('me/payslips')
  @ZResponse(z.array(payslip), 200, 'Your approved payslips, newest first')
  mine(@Access() a: AccessProfile) {
    return this.payroll.myPayslips(a);
  }

  @Get('me/p9')
  @ApiProduces('application/pdf')
  async myP9(@Access() a: AccessProfile, @ZQuery(z.object({ year: z.coerce.number().int().min(2000).max(2100) })) q: { year: number }, @Res() res: Response) {
    if (!a.employeeId) throw badRequest('no_employee', 'Your account is not linked to an employee record');
    send(res, await this.outputs.p9(a, a.employeeId, q.year));
  }
}

@Module({
  imports: [TypeOrmModule.forFeature(PAYROLL_ENTITIES), OrganisationModule, WorkflowModule, LeaveModule],
  providers: [PayrollService, PayrollOutputs],
  controllers: [PayrollSetupController, PayController, PayrollRunController],
  exports: [PayrollService],
})
export class PayrollModule {}
