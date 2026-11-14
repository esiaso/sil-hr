import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, IsNull } from 'typeorm';
import { z } from 'zod';
import { AuditAction, type ApiClient as ApiClientDto, type TokenResponse, createApiClient, updateApiClient } from '@sil/hr-shared';
import { loadEnv } from '../../config/env';
import { iso } from '../../common/base.entity';
import { randomToken, sha256 } from '../../common/crypto';
import { assertVersion } from '../../common/etag';
import { notFound, ProblemException } from '../../common/problem';
import { writeAudit } from '../audit/audit.subscriber';
import { ApiClient, ApiClientSecret } from './api-client.entities';
import { TokenService } from './token.service';

function toDto(c: ApiClient): ApiClientDto {
  return {
    id: c.id,
    client_id: c.clientId,
    name: c.name,
    description: c.description,
    scopes: c.scopes,
    is_active: c.isActive,
    rate_limit_per_minute: c.rateLimitPerMinute,
    last_used_at: iso(c.lastUsedAt),
    secrets: (c.secrets ?? [])
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map((s) => ({ id: s.id, prefix: s.prefix, created_at: s.createdAt.toISOString(), expires_at: iso(s.expiresAt), last_used_at: iso(s.lastUsedAt), revoked_at: iso(s.revokedAt) })),
    created_at: c.createdAt.toISOString(),
    updated_at: c.updatedAt.toISOString(),
    version: c.version,
  };
}

/** OAuth error responses (RFC 6749 §5.2) carried as problem details. */
const oauthError = (status: number, error: string, detail: string) => new ProblemException(status, error, detail, undefined, { error, error_description: detail });

