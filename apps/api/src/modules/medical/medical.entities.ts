import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';
import { AppBaseEntity } from '../../common/base.entity';

/** Money reads as a decimal string (never a JS number). */
const MONEY = { type: 'numeric' as const, precision: 14, scale: 2 };
const PCT = { type: 'numeric' as const, precision: 5, scale: 2 };

@Entity('medical_scheme')
export class MedicalScheme extends AppBaseEntity {
  @Column({ type: 'varchar', length: 30 }) code: string;
  @Column({ type: 'varchar', length: 200 }) name: string;
  @Column({ type: 'varchar', length: 1000, nullable: true }) description: string | null;
  @Column({ type: 'int', default: 1 }) yearStartMonth: number;
  @Column({ type: 'varchar', length: 12, default: 'reset' }) unusedLimitPolicy: 'reset' | 'carry_over';
  @Column({ ...PCT, default: 100 }) carryOverMaxPct: string;
  @Column({ type: 'int', default: 5 }) maxDependants: number;
  @Column({ type: 'varchar', length: 10, default: 'approval' }) overLimitAction: 'block' | 'approval';
  @Column({ type: 'boolean', default: false }) contributionsEnabled: boolean;
  @Column({ type: 'varchar', length: 10, default: 'active' }) status: 'active' | 'inactive';
}

@Entity('medical_category')
export class MedicalCategory extends AppBaseEntity {
  @Column({ type: 'uuid' }) schemeId: string;
  @Column({ type: 'varchar', length: 30 }) code: string;
  @Column({ type: 'varchar', length: 200 }) name: string;
  @Column({ type: 'varchar', length: 12, default: 'shared' }) sharing: 'shared' | 'per_person';
  @Column({ ...PCT, default: 0 }) coPayPct: string;
  @Column({ ...MONEY, nullable: true }) perVisitCap: string | null;
  @Column({ type: 'int', default: 0 }) waitingDays: number;
  @Column({ type: 'boolean', default: false }) principalAndSpouseOnly: boolean;
  @Column({ type: 'int', default: 100 }) sortOrder: number;
  @Column({ type: 'varchar', length: 10, default: 'active' }) status: 'active' | 'inactive';
}

@Entity('medical_limit_rule')
export class MedicalLimitRule extends AppBaseEntity {
  @Column({ type: 'uuid' }) schemeId: string;
  @Column({ type: 'uuid' }) categoryId: string;
  @Column({ type: 'uuid', nullable: true }) jobGradeId: string | null;
  @Column({ type: 'varchar', length: 12, nullable: true }) employmentType: string | null;
  @Column(MONEY) annualLimit: string;
  @Column({ ...MONEY, nullable: true }) dependantLimit: string | null;
  @Column({ type: 'date' }) effectiveFrom: string;
  @Column({ type: 'date', nullable: true }) effectiveTo: string | null;
}

@Entity('medical_contribution_rate')
export class MedicalContributionRate extends AppBaseEntity {
  @Column({ type: 'uuid' }) schemeId: string;
  @Column({ type: 'uuid', nullable: true }) jobGradeId: string | null;
  @Column({ type: 'varchar', length: 12, nullable: true }) employmentType: string | null;
  @Column({ type: 'varchar', length: 15 }) method: 'fixed' | 'percent_basic';
  @Column({ type: 'numeric', precision: 14, scale: 4 }) value: string;
  @Column({ ...MONEY, default: 0 }) perDependant: string;
  @Column({ type: 'date' }) effectiveFrom: string;
  @Column({ type: 'date', nullable: true }) effectiveTo: string | null;
}

@Entity('medical_member')
export class MedicalMember extends AppBaseEntity {
  @Column({ type: 'uuid' }) schemeId: string;
  @Column({ type: 'uuid' }) employeeId: string;
  @Column({ type: 'uuid', nullable: true }) dependantId: string | null;
  @Column({ type: 'uuid', nullable: true }) principalMemberId: string | null;
  @Column({ type: 'varchar', length: 30 }) memberNumber: string;
  @Column({ type: 'varchar', length: 300 }) name: string;
  @Column({ type: 'varchar', length: 12 }) relationship: 'principal' | 'spouse' | 'child' | 'other';
  @Column({ type: 'date', nullable: true }) dateOfBirth: string | null;
  @Column({ type: 'date' }) coverStart: string;
  @Column({ type: 'date', nullable: true }) coverEnd: string | null;
  @Column({ type: 'varchar', length: 10, default: 'active' }) status: 'active' | 'ended';
  @Column({ type: 'varchar', length: 200, nullable: true }) endReason: string | null;
}

