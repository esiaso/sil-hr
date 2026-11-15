import { Column, CreateDateColumn, Entity, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';
import { AppBaseEntity, numericTransformer } from '../../common/base.entity';
import { Employee } from '../employees/employee.entities';

const NUM = (precision = 5, scale = 1) => ({ type: 'numeric' as const, precision, scale, transformer: numericTransformer });

@Entity('leave_type')
export class LeaveType extends AppBaseEntity {
  @Column({ type: 'varchar', length: 30 }) code: string;
  @Column({ type: 'varchar', length: 200 }) name: string;
  @Column({ type: 'varchar', length: 500, nullable: true }) description: string | null;
  @Column({ type: 'boolean', default: true }) isPaid: boolean;
  @Column({ ...NUM(3, 2), default: 1 }) payRate: number;
  @Column({ type: 'varchar', length: 14, default: 'working_days' }) counting: 'working_days' | 'calendar_days';
  @Column({ type: 'varchar', length: 8, default: 'annual' }) accrual: 'monthly' | 'annual' | 'none';
  @Column({ ...NUM(), default: 0 }) defaultEntitlementDays: number;
  @Column({ type: 'boolean', default: true }) allowHalfDay: boolean;
  @Column({ type: 'boolean', default: false }) allowNegativeBalance: boolean;
  @Column({ type: 'varchar', length: 6, nullable: true }) gender: 'female' | 'male' | null;
  @Column({ type: 'int', default: 0 }) minServiceMonths: number;
  @Column({ type: 'int', default: 0 }) minNoticeDays: number;
  @Column({ ...NUM(), nullable: true }) maxConsecutiveDays: number | null;
  @Column({ ...NUM(), nullable: true }) requiresDocumentOverDays: number | null;
  @Column({ ...NUM(), default: 0 }) carryForwardMaxDays: number;
  @Column({ type: 'int', nullable: true }) carryForwardExpiryMonths: number | null;
  @Column({ type: 'boolean', default: false }) encashable: boolean;
  @Column({ type: 'varchar', length: 7, nullable: true }) colour: string | null;
  @Column({ type: 'varchar', length: 10, default: 'active' }) status: 'active' | 'inactive';
}

@Entity('leave_policy')
export class LeavePolicy extends AppBaseEntity {
  @Column({ type: 'uuid' }) leaveTypeId: string;
  @Column({ type: 'uuid', nullable: true }) jobGradeId: string | null;
  @Column({ type: 'varchar', length: 12, nullable: true }) employmentType: string | null;
  @Column(NUM()) entitlementDays: number;
  @Column({ type: 'date' }) effectiveFrom: string;
  @Column({ type: 'date', nullable: true }) effectiveTo: string | null;
}

@Entity('public_holiday')
export class PublicHoliday extends AppBaseEntity {
  @Column({ type: 'date' }) date: string;
  @Column({ type: 'varchar', length: 200 }) name: string;
  @Column({ type: 'uuid', nullable: true }) branchId: string | null;
}

@Entity('leave_request')
export class LeaveRequest extends AppBaseEntity {
  @Column({ type: 'varchar', length: 40 }) number: string;
  @Column({ type: 'uuid' }) employeeId: string;
  @ManyToOne(() => Employee) @JoinColumn({ name: 'employee_id' }) employee?: Employee;
  @Column({ type: 'uuid' }) leaveTypeId: string;
  @ManyToOne(() => LeaveType) @JoinColumn({ name: 'leave_type_id' }) leaveType?: LeaveType;
  @Column({ type: 'date' }) startDate: string;
  @Column({ type: 'date' }) endDate: string;
  @Column({ type: 'boolean', default: false }) startHalfDay: boolean;
  @Column({ type: 'boolean', default: false }) endHalfDay: boolean;
  @Column(NUM()) days: number;
  @Column({ type: 'int' }) leaveYear: number;
  @Column({ type: 'varchar', length: 1000, nullable: true }) reason: string | null;
  @Column({ type: 'varchar', length: 10, default: 'draft' }) status: 'draft' | 'pending' | 'returned' | 'approved' | 'rejected' | 'cancelled';
  @Column({ type: 'uuid', nullable: true }) documentId: string | null;
  @Column({ type: 'uuid', nullable: true }) workflowInstanceId: string | null;
  @Column({ type: 'timestamptz', precision: 3, nullable: true }) submittedAt: Date | null;
  @Column({ type: 'timestamptz', precision: 3, nullable: true }) decidedAt: Date | null;
  @Column({ type: 'varchar', length: 1000, nullable: true }) decisionComment: string | null;
}

/** Append-only (trigger). Every balance is the sum of these rows. */
@Entity('leave_ledger')
export class LeaveLedger {
  @PrimaryColumn({ type: 'uuid', default: () => 'uuid_generate_v7()' }) id: string;
  @Column({ type: 'uuid' }) employeeId: string;
  @Column({ type: 'uuid' }) leaveTypeId: string;
  @Column({ type: 'int' }) leaveYear: number;
  @Column({ type: 'varchar', length: 14 }) entryType: 'accrual' | 'carry_forward' | 'adjustment' | 'reserved' | 'release' | 'taken' | 'expiry' | 'encashment';
  @Column(NUM(6, 2)) days: number;
  @Column({ type: 'date' }) effectiveDate: string;
  @Column({ type: 'uuid', nullable: true }) leaveRequestId: string | null;
  @Column({ type: 'varchar', length: 40, nullable: true }) periodKey: string | null;
  @Column({ type: 'varchar', length: 300, nullable: true }) note: string | null;
  @CreateDateColumn({ type: 'timestamptz', precision: 3 }) createdAt: Date;
  @Column({ type: 'uuid', nullable: true }) createdBy: string | null;
}

export const LEAVE_ENTITIES = [LeaveType, LeavePolicy, PublicHoliday, LeaveRequest, LeaveLedger];
