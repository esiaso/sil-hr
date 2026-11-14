import { Controller, Get, Global, Injectable, Module } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { InjectDataSource, TypeOrmModule } from '@nestjs/typeorm';
import { Column, CreateDateColumn, DataSource, Entity, EntityManager, Index, PrimaryGeneratedColumn } from 'typeorm';
import { z } from 'zod';
import {
  catalogueEntry,
  EVENT_CATALOGUE,
  eventDefinition,
  outboxEvent,
  outboxQuery,
  pageOf,
  type CatalogueEntry,
  type CloudEvent,
  type EventData,
  type EventType,
  type Page,
} from '@sil/hr-shared';
import { loadEnv } from '../../config/env';
import { Public, RequirePermissions } from '../../common/decorators';
import { badRequest } from '../../common/problem';
import { RequestContext } from '../../common/request-context';
import { jsonSchema, ZQuery, ZResponse } from '../../common/zod';

/**
 * Transactional outbox. A row is written in the same transaction as the change it
 * describes; the worker publishes it afterwards. Rolled-back changes leave no row.
 */
@Entity('outbox_event')
@Index('ix_outbox_unpublished', ['id'], { where: 'published_at IS NULL' })
export class OutboxEvent {
  @PrimaryGeneratedColumn('identity', { type: 'bigint', generatedIdentity: 'ALWAYS' })
  id: string;

  /** CloudEvents `id`. */
  @Index({ unique: true })
  @Column({ type: 'uuid', default: () => 'uuid_generate_v7()' })
  eventId: string;

  @Column({ type: 'varchar', length: 100 })
  type: string;

  @Column({ type: 'varchar', length: 200 })
  subject: string;

  @CreateDateColumn({ type: 'timestamptz', precision: 3 })
  occurredAt: Date;

  @Column({ type: 'varchar', length: 100, nullable: true })
  correlationId: string | null;

  @Column({ type: 'jsonb' })
  data: Record<string, unknown>;

  /** Restricts delivery to one webhook subscription (test events). */
  @Column({ type: 'uuid', nullable: true })
  onlySubscriptionId: string | null;

  @Column({ type: 'timestamptz', precision: 3, nullable: true })
  publishedAt: Date | null;

  @Column({ type: 'int', default: 0 })
  attempts: number;

  @Column({ type: 'varchar', length: 1000, nullable: true })
  lastError: string | null;
}

export function toCloudEvent(row: OutboxEvent): CloudEvent {
  const env = loadEnv();
  return {
    specversion: '1.0',
    id: row.eventId,
    source: env.eventSource,
    type: row.type,
    subject: row.subject,
    time: row.occurredAt.toISOString(),
    datacontenttype: 'application/json',
    dataschema: `${env.publicBaseUrl}/api/v1/events/catalogue#${row.type}`,
    ...(row.correlationId ? { correlationid: row.correlationId } : {}),
    data: row.data,
  };
}

@Injectable()
export class OutboxService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /**
   * Records an event inside the caller's transaction. The payload is validated against
   * the catalogue so a schema drift fails the change, not the consumer.
   */
  async record<T extends EventType>(manager: EntityManager, type: T, subject: string, data: EventData<T>, opts: { onlySubscriptionId?: string } = {}): Promise<OutboxEvent> {
    if (!manager.queryRunner?.isTransactionActive) {
      throw new Error(`Outbox event ${type} must be recorded inside the transaction that makes the change`);
    }
    const def = eventDefinition(type);
    if (!def) throw new Error(`Unknown event type ${type}`);
    const parsed = def.schema.parse(data) as Record<string, unknown>;
    const repo = manager.getRepository(OutboxEvent);
    return repo.save(
      repo.create({
        type,
        subject,
        data: parsed,
        correlationId: RequestContext.correlationId(),
        onlySubscriptionId: opts.onlySubscriptionId ?? null,
      }),
    );
  }

  async list(q: z.infer<typeof outboxQuery>): Promise<Page<z.infer<typeof outboxEvent>>> {
    const qb = this.dataSource.getRepository(OutboxEvent).createQueryBuilder('o');
    if (q.type) qb.andWhere('o.type = :type', { type: q.type });
    if (q.unpublished === 'true') qb.andWhere('o.published_at IS NULL');
    if (q.cursor) {
      if (!/^\d+$/.test(q.cursor)) throw badRequest('invalid_cursor', 'The cursor is not valid');
      qb.andWhere('o.id < :c', { c: q.cursor });
    }
    const rows = await qb.orderBy('o.id', 'DESC').limit(q.limit + 1).getMany();
    const more = rows.length > q.limit;
    const data = (more ? rows.slice(0, q.limit) : rows).map((r) => ({
      id: r.id,
      type: r.type,
      subject: r.subject,
      occurred_at: r.occurredAt.toISOString(),
      published_at: r.publishedAt?.toISOString() ?? null,
      attempts: r.attempts,
      last_error: r.lastError,
      data: r.data,
    }));
    return { data, next_cursor: more ? data[data.length - 1].id : null };
  }
}

export function catalogue(): CatalogueEntry[] {
  return EVENT_CATALOGUE.map((e) => ({
    type: e.type,
    version: Number(/\.v(\d+)$/.exec(e.type)?.[1] ?? 1),
    description: e.description,
    subject: e.subject,
    data_schema: jsonSchema(e.schema),
    example: e.example as Record<string, unknown>,
  }));
}

@ApiTags('Events')
@Controller('events')
export class EventsController {
  constructor(private readonly outbox: OutboxService) {}

  /** Public so developers of other systems can read it before they have a client. */
  @Get('catalogue')
  @Public()
  @ZResponse(z.array(catalogueEntry))
  catalogue() {
    return catalogue();
  }

  @Get('outbox')
  @RequirePermissions('webhook:read')
  @ZResponse(pageOf(outboxEvent))
  list(@ZQuery(outboxQuery) q: z.infer<typeof outboxQuery>) {
    return this.outbox.list(q);
  }
}

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([OutboxEvent])],
  providers: [OutboxService],
  controllers: [EventsController],
  exports: [OutboxService],
})
export class EventsModule {}
