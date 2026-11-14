import { Controller, Get, Global, Inject, Injectable, Module, Param, ParseUUIDPipe, Post, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBody, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { InjectDataSource, TypeOrmModule } from '@nestjs/typeorm';
import { Column, CreateDateColumn, DataSource, Entity, Index, JoinColumn, ManyToOne, OneToMany, PrimaryColumn } from 'typeorm';
import { z } from 'zod';
import { AuditAction, createDocumentFields, documentQuery, documentRecord, downloadUrl, pageOf, type DocumentRecord } from '@sil/hr-shared';
import { loadEnv } from '../../config/env';
import { iso, SoftDeleteEntity } from '../../common/base.entity';
import { sha256 } from '../../common/crypto';
import { RequirePermissions } from '../../common/decorators';
import { mapPage, paginate } from '../../common/pagination';
import { notFound, ProblemException, unprocessable } from '../../common/problem';
import { ZBody, ZQuery, ZResponse } from '../../common/zod';
import { RequestContext } from '../../common/request-context';
import { writeAudit } from '../audit/audit.subscriber';
import { SettingsService } from '../settings/settings.module';
import { NoopScanner, OBJECT_STORAGE, S3Storage, VIRUS_SCANNER, type ObjectStorage, type VirusScanner } from './storage';

/** A logical document attached to something (owner_type/owner_id), with versions. */
@Entity('document')
@Index(['ownerType', 'ownerId'])
export class DocumentEntity extends SoftDeleteEntity {
  @Column({ type: 'varchar', length: 60 })
  ownerType: string;

  @Column({ type: 'uuid', nullable: true })
  ownerId: string | null;

  @Column({ type: 'varchar', length: 60, nullable: true })
  category: string | null;

  @Column({ type: 'varchar', length: 200 })
  title: string;

  /** Medical, disciplinary or financial: reads are audited. */
  @Column({ type: 'boolean', default: false })
  isSensitive: boolean;

  @Column({ type: 'uuid', nullable: true })
  currentVersionId: string | null;

  @OneToMany(() => DocumentVersion, (v) => v.document)
  versions?: DocumentVersion[];
}

@Entity('document_version')
@Index(['documentId', 'versionNo'], { unique: true })
export class DocumentVersion {
  @PrimaryColumn({ type: 'uuid', default: () => 'uuid_generate_v7()' })
  id: string;

  @Column({ type: 'uuid' })
  documentId: string;

  @ManyToOne(() => DocumentEntity, (d) => d.versions, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'document_id' })
  document?: DocumentEntity;

  @Column({ type: 'int' })
  versionNo: number;

  @Column({ type: 'varchar', length: 300 })
  objectKey: string;

  @Column({ type: 'varchar', length: 255 })
  fileName: string;

  @Column({ type: 'varchar', length: 120 })
  mimeType: string;

  @Column({ type: 'bigint' })
  sizeBytes: string;

  @Column({ type: 'char', length: 64 })
  sha256: string;

  @Column({ type: 'varchar', length: 20 })
  scanStatus: 'pending' | 'clean' | 'infected' | 'not_scanned';

  @CreateDateColumn({ type: 'timestamptz', precision: 3 })
  uploadedAt: Date;

  @Column({ type: 'uuid', nullable: true })
  uploadedBy: string | null;
}

function versionDto(v: DocumentVersion) {
  return { id: v.id, version_no: v.versionNo, file_name: v.fileName, mime_type: v.mimeType, size_bytes: Number(v.sizeBytes), sha256: v.sha256, scan_status: v.scanStatus, uploaded_at: v.uploadedAt.toISOString(), uploaded_by: v.uploadedBy };
}

function toDto(d: DocumentEntity, withVersions = false): DocumentRecord {
  const versions = (d.versions ?? []).sort((a, b) => b.versionNo - a.versionNo);
  const current = versions.find((v) => v.id === d.currentVersionId) ?? null;
  return {
    id: d.id, owner_type: d.ownerType, owner_id: d.ownerId, category: d.category, title: d.title, is_sensitive: d.isSensitive,
    current_version: current ? versionDto(current) : null,
    ...(withVersions ? { versions: versions.map(versionDto) } : {}),
    deleted_at: iso(d.deletedAt), created_at: d.createdAt.toISOString(), updated_at: d.updatedAt.toISOString(), version: d.version,
  };
}

