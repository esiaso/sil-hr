import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';
import { AppBaseEntity, numericTransformer } from '../../common/base.entity';

const MONEY = { type: 'numeric' as const, precision: 14, scale: 2 };

export type ContractType = 'permanent' | 'fixed_term' | 'probation' | 'locum' | 'internship' | 'casual';

@Entity('employee_contract')
export class EmployeeContract extends AppBaseEntity {
  @Column({ type: 'varchar', length: 40 }) number: string;
  @Column({ type: 'uuid' }) employeeId: string;
  @Column({ type: 'varchar', length: 15 }) contractType: ContractType;
  @Column({ type: 'uuid', nullable: true }) positionId: string | null;
  @Column({ type: 'date' }) startDate: string;
  @Column({ type: 'date', nullable: true }) endDate: string | null;
  @Column({ type: 'int', nullable: true }) probationMonths: number | null;
  @Column({ type: 'int', default: 30 }) noticeDays: number;
  @Column({ ...MONEY, nullable: true }) basic: string | null;
  @Column({ type: 'varchar', length: 4000, nullable: true }) terms: string | null;
  @Column({ type: 'uuid', nullable: true }) documentId: string | null;
  @Column({ type: 'varchar', length: 12, default: 'active' }) status: 'draft' | 'active' | 'ended' | 'renewed' | 'terminated';
  @Column({ type: 'uuid', nullable: true }) renewedFromId: string | null;
  @Column({ type: 'timestamptz', precision: 3, nullable: true }) remindedAt: Date | null;
}

export type LifecycleKind = 'promotion' | 'transfer' | 'confirmation' | 'contract_renewal' | 'resignation' | 'termination' | 'final_dues';

@Entity('lifecycle_request')
export class LifecycleRequest extends AppBaseEntity {
  @Column({ type: 'varchar', length: 40 }) number: string;
  @Column({ type: 'varchar', length: 20 }) kind: LifecycleKind;
  @Column({ type: 'uuid' }) employeeId: string;
  @Column({ type: 'date' }) effectiveDate: string;
  @Column({ type: 'jsonb', default: () => "'{}'" }) details: Record<string, unknown>;
  @Column({ type: 'varchar', length: 2000, nullable: true }) reason: string | null;
  @Column({ type: 'varchar', length: 10, default: 'pending' }) status: 'pending' | 'approved' | 'rejected' | 'returned' | 'cancelled';
  @Column({ type: 'varchar', length: 1000, nullable: true }) decisionComment: string | null;
  @Column({ type: 'uuid', nullable: true }) workflowInstanceId: string | null;
  @Column({ type: 'jsonb', nullable: true }) result: Record<string, unknown> | null;
}

export type Assignee = 'hr' | 'it' | 'facilities' | 'finance' | 'line_manager' | 'employee';

@Entity('checklist_template')
export class ChecklistTemplate extends AppBaseEntity {
  @Column({ type: 'varchar', length: 30 }) code: string;
  @Column({ type: 'varchar', length: 200 }) name: string;
  @Column({ type: 'varchar', length: 12 }) kind: 'onboarding' | 'offboarding';
  @Column({ type: 'varchar', length: 12, array: true, default: () => "'{}'" }) employmentTypes: string[];
  @Column({ type: 'boolean', default: false }) isDefault: boolean;
  @Column({ type: 'varchar', length: 10, default: 'active' }) status: 'active' | 'inactive';
}

@Entity('checklist_template_task')
export class ChecklistTemplateTask extends AppBaseEntity {
  @Column({ type: 'uuid' }) templateId: string;
  @Column({ type: 'int' }) seq: number;
  @Column({ type: 'varchar', length: 200 }) title: string;
  @Column({ type: 'varchar', length: 1000, nullable: true }) description: string | null;
  @Column({ type: 'varchar', length: 15 }) assignee: Assignee;
  @Column({ type: 'int', default: 0 }) dueOffsetDays: number;
  @Column({ type: 'boolean', default: false }) blocksExit: boolean;
}

