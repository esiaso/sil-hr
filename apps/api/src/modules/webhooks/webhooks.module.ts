import { Controller, Get, HttpCode, Injectable, Module, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { InjectDataSource, TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { z } from 'zod';
import {
  AuditAction, EVENT_TYPES, createWebhookSubscription, pageOf, updateWebhookSubscription, webhookDelivery, webhookDeliveryQuery, webhookSecret,
  webhookSubscription, type WebhookDelivery as DeliveryDto, type WebhookSubscription as SubscriptionDto,
} from '@sil/hr-shared';
import { iso } from '../../common/base.entity';
import { encrypt } from '../../common/crypto';
import { RequirePermissions } from '../../common/decorators';
import { ApiIfMatch, assertVersion, IfMatch } from '../../common/etag';
import { mapPage, paginate } from '../../common/pagination';
import { notFound, unprocessable } from '../../common/problem';
import { ZBody, ZQuery, ZResponse } from '../../common/zod';
import { writeAudit } from '../audit/audit.subscriber';
import { OutboxService } from '../events/events.module';
import { EVENT_PUBLISHERS, OutboxPublisher, RedisStreamPublisher, WebhookDeliveryProcessor, WebhookPublisher } from './publishing';
import { newWebhookSecret } from './signing';
import { WEBHOOK_ENTITIES, WebhookAttempt, WebhookDelivery, WebhookSubscription } from './webhook.entities';

function subDto(s: WebhookSubscription): SubscriptionDto {
  return {
    id: s.id, name: s.name, url: s.url, event_types: s.eventTypes, status: s.status, paused_reason: s.pausedReason,
    consecutive_failures: s.consecutiveFailures, secret_prefix: s.secretPrefix, last_delivery_at: iso(s.lastDeliveryAt),
    created_at: s.createdAt.toISOString(), updated_at: s.updatedAt.toISOString(), version: s.version,
  };
}

function deliveryDto(d: WebhookDelivery, attempts?: WebhookAttempt[]): DeliveryDto {
  return {
    id: d.id, subscription_id: d.subscriptionId, event_id: d.eventId, event_type: d.eventType, status: d.status, attempt_count: d.attemptCount,
    next_attempt_at: iso(d.nextAttemptAt), last_status_code: d.lastStatusCode, last_error: d.lastError, delivered_at: iso(d.deliveredAt), created_at: d.createdAt.toISOString(),
    ...(attempts ? { attempts: attempts.sort((a, b) => a.attemptNo - b.attemptNo).map((a) => ({ attempt_no: a.attemptNo, started_at: a.startedAt.toISOString(), duration_ms: a.durationMs, status_code: a.statusCode, error: a.error, response_excerpt: a.responseExcerpt })) } : {}),
  };
}

function assertEventTypes(types: string[]): void {
  const unknown = types.filter((t) => t !== '*' && !(EVENT_TYPES as string[]).includes(t));
  if (unknown.length) throw unprocessable('unknown_event_type', `Unknown event type(s): ${unknown.join(', ')}`, [{ path: 'event_types', message: unknown.join(', ') }]);
}

@Injectable()
export class WebhooksService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly outbox: OutboxService,
  ) {}

  async list(): Promise<SubscriptionDto[]> {
    return (await this.dataSource.getRepository(WebhookSubscription).find({ order: { name: 'ASC' } })).map(subDto);
  }

  async get(id: string): Promise<SubscriptionDto> {
    const s = await this.dataSource.getRepository(WebhookSubscription).findOneBy({ id });
    if (!s) throw notFound('Webhook subscription');
    return subDto(s);
  }

  /** The signing secret is returned once, at creation (and on rotation). */
  async create(dto: z.infer<typeof createWebhookSubscription>): Promise<{ subscription: SubscriptionDto; secret: string }> {
    assertEventTypes(dto.event_types);
    const secret = newWebhookSecret();
    const repo = this.dataSource.getRepository(WebhookSubscription);
    const s = await repo.save(repo.create({ name: dto.name, url: dto.url, eventTypes: [...new Set(dto.event_types)], secretEnc: encrypt(secret)!, secretPrefix: secret.slice(0, 12) }));
    return { subscription: subDto(s), secret };
  }

  async update(id: string, dto: z.infer<typeof updateWebhookSubscription>, version: number): Promise<SubscriptionDto> {
    if (dto.event_types) assertEventTypes(dto.event_types);
    return this.dataSource.transaction(async (m) => {
      const repo = m.getRepository(WebhookSubscription);
      const s = await repo.findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
      if (!s) throw notFound('Webhook subscription');
      assertVersion(s.version, version);
      if (dto.name !== undefined) s.name = dto.name;
      if (dto.url !== undefined) s.url = dto.url;
      if (dto.event_types !== undefined) s.eventTypes = [...new Set(dto.event_types)];
      if (dto.status !== undefined && dto.status !== s.status) {
        s.status = dto.status;
        if (dto.status === 'active') {
          s.pausedReason = null;
          s.consecutiveFailures = 0;
        } else if (dto.status === 'paused') {
          s.pausedReason = 'Paused by an administrator';
        }
      }
      return subDto(await repo.save(s));
    });
  }

  async rotateSecret(id: string): Promise<{ id: string; secret: string }> {
    const repo = this.dataSource.getRepository(WebhookSubscription);
    const s = await repo.findOneBy({ id });
    if (!s) throw notFound('Webhook subscription');
    const secret = newWebhookSecret();
    s.secretEnc = encrypt(secret)!;
    s.secretPrefix = secret.slice(0, 12);
    await repo.save(s);
    return { id, secret };
  }

  async sendTest(id: string): Promise<void> {
    await this.dataSource.transaction(async (m) => {
      const s = await m.getRepository(WebhookSubscription).findOneBy({ id });
      if (!s) throw notFound('Webhook subscription');
      await this.outbox.record(m, 'hr.webhook.test.v1', s.id, { message: `Test event from PeopleTrack for "${s.name}"` }, { onlySubscriptionId: s.id });
    });
  }

  async deliveries(subscriptionId: string, q: z.infer<typeof webhookDeliveryQuery>) {
    const qb = this.dataSource.getRepository(WebhookDelivery).createQueryBuilder('d').where('d.subscription_id = :s', { s: subscriptionId });
    if (q.status) qb.andWhere('d.status = :status', { status: q.status });
    if (q.event_type) qb.andWhere('d.event_type = :t', { t: q.event_type });
    const page = await paginate(qb, { ...q, sort: q.sort ?? '-created_at' }, { alias: 'd', defaultSort: '-created_at', sortable: {} });
    return mapPage(page, (d: WebhookDelivery) => deliveryDto(d));
  }

  async delivery(id: string): Promise<DeliveryDto> {
    const d = await this.dataSource.getRepository(WebhookDelivery).findOneBy({ id });
    if (!d) throw notFound('Delivery');
    return deliveryDto(d, await this.dataSource.getRepository(WebhookAttempt).findBy({ deliveryId: id }));
  }

  /** Re-queues a delivery (typically dead-lettered) with a fresh retry budget. */
  async replay(id: string): Promise<DeliveryDto> {
    return this.dataSource.transaction(async (m) => {
      const repo = m.getRepository(WebhookDelivery);
      const d = await repo.findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
      if (!d) throw notFound('Delivery');
      d.status = 'pending';
      d.attemptCount = 0;
      d.nextAttemptAt = new Date();
      await repo.save(d);
      await writeAudit(m, { action: AuditAction.REPLAY, entityType: 'WebhookDelivery', entityId: id, after: { eventId: d.eventId, subscriptionId: d.subscriptionId } });
      return deliveryDto(d);
    });
  }
}

