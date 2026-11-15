import { Column, Entity, JoinColumn, ManyToOne, OneToMany, PrimaryColumn } from 'typeorm';
import { AppBaseEntity, numericTransformer } from '../../common/base.entity';

@Entity('workflow_definition')
export class WorkflowDefinition extends AppBaseEntity {
  @Column({ type: 'varchar', length: 40 }) code: string;
  @Column({ type: 'varchar', length: 200 }) name: string;
  @Column({ type: 'varchar', length: 40 }) requestType: string;
  @Column({ type: 'varchar', length: 500, nullable: true }) description: string | null;
  @Column({ type: 'jsonb', default: () => "'{}'" }) conditions: { kinds?: string[]; employment_types?: string[]; department_ids?: string[]; min_value?: number; max_value?: number };
  @Column({ type: 'int', default: 100 }) priority: number;
  @Column({ type: 'boolean', default: true }) isActive: boolean;
  @OneToMany(() => WorkflowStep, (s) => s.definition) steps?: WorkflowStep[];
}

@Entity('workflow_step')
export class WorkflowStep {
  @PrimaryColumn({ type: 'uuid', default: () => 'uuid_generate_v7()' }) id: string;
  @Column({ type: 'uuid' }) definitionId: string;
  @ManyToOne(() => WorkflowDefinition, (d) => d.steps, { onDelete: 'CASCADE' }) @JoinColumn({ name: 'definition_id' }) definition?: WorkflowDefinition;
  @Column({ type: 'int' }) stepNo: number;
  @Column({ type: 'varchar', length: 100 }) name: string;
  @Column({ type: 'varchar', length: 20 }) approverRule: 'line_manager' | 'manager_level' | 'department_head' | 'role' | 'user';
  @Column({ type: 'int', nullable: true }) level: number | null;
  @Column({ type: 'uuid', nullable: true }) roleId: string | null;
  @Column({ type: 'uuid', nullable: true }) userId: string | null;
  @Column({ type: 'numeric', precision: 10, scale: 2, nullable: true, transformer: numericTransformer }) minValue: number | null;
  @Column({ type: 'int', nullable: true }) escalateAfterHours: number | null;
  @Column({ type: 'varchar', length: 20, nullable: true }) escalateTo: 'next_manager' | 'role' | null;
  @Column({ type: 'uuid', nullable: true }) escalateRoleId: string | null;
}

@Entity('workflow_instance')
export class WorkflowInstance extends AppBaseEntity {
  @Column({ type: 'uuid' }) definitionId: string;
  @Column({ type: 'varchar', length: 40 }) definitionCode: string;
  @Column({ type: 'varchar', length: 40 }) requestType: string;
  @Column({ type: 'uuid' }) subjectId: string;
  @Column({ type: 'uuid', nullable: true }) subjectEmployeeId: string | null;
  @Column({ type: 'uuid', nullable: true }) requesterUserId: string | null;
  @Column({ type: 'varchar', length: 12, default: 'pending' }) status: 'pending' | 'approved' | 'rejected' | 'returned' | 'cancelled';
  @Column({ type: 'int', nullable: true }) currentStepNo: number | null;
  @Column({ type: 'varchar', length: 300 }) summary: string;
  @Column({ type: 'numeric', precision: 10, scale: 2, nullable: true, transformer: numericTransformer }) value: number | null;
  @Column({ type: 'jsonb', default: () => "'{}'" }) context: Record<string, unknown>;
  @Column({ type: 'timestamptz', precision: 3, nullable: true }) completedAt: Date | null;
  @OneToMany(() => WorkflowTask, (t) => t.instance) tasks?: WorkflowTask[];
}

@Entity('workflow_task')
export class WorkflowTask extends AppBaseEntity {
  @Column({ type: 'uuid' }) instanceId: string;
  @ManyToOne(() => WorkflowInstance, (i) => i.tasks, { onDelete: 'CASCADE' }) @JoinColumn({ name: 'instance_id' }) instance?: WorkflowInstance;
  @Column({ type: 'int' }) stepNo: number;
  @Column({ type: 'varchar', length: 100 }) stepName: string;
  @Column({ type: 'uuid', nullable: true }) assigneeUserId: string | null;
  @Column({ type: 'uuid', nullable: true }) candidateRoleId: string | null;
  @Column({ type: 'uuid', nullable: true }) onBehalfOfUserId: string | null;
  @Column({ type: 'varchar', length: 12, default: 'open' }) status: 'open' | 'approved' | 'rejected' | 'returned' | 'escalated' | 'skipped' | 'cancelled';
  @Column({ type: 'timestamptz', precision: 3, nullable: true }) dueAt: Date | null;
  @Column({ type: 'timestamptz', precision: 3, nullable: true }) actedAt: Date | null;
  @Column({ type: 'uuid', nullable: true }) actedBy: string | null;
  @Column({ type: 'varchar', length: 1000, nullable: true }) comment: string | null;
}

@Entity('workflow_delegation')
export class WorkflowDelegation extends AppBaseEntity {
  @Column({ type: 'uuid' }) fromUserId: string;
  @Column({ type: 'uuid' }) toUserId: string;
  @Column({ type: 'date' }) startsOn: string;
  @Column({ type: 'date' }) endsOn: string;
  @Column({ type: 'text', array: true, default: () => "'{}'" }) requestTypes: string[];
  @Column({ type: 'varchar', length: 300, nullable: true }) reason: string | null;
}

export const WORKFLOW_ENTITIES = [WorkflowDefinition, WorkflowStep, WorkflowInstance, WorkflowTask, WorkflowDelegation];
