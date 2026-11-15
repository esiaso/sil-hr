import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';
import { AppBaseEntity, numericTransformer } from '../../common/base.entity';

const MONEY = { type: 'numeric' as const, precision: 14, scale: 2 };

@Entity('job_requisition')
export class JobRequisition extends AppBaseEntity {
  @Column({ type: 'varchar', length: 40 }) number: string;
  @Column({ type: 'uuid' }) positionId: string;
  @Column({ type: 'int', default: 1 }) headcount: number;
  @Column({ type: 'varchar', length: 12 }) employmentType: string;
  @Column({ type: 'varchar', length: 12 }) reason: 'new' | 'replacement' | 'temporary';
  @Column({ type: 'uuid', nullable: true }) replacesEmployeeId: string | null;
  @Column({ ...MONEY, nullable: true }) salaryMin: string | null;
  @Column({ ...MONEY, nullable: true }) salaryMax: string | null;
  @Column({ type: 'date', nullable: true }) neededBy: string | null;
  @Column({ type: 'varchar', length: 4000 }) justification: string;
  @Column({ type: 'varchar', length: 10, default: 'pending' }) status: 'pending' | 'approved' | 'rejected' | 'returned' | 'filled' | 'cancelled';
  @Column({ type: 'uuid', nullable: true }) requestedBy: string | null;
  @Column({ type: 'varchar', length: 1000, nullable: true }) decisionComment: string | null;
  @Column({ type: 'uuid', nullable: true }) workflowInstanceId: string | null;
  @Column({ type: 'int', default: 0 }) hired: number;
}

export interface PostingQuestion { key: string; label: string; type: 'text' | 'yes_no' | 'number'; required: boolean }

@Entity('job_posting')
export class JobPosting extends AppBaseEntity {
  @Column({ type: 'uuid' }) requisitionId: string;
  @Column({ type: 'varchar', length: 120 }) slug: string;
  @Column({ type: 'varchar', length: 200 }) title: string;
  @Column({ type: 'varchar', length: 500, nullable: true }) summary: string | null;
  @Column({ type: 'text' }) description: string;
  @Column({ type: 'text', nullable: true }) requirements: string | null;
  @Column({ type: 'varchar', length: 200, nullable: true }) location: string | null;
  @Column({ type: 'varchar', length: 12 }) employmentType: string;
  @Column({ type: 'boolean', default: false }) showSalary: boolean;
  @Column({ type: 'date' }) closingDate: string;
  @Column({ type: 'boolean', default: false }) internalOnly: boolean;
  @Column({ type: 'jsonb', default: () => "'[]'" }) questions: PostingQuestion[];
  @Column({ type: 'varchar', length: 10, default: 'draft' }) status: 'draft' | 'published' | 'closed';
  @Column({ type: 'timestamptz', precision: 3, nullable: true }) publishedAt: Date | null;
}

@Entity('candidate')
export class Candidate extends AppBaseEntity {
  @Column({ type: 'varchar', length: 200 }) email: string;
  @Column({ type: 'varchar', length: 100 }) firstName: string;
  @Column({ type: 'varchar', length: 100 }) lastName: string;
  @Column({ type: 'varchar', length: 30, nullable: true }) phone: string | null;
  @Column({ type: 'varchar', length: 200, nullable: true }) location: string | null;
  @Column({ type: 'uuid', nullable: true }) employeeId: string | null;
  @Column({ type: 'timestamptz', precision: 3 }) consentAt: Date;
  @Column({ type: 'date' }) retainUntil: string;
}

export const STAGES = ['applied', 'screening', 'shortlisted', 'interview', 'assessment', 'offer', 'hired', 'rejected', 'withdrawn'] as const;
export type Stage = (typeof STAGES)[number];

@Entity('job_application')
export class JobApplication extends AppBaseEntity {
  @Column({ type: 'varchar', length: 40 }) number: string;
  @Column({ type: 'uuid' }) postingId: string;
  @Column({ type: 'uuid' }) candidateId: string;
  @Column({ type: 'varchar', length: 12, default: 'careers' }) source: 'careers' | 'internal' | 'referral' | 'agency' | 'other';
  @Column({ type: 'varchar', length: 12, default: 'applied' }) stage: Stage;
  @Column({ type: 'uuid', nullable: true }) cvDocumentId: string | null;
  @Column({ type: 'varchar', length: 4000, nullable: true }) coverNote: string | null;
  @Column({ type: 'jsonb', default: () => "'{}'" }) answers: Record<string, string>;
  @Column({ type: 'int', nullable: true }) rating: number | null;
  @Column({ type: 'varchar', length: 500, nullable: true }) rejectionReason: string | null;
  @Column({ type: 'uuid', nullable: true }) hiredEmployeeId: string | null;
}