export type ApplicationKind = 'enrol' | 'add_dependant' | 'remove_dependant' | 'top_up' | 'pre_auth' | 'over_limit_claim';

@Entity('medical_application')
export class MedicalApplication extends AppBaseEntity {
  @Column({ type: 'varchar', length: 40 }) number: string;
  @Column({ type: 'varchar', length: 20 }) kind: ApplicationKind;
  @Column({ type: 'uuid' }) schemeId: string;
  @Column({ type: 'uuid' }) employeeId: string;
  @Column({ type: 'uuid', nullable: true }) memberId: string | null;
  @Column({ type: 'uuid', nullable: true }) categoryId: string | null;
  @Column({ ...MONEY, nullable: true }) amount: string | null;
  @Column({ type: 'date', nullable: true }) effectiveDate: string | null;
  @Column({ type: 'jsonb', default: () => "'{}'" }) details: Record<string, unknown>;
  @Column({ type: 'uuid', array: true, default: () => "'{}'" }) documentIds: string[];
  @Column({ type: 'varchar', length: 1000, nullable: true }) reason: string | null;
  @Column({ type: 'varchar', length: 10, default: 'pending' }) status: 'pending' | 'approved' | 'rejected' | 'returned' | 'cancelled';
  @Column({ type: 'varchar', length: 1000, nullable: true }) decisionComment: string | null;
  @Column({ type: 'uuid', nullable: true }) workflowInstanceId: string | null;
  @Column({ type: 'jsonb', nullable: true }) result: Record<string, unknown> | null;
}

export type LedgerType = 'claim' | 'reversal' | 'adjustment' | 'top_up' | 'carry_over' | 'hold' | 'hold_release';

/** Append-only (trigger): nothing here is ever updated or deleted. */
@Entity('medical_ledger')
export class MedicalLedger {
  @PrimaryColumn({ type: 'uuid', default: () => 'uuid_generate_v7()' }) id: string;
  @CreateDateColumn({ type: 'timestamptz', precision: 3 }) createdAt: Date;
  @Column({ type: 'uuid', nullable: true }) createdBy: string | null;
  @Column({ type: 'uuid' }) schemeId: string;
  @Column({ type: 'uuid' }) categoryId: string;
  @Column({ type: 'uuid' }) poolMemberId: string;
  @Column({ type: 'uuid' }) memberId: string;
  @Column({ type: 'int' }) schemeYear: number;
  @Column({ type: 'varchar', length: 15 }) entryType: LedgerType;
  @Column(MONEY) amount: string;
  @Column({ ...MONEY, nullable: true }) invoiceAmount: string | null;
  @Column({ ...MONEY, nullable: true }) memberShare: string | null;
  @Column({ type: 'date' }) occurredOn: string;
  @Column({ type: 'varchar', length: 200, nullable: true }) facility: string | null;
  @Column({ type: 'varchar', length: 200, nullable: true }) department: string | null;
  @Column({ type: 'varchar', length: 100, nullable: true }) invoiceRef: string | null;
  @Column({ type: 'varchar', length: 200, nullable: true }) externalRef: string | null;
  @Column({ type: 'varchar', length: 10, default: 'web' }) source: 'web' | 'api' | 'system';
  @Column({ type: 'uuid', nullable: true }) reversesId: string | null;
  @Column({ type: 'uuid', nullable: true }) holdId: string | null;
  @Column({ type: 'date', nullable: true }) expiresOn: string | null;
  @Column({ type: 'varchar', length: 500, nullable: true }) reason: string | null;
  @Column({ type: 'uuid', nullable: true }) documentId: string | null;
  @Column({ type: 'uuid', nullable: true }) applicationId: string | null;
}

export const MEDICAL_ENTITIES = [MedicalScheme, MedicalCategory, MedicalLimitRule, MedicalContributionRate, MedicalMember, MedicalApplication, MedicalLedger];