@Injectable()
export class ApiClientsService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly tokens: TokenService,
  ) {}

  async list(): Promise<ApiClientDto[]> {
    const rows = await this.dataSource.getRepository(ApiClient).find({ relations: { secrets: true }, order: { name: 'ASC' } });
    return rows.map(toDto);
  }

  async get(id: string): Promise<ApiClientDto> {
    const c = await this.dataSource.getRepository(ApiClient).findOne({ where: { id }, relations: { secrets: true } });
    if (!c) throw notFound('API client');
    return toDto(c);
  }

  /** Creates a client and its first secret. The secret is shown once and never again. */
  async create(dto: z.infer<typeof createApiClient>): Promise<{ client: ApiClientDto; client_secret: string }> {
    return this.dataSource.transaction(async (m) => {
      const repo = m.getRepository(ApiClient);
      const c = await repo.save(repo.create({ clientId: `hrc_${randomToken(12)}`, name: dto.name, description: dto.description ?? null, scopes: dto.scopes, rateLimitPerMinute: dto.rate_limit_per_minute }));
      const secret = await this.addSecret(m, c.id);
      c.secrets = [await m.getRepository(ApiClientSecret).findOneByOrFail({ id: secret.id })];
      return { client: toDto(c), client_secret: secret.secret };
    });
  }

  private async addSecret(m: import('typeorm').EntityManager, apiClientId: string): Promise<{ id: string; secret: string }> {
    const secret = `hrs_${randomToken(32)}`;
    const row = await m.getRepository(ApiClientSecret).save(m.getRepository(ApiClientSecret).create({ apiClientId, secretHash: sha256(secret), prefix: secret.slice(0, 10) }));
    return { id: row.id, secret };
  }

  async update(id: string, dto: z.infer<typeof updateApiClient>, version: number): Promise<ApiClientDto> {
    return this.dataSource.transaction(async (m) => {
      const repo = m.getRepository(ApiClient);
      const c = await repo.findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
      if (!c) throw notFound('API client');
      assertVersion(c.version, version);
      if (dto.name !== undefined) c.name = dto.name;
      if (dto.description !== undefined) c.description = dto.description ?? null;
      if (dto.scopes !== undefined) c.scopes = dto.scopes;
      if (dto.rate_limit_per_minute !== undefined) c.rateLimitPerMinute = dto.rate_limit_per_minute;
      if (dto.is_active !== undefined) c.isActive = dto.is_active;
      await repo.save(c);
      return toDto((await repo.findOne({ where: { id }, relations: { secrets: true } }))!);
    });
  }

  /** New secret; the previous active ones keep working for the grace period, then expire. */
  async rotate(id: string, graceHours: number): Promise<{ client_id: string; client_secret: string; secret_id: string }> {
    return this.dataSource.transaction(async (m) => {
      const c = await m.getRepository(ApiClient).findOneBy({ id });
      if (!c) throw notFound('API client');
      const expiry = new Date(Date.now() + graceHours * 3_600_000);
      await m
        .createQueryBuilder()
        .update(ApiClientSecret)
        .set({ expiresAt: expiry })
        .where('api_client_id = :id AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > :expiry)', { id, expiry })
        .execute();
      const secret = await this.addSecret(m, id);
      await writeAudit(m, { action: AuditAction.SECRET_ROTATED, entityType: 'ApiClient', entityId: id, after: { secretId: secret.id, previousExpireAt: expiry.toISOString() } });
      return { client_id: c.clientId, client_secret: secret.secret, secret_id: secret.id };
    });
  }

  async revokeSecret(clientId: string, secretId: string): Promise<void> {
    const res = await this.dataSource.getRepository(ApiClientSecret).update({ id: secretId, apiClientId: clientId, revokedAt: IsNull() }, { revokedAt: new Date() });
    if (!res.affected) throw notFound('Active secret');
    await writeAudit(this.dataSource.manager, { action: 'secret_revoked', entityType: 'ApiClient', entityId: clientId, after: { secretId } });
  }

  /** OAuth 2.0 client-credentials grant. */
  async token(clientId: string | undefined, clientSecret: string | undefined, requestedScope: string | undefined): Promise<TokenResponse> {
    if (!clientId || !clientSecret) throw oauthError(401, 'invalid_client', 'Send client_id and client_secret (HTTP Basic or form fields)');
    const client = await this.dataSource.getRepository(ApiClient).findOneBy({ clientId });
    const secret = client
      ? await this.dataSource.getRepository(ApiClientSecret).findOneBy({ apiClientId: client.id, secretHash: sha256(clientSecret), revokedAt: IsNull() })
      : null;
    if (!client || !secret || (secret.expiresAt && secret.expiresAt < new Date())) throw oauthError(401, 'invalid_client', 'Unknown client or wrong secret');
    if (!client.isActive) throw oauthError(401, 'invalid_client', 'This client is disabled');

    const requested = requestedScope ? requestedScope.split(/\s+/).filter(Boolean) : client.scopes;
    const notAllowed = requested.filter((s) => !client.scopes.includes(s));
    if (notAllowed.length) throw oauthError(400, 'invalid_scope', `Not granted to this client: ${notAllowed.join(' ')}`);

    const ttl = loadEnv().clientTokenTtlSeconds;
    const access = await this.tokens.sign({ sub: client.id, typ: 'client', scope: requested.join(' '), client_id: client.clientId }, ttl);
    // Bookkeeping, not an edit: raw SQL so the row version (ETag) does not change.
    await this.dataSource.query(`UPDATE api_client_secret SET last_used_at = now() WHERE id = $1`, [secret.id]);
    await this.dataSource.query(`UPDATE api_client SET last_used_at = now() WHERE id = $1`, [client.id]);
    await writeAudit(this.dataSource.manager, { action: AuditAction.TOKEN_ISSUED, entityType: 'ApiClient', entityId: client.id, after: { scope: requested.join(' ') }, actor: { type: 'client', id: client.id, name: client.name } });
    return { access_token: access, token_type: 'Bearer', expires_in: ttl, scope: requested.join(' ') };
  }
}
