import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type Redis from 'ioredis';
import { DataSource, EntityManager } from 'typeorm';
import { WEBHOOK_HEADERS, type CloudEvent } from '@sil/hr-shared';
import { loadEnv } from '../../config/env';
import { decrypt } from '../../common/crypto';
import { InjectRedis } from '../../common/redis';
import { OutboxEvent, toCloudEvent } from '../events/events.module';
import { NotificationsService } from '../notifications/notifications.module';
import { SettingsService } from '../settings/settings.module';
import { backoffSeconds, sign } from './signing';
import { WebhookAttempt, WebhookDelivery, WebhookSubscription } from './webhook.entities';

/**
 * Where published events go. Domain code never sees this: it writes to the outbox.
 * Adding NATS, Kafka or RabbitMQ is one more adapter.
 */
export interface EventPublisher {
  readonly name: string;
  /** Runs inside the transaction that marks the outbox row published; throw to retry later. */
  publish(manager: EntityManager, row: OutboxEvent, event: CloudEvent): Promise<void>;
}
export const EVENT_PUBLISHERS = Symbol('EVENT_PUBLISHERS');

/** Fans an event out into one durable delivery per matching active subscription. */
@Injectable()
export class WebhookPublisher implements EventPublisher {
  readonly name = 'webhooks';

  async publish(m: EntityManager, row: OutboxEvent, event: CloudEvent): Promise<void> {
    // Test events go to one subscription whatever its filter (but never to a disabled one).
    const params: unknown[] = row.onlySubscriptionId ? [row.onlySubscriptionId] : [row.type];
    const filter = row.onlySubscriptionId
      ? `status <> 'disabled' AND id = $1::uuid`
      : `status = 'active' AND ($1::text = ANY(event_types) OR '*' = ANY(event_types))`;
    await m.query(
      `INSERT INTO webhook_delivery (subscription_id, outbox_event_id, event_id, event_type, payload, status, next_attempt_at)
       SELECT id, $${params.length + 1}, $${params.length + 2}, $${params.length + 3}, $${params.length + 4}::jsonb, 'pending', now()
         FROM webhook_subscription WHERE ${filter}
       ON CONFLICT (subscription_id, outbox_event_id) DO NOTHING`,
      [...params, row.id, row.eventId, row.type, JSON.stringify(event)],
    );
  }
}

/** Appends every event to a Redis Stream for consumers inside the network. */
@Injectable()
export class RedisStreamPublisher implements EventPublisher {
  readonly name = 'redis_stream';

  constructor(@InjectRedis() private readonly redis: Redis) {}

  async publish(_m: EntityManager, row: OutboxEvent, event: CloudEvent): Promise<void> {
    if (row.onlySubscriptionId) return;
    await this.redis.xadd(loadEnv().eventStream, 'MAXLEN', '~', '1000000', '*', 'id', event.id, 'type', event.type, 'event', JSON.stringify(event));
  }
}

@Injectable()
export class OutboxPublisher {
  private readonly logger = new Logger('OutboxPublisher');

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(EVENT_PUBLISHERS) private readonly publishers: EventPublisher[],
  ) {}

  /**
   * Publishes up to `limit` unpublished events in order. Each event is its own
   * transaction: a failing adapter leaves that event unpublished (retried next pass)
   * without blocking the others. Safe to run in several workers at once.
   */
  async drainOnce(limit = 100): Promise<number> {
    let published = 0;
    for (let i = 0; i < limit; i++) {
      let claimed: OutboxEvent | null = null;
      try {
        const done = await this.dataSource.transaction(async (m) => {
          claimed = await m
            .getRepository(OutboxEvent)
            .createQueryBuilder('o')
            .where('o.published_at IS NULL')
            .orderBy('o.id', 'ASC')
            .limit(1)
            .setLock('pessimistic_write')
            .setOnLocked('skip_locked')
            .getOne();
          if (!claimed) return false;
          const event = toCloudEvent(claimed);
          for (const p of this.publishers) await p.publish(m, claimed, event);
          await m.getRepository(OutboxEvent).update({ id: claimed.id }, { publishedAt: new Date(), attempts: claimed.attempts + 1, lastError: null });
          return true;
        });
        if (!done) break;
        published++;
      } catch (err) {
        const row = claimed as OutboxEvent | null;
        this.logger.warn({ err, eventId: row?.eventId }, 'Publishing failed; will retry');
        if (row) {
          await this.dataSource.getRepository(OutboxEvent).update({ id: row.id }, { attempts: row.attempts + 1, lastError: String((err as Error).message).slice(0, 1000) });
        }
        break;
      }
    }
    return published;
  }
}

