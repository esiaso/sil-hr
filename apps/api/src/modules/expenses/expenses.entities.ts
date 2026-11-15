import { Column, Entity, PrimaryColumn } from 'typeorm';
import { AppBaseEntity } from '../../common/base.entity';

@Entity('travel_request')
export class TravelRequest extends AppBaseEntity {
  @Column({ type: 'varchar', length: 40 }) number: string;
  @Column({ type: 'uuid' }) employeeId: string;
  @Column({ type: 'varchar', length: 1000 }) purpose: string;
  @Column({ type: 'varchar', length: 200 }) destination: string;
  @Column({ type: 'date' }) departOn: string;
  @Column({ type: 'date' }) returnOn: string;
  @Column({ type: 'numeric', precision: 14, scale: 2, default: 0 }) estimatedCost: string;
  @Column({ type: 'numeric', precision: 14, scale: 2, default: 0 }) advance: string;
  @Column({ type: 'char', length: 7, nullable: true }) advancePeriod: string | null;
  @Column({ type: 'varchar', length: 10, default: 'pending' }) status: 'pending' | 'approved' | 'rejected' | 'returned' | 'cancelled';
  @Column({ type: 'varchar', length: 1000, nullable: true }) decisionComment: string | null;
  @Column({ type: 'uuid', nullable: true }) workflowInstanceId: string | null;
}

@Entity('expense_claim')
export class ExpenseClaim extends AppBaseEntity {
  @Column({ type: 'varchar', length: 40 }) number: string;
  @Column({ type: 'uuid' }) employeeId: string;
  @Column({ type: 'uuid', nullable: true }) travelRequestId: string | null;
  @Column({ type: 'varchar', length: 200 }) title: string;
  @Column({ type: 'numeric', precision: 14, scale: 2, default: 0 }) total: string;
  @Column({ type: 'numeric', precision: 14, scale: 2, default: 0 }) advanceOffset: string;
  @Column({ type: 'varchar', length: 10, default: 'draft' }) status: 'draft' | 'pending' | 'approved' | 'rejected' | 'returned' | 'cancelled';
  @Column({ type: 'char', length: 7, nullable: true }) paidPeriod: string | null;
  @Column({ type: 'varchar', length: 1000, nullable: true }) decisionComment: string | null;
  @Column({ type: 'uuid', nullable: true }) workflowInstanceId: string | null;
}

@Entity('expense_item')
export class ExpenseItem {
  @PrimaryColumn({ type: 'uuid', default: () => 'uuid_generate_v7()' }) id: string;
  @Column({ type: 'uuid' }) claimId: string;
  @Column({ type: 'date' }) spentOn: string;
  @Column({ type: 'varchar', length: 14 }) category: string;
  @Column({ type: 'varchar', length: 300 }) description: string;
  @Column({ type: 'numeric', precision: 14, scale: 2 }) amount: string;
  @Column({ type: 'uuid', nullable: true }) receiptDocumentId: string | null;
}

export const EXPENSE_ENTITIES = [TravelRequest, ExpenseClaim, ExpenseItem];
