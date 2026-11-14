import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { Request, Response } from 'express';
import { from, lastValueFrom, Observable } from 'rxjs';
import { Column, CreateDateColumn, DataSource, Entity, Index, PrimaryColumn } from 'typeorm';
import { sha256 } from './crypto';
import { ProblemException } from './problem';
import { RequestContext } from './request-context';

export const IDEMPOTENCY_HEADER = 'idempotency-key';
const KEY_RE = /^[A-Za-z0-9._:-]{8,200}$/;
const TTL_HOURS = 24;

/** One row per (caller, Idempotency-Key): the stored response is replayed on retries. */
@Entity('idempotency_key')
@Index(['actorKey', 'key'], { unique: true })
export class IdempotencyKey {
  @PrimaryColumn({ type: 'uuid', default: () => 'uuid_generate_v7()' })
  id: string;

  @Column({ type: 'varchar', length: 120 })
  actorKey: string;

  @Column({ type: 'varchar', length: 200 })
  key: string;

  @Column({ type: 'char', length: 64 })
  requestHash: string;

  @Column({ type: 'varchar', length: 20 })
  state: 'in_progress' | 'completed';

  @Column({ type: 'int', nullable: true })
  responseStatus: number | null;

  @Column({ type: 'jsonb', nullable: true })
  responseBody: unknown;

  @CreateDateColumn({ type: 'timestamptz', precision: 3 })
  createdAt: Date;

  @Column({ type: 'timestamptz', precision: 3 })
  expiresAt: Date;
}

/**
 * Honours `Idempotency-Key` on POST. The first request with a key runs and its response
 * is stored; a retry with the same key and body gets the stored response (same status),
 * a retry with a different body gets 422, and a retry while the first is still running
 * gets 409. A failed first attempt releases the key so it can be retried.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<Request>();
    const res = context.switchToHttp().getResponse<Response>();
    const key = req.get(IDEMPOTENCY_HEADER);
    if (req.method !== 'POST' || !key) return next.handle();
    return from(this.run(context, req, res, key, next));
  }

  private async run(context: ExecutionContext, req: Request, res: Response, key: string, next: CallHandler): Promise<unknown> {
    if (!KEY_RE.test(key)) throw new ProblemException(400, 'invalid_idempotency_key', 'Idempotency-Key must be 8–200 characters: letters, digits, . _ : -');
    const ctx = RequestContext.get();
    const actorKey = `${ctx?.actorType ?? 'anon'}:${ctx?.actorId ?? req.ip ?? 'unknown'}`.slice(0, 120);
    const requestHash = sha256(`${req.method} ${req.originalUrl}\n${JSON.stringify(req.body ?? null)}`);
    const repo = this.dataSource.getRepository(IdempotencyKey);

    await this.dataSource.query(`DELETE FROM idempotency_key WHERE actor_key = $1 AND key = $2 AND expires_at < now()`, [actorKey, key]);
    const inserted = await this.dataSource.query(
      `INSERT INTO idempotency_key (actor_key, key, request_hash, state, expires_at)
       VALUES ($1, $2, $3, 'in_progress', now() + interval '${TTL_HOURS} hours')
       ON CONFLICT (actor_key, key) DO NOTHING RETURNING id`,
      [actorKey, key, requestHash],
    );
    if (!inserted.length) {
      const existing = await repo.findOneByOrFail({ actorKey, key });
      if (existing.requestHash !== requestHash) {
        throw new ProblemException(422, 'idempotency_key_reused', 'This Idempotency-Key was already used with a different request');
      }
      if (existing.state === 'in_progress') {
        throw new ProblemException(409, 'idempotency_in_progress', 'A request with this Idempotency-Key is still being processed');
      }
      res.status(existing.responseStatus ?? 200);
      res.setHeader('Idempotent-Replayed', 'true');
      return existing.responseBody;
    }

    const id = inserted[0].id as string;
    try {
      const body = await lastValueFrom(next.handle(), { defaultValue: undefined });
      const declared = Reflect.getMetadata('__httpCode__', context.getHandler()) as number | undefined;
      const status = declared ?? (res.statusCode !== 200 ? res.statusCode : 201);
      await repo.update({ id }, { state: 'completed', responseStatus: status, responseBody: (body ?? null) as never });
      return body;
    } catch (err) {
      await repo.delete({ id });
      throw err;
    }
  }
}