/** Sends due webhook deliveries, records every attempt and schedules retries. */
@Injectable()
export class WebhookDeliveryProcessor {
  private readonly logger = new Logger('WebhookDelivery');

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly settings: SettingsService,
    private readonly notifications: NotificationsService,
  ) {}

  /** Leases due deliveries (so parallel workers never send one twice) and sends them. */
  async processDue(limit = 20): Promise<number> {
    // TypeORM's postgres driver returns [rows, affectedCount] for UPDATE … RETURNING.
    const [leased]: [{ id: string }[], number] = await this.dataSource.query(
      `UPDATE webhook_delivery d SET next_attempt_at = now() + interval '2 minutes'
        WHERE d.id IN (
          SELECT d2.id FROM webhook_delivery d2 JOIN webhook_subscription s ON s.id = d2.subscription_id
           WHERE d2.status IN ('pending', 'retrying') AND d2.next_attempt_at <= now()
             AND (s.status = 'active' OR (s.status = 'paused' AND d2.event_type = 'hr.webhook.test.v1'))
           ORDER BY d2.next_attempt_at LIMIT $1 FOR UPDATE OF d2 SKIP LOCKED)
        RETURNING d.id`,
      [limit],
    );
    for (const { id } of leased) await this.attempt(id);
    return leased.length;
  }

  async attempt(deliveryId: string): Promise<void> {
    const delivery = await this.dataSource.getRepository(WebhookDelivery).findOneByOrFail({ id: deliveryId });
    const sub = await this.dataSource.getRepository(WebhookSubscription).createQueryBuilder('s').addSelect('s.secretEnc').where('s.id = :id', { id: delivery.subscriptionId }).getOneOrFail();
    const body = JSON.stringify(delivery.payload);
    const timestamp = Math.floor(Date.now() / 1000);
    const timeoutMs = (await this.settings.get('webhooks.timeout_seconds')) * 1000;
    const started = Date.now();
    let statusCode: number | null = null;
    let error: string | null = null;
    let excerpt: string | null = null;
    try {
      const res = await fetch(sub.url, {
        method: 'POST',
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          'content-type': 'application/cloudevents+json',
          'user-agent': 'SIL-HR-Webhooks/1',
          [WEBHOOK_HEADERS.id]: delivery.id,
          [WEBHOOK_HEADERS.timestamp]: String(timestamp),
          [WEBHOOK_HEADERS.signature]: sign(decrypt(sub.secretEnc)!, delivery.id, timestamp, body),
          'ce-id': delivery.eventId,
          'ce-type': delivery.eventType,
        },
        body,
      });
      statusCode = res.status;
      excerpt = (await res.text().catch(() => '')).slice(0, 500) || null;
      if (res.status < 200 || res.status >= 300) error = `HTTP ${res.status}`;
    } catch (e) {
      error = (e as Error).name === 'TimeoutError' ? `Timed out after ${timeoutMs / 1000} s` : String((e as Error).message ?? e);
    }
    const durationMs = Date.now() - started;
    await this.record(delivery, sub, { statusCode, error, excerpt, durationMs });
  }

  private async record(delivery: WebhookDelivery, sub: WebhookSubscription, r: { statusCode: number | null; error: string | null; excerpt: string | null; durationMs: number }): Promise<void> {
    const maxAttempts = await this.settings.get('webhooks.max_attempts');
    const pauseAfter = await this.settings.get('webhooks.pause_after_dead_letters');
    await this.dataSource.transaction(async (m) => {
      const attemptNo = delivery.attemptCount + 1;
      await m.getRepository(WebhookAttempt).insert({ deliveryId: delivery.id, attemptNo, durationMs: r.durationMs, statusCode: r.statusCode, error: r.error?.slice(0, 1000) ?? null, responseExcerpt: r.excerpt });
      const subs = m.getRepository(WebhookSubscription);
      if (!r.error) {
        await m.getRepository(WebhookDelivery).update({ id: delivery.id }, { status: 'delivered', attemptCount: attemptNo, deliveredAt: new Date(), nextAttemptAt: null, lastStatusCode: r.statusCode, lastError: null });
        await subs.update({ id: sub.id }, { consecutiveFailures: 0, lastDeliveryAt: new Date() });
        return;
      }
      if (attemptNo < maxAttempts) {
        await m.getRepository(WebhookDelivery).update({ id: delivery.id }, { status: 'retrying', attemptCount: attemptNo, nextAttemptAt: new Date(Date.now() + backoffSeconds(attemptNo) * 1000), lastStatusCode: r.statusCode, lastError: r.error.slice(0, 1000) });
        return;
      }
      await m.getRepository(WebhookDelivery).update({ id: delivery.id }, { status: 'dead_lettered', attemptCount: attemptNo, nextAttemptAt: null, lastStatusCode: r.statusCode, lastError: r.error.slice(0, 1000) });
      const failures = sub.consecutiveFailures + 1;
      if (failures >= pauseAfter && sub.status === 'active') {
        const reason = `Paused automatically after ${failures} dead-lettered deliveries in a row (last: ${r.error})`.slice(0, 300);
        await subs.update({ id: sub.id }, { consecutiveFailures: failures, status: 'paused', pausedReason: reason });
        await this.notifications.notifyPermissionHolders('webhook:manage', 'webhook_paused', { subscription: sub.name, url: sub.url, reason }, `/integrations/webhooks/${sub.id}`, m);
        this.logger.warn({ subscriptionId: sub.id }, reason);
      } else {
        await subs.update({ id: sub.id }, { consecutiveFailures: failures });
      }
    });
  }
}
