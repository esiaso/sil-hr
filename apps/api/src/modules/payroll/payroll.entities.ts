import { Column, Entity, PrimaryColumn } from 'typeorm';
import { AppBaseEntity, numericTransformer } from '../../common/base.entity';
import type { ComponentKind, ComponentMethod, TaxTreatment } from './payroll.calc';
import type { StatutoryCode } from './payroll.statutory';

/** Money reads as a decimal string (ARCHITECTURE: never JS numbers for money). */
const MONEY = { type: 'numeric' as const, precision: 14, scale: 2 };
const NUM4 = { type: 'numeric' as const, precision: 14, scale: 4, nullable: true, transformer: numericTransformer };

@Entity('pay_component')
export class PayComponent extends AppBaseEntity {
  @Column({ type: 'varchar', length: 30 }) code: string;
  @Column({ type: 'varchar', length: 200 }) name: string;
  @Column({ type: 'varchar', length: 25 }) kind: ComponentKind;
  @Column({ type: 'varchar', length: 15, default: 'fixed' }) method: ComponentMethod;
  @Column(NUM4) defaultValue: number | null;
  @Column({ type: 'varchar', length: 500, nullable: true }) formula: string | null;
  @Column({ type: 'boolean', default: true }) taxable: boolean;
  @Column({ type: 'boolean', default: false }) pensionable: boolean;
  @Column({ type: 'boolean', default: true }) prorate: boolean;
  @Column({ type: 'varchar', length: 25, default: 'none' }) taxTreatment: TaxTreatment;
  @Column({ type: 'boolean', default: false }) isSystem: boolean;
  @Column({ type: 'int', default: 100 }) sortOrder: number;
  @Column({ type: 'varchar', length: 10, default: 'active' }) status: 'active' | 'inactive';
}

@Entity('statutory_rate')
export class StatutoryRate extends AppBaseEntity {
  @Column({ type: 'varchar', length: 20 }) code: StatutoryCode;
  @Column({ type: 'date' }) effectiveFrom: string;
  @Column({ type: 'date', nullable: true }) effectiveTo: string | null;
  @Column({ type: 'jsonb' }) params: Record<string, unknown>;
  @Column({ type: 'varchar', length: 300, nullable: true }) source: string | null;
}

@Entity('employee_salary')
export class EmployeeSalary extends AppBaseEntity {
  @Column({ type: 'uuid' }) employeeId: string;
  @Column(MONEY) basic: string;
  @Column({ type: 'date' }) effectiveFrom: string;
  @Column({ type: 'date', nullable: true }) effectiveTo: string | null;
  @Column({ type: 'varchar', length: 300, nullable: true }) reason: string | null;
}

@Entity('employee_pay_item')
export class EmployeePayItem extends AppBaseEntity {
  @Column({ type: 'uuid' }) employeeId: string;
  @Column({ type: 'uuid' }) componentId: string;
  @Column(NUM4) value: number | null;
  @Column({ type: 'varchar', length: 500, nullable: true }) formula: string | null;
  @Column({ type: 'date' }) effectiveFrom: string;
  @Column({ type: 'date', nullable: true }) effectiveTo: string | null;
  @Column({ type: 'varchar', length: 300, nullable: true }) note: string | null;
}

@Entity('employee_loan')
export class EmployeeLoan extends AppBaseEntity {
  @Column({ type: 'uuid' }) employeeId: string;
  @Column({ type: 'uuid' }) componentId: string;
  @Column({ type: 'varchar', length: 60, nullable: true }) reference: string | null;
  @Column(MONEY) principal: string;
  @Column(MONEY) installment: string;
  @Column({ type: 'char', length: 7 }) startPeriod: string;
  @Column({ type: 'varchar', length: 10, default: 'active' }) status: 'active' | 'settled' | 'cancelled';
  @Column({ type: 'varchar', length: 300, nullable: true }) note: string | null;
}

@Entity('payroll_one_off')
export class PayrollOneOff extends AppBaseEntity {
  @Column({ type: 'uuid' }) employeeId: string;
  @Column({ type: 'uuid' }) componentId: string;
  @Column({ type: 'char', length: 7 }) period: string;
  @Column(MONEY) amount: string;
  @Column({ type: 'varchar', length: 300, nullable: true }) note: string | null;
}

export type RunStatus = 'draft' | 'calculated' | 'under_review' | 'approved' | 'paid' | 'closed';

