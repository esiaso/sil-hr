import type { LoggerService } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import pino, { type Logger } from 'pino';
import { Counter, Histogram, collectDefaultMetrics, register } from 'prom-client';
import { loadEnv } from '../config/env';
import { RequestContext } from './request-context';

/**
 * Structured JSON logs. Every line carries the correlation id and actor of the request
 * or job it belongs to. Secrets and personal data never go into log fields.
 */
export const rootLogger: Logger = pino({
  level: loadEnv().logLevel,
  base: { service: 'sil-hr' },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: { paths: ['*.password', '*.secret', '*.client_secret', '*.refresh_token', '*.access_token', '*.authorization', 'req.headers.authorization', 'req.headers.cookie'], censor: '[REDACTED]' },
  mixin() {
    const ctx = RequestContext.get();
    return ctx ? { correlation_id: ctx.correlationId, actor: ctx.actorId ? `${ctx.actorType}:${ctx.actorId}` : undefined } : {};
  },
});

export class PinoNestLogger implements LoggerService {
  log(message: unknown, context?: string) {
    this.write('info', message, context);
  }
  error(message: unknown, trace?: string, context?: string) {
    this.write('error', message, context, trace);
  }
  warn(message: unknown, context?: string) {
    this.write('warn', message, context);
  }
  debug(message: unknown, context?: string) {
    this.write('debug', message, context);
  }
  verbose(message: unknown, context?: string) {
    this.write('trace', message, context);
  }
  private write(level: 'info' | 'error' | 'warn' | 'debug' | 'trace', message: unknown, context?: string, trace?: string) {
    if (message && typeof message === 'object') rootLogger[level]({ context, ...(message as object), ...(trace ? { trace } : {}) });
    else rootLogger[level]({ context, ...(trace ? { trace } : {}) }, String(message));
  }
}

collectDefaultMetrics({ prefix: 'silhr_' });
const httpDuration = new Histogram({ name: 'silhr_http_request_duration_seconds', help: 'HTTP request duration', labelNames: ['method', 'route', 'status'], buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5] });
export const eventsPublished = new Counter({ name: 'silhr_events_published_total', help: 'Outbox events published' });
export const webhookAttempts = new Counter({ name: 'silhr_webhook_attempts_total', help: 'Webhook delivery attempts', labelNames: ['outcome'] });
export const metricsRegistry = register;

/** One access-log line and one histogram observation per request. */
export function accessLogMiddleware(req: Request, res: Response, next: NextFunction): void {
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const seconds = Number(process.hrtime.bigint() - start) / 1e9;
    const route = (req.route?.path as string | undefined) ?? 'unmatched';
    httpDuration.observe({ method: req.method, route, status: String(res.statusCode) }, seconds);
    rootLogger.info({ method: req.method, path: req.originalUrl.split('?')[0], status: res.statusCode, ms: Math.round(seconds * 1000), ip: req.ip }, 'request');
  });
  next();
}