const Uuid = (name = 'id') => Param(name, ParseUUIDPipe);

@ApiTags('Integration: webhooks')
@Controller('webhooks')
export class WebhooksController {
  constructor(private readonly webhooks: WebhooksService) {}

  @Get('subscriptions')
  @RequirePermissions('webhook:read')
  @ZResponse(z.array(webhookSubscription))
  list() {
    return this.webhooks.list();
  }

  @Get('subscriptions/:id')
  @RequirePermissions('webhook:read')
  @ZResponse(webhookSubscription)
  get(@Uuid() id: string) {
    return this.webhooks.get(id);
  }

  @Post('subscriptions')
  @RequirePermissions('webhook:manage')
  @ZResponse(z.object({ subscription: webhookSubscription, secret: z.string() }), 201, 'Created. The signing secret is shown only in this response.')
  create(@ZBody(createWebhookSubscription) dto: z.infer<typeof createWebhookSubscription>) {
    return this.webhooks.create(dto);
  }

  @Patch('subscriptions/:id')
  @RequirePermissions('webhook:manage')
  @ApiIfMatch()
  @ZResponse(webhookSubscription)
  update(@Uuid() id: string, @ZBody(updateWebhookSubscription) dto: z.infer<typeof updateWebhookSubscription>, @IfMatch() v: number) {
    return this.webhooks.update(id, dto, v);
  }

  @Post('subscriptions/:id/secret')
  @RequirePermissions('webhook:manage')
  @ZResponse(webhookSecret, 201)
  rotate(@Uuid() id: string) {
    return this.webhooks.rotateSecret(id);
  }

  @Post('subscriptions/:id/test')
  @RequirePermissions('webhook:manage')
  @HttpCode(202)
  @ZResponse(null, 202, 'Queued')
  test(@Uuid() id: string) {
    return this.webhooks.sendTest(id);
  }

  @Get('subscriptions/:id/deliveries')
  @RequirePermissions('webhook:read')
  @ZResponse(pageOf(webhookDelivery))
  deliveries(@Uuid() id: string, @ZQuery(webhookDeliveryQuery) q: z.infer<typeof webhookDeliveryQuery>) {
    return this.webhooks.deliveries(id, q);
  }

  @Get('deliveries/:id')
  @RequirePermissions('webhook:read')
  @ZResponse(webhookDelivery)
  delivery(@Uuid() id: string) {
    return this.webhooks.delivery(id);
  }

  @Post('deliveries/:id/replay')
  @RequirePermissions('webhook:manage')
  @HttpCode(202)
  @ZResponse(webhookDelivery, 202)
  replay(@Uuid() id: string) {
    return this.webhooks.replay(id);
  }
}

@Module({
  imports: [TypeOrmModule.forFeature(WEBHOOK_ENTITIES)],
  providers: [
    WebhooksService,
    WebhookPublisher,
    RedisStreamPublisher,
    { provide: EVENT_PUBLISHERS, useFactory: (w: WebhookPublisher, r: RedisStreamPublisher) => [w, r], inject: [WebhookPublisher, RedisStreamPublisher] },
    OutboxPublisher,
    WebhookDeliveryProcessor,
  ],
  controllers: [WebhooksController],
  exports: [OutboxPublisher, WebhookDeliveryProcessor],
})
export class WebhooksModule {}
