import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { QueryFailedError } from 'typeorm';
import { ZodError } from 'zod';
import type { Problem } from '@sil/hr-shared';
import { RequestContext } from './request-context';

export const PROBLEM_CONTENT_TYPE = 'application/problem+json';
const TYPE_BASE = 'urn:sil:hr:problem:';

const TITLES: Record<number, string> = {
  400: 'Bad request',
  401: 'Unauthorised',
  403: 'Forbidden',
  404: 'Not found',
  409: 'Conflict',
  412: 'Precondition failed',
  413: 'Payload too large',
  415: 'Unsupported media type',
  422: 'Unprocessable content',
  428: 'Precondition required',
  429: 'Too many requests',
  500: 'Internal server error',
  503: 'Service unavailable',
};

/**
 * Throw this for every expected error. `code` is a stable machine-readable string
 * (also the last segment of `type`); `detail` is for humans.
 */
export class ProblemException extends HttpException {
  constructor(
    status: number,
    readonly code: string,
    detail?: string,
    readonly errors?: { path: string; message: string }[],
    readonly extra?: Record<string, unknown>,
  ) {
    super({ code, detail }, status);
  }
}

export const notFound = (what = 'Resource') => new ProblemException(404, 'not_found', `${what} not found`);
export const conflict = (code: string, detail: string) => new ProblemException(409, code, detail);
export const badRequest = (code: string, detail: string) => new ProblemException(400, code, detail);
export const unprocessable = (code: string, detail: string, errors?: { path: string; message: string }[]) =>
  new ProblemException(422, code, detail, errors);
export const forbidden = (detail = 'You do not have permission to do this', code = 'forbidden') =>
  new ProblemException(403, code, detail);
export const unauthorised = (detail = 'Authentication required', code = 'unauthorised') =>
  new ProblemException(401, code, detail);

export function zodErrors(err: ZodError): { path: string; message: string }[] {
  return err.issues.map((i) => ({ path: i.path.join('.') || '(root)', message: i.message }));
}

/** Maps PostgreSQL constraint violations to problems. Constraint names are deterministic. */
function fromQueryFailed(err: QueryFailedError): ProblemException | null {
  const driver = err.driverError as { code?: string; constraint?: string; detail?: string } | undefined;
  switch (driver?.code) {
    case '23505':
      return new ProblemException(409, 'duplicate', duplicateDetail(driver.detail), undefined, { constraint: driver.constraint });
    case '23503':
      return new ProblemException(409, 'referenced', 'The record is referenced by, or refers to, a record that does not exist or is in use', undefined, { constraint: driver.constraint });
    case '23P01':
      return new ProblemException(409, 'overlap', 'The date range overlaps an existing one', undefined, { constraint: driver.constraint });
    case '23514':
      return new ProblemException(422, 'check_violation', `A value breaks the rule ${driver.constraint ?? ''}`.trim(), undefined, { constraint: driver.constraint });
    case '22P02':
      return new ProblemException(400, 'invalid_input', 'A value has the wrong format');
    default:
      return null;
  }
}

function duplicateDetail(detail?: string): string {
  const m = detail && /Key \((.+?)\)=\((.+?)\) already exists/.exec(detail);
  if (!m) return 'A record with these values already exists';
  const fields = m[1].replace(/lower\((\w+)::text\)/g, '$1').replace(/"/g, '');
  return `A record with this ${fields.replace(/_/g, ' ')} already exists`;
}

export function toProblem(exception: unknown, instance?: string): Problem & Record<string, unknown> {
  let ex: unknown = exception;
  if (ex instanceof ZodError) ex = new ProblemException(422, 'validation_failed', 'The request is not valid', zodErrors(ex));
  if (ex instanceof QueryFailedError) ex = fromQueryFailed(ex) ?? ex;

  const correlation_id = RequestContext.correlationId() ?? undefined;
  if (ex instanceof ProblemException) {
    const status = ex.getStatus();
    const body = ex.getResponse() as { detail?: string };
    return {
      type: TYPE_BASE + ex.code,
      title: TITLES[status] ?? 'Error',
      status,
      detail: body.detail,
      code: ex.code,
      instance,
      correlation_id,
      ...(ex.errors ? { errors: ex.errors } : {}),
      ...(ex.extra ?? {}),
    };
  }
  if (ex instanceof HttpException) {
    const status = ex.getStatus();
    const res = ex.getResponse();
    const message = typeof res === 'string' ? res : (res as { message?: string | string[] }).message;
    const code = status === 404 ? 'not_found' : status === 413 ? 'payload_too_large' : `http_${status}`;
    return {
      type: TYPE_BASE + code,
      title: TITLES[status] ?? 'Error',
      status,
      detail: Array.isArray(message) ? message.join('; ') : message,
      code,
      instance,
      correlation_id,
    };
  }
  return {
    type: TYPE_BASE + 'internal',
    title: TITLES[500],
    status: 500,
    detail: 'Something went wrong. Quote the correlation id when reporting it.',
    code: 'internal',
    instance,
    correlation_id,
  };
}

@Catch()
export class ProblemFilter implements ExceptionFilter {
  private readonly logger = new Logger('Problem');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const req = ctx.getRequest<Request>();
    const res = ctx.getResponse<Response>();
    const problem = toProblem(exception, req.originalUrl?.split('?')[0]);
    if (problem.status >= 500) this.logger.error({ err: exception, correlationId: problem.correlation_id }, 'Unhandled error');
    if (res.headersSent) return;
    if (problem.status === 429 && (exception as { retryAfter?: number }).retryAfter) {
      res.setHeader('Retry-After', String((exception as { retryAfter?: number }).retryAfter));
    }
    res.status(problem.status).type(PROBLEM_CONTENT_TYPE).send(JSON.stringify(problem));
  }
}

export { HttpStatus };