@Entity('application_event')
export class ApplicationEvent {
  @PrimaryColumn({ type: 'uuid', default: () => 'uuid_generate_v7()' }) id: string;
  @Column({ type: 'uuid' }) applicationId: string;
  @CreateDateColumn({ type: 'timestamptz', precision: 3 }) createdAt: Date;
  @Column({ type: 'uuid', nullable: true }) createdBy: string | null;
  @Column({ type: 'varchar', length: 200, nullable: true }) actorName: string | null;
  @Column({ type: 'varchar', length: 12, nullable: true }) fromStage: string | null;
  @Column({ type: 'varchar', length: 12, nullable: true }) toStage: string | null;
  @Column({ type: 'varchar', length: 2000, nullable: true }) note: string | null;
}

@Entity('interview')
export class Interview extends AppBaseEntity {
  @Column({ type: 'uuid' }) applicationId: string;
  @Column({ type: 'timestamptz', precision: 3 }) scheduledAt: Date;
  @Column({ type: 'int', default: 45 }) durationMinutes: number;
  @Column({ type: 'varchar', length: 300, nullable: true }) location: string | null;
  @Column({ type: 'varchar', length: 12, default: 'panel' }) kind: 'phone' | 'panel' | 'practical' | 'online';
  @Column({ type: 'varchar', length: 12, default: 'scheduled' }) status: 'scheduled' | 'completed' | 'cancelled' | 'no_show';
  @Column({ type: 'uuid', array: true, default: () => "'{}'" }) panelUserIds: string[];
}

@Entity('interview_feedback')
export class InterviewFeedback extends AppBaseEntity {
  @Column({ type: 'uuid' }) interviewId: string;
  @Column({ type: 'uuid' }) userId: string;
  @Column({ type: 'jsonb', default: () => "'{}'" }) scores: Record<string, number>;
  @Column({ type: 'varchar', length: 12 }) recommendation: 'strong_yes' | 'yes' | 'no' | 'strong_no';
  @Column({ type: 'varchar', length: 4000, nullable: true }) comment: string | null;
}

@Entity('assessment')
export class Assessment extends AppBaseEntity {
  @Column({ type: 'uuid' }) applicationId: string;
  @Column({ type: 'varchar', length: 200 }) name: string;
  @Column({ type: 'numeric', precision: 6, scale: 2, transformer: numericTransformer }) score: number;
  @Column({ type: 'numeric', precision: 6, scale: 2, transformer: numericTransformer }) maxScore: number;
  @Column({ type: 'date' }) takenOn: string;
  @Column({ type: 'varchar', length: 2000, nullable: true }) notes: string | null;
}

@Entity('job_offer')
export class JobOffer extends AppBaseEntity {
  @Column({ type: 'varchar', length: 40 }) number: string;
  @Column({ type: 'uuid' }) applicationId: string;
  @Column({ type: 'uuid' }) positionId: string;
  @Column({ type: 'varchar', length: 15 }) contractType: string;
  @Column({ type: 'date' }) startDate: string;
  @Column({ type: 'date', nullable: true }) endDate: string | null;
  @Column(MONEY) basic: string;
  @Column({ type: 'int', nullable: true }) probationMonths: number | null;
  @Column({ type: 'int', default: 30 }) noticeDays: number;
  @Column({ type: 'varchar', length: 4000, nullable: true }) conditions: string | null;
  @Column({ type: 'varchar', length: 10, default: 'pending' }) status: 'pending' | 'approved' | 'rejected' | 'returned' | 'accepted' | 'declined' | 'withdrawn';
  @Column({ type: 'varchar', length: 1000, nullable: true }) decisionComment: string | null;
  @Column({ type: 'uuid', nullable: true }) workflowInstanceId: string | null;
  @Column({ type: 'uuid', nullable: true }) letterDocumentId: string | null;
  @Column({ type: 'timestamptz', precision: 3, nullable: true }) respondedAt: Date | null;
  @Column({ type: 'uuid', nullable: true }) employeeId: string | null;
}

export const RECRUITMENT_ENTITIES = [JobRequisition, JobPosting, Candidate, JobApplication, ApplicationEvent, Interview, InterviewFeedback, Assessment, JobOffer];
