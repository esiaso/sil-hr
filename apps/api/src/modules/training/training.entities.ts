import { Column, Entity } from 'typeorm';
import { AppBaseEntity } from '../../common/base.entity';

@Entity('training_programme')
export class TrainingProgramme extends AppBaseEntity {
  @Column({ type: 'varchar', length: 30 }) code: string;
  @Column({ type: 'varchar', length: 200 }) title: string;
  @Column({ type: 'varchar', length: 4000, nullable: true }) description: string | null;
  @Column({ type: 'varchar', length: 12 }) category: string;
  @Column({ type: 'varchar', length: 12 }) delivery: string;
  @Column({ type: 'varchar', length: 200, nullable: true }) provider: string | null;
  @Column({ type: 'numeric', precision: 6, scale: 2, default: 0 }) durationHours: string;
  @Column({ type: 'numeric', precision: 4, scale: 1, default: 0 }) cpdPoints: string;
  @Column({ type: 'varchar', length: 20, array: true, default: () => "'{}'" }) cpdBodies: string[];
  @Column({ type: 'varchar', length: 10, default: 'none' }) mandatoryFor: 'none' | 'all' | 'clinical';
  @Column({ type: 'int', nullable: true }) refreshMonths: number | null;
  @Column({ type: 'int', nullable: true }) passMark: number | null;
  @Column({ type: 'varchar', length: 10, default: 'active' }) status: 'active' | 'inactive';
}

@Entity('training_session')
export class TrainingSession extends AppBaseEntity {
  @Column({ type: 'varchar', length: 40 }) number: string;
  @Column({ type: 'uuid' }) programmeId: string;
  @Column({ type: 'timestamptz', precision: 3 }) startsAt: Date;
  @Column({ type: 'timestamptz', precision: 3 }) endsAt: Date;
  @Column({ type: 'varchar', length: 200, nullable: true }) venue: string | null;
  @Column({ type: 'varchar', length: 200, nullable: true }) trainer: string | null;
  @Column({ type: 'int', nullable: true }) capacity: number | null;
  @Column({ type: 'numeric', precision: 14, scale: 2, nullable: true }) costPerPerson: string | null;
  @Column({ type: 'boolean', default: true }) openForRequests: boolean;
  @Column({ type: 'varchar', length: 10, default: 'scheduled' }) status: 'scheduled' | 'completed' | 'cancelled';
}

export type EnrolmentStatus = 'requested' | 'enrolled' | 'attended' | 'absent' | 'withdrawn' | 'declined';

@Entity('training_enrolment')
export class TrainingEnrolment extends AppBaseEntity {
  @Column({ type: 'uuid' }) sessionId: string;
  @Column({ type: 'uuid' }) employeeId: string;
  @Column({ type: 'varchar', length: 10 }) status: EnrolmentStatus;
  @Column({ type: 'varchar', length: 1000, nullable: true }) reason: string | null;
  @Column({ type: 'int', nullable: true }) score: number | null;
  @Column({ type: 'boolean', nullable: true }) passed: boolean | null;
  @Column({ type: 'numeric', precision: 4, scale: 1, nullable: true }) cpdPoints: string | null;
  @Column({ type: 'date', nullable: true }) completedOn: string | null;
  @Column({ type: 'int', nullable: true }) feedbackRating: number | null;
  @Column({ type: 'varchar', length: 2000, nullable: true }) feedbackComment: string | null;
  @Column({ type: 'varchar', length: 1000, nullable: true }) decisionComment: string | null;
  @Column({ type: 'uuid', nullable: true }) workflowInstanceId: string | null;
}

@Entity('cpd_requirement')
export class CpdRequirement extends AppBaseEntity {
  @Column({ type: 'varchar', length: 20 }) licensingBody: string;
  @Column({ type: 'numeric', precision: 4, scale: 1 }) pointsPerYear: string;
  @Column({ type: 'varchar', length: 300, nullable: true }) description: string | null;
}

@Entity('cpd_entry')
export class CpdEntry extends AppBaseEntity {
  @Column({ type: 'uuid' }) employeeId: string;
  @Column({ type: 'varchar', length: 10 }) source: 'training' | 'external';
  @Column({ type: 'uuid', nullable: true }) enrolmentId: string | null;
  @Column({ type: 'varchar', length: 300 }) title: string;
  @Column({ type: 'varchar', length: 200, nullable: true }) provider: string | null;
  @Column({ type: 'date' }) activityDate: string;
  @Column({ type: 'numeric', precision: 4, scale: 1 }) points: string;
  @Column({ type: 'varchar', length: 20, nullable: true }) licensingBody: string | null;
  @Column({ type: 'uuid', nullable: true }) evidenceDocumentId: string | null;
  @Column({ type: 'varchar', length: 10, default: 'pending' }) status: 'pending' | 'verified' | 'rejected';
  @Column({ type: 'varchar', length: 1000, nullable: true }) decisionComment: string | null;
  @Column({ type: 'uuid', nullable: true }) verifiedBy: string | null;
  @Column({ type: 'timestamptz', precision: 3, nullable: true }) verifiedAt: Date | null;
}

export const TRAINING_ENTITIES = [TrainingProgramme, TrainingSession, TrainingEnrolment, CpdRequirement, CpdEntry];