/** Recognises file types by content, not by the name or the client's claim. */
function sniffMime(buf: Buffer, claimed: string): string {
  if (buf.subarray(0, 5).toString() === '%PDF-') return 'application/pdf';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) {
    return claimed.startsWith('application/vnd.openxmlformats') ? claimed : 'application/zip';
  }
  if (claimed === 'text/csv' && !buf.subarray(0, 4096).includes(0)) return 'text/csv';
  return 'application/octet-stream';
}

@Injectable()
export class DocumentsService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
    @Inject(VIRUS_SCANNER) private readonly scanner: VirusScanner,
    private readonly settings: SettingsService,
  ) {}

  async list(q: z.infer<typeof documentQuery>) {
    const qb = this.dataSource.getRepository(DocumentEntity).createQueryBuilder('d').leftJoinAndSelect('d.versions', 'v', 'v.id = d.current_version_id');
    if (q.owner_type) qb.andWhere('d.owner_type = :ot', { ot: q.owner_type });
    if (q.owner_id) qb.andWhere('d.owner_id = :oi', { oi: q.owner_id });
    if (q.search) qb.andWhere('d.title ILIKE :s', { s: `%${q.search}%` });
    return mapPage(await paginate(qb, q, { alias: 'd', defaultSort: '-created_at', sortable: { title: { prop: 'title', column: 'title' } } }), (d) => toDto(d));
  }

  async get(id: string): Promise<DocumentRecord> {
    const d = await this.dataSource.getRepository(DocumentEntity).findOne({ where: { id }, relations: { versions: true } });
    if (!d) throw notFound('Document');
    return toDto(d, true);
  }

  private async store(documentId: string, versionNo: number, file: Express.Multer.File) {
    if (!file?.buffer?.length) throw unprocessable('file_required', 'Attach a non-empty file in the "file" field');
    const mime = sniffMime(file.buffer, file.mimetype);
    const allowed = await this.settings.get('documents.allowed_mime_types');
    if (!allowed.includes(mime)) throw new ProblemException(415, 'unsupported_file_type', `Files of type ${mime} are not accepted`);
    const scan = await this.scanner.scan(file.buffer, file.originalname);
    if (scan === 'infected') throw unprocessable('infected_file', 'The file failed the virus scan');
    const objectKey = `documents/${documentId}/v${versionNo}-${sha256(file.buffer).slice(0, 16)}`;
    await this.storage.put(objectKey, file.buffer, mime);
    return { objectKey, mime, scan };
  }

  async create(fields: z.infer<typeof createDocumentFields>, file: Express.Multer.File, uploadedBy: string | null): Promise<DocumentRecord> {
    const repo = this.dataSource.getRepository(DocumentEntity);
    const draft = repo.create({ ownerType: fields.owner_type, ownerId: fields.owner_id ?? null, category: fields.category ?? null, title: fields.title, isSensitive: fields.is_sensitive === 'true' });
    return this.dataSource.transaction(async (m) => {
      const d = await m.getRepository(DocumentEntity).save(draft);
      const stored = await this.store(d.id, 1, file);
      const v = await m.getRepository(DocumentVersion).save(m.getRepository(DocumentVersion).create({ documentId: d.id, versionNo: 1, objectKey: stored.objectKey, fileName: file.originalname.slice(0, 255), mimeType: stored.mime, sizeBytes: String(file.size), sha256: sha256(file.buffer), scanStatus: stored.scan, uploadedBy: uploadedBy ?? RequestContext.get()?.actorId ?? null }));
      d.currentVersionId = v.id;
      await m.getRepository(DocumentEntity).save(d);
      d.versions = [v];
      return toDto(d, true);
    });
  }

  async addVersion(id: string, file: Express.Multer.File, uploadedBy: string | null): Promise<DocumentRecord> {
    return this.dataSource.transaction(async (m) => {
      const d = await m.getRepository(DocumentEntity).findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
      if (!d) throw notFound('Document');
      const [{ max }] = await m.query(`SELECT coalesce(max(version_no), 0)::int AS max FROM document_version WHERE document_id = $1`, [id]);
      const versionNo = max + 1;
      const stored = await this.store(id, versionNo, file);
      const v = await m.getRepository(DocumentVersion).save(m.getRepository(DocumentVersion).create({ documentId: id, versionNo, objectKey: stored.objectKey, fileName: file.originalname.slice(0, 255), mimeType: stored.mime, sizeBytes: String(file.size), sha256: sha256(file.buffer), scanStatus: stored.scan, uploadedBy: uploadedBy ?? RequestContext.get()?.actorId ?? null }));
      d.currentVersionId = v.id;
      await m.getRepository(DocumentEntity).save(d);
      d.versions = await m.getRepository(DocumentVersion).findBy({ documentId: id });
      return toDto(d, true);
    });
  }

  /** A short-lived signed link. Downloads of sensitive documents are audited. */
  async downloadUrl(id: string, versionId?: string): Promise<{ url: string; expires_at: string }> {
    const d = await this.dataSource.getRepository(DocumentEntity).findOneBy({ id });
    if (!d) throw notFound('Document');
    const v = await this.dataSource.getRepository(DocumentVersion).findOneBy({ id: versionId ?? d.currentVersionId ?? '00000000-0000-0000-0000-000000000000', documentId: id });
    if (!v) throw notFound('Document version');
    if (v.scanStatus === 'infected' || v.scanStatus === 'pending') throw new ProblemException(409, 'not_downloadable', `This file is ${v.scanStatus === 'pending' ? 'still being scanned' : 'quarantined'}`);
    const ttl = await this.settings.get('documents.download_url_ttl_seconds');
    await writeAudit(this.dataSource.manager, { action: d.isSensitive ? AuditAction.SENSITIVE_READ : 'download', entityType: 'Document', entityId: d.id, after: { versionId: v.id } });
    return { url: await this.storage.signedGetUrl(v.objectKey, ttl, v.fileName), expires_at: new Date(Date.now() + ttl * 1000).toISOString() };
  }
}

