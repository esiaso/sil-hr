import { Column, Entity } from 'typeorm';
import { AppBaseEntity } from '../../common/base.entity';

@Entity('performance_indicator')
export class PerformanceIndicator extends AppBaseEntity {
  @Column({ type: 'varchar', length: 30 }) code: string;
  @Column({ type: 'varchar', length: 200 }) name: string;
  @Column({ type: 'varchar', length: 2000, nullable: true }) description: string | null;
  @Column({ type: 'varchar', length: 20 }) category: string;
  @Column({ type: 'varchar', length: 10 }) measure: 'rating' | 'percent' | 'number' | 'yes_no';
  @Column({ type: 'varchar', length: 100, nullable: true }) defaultTarget: string | null;
  @Column({ type: 'uuid', nullable: true }) departmentId: string | null;
  @Column({ type: 'uuid', nullable: true }) positionId: string | null;
  @Column({ type: 'varchar', length: 10, default: 'active' }) status: 'active' | 'inactive';
}

@Entity('review_cycle')
export class ReviewCycle extends AppBaseEntity {
  @Column({ type: 'varchar', length: 120 }) name: string;
  @Column({ type: 'varchar', length: 10 }) kind: 'annual' | 'mid_year' | 'quarterly' | 'probation';
  @Column({ type: 'date' }) periodStart: string;
  @Column({ type: 'date' }) periodEnd: string;
  @Column({ type: 'date' }) goalsDue: string;
  @Column({ type: 'date' }) selfReviewDue: string;
  @Column({ type: 'date' }) managerReviewDue: string;
  @Column({ type: 'uuid', nullable: true }) departmentId: string | null;
  @Column({ type: 'varchar', length: 12, default: 'draft' }) status: 'draft' | 'goal_setting' | 'reviewing' | 'closed';
  @Column({ type: 'timestamptz', precision: 3, nullable: true }) launchedAt: Date | null;
}

export type ReviewStatus = 'goal_setting' | 'self_review' | 'manager_review' | 'approval' | 'acknowledgement' | 'completed';

@Entity('performance_review')
export class PerformanceReview extends AppBaseEntity {
  @Column({ type: 'uuid' }) cycleId: string;
  @Column({ type: 'uuid' }) employeeId: string;
  @Column({ type: 'uuid', nullable: true }) reviewerUserId: string | null;
  @Column({ type: 'varchar', length: 16, default: 'goal_setting' }) status: ReviewStatus;
  @Column({ type: 'numeric', precision: 3, scale: 2, nullable: true }) selfRating: string | null;
  @Column({ type: 'varchar', length: 4000, nullable: true }) selfComment: string | null;
  @Column({ type: 'timestamptz', precision: 3, nullable: true }) selfSubmittedAt: Date | null;
  @Column({ type: 'numeric', precision: 3, scale: 2, nullable: true }) managerRating: string | null;
  @Column({ type: 'varchar', length: 4000, nullable: true }) managerComment: string | null;
  @Column({ type: 'varchar', length: 4000, nullable: true }) strengths: string | null;
  @Column({ type: 'varchar', length: 4000, nullable: true }) developmentNeeds: string | null;
  @Column({ type: 'timestamptz', precision: 3, nullable: true }) managerSubmittedAt: Date | null;
  @Column({ type: 'numeric', precision: 3, scale: 2, nullable: true }) finalRating: string | null;
  @Column({ type: 'varchar', length: 2000, nullable: true }) calibrationComment: string | null;
  @Column({ type: 'boolean', nullable: true }) employeeAgrees: boolean | null;
  @Column({ type: 'varchar', length: 2000, nullable: true }) employeeComment: string | null;
  @Column({ type: 'timestamptz', precision: 3, nullable: true }) acknowledgedAt: Date | null;
  @Column({ type: 'uuid', nullable: true }) workflowInstanceId: string | null;
}

@Entity('performance_goal')
export class PerformanceGoal extends AppBaseEntity {
  @Column({ type: 'uuid' }) reviewId: string;
  @Column({ type: 'uuid', nullable: true }) indicatorId: string | null;
  @Column({ type: 'varchar', length: 300 }) title: string;
  @Column({ type: 'varchar', length: 2000, nullable: true }) description: string | null;
  @Column({ type: 'varchar', length: 10 }) measure: 'rating' | 'percent' | 'number' | 'yes_no';
  @Column({ type: 'varchar', length: 100, nullable: true }) target: string | null;
  @Column({ type: 'int' }) weight: number;
  @Column({ type: 'varchar', length: 10, default: 'proposed' }) status: 'proposed' | 'agreed' | 'dropped';
  @Column({ type: 'int', default: 0 }) progress: number;
  @Column({ type: 'varchar', length: 1000, nullable: true }) progressNote: string | null;
  @Column({ type: 'int', nullable: true }) selfScore: number | null;
  @Column({ type: 'varchar', length: 2000, nullable: true }) selfComment: string | null;
  @Column({ type: 'int', nullable: true }) managerScore: number | null;
  @Column({ type: 'varchar', length: 2000, nullable: true }) managerComment: string | null;
}

export const PERFORMANCE_ENTITIES = [PerformanceIndicator, ReviewCycle, PerformanceReview, PerformanceGoal];
