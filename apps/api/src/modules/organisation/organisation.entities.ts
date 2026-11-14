import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { AppBaseEntity, SoftDeleteEntity } from '../../common/base.entity';

/** The legal entity. One row in this build; root tables reference it so a second could be added. */
@Entity('organisation')
export class Organisation extends AppBaseEntity {
  @Index({ unique: true })
  @Column({ type: 'varchar', length: 40 })
  code: string;

  @Column({ type: 'varchar', length: 200 })
  name: string;

  @Column({ type: 'varchar', length: 200, nullable: true })
  legalName: string | null;

  @Column({ type: 'varchar', length: 20, nullable: true })
  kraPin: string | null;

  @Column({ type: 'varchar', length: 40, nullable: true })
  nssfEmployerNo: string | null;

  @Column({ type: 'varchar', length: 40, nullable: true })
  shaEmployerNo: string | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  address: string | null;

  @Column({ type: 'varchar', length: 40, nullable: true })
  phone: string | null;

  @Column({ type: 'varchar', length: 200, nullable: true })
  email: string | null;

  @Column({ type: 'varchar', length: 200, nullable: true })
  website: string | null;
}

/** A site: main hospital, satellite clinic… */
@Entity('branch')
@Index(['organisationId', 'code'], { unique: true, where: 'deleted_at IS NULL' })
export class Branch extends SoftDeleteEntity {
  @Column({ type: 'uuid' })
  organisationId: string;

  @ManyToOne(() => Organisation, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'organisation_id' })
  organisation?: Organisation;

  @Column({ type: 'varchar', length: 40 })
  code: string;

  @Column({ type: 'varchar', length: 200 })
  name: string;

  @Column({ type: 'varchar', length: 500, nullable: true })
  address: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  city: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  county: string | null;

  @Column({ type: 'varchar', length: 40, nullable: true })
  phone: string | null;

  @Column({ type: 'varchar', length: 200, nullable: true })
  email: string | null;

  @Column({ type: 'varchar', length: 60, nullable: true })
  timezone: string | null;

  @Column({ type: 'varchar', length: 10, default: 'active' })
  status: 'active' | 'inactive';
}

@Entity('cost_centre')
@Index(['organisationId', 'code'], { unique: true, where: 'deleted_at IS NULL' })
export class CostCentre extends SoftDeleteEntity {
  @Column({ type: 'uuid' })
  organisationId: string;

  @ManyToOne(() => Organisation, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'organisation_id' })
  organisation?: Organisation;

  @Column({ type: 'varchar', length: 40 })
  code: string;

  @Column({ type: 'varchar', length: 200 })
  name: string;

  @Column({ type: 'varchar', length: 500, nullable: true })
  description: string | null;

  @Column({ type: 'varchar', length: 10, default: 'active' })
  status: 'active' | 'inactive';
}

/**
 * Departments form a tree within a branch (department → sub-department → unit).
 * `path` holds the ancestor ids, root first, so subtree queries are one index lookup.
 */
@Entity('department')
@Index(['organisationId', 'code'], { unique: true, where: 'deleted_at IS NULL' })
export class Department extends SoftDeleteEntity {
  @Column({ type: 'uuid' })
  organisationId: string;

  @ManyToOne(() => Organisation, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'organisation_id' })
  organisation?: Organisation;

  @Column({ type: 'uuid' })
  branchId: string;

  @ManyToOne(() => Branch, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'branch_id' })
  branch?: Branch;

  @Column({ type: 'uuid', nullable: true })
  parentId: string | null;

  @ManyToOne(() => Department, { onDelete: 'RESTRICT', nullable: true })
  @JoinColumn({ name: 'parent_id' })
  parent?: Department | null;

  @Column({ type: 'uuid', nullable: true })
  costCentreId: string | null;

  @ManyToOne(() => CostCentre, { onDelete: 'RESTRICT', nullable: true })
  @JoinColumn({ name: 'cost_centre_id' })
  costCentre?: CostCentre | null;

  @Column({ type: 'varchar', length: 40 })
  code: string;

  @Column({ type: 'varchar', length: 200 })
  name: string;

  @Column({ type: 'varchar', length: 1000, nullable: true })
  description: string | null;

  @Column({ type: 'uuid', array: true, default: () => "'{}'" })
  path: string[];

  @Column({ type: 'varchar', length: 10, default: 'active' })
  status: 'active' | 'inactive';
}

@Entity('job_grade')
@Index(['organisationId', 'code'], { unique: true, where: 'deleted_at IS NULL' })
export class JobGrade extends SoftDeleteEntity {
  @Column({ type: 'uuid' })
  organisationId: string;

  @ManyToOne(() => Organisation, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'organisation_id' })
  organisation?: Organisation;

  @Column({ type: 'varchar', length: 40 })
  code: string;

  @Column({ type: 'varchar', length: 200 })
  name: string;

  /** Lower = more senior. */
  @Column({ type: 'int' })
  rank: number;

  @Column({ type: 'varchar', length: 500, nullable: true })
  description: string | null;

  @Column({ type: 'varchar', length: 10, default: 'active' })
  status: 'active' | 'inactive';
}

/** A designation in a department with an approved headcount. */
@Entity('position')
@Index(['organisationId', 'code'], { unique: true, where: 'deleted_at IS NULL' })
export class Position extends SoftDeleteEntity {
  @Column({ type: 'uuid' })
  organisationId: string;

  @ManyToOne(() => Organisation, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'organisation_id' })
  organisation?: Organisation;

  @Column({ type: 'uuid' })
  departmentId: string;

  @ManyToOne(() => Department, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'department_id' })
  department?: Department;

  @Column({ type: 'uuid', nullable: true })
  jobGradeId: string | null;

  @ManyToOne(() => JobGrade, { onDelete: 'RESTRICT', nullable: true })
  @JoinColumn({ name: 'job_grade_id' })
  jobGrade?: JobGrade | null;

  @Column({ type: 'uuid', nullable: true })
  reportsToPositionId: string | null;

  @ManyToOne(() => Position, { onDelete: 'RESTRICT', nullable: true })
  @JoinColumn({ name: 'reports_to_position_id' })
  reportsTo?: Position | null;

  @Column({ type: 'varchar', length: 40 })
  code: string;

  @Column({ type: 'varchar', length: 200 })
  title: string;

  @Column({ type: 'varchar', length: 2000, nullable: true })
  description: string | null;

  @Column({ type: 'int', default: 1 })
  headcount: number;

  @Column({ type: 'boolean', default: false })
  isClinical: boolean;

  @Column({ type: 'varchar', length: 100, nullable: true })
  licenceRequired: string | null;

  @Column({ type: 'varchar', length: 10, default: 'active' })
  status: 'active' | 'inactive';
}

export const ORGANISATION_ENTITIES = [Organisation, Branch, CostCentre, Department, JobGrade, Position];
