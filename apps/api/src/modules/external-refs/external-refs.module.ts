import { Controller, Delete, Get, Global, HttpCode, Injectable, Module, Param, ParseUUIDPipe, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { InjectDataSource, TypeOrmModule } from '@nestjs/typeorm';
import { Column, DataSource, Entity, EntityManager, Index } from 'typeorm';
import { z } from 'zod';
import { externalRef, externalRefQuery, pageOf, upsertExternalRef } from '@sil/hr-shared';
import { AppBaseEntity } from '../../common/base.entity';
import { RequirePermissions } from '../../common/decorators';
import { mapPage, paginate } from '../../common/pagination';
import { notFound } from '../../common/problem';
import { ZBody, ZQuery, ZResponse } from '../../common/zod';

/**
 * Other systems' identifiers for HR records: (entity, id) ↔ (system, external id).
 * One external id per system per entity, and an external id maps to one record.
 */
@Entity('external_ref')
@Index(['system', 'entityType', 'externalId'], { unique: true })
@Index(['entityType', 'entityId', 'system'], { unique: true })
export class ExternalRef extends AppBaseEntity {
  @Column({ type: 'varchar', length: 60 })
  entityType: string;

  @Column({ type: 'uuid' })
  entityId: string;

  @Column({ type: 'varchar', length: 40 })
  system: string;

  @Column({ type: 'varchar', length: 200 })
  externalId: string;
}

const toDto = (r: ExternalRef) => ({
  id: r.id, entity_type: r.entityType, entity_id: r.entityId, system: r.system, external_id: r.externalId,
  created_at: r.createdAt.toISOString(), updated_at: r.updatedAt.toISOString(), version: r.version,
});

@Injectable()
export class ExternalRefsService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  list(q: z.infer<typeof externalRefQuery>) {
    const qb = this.dataSource.getRepository(ExternalRef).createQueryBuilder('r');
    for (const [k, col] of [['entity_type', 'entity_type'], ['entity_id', 'entity_id'], ['system', 'system'], ['external_id', 'external_id']] as const) {
      if (q[k]) qb.andWhere(`r.${col} = :${k}`, { [k]: q[k] });
    }
    return paginate(qb, q, { alias: 'r', defaultSort: 'created_at', sortable: {} }).then((p) => mapPage(p, toDto));
  }

  /** Sets (or replaces) the system's id for a record. */
  async upsert(dto: z.infer<typeof upsertExternalRef>, manager: EntityManager = this.dataSource.manager) {
    const repo = manager.getRepository(ExternalRef);
    const existing = await repo.findOneBy({ entityType: dto.entity_type, entityId: dto.entity_id, system: dto.system });
    if (existing) {
      existing.externalId = dto.external_id;
      return toDto(await repo.save(existing));
    }
    return toDto(await repo.save(repo.create({ entityType: dto.entity_type, entityId: dto.entity_id, system: dto.system, externalId: dto.external_id })));
  }

  /** Finds the HR record another system knows by its own id. */
  async resolve(system: string, entityType: string, externalId: string): Promise<string | null> {
    const r = await this.dataSource.getRepository(ExternalRef).findOneBy({ system, entityType, externalId });
    return r?.entityId ?? null;
  }

  async remove(id: string): Promise<void> {
    const repo = this.dataSource.getRepository(ExternalRef);
    const r = await repo.findOneBy({ id });
    if (!r) throw notFound('External reference');
    await repo.remove(r);
  }
}

@ApiTags('Integration: external references')
@Controller('external-refs')
export class ExternalRefsController {
  constructor(private readonly refs: ExternalRefsService) {}

  @Get()
  @RequirePermissions('external_ref:read')
  @ZResponse(pageOf(externalRef))
  list(@ZQuery(externalRefQuery) q: z.infer<typeof externalRefQuery>) {
    return this.refs.list(q);
  }

  @Put()
  @RequirePermissions('external_ref:manage')
  @ZResponse(externalRef)
  upsert(@ZBody(upsertExternalRef) dto: z.infer<typeof upsertExternalRef>) {
    return this.refs.upsert(dto);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermissions('external_ref:manage')
  @ZResponse(null, 204)
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.refs.remove(id);
  }
}

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([ExternalRef])],
  providers: [ExternalRefsService],
  controllers: [ExternalRefsController],
  exports: [ExternalRefsService],
})
export class ExternalRefsModule {}