const uploadLimits = () => ({ limits: { fileSize: loadEnv().maxUploadMb * 1024 * 1024, files: 1 } });
const fileBody = (extra: Record<string, unknown> = {}) =>
  ApiBody({ schema: { type: 'object', required: ['file', ...Object.keys(extra).filter((k) => k === 'owner_type' || k === 'title')], properties: { file: { type: 'string', format: 'binary' }, ...extra } } as never });

@ApiTags('Documents')
@Controller('documents')
export class DocumentsController {
  constructor(private readonly docs: DocumentsService) {}

  @Get()
  @RequirePermissions('document:read')
  @ZResponse(pageOf(documentRecord))
  list(@ZQuery(documentQuery) q: z.infer<typeof documentQuery>) {
    return this.docs.list(q);
  }

  @Get(':id')
  @RequirePermissions('document:read')
  @ZResponse(documentRecord)
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.docs.get(id);
  }

  @Post()
  @RequirePermissions('document:write')
  @ApiConsumes('multipart/form-data')
  @fileBody({ owner_type: { type: 'string' }, owner_id: { type: 'string', format: 'uuid' }, category: { type: 'string' }, title: { type: 'string' }, is_sensitive: { type: 'string', enum: ['true', 'false'] } })
  @UseInterceptors(FileInterceptor('file', uploadLimits()))
  @ZResponse(documentRecord, 201)
  create(@ZBody(createDocumentFields) fields: z.infer<typeof createDocumentFields>, @UploadedFile() file: Express.Multer.File) {
    return this.docs.create(fields, file, null);
  }

  @Post(':id/versions')
  @RequirePermissions('document:write')
  @ApiConsumes('multipart/form-data')
  @fileBody()
  @UseInterceptors(FileInterceptor('file', uploadLimits()))
  @ZResponse(documentRecord, 201)
  addVersion(@Param('id', ParseUUIDPipe) id: string, @UploadedFile() file: Express.Multer.File) {
    return this.docs.addVersion(id, file, null);
  }

  @Post(':id/download-url')
  @RequirePermissions('document:read')
  @ZResponse(downloadUrl, 201)
  download(@Param('id', ParseUUIDPipe) id: string) {
    return this.docs.downloadUrl(id);
  }
}

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([DocumentEntity, DocumentVersion])],
  providers: [DocumentsService, { provide: OBJECT_STORAGE, useFactory: () => new S3Storage() }, { provide: VIRUS_SCANNER, useClass: NoopScanner }],
  controllers: [DocumentsController],
  exports: [DocumentsService, OBJECT_STORAGE],
})
export class DocumentsModule {}
