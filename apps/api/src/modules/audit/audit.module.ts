import { Controller, Get, Global, Injectable, Module } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { InjectDataSource, TypeOrmModule } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { z } from 'zod';
import { auditEntry, auditQuery, pageOf, type AuditEntry, type Page } from '@sil/hr-shared';
import { RequirePermissions } from '../../common/decorators';
import { badRequest } from '../../common/problem';
import { ZQuery, ZResponse } from '../../common/zod';
import { AuditLog } from './audit.entity';
import { writeAudit, type AuditEntryInput } from './audit.subscriber';

type AuditQuery = z.infer<typeof auditQuery>;

export function toAuditDto(r: AuditLog): AuditEntry {
  return {
    id: r.id,
    occurred_at: r.occurredAt.toISOString(),
    actor_type: r.actorType as AuditEntry['actor_type'],
    actor_id: r.actorId,
    actor_name: r.actorName,
    action: r.action,
    entity_type: r.entityType,
    entity_id: r.entityId,
    before: r.before,
    after: r.after,
    ip: r.ip,
    user_agent: r.userAgent,
    correlation_id: r.correlationId,
  };
}

@Injectable()
export class AuditService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /** For things the subscriber cannot see: logins, exports, approvals, sensitive reads. */
  record(entry: AuditEntryInput, manager: EntityManager = this.dataSource.manager): Promise<void> {
    return writeAudit(manager, entry);
  }

  /** Newest first; the cursor is the last id seen. */
  async list(q: AuditQuery): Promise<Page<AuditEntry>> {
    const qb = this.dataSource.getRepository(AuditLog).createQueryBuilder('a');
    if (q.entity_type) qb.andWhere('a.entity_type = :et', { et: q.entity_type });
    if (q.entity_id) qb.andWhere('a.entity_id = :eid', { eid: q.entity_id });
    if (q.actor_id) qb.andWhere('a.actor_id = :aid', { aid: q.actor_id });
    if (q.action) qb.andWhere('a.action = :action', { action: q.action });
    if (q.from) qb.andWhere('a.occurred_at >= :from', { from: q.from });
    if (q.to) qb.andWhere('a.occurred_at < :to', { to: q.to });
    if (q.search) qb.andWhere('(a.actor_name ILIKE :s OR a.entity_type ILIKE :s OR a.entity_id ILIKE :s)', { s: `%${q.search}%` });
    if (q.cursor) {
      if (!/^\d+$/.test(q.cursor)) throw badRequest('invalid_cursor', 'The cursor is not valid');
      qb.andWhere('a.id < :cursor', { cursor: q.cursor });
    }
    const rows = await qb.orderBy('a.id', 'DESC').limit(q.limit + 1).getMany();
    const more = rows.length > q.limit;
    const data = (more ? rows.slice(0, q.limit) : rows).map(toAuditDto);
    return { data, next_cursor: more ? data[data.length - 1].id : null };
  }
}

@ApiTags('Audit')
@Controller('audit')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  @RequirePermissions('audit:read')
  @ZResponse(pageOf(auditEntry))
  list(@ZQuery(auditQuery) q: AuditQuery) {
    return this.audit.list(q);
  }
}

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([AuditLog])],
  providers: [AuditService],
  controllers: [AuditController],
  exports: [AuditService],
})
export class AuditModule {}
