import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';
import { AppBaseEntity } from '../../common/base.entity';

@Entity('webhook_subscription')
export class WebhookSubscription extends AppBaseEntity {
  @Column({ type: 'varchar', length: 200 })
  name: string;

  @Column({ type: 'varchar', length: 500 })
  url: string;

  /** Exact event types, or '*' for every type. */
  @Column({ type: 'text', array: true })
  eventTypes: string[];

  /** `whsec_…` signing secret, AES-256-GCM encrypted (needed in clear to sign). */
  @Column({ type: 'varchar', length: 400, select: false })
  secretEnc: string;

  @Column({ type: 'varchar', length: 16 })
  secretPrefix: string;

  @Column({ type: 'varchar', length: 10, default: 'active' })
  status: 'active' | 'paused' | 'disabled';

  @Column({ type: 'varchar', length: 300, nullable: true })
  pausedReason: string | null;

  /** Dead-lettered deliveries in a row; reset by any success. */
  @Column({ type: 'int', default: 0 })
  consecutiveFailures: number;

  @Column({ type: 'timestamptz', precision: 3, nullable: true })
  lastDeliveryAt: Date | null;
}

/** One event to one subscription. Its id is the `webhook-id` header, stable across retries. */
@Entity('webhook_delivery')
@Index(['subscriptionId', 'createdAt'])
@Index('ix_webhook_delivery_due', ['nextAttemptAt'], { where: "status IN ('pending', 'retrying')" })
@Index(['subscriptionId', 'outboxEventId'], { unique: true })
export class WebhookDelivery {
  @PrimaryColumn({ type: 'uuid', default: () => 'uuid_generate_v7()' })
  id: string;

  @Column({ type: 'uuid' })
  subscriptionId: string;

  @ManyToOne(() => WebhookSubscription, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'subscription_id' })
  subscription?: WebhookSubscription;

  @Column({ type: 'bigint' })
  outboxEventId: string;

  @Column({ type: 'uuid' })
  eventId: string;

  @Column({ type: 'varchar', length: 100 })
  eventType: string;

  /** The exact CloudEvents body sent (and signed). */
  @Column({ type: 'jsonb' })
  payload: Record<string, unknown>;

  @Column({ type: 'varchar', length: 20, default: 'pending' })
  status: 'pending' | 'retrying' | 'delivered' | 'dead_lettered' | 'cancelled';

  @Column({ type: 'int', default: 0 })
  attemptCount: number;

  @Column({ type: 'timestamptz', precision: 3, nullable: true })
  nextAttemptAt: Date | null;

  @Column({ type: 'int', nullable: true })
  lastStatusCode: number | null;

  @Column({ type: 'varchar', length: 1000, nullable: true })
  lastError: string | null;

  @Column({ type: 'timestamptz', precision: 3, nullable: true })
  deliveredAt: Date | null;

  @CreateDateColumn({ type: 'timestamptz', precision: 3 })
  createdAt: Date;
}

@Entity('webhook_attempt')
@Index(['deliveryId', 'attemptNo'])
export class WebhookAttempt {
  @PrimaryColumn({ type: 'uuid', default: () => 'uuid_generate_v7()' })
  id: string;

  @Column({ type: 'uuid' })
  deliveryId: string;

  @ManyToOne(() => WebhookDelivery, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'delivery_id' })
  delivery?: WebhookDelivery;

  @Column({ type: 'int' })
  attemptNo: number;

  @CreateDateColumn({ type: 'timestamptz', precision: 3 })
  startedAt: Date;

  @Column({ type: 'int' })
  durationMs: number;

  @Column({ type: 'int', nullable: true })
  statusCode: number | null;

  @Column({ type: 'varchar', length: 1000, nullable: true })
  error: string | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  responseExcerpt: string | null;
}

export const WEBHOOK_ENTITIES = [WebhookSubscription, WebhookDelivery, WebhookAttempt];
