import { Controller, Get, Module, Res } from '@nestjs/common';
import { ApiProduces, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { z } from 'zod';
import { asAtQuery, contractExpiryRow, dashboard, expiryQuery, headcountQuery, headcountRow, leaveLiabilityRow, licenceExpiryRow, overtimeRow, payrollCostRow, periodQuery, periodsQuery, turnoverRow, type ReportCode } from '@sil/hr-shared';
import { AccessProfile } from '../../common/access';
import { Access, RequirePermissions } from '../../common/decorators';
import { ZQuery, ZResponse } from '../../common/zod';
import { OrganisationModule } from '../organisation/organisation.module';
import { ReportsService, type ReportOutput } from './reports.service';

type Q<T extends z.ZodType> = z.infer<T>;

@ApiTags('Reports')
@Controller()
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  private async send(res: Response, code: ReportCode, format: 'json' | 'csv' | 'xlsx', out: ReportOutput<Record<string, unknown>>) {
    if (format === 'json') return out.rows;
    const f = await this.reports.export(code, out, format);
    res.setHeader('content-type', f.mimeType);
    res.setHeader('content-disposition', `attachment; filename="${f.fileName}"`);
    res.setHeader('cache-control', 'no-store');
    res.send(f.body);
    return undefined;
  }

  @Get('dashboard')
  @ZResponse(dashboard, 200, 'Figures for the home page, limited to your scope; figures you may not see are null')
  dashboard(@Access() a: AccessProfile) {
    return this.reports.dashboard(a);
  }

  @Get('reports/headcount')
  @RequirePermissions('report:read')
  @ApiProduces('application/json', 'text/csv', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  @ZResponse(z.array(headcountRow), 200, 'Staff employed on as_at (default today), by the department and branch in force that day')
  async headcount(@Access() a: AccessProfile, @ZQuery(headcountQuery) q: Q<typeof headcountQuery>, @Res({ passthrough: true }) res: Response) {
    return this.send(res, 'headcount', q.format, await this.reports.headcount(a, q));
  }

  @Get('reports/turnover')
  @RequirePermissions('report:read')
  @ApiProduces('application/json', 'text/csv', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  @ZResponse(z.array(turnoverRow), 200, 'Leavers ÷ average headcount, by current department')
  async turnover(@Access() a: AccessProfile, @ZQuery(periodQuery) q: Q<typeof periodQuery>, @Res({ passthrough: true }) res: Response) {
    return this.send(res, 'turnover', q.format, await this.reports.turnover(a, q));
  }

  @Get('reports/leave-liability')
  @RequirePermissions('report:read')
  @ApiProduces('application/json', 'text/csv', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  @ZResponse(z.array(leaveLiabilityRow), 200, 'Unused annual leave × basic ÷ the leave-pay divisor')
  async leaveLiability(@Access() a: AccessProfile, @ZQuery(asAtQuery) q: Q<typeof asAtQuery>, @Res({ passthrough: true }) res: Response) {
    return this.send(res, 'leave-liability', q.format, await this.reports.leaveLiability(a, q));
  }

  @Get('reports/overtime-cost')
  @RequirePermissions('report:read')
  @ApiProduces('application/json', 'text/csv', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  @ZResponse(z.array(overtimeRow), 200, 'Overtime recorded by attendance and paid by approved payrolls, by month and department')
  async overtime(@Access() a: AccessProfile, @ZQuery(periodsQuery) q: Q<typeof periodsQuery>, @Res({ passthrough: true }) res: Response) {
    return this.send(res, 'overtime-cost', q.format, await this.reports.overtimeCost(a, q));
  }

  @Get('reports/payroll-cost')
  @RequirePermissions('report:read')
  @ApiProduces('application/json', 'text/csv', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  @ZResponse(z.array(payrollCostRow), 200, 'Approved payrolls by month, department and cost centre')
  async payrollCost(@Access() a: AccessProfile, @ZQuery(periodsQuery) q: Q<typeof periodsQuery>, @Res({ passthrough: true }) res: Response) {
    return this.send(res, 'payroll-cost', q.format, await this.reports.payrollCost(a, q));
  }

  @Get('reports/licence-expiry')
  @RequirePermissions('report:read')
  @ApiProduces('application/json', 'text/csv', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  @ZResponse(z.array(licenceExpiryRow), 200, 'Each person’s latest licence per body expiring within the window (and already expired, by default)')
  async licences(@Access() a: AccessProfile, @ZQuery(expiryQuery) q: Q<typeof expiryQuery>, @Res({ passthrough: true }) res: Response) {
    return this.send(res, 'licence-expiry', q.format, await this.reports.licenceExpiry(a, q));
  }

  @Get('reports/contract-expiry')
  @RequirePermissions('report:read')
  @ApiProduces('application/json', 'text/csv', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  @ZResponse(z.array(contractExpiryRow), 200, 'Active fixed-term contracts ending within the window')
  async contracts(@Access() a: AccessProfile, @ZQuery(expiryQuery) q: Q<typeof expiryQuery>, @Res({ passthrough: true }) res: Response) {
    return this.send(res, 'contract-expiry', q.format, await this.reports.contractExpiry(a, q));
  }
}

@Module({
  imports: [OrganisationModule],
  providers: [ReportsService],
  controllers: [ReportsController],
})
export class ReportsModule {}
