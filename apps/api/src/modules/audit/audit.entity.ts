import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonObject = Record<string, any>;

/**
 * Append-only: a database trigger rejects UPDATE, DELETE and TRUNCATE.
 * The id is a bigint identity so entries have a total order.
 */
@Entity('audit_log')
@Index(['entityType', 'entityId'])
@Index(['occurredAt'])
export class AuditLog {
  @PrimaryGeneratedColumn('identity', { type: 'bigint', generatedIdentity: 'ALWAYS' })
  id: string;

  @CreateDateColumn({ type: 'timestamptz', precision: 3 })
  occurredAt: Date;

  @Column({ type: 'varchar', length: 10 })
  actorType: string;

  @Index()
  @Column({ type: 'uuid', nullable: true })
  actorId: string | null;

  @Column({ type: 'varchar', length: 200, nullable: true })
  actorName: string | null;

  @Column({ type: 'varchar', length: 30 })
  action: string;

  @Column({ type: 'varchar', length: 100 })
  entityType: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  entityId: string | null;

  @Column({ type: 'jsonb', nullable: true })
  before: JsonObject | null;

  @Column({ type: 'jsonb', nullable: true })
  after: JsonObject | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  ip: string | null;

  @Column({ type: 'varchar', length: 300, nullable: true })
  userAgent: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  correlationId: string | null;
}
