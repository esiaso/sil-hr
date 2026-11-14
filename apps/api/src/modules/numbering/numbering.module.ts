import { Controller, Get, Global, Injectable, Module, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { InjectDataSource, TypeOrmModule } from '@nestjs/typeorm';
import { Column, DataSource, Entity, EntityManager, Index } from 'typeorm';
import { z } from 'zod';
import { createNumberingScheme, numberingScheme, updateNumberingScheme, type NumberingScheme as SchemeDto } from '@sil/hr-shared';
import { AppBaseEntity } from '../../common/base.entity';
import { RequirePermissions } from '../../common/decorators';
import { ApiIfMatch, assertVersion, IfMatch } from '../../common/etag';
import { badRequest, notFound } from '../../common/problem';
import { ZBody, ZResponse } from '../../common/zod';
import { SettingsService } from '../settings/settings.module';

@Entity('numbering_scheme')
export class NumberingScheme extends AppBaseEntity {
  @Index({ unique: true })
  @Column({ type: 'varchar', length: 60 })
  documentType: string;

  @Column({ type: 'varchar', length: 200 })
  name: string;

  @Column({ type: 'varchar', length: 20, default: '' })
  prefix: string;

  /** Tokens: {PREFIX} {YYYY} {YY} {MM} {SEQ} {BRANCH}. */
  @Column({ type: 'varchar', length: 100 })
  format: string;

  @Column({ type: 'int', default: 5 })
  padding: number;

  @Column({ type: 'varchar', length: 10, default: 'never' })
  reset: 'never' | 'yearly';

  @Column({ type: 'boolean', default: true })
  isActive: boolean;
}

/** One counter per scheme and period ('ALL' or the year). Locked FOR UPDATE when used. */
@Entity('number_sequence')
@Index(['schemeId', 'period'], { unique: true })
export class NumberSequence {
  @Column({ type: 'uuid', primary: true, default: () => 'uuid_generate_v7()' })
  id: string;

  @Column({ type: 'uuid' })
  schemeId: string;

  @Column({ type: 'varchar', length: 10 })
  period: string;

  @Column({ type: 'bigint', default: 1 })
  nextValue: string;
}

export function formatNumber(format: string, v: { prefix: string; date: string; seq: number; padding: number; branchCode?: string | null }): string {
  const [yyyy, mm] = v.date.split('-');
  return format
    .replace('{PREFIX}', v.prefix)
    .replace('{YYYY}', yyyy)
    .replace('{YY}', yyyy.slice(2))
    .replace('{MM}', mm)
    .replace('{BRANCH}', v.branchCode ?? '')
    .replace('{SEQ}', String(v.seq).padStart(v.padding, '0'));
}

export interface NextNumberOptions {
  /** YYYY-MM-DD; defaults to today in the organisation timezone. Picks the yearly period. */
  date?: string;
  branchCode?: string | null;
  /** Pass the caller's transaction so the number is consumed only if it commits (gap-free). */
  manager?: EntityManager;
}

function toDto(s: NumberingScheme, preview?: string): SchemeDto {
  return {
    id: s.id,
    document_type: s.documentType,
    name: s.name,
    prefix: s.prefix,
    format: s.format,
    padding: s.padding,
    reset: s.reset,
    is_active: s.isActive,
    next_preview: preview,
    created_at: s.createdAt.toISOString(),
    updated_at: s.updatedAt.toISOString(),
    version: s.version,
  };
}

@Injectable()
export class NumberingService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly settings: SettingsService,
  ) {}

  async next(documentType: string, options: NextNumberOptions = {}): Promise<string> {
    if (options.manager) return this.allocate(options.manager, documentType, options);
    return this.dataSource.transaction((m) => this.allocate(m, documentType, options));
  }

  private async allocate(manager: EntityManager, documentType: string, options: NextNumberOptions): Promise<string> {
    const scheme = await manager.getRepository(NumberingScheme).findOneBy({ documentType, isActive: true });
    if (!scheme) throw badRequest('no_numbering_scheme', `No active numbering scheme for "${documentType}"`);
    const date = options.date ?? (await this.settings.today(manager));
    const period = scheme.reset === 'yearly' ? date.slice(0, 4) : 'ALL';
    await manager.query(
      `INSERT INTO number_sequence (scheme_id, period, next_value) VALUES ($1, $2, 1) ON CONFLICT (scheme_id, period) DO NOTHING`,
      [scheme.id, period],
    );
    // UPDATE … RETURNING comes back as [rows, affectedCount] from the postgres driver.
    const [[row]] = await manager.query(
      `UPDATE number_sequence SET next_value = next_value + 1 WHERE scheme_id = $1 AND period = $2 RETURNING next_value - 1 AS seq`,
      [scheme.id, period],
    );
    return formatNumber(scheme.format, { prefix: scheme.prefix, date, seq: Number(row.seq), padding: scheme.padding, branchCode: options.branchCode });
  }

  private async preview(s: NumberingScheme): Promise<string> {
    const date = await this.settings.today();
    const period = s.reset === 'yearly' ? date.slice(0, 4) : 'ALL';
    const [row] = await this.dataSource.query(`SELECT next_value FROM number_sequence WHERE scheme_id = $1 AND period = $2`, [s.id, period]);
    return formatNumber(s.format, { prefix: s.prefix, date, seq: Number(row?.next_value ?? 1), padding: s.padding, branchCode: 'BR' });
  }

  async list(): Promise<SchemeDto[]> {
    const rows = await this.dataSource.getRepository(NumberingScheme).find({ order: { documentType: 'ASC' } });
    return Promise.all(rows.map(async (r) => toDto(r, await this.preview(r))));
  }

  async create(dto: z.infer<typeof createNumberingScheme>): Promise<SchemeDto> {
    const repo = this.dataSource.getRepository(NumberingScheme);
    const row = await repo.save(repo.create({ documentType: dto.document_type, name: dto.name, prefix: dto.prefix, format: dto.format, padding: dto.padding, reset: dto.reset }));
    return toDto(row, await this.preview(row));
  }

  async update(id: string, dto: z.infer<typeof updateNumberingScheme>, expectedVersion: number): Promise<SchemeDto> {
    return this.dataSource.transaction(async (m) => {
      const repo = m.getRepository(NumberingScheme);
      const row = await repo.findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
      if (!row) throw notFound('Numbering scheme');
      assertVersion(row.version, expectedVersion);
      if (dto.name !== undefined) row.name = dto.name;
      if (dto.prefix !== undefined) row.prefix = dto.prefix;
      if (dto.format !== undefined) row.format = dto.format;
      if (dto.padding !== undefined) row.padding = dto.padding;
      if (dto.reset !== undefined) row.reset = dto.reset;
      if (dto.is_active !== undefined) row.isActive = dto.is_active;
      return toDto(await repo.save(row));
    });
  }
}

@ApiTags('Numbering')
@Controller('numbering-schemes')
export class NumberingController {
  constructor(private readonly numbering: NumberingService) {}

  @Get()
  @RequirePermissions('numbering:read')
  @ZResponse(z.array(numberingScheme))
  list() {
    return this.numbering.list();
  }

  @Post()
  @RequirePermissions('numbering:manage')
  @ZResponse(numberingScheme, 201)
  create(@ZBody(createNumberingScheme) dto: z.infer<typeof createNumberingScheme>) {
    return this.numbering.create(dto);
  }

  @Patch(':id')
  @RequirePermissions('numbering:manage')
  @ApiIfMatch()
  @ZResponse(numberingScheme)
  update(@Param('id', ParseUUIDPipe) id: string, @ZBody(updateNumberingScheme) dto: z.infer<typeof updateNumberingScheme>, @IfMatch() version: number) {
    return this.numbering.update(id, dto, version);
  }
}

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([NumberingScheme, NumberSequence])],
  providers: [NumberingService],
  controllers: [NumberingController],
  exports: [NumberingService],
})
export class NumberingModule {}