@Entity('checklist')
export class Checklist extends AppBaseEntity {
  @Column({ type: 'uuid' }) employeeId: string;
  @Column({ type: 'varchar', length: 12 }) kind: 'onboarding' | 'offboarding';
  @Column({ type: 'uuid', nullable: true }) templateId: string | null;
  @Column({ type: 'date' }) anchorDate: string;
  @Column({ type: 'varchar', length: 10, default: 'open' }) status: 'open' | 'completed' | 'cancelled';
  @Column({ type: 'uuid', nullable: true }) lifecycleRequestId: string | null;
  @Column({ type: 'timestamptz', precision: 3, nullable: true }) completedAt: Date | null;
}

@Entity('checklist_task')
export class ChecklistTask extends AppBaseEntity {
  @Column({ type: 'uuid' }) checklistId: string;
  @Column({ type: 'int' }) seq: number;
  @Column({ type: 'varchar', length: 200 }) title: string;
  @Column({ type: 'varchar', length: 1000, nullable: true }) description: string | null;
  @Column({ type: 'varchar', length: 15 }) assignee: Assignee;
  @Column({ type: 'date' }) dueDate: string;
  @Column({ type: 'boolean', default: false }) blocksExit: boolean;
  @Column({ type: 'varchar', length: 16, default: 'open' }) status: 'open' | 'done' | 'not_applicable';
  @Column({ type: 'uuid', nullable: true }) doneBy: string | null;
  @Column({ type: 'timestamptz', precision: 3, nullable: true }) doneAt: Date | null;
  @Column({ type: 'varchar', length: 1000, nullable: true }) note: string | null;
}

export type ExitKind = 'resignation' | 'termination' | 'contract_end' | 'retirement' | 'death' | 'other';

@Entity('exit_clearance')
export class ExitClearance extends AppBaseEntity {
  @Column({ type: 'uuid' }) employeeId: string;
  @Column({ type: 'date' }) exitDate: string;
  @Column({ type: 'varchar', length: 12 }) exitKind: ExitKind;
  @Column({ type: 'int', default: 0 }) noticeDays: number;
  @Column({ type: 'int', default: 0 }) noticeServedDays: number;
  @Column({ type: 'jsonb', nullable: true }) procurement: Record<string, unknown> | null;
  @Column({ type: 'timestamptz', precision: 3, nullable: true }) procurementCheckedAt: Date | null;
  @Column({ type: 'boolean', nullable: true }) procurementCleared: boolean | null;
  @Column({ ...MONEY, default: 0 }) loansOutstanding: string;
  @Column({ type: 'numeric', precision: 6, scale: 2, default: 0, transformer: numericTransformer }) leaveDays: number;
  @Column({ ...MONEY, default: 0 }) leavePay: string;
  @Column({ ...MONEY, default: 0 }) noticePay: string;
  @Column({ type: 'varchar', length: 10, default: 'draft' }) finalDuesStatus: 'draft' | 'submitted' | 'approved' | 'posted';
  @Column({ type: 'uuid', nullable: true }) finalDuesRequestId: string | null;
  @Column({ type: 'timestamptz', precision: 3, nullable: true }) completedAt: Date | null;
}

export type CaseKind = 'warning' | 'improvement_plan' | 'complaint' | 'award' | 'disciplinary';

