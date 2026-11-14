import { CallHandler, ExecutionContext, Injectable, NestInterceptor, createParamDecorator } from '@nestjs/common';
import { ApiHeader } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { map, Observable } from 'rxjs';
import { ProblemException } from './problem';

/**
 * Optimistic concurrency. Every versioned resource is returned with `ETag: "<version>"`.
 * PUT/PATCH/DELETE on it must send `If-Match` with that value: missing → 428, stale → 412.
 */
export const etagOf = (version: number) => `"${version}"`;

function parseIfMatch(header: string | undefined): number {
  if (!header) {
    throw new ProblemException(428, 'if_match_required', 'Send If-Match with the ETag you last read, so concurrent edits are not lost');
  }
  const m = /^(?:W\/)?"(\d+)"$/.exec(header.trim());
  if (!m) throw new ProblemException(400, 'invalid_if_match', 'If-Match must be the ETag value, e.g. "3"');
  return Number(m[1]);
}

/** The version the client last saw, from If-Match. */
export const IfMatch = createParamDecorator((_data: unknown, ctx: ExecutionContext): number => {
  return parseIfMatch(ctx.switchToHttp().getRequest<Request>().get('if-match'));
});

export const ApiIfMatch = () => ApiHeader({ name: 'If-Match', required: true, description: 'ETag of the version being changed' });

export function assertVersion(current: number, expected: number): void {
  if (current !== expected) {
    throw new ProblemException(412, 'version_mismatch', `The record changed since you read it (now version ${current}); reload and try again`, undefined, {
      current_version: current,
    });
  }
}

/** Sets ETag on single-resource responses and answers If-None-Match with 304. */
@Injectable()
export class EtagInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();
    return next.handle().pipe(
      map((body) => {
        if (body && typeof body === 'object' && !Array.isArray(body) && typeof (body as { version?: unknown }).version === 'number') {
          const etag = etagOf((body as { version: number }).version);
          res.setHeader('ETag', etag);
          if (req.method === 'GET' && req.get('if-none-match') === etag) {
            res.status(304);
            return undefined;
          }
        }
        return body;
      }),
    );
  }
}