@Entity('payroll_run')
export class PayrollRun extends AppBaseEntity {
  @Column({ type: 'varchar', length: 30 }) number: string;
  @Column({ type: 'char', length: 7 }) period: string;
  @Column({ type: 'date' }) periodStart: string;
  @Column({ type: 'date' }) periodEnd: string;
  @Column({ type: 'date' }) payDate: string;
  @Column({ type: 'varchar', length: 15, default: 'draft' }) status: RunStatus;
  @Column({ type: 'int', default: 0 }) employees: number;
  @Column({ ...MONEY, default: 0 }) gross: string;
  @Column({ ...MONEY, default: 0 }) totalDeductions: string;
  @Column({ ...MONEY, default: 0 }) net: string;
  @Column({ ...MONEY, default: 0 }) paye: string;
  @Column({ ...MONEY, default: 0 }) employerCost: string;
  @Column({ type: 'jsonb', default: () => "'[]'" }) warnings: { employee_id: string | null; name: string | null; message: string }[];
  @Column({ type: 'timestamptz', precision: 3, nullable: true }) calculatedAt: Date | null;
  @Column({ type: 'uuid', nullable: true }) calculatedBy: string | null;
  @Column({ type: 'timestamptz', precision: 3, nullable: true }) submittedAt: Date | null;
  @Column({ type: 'timestamptz', precision: 3, nullable: true }) approvedAt: Date | null;
  @Column({ type: 'timestamptz', precision: 3, nullable: true }) paidAt: Date | null;
  @Column({ type: 'timestamptz', precision: 3, nullable: true }) closedAt: Date | null;
  @Column({ type: 'varchar', length: 1000, nullable: true }) decisionComment: string | null;
  @Column({ type: 'uuid', nullable: true }) workflowInstanceId: string | null;
}

@Entity('payslip')
export class Payslip extends AppBaseEntity {
  @Column({ type: 'uuid' }) runId: string;
  @Column({ type: 'uuid' }) employeeId: string;
  @Column({ type: 'varchar', length: 40, nullable: true }) number: string | null;
  @Column({ type: 'varchar', length: 300 }) employeeName: string;
  @Column({ type: 'varchar', length: 30 }) staffNumber: string;
  @Column({ type: 'uuid', nullable: true }) departmentId: string | null;
  @Column({ type: 'varchar', length: 200, nullable: true }) departmentName: string | null;
  @Column({ type: 'uuid', nullable: true }) costCentreId: string | null;
  @Column({ type: 'varchar', length: 30, nullable: true }) costCentreCode: string | null;
  @Column(MONEY) basic: string;
  @Column(MONEY) gross: string;
  @Column(MONEY) taxablePay: string;
  @Column(MONEY) paye: string;
  @Column(MONEY) nssf: string;
  @Column(MONEY) shif: string;
  @Column(MONEY) housingLevy: string;
  @Column(MONEY) totalDeductions: string;
  @Column(MONEY) net: string;
  @Column(MONEY) employerCost: string;
  @Column({ type: 'jsonb' }) tax: { allowable: number; tax_before_relief: number; personal_relief: number; insurance_relief: number };
  @Column({ type: 'jsonb' }) inputs: Record<string, unknown>;
  @Column({ type: 'jsonb', default: () => "'[]'" }) warnings: string[];
  @Column({ type: 'varchar', length: 15, nullable: true }) paymentMethod: 'bank' | 'mobile_money' | 'cash' | null;
  @Column({ type: 'uuid', nullable: true }) paymentAccountId: string | null;
}

@Entity('payslip_line')
export class PayslipLine {
  @PrimaryColumn({ type: 'uuid', default: () => 'uuid_generate_v7()' }) id: string;
  @Column({ type: 'uuid' }) payslipId: string;
  @Column({ type: 'int' }) seq: number;
  @Column({ type: 'varchar', length: 40 }) code: string;
  @Column({ type: 'varchar', length: 200 }) name: string;
  @Column({ type: 'varchar', length: 25 }) kind: string;
  @Column(MONEY) amount: string;
  @Column({ type: 'boolean', nullable: true }) taxable: boolean | null;
  @Column({ type: 'varchar', length: 200, nullable: true }) detail: string | null;
  @Column({ type: 'uuid', nullable: true }) loanId: string | null;
}

export interface FileColumn { header: string; field: string; value?: string }

@Entity('payment_file_format')
export class PaymentFileFormat extends AppBaseEntity {
  @Column({ type: 'varchar', length: 30 }) code: string;
  @Column({ type: 'varchar', length: 200 }) name: string;
  @Column({ type: 'varchar', length: 15 }) channel: 'bank' | 'mobile_money';
  @Column({ type: 'varchar', length: 5 }) fileType: 'xlsx' | 'csv';
  @Column({ type: 'jsonb' }) columns: FileColumn[];
  @Column({ type: 'boolean', default: false }) isDefault: boolean;
  @Column({ type: 'varchar', length: 500, nullable: true }) note: string | null;
}

@Entity('gl_account_map')
export class GlAccountMap extends AppBaseEntity {
  @Column({ type: 'varchar', length: 40 }) key: string;
  @Column({ type: 'varchar', length: 200, nullable: true }) description: string | null;
  @Column({ type: 'varchar', length: 40, nullable: true }) debitAccount: string | null;
  @Column({ type: 'varchar', length: 40, nullable: true }) creditAccount: string | null;
}

export const PAYROLL_ENTITIES = [PayComponent, StatutoryRate, EmployeeSalary, EmployeePayItem, EmployeeLoan, PayrollOneOff, PayrollRun, Payslip, PayslipLine, PaymentFileFormat, GlAccountMap];