@Entity('relations_case')
export class RelationsCase extends AppBaseEntity {
  @Column({ type: 'varchar', length: 40 }) number: string;
  @Column({ type: 'varchar', length: 20 }) kind: CaseKind;
  @Column({ type: 'uuid', nullable: true }) employeeId: string | null;
  @Column({ type: 'varchar', length: 300 }) subject: string;
  @Column({ type: 'varchar', length: 8000, nullable: true }) details: string | null;
  @Column({ type: 'varchar', length: 10, nullable: true }) severity: 'verbal' | 'first' | 'final' | null;
  @Column({ type: 'date' }) openedOn: string;
  @Column({ type: 'date', nullable: true }) reviewDate: string | null;
  @Column({ type: 'date', nullable: true }) expiresOn: string | null;
  @Column({ type: 'varchar', length: 12, default: 'open' }) status: 'open' | 'closed' | 'withdrawn';
  @Column({ type: 'varchar', length: 4000, nullable: true }) outcome: string | null;
  @Column({ type: 'boolean', default: false }) restricted: boolean;
  @Column({ type: 'uuid', nullable: true }) complainantEmployeeId: string | null;
  @Column({ type: 'timestamptz', precision: 3, nullable: true }) acknowledgedAt: Date | null;
  @Column({ type: 'uuid', array: true, default: () => "'{}'" }) documentIds: string[];
}

@Entity('relations_case_access')
export class RelationsCaseAccess {
  @PrimaryColumn({ type: 'uuid' }) caseId: string;
  @PrimaryColumn({ type: 'uuid' }) userId: string;
  @Column({ type: 'varchar', length: 12, default: 'investigator' }) role: 'owner' | 'investigator';
}

@Entity('relations_note')
export class RelationsNote {
  @PrimaryColumn({ type: 'uuid', default: () => 'uuid_generate_v7()' }) id: string;
  @Column({ type: 'uuid' }) caseId: string;
  @CreateDateColumn({ type: 'timestamptz', precision: 3 }) createdAt: Date;
  @Column({ type: 'uuid', nullable: true }) createdBy: string | null;
  @Column({ type: 'varchar', length: 200, nullable: true }) authorName: string | null;
  @Column({ type: 'varchar', length: 4000 }) body: string;
  @Column({ type: 'boolean', default: false }) visibleToEmployee: boolean;
}

@Entity('improvement_objective')
export class ImprovementObjective extends AppBaseEntity {
  @Column({ type: 'uuid' }) caseId: string;
  @Column({ type: 'int' }) seq: number;
  @Column({ type: 'varchar', length: 1000 }) objective: string;
  @Column({ type: 'varchar', length: 1000, nullable: true }) measure: string | null;
  @Column({ type: 'date', nullable: true }) dueDate: string | null;
  @Column({ type: 'varchar', length: 12, default: 'open' }) status: 'open' | 'met' | 'not_met';
  @Column({ type: 'varchar', length: 1000, nullable: true }) comment: string | null;
}

@Entity('letter_template')
export class LetterTemplate extends AppBaseEntity {
  @Column({ type: 'varchar', length: 30 }) code: string;
  @Column({ type: 'varchar', length: 200 }) name: string;
  @Column({ type: 'text' }) body: string;
  @Column({ type: 'varchar', length: 10, default: 'active' }) status: 'active' | 'inactive';
}

@Entity('issued_letter')
export class IssuedLetter {
  @PrimaryColumn({ type: 'uuid', default: () => 'uuid_generate_v7()' }) id: string;
  @CreateDateColumn({ type: 'timestamptz', precision: 3 }) createdAt: Date;
  @Column({ type: 'uuid', nullable: true }) createdBy: string | null;
  @Column({ type: 'varchar', length: 40 }) number: string;
  @Column({ type: 'uuid' }) templateId: string;
  @Column({ type: 'uuid' }) employeeId: string;
  @Column({ type: 'varchar', length: 4 }) format: 'pdf' | 'docx';
  @Column({ type: 'uuid' }) documentId: string;
  @Column({ type: 'jsonb' }) fields: Record<string, string>;
}

export const LIFECYCLE_ENTITIES = [EmployeeContract, LifecycleRequest, ChecklistTemplate, ChecklistTemplateTask, Checklist, ChecklistTask, ExitClearance, RelationsCase, RelationsCaseAccess, RelationsNote, ImprovementObjective, LetterTemplate, IssuedLetter];
