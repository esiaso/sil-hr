import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { ActorType } from '@sil/hr-shared';
import type { AccessProfile } from './access';

/** Who is acting, carried through services, the audit subscriber, the outbox and jobs. */
export interface RequestContextData {
  correlationId: string;
  actorType: ActorType;
  actorId: string | null;
  actorName: string | null;
  ip: string | null;
  userAgent: string | null;
  /** Resolved permissions and data scopes; null until the auth guard has run. */
  access: AccessProfile | null;
}

const storage = new AsyncLocalStorage<RequestContextData>();

export const CORRELATION_HEADER = 'x-correlation-id';

export const RequestContext = {
  get(): RequestContextData | undefined {
    return storage.getStore();
  },

  run<T>(data: Partial<RequestContextData>, fn: () => T): T {
    return storage.run(
      {
        correlationId: randomUUID(),
        actorType: 'system',
        actorId: null,
        actorName: 'system',
        ip: null,
        userAgent: null,
        access: null,
        ...data,
      },
      fn,
    );
  },

  /** Updates the current context in place (the auth guard, login). */
  setActor(actor: { type: ActorType; id: string | null; name: string | null; access?: AccessProfile | null }): void {
    const ctx = storage.getStore();
    if (!ctx) return;
    ctx.actorType = actor.type;
    ctx.actorId = actor.id;
    ctx.actorName = actor.name;
    if (actor.access !== undefined) ctx.access = actor.access;
  },

  correlationId(): string | null {
    return storage.getStore()?.correlationId ?? null;
  },
};

const CORRELATION_RE = /^[A-Za-z0-9._:-]{8,100}$/;

export function requestContextMiddleware(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.get(CORRELATION_HEADER);
  const correlationId = incoming && CORRELATION_RE.test(incoming) ? incoming : randomUUID();
  res.setHeader(CORRELATION_HEADER, correlationId);
  RequestContext.run(
    {
      correlationId,
      actorType: 'system',
      actorId: null,
      actorName: null,
      ip: req.ip ?? req.socket.remoteAddress ?? null,
      userAgent: req.get('user-agent')?.slice(0, 300) ?? null,
    },
    () => next(),
  );
}
