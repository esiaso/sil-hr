import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from '@nestjs/swagger';
import helmet from 'helmet';
import type Redis from 'ioredis';
import { loadEnv, type Env } from './config/env';
import { accessLogMiddleware } from './common/logger';
import { consumeRateLimit, REDIS } from './common/redis';
import { CORRELATION_HEADER, requestContextMiddleware } from './common/request-context';
import { toProblem, PROBLEM_CONTENT_TYPE } from './common/problem';

export const API_PREFIX = 'api/v1';

/** Paths limited per IP (credential guessing). */
const AUTH_PATHS = ['auth/login', 'auth/mfa/verify', 'auth/refresh', 'oauth/token'];

/** HTTP pipeline shared by main.ts, the OpenAPI export and the integration tests. */
export function configureApp(app: NestExpressApplication, env: Env = loadEnv()): void {
  app.setGlobalPrefix(API_PREFIX, { exclude: ['scim/v2/{*path}'] });
  app.set('trust proxy', env.trustProxy ? 1 : false);
  // ETags are ours (resource versions), not Express's body hashes.
  app.set('etag', false);
  app.useBodyParser('json', { type: ['application/json', 'application/scim+json', 'application/merge-patch+json'], limit: '2mb' });
  app.useBodyParser('urlencoded', { extended: false, limit: '100kb' });
  // JSON API: CSP is the web app's job (and would block the Swagger UI).
  app.use(helmet({ contentSecurityPolicy: false }));
  app.enableCors({
    origin: env.corsOrigins,
    credentials: false,
    allowedHeaders: ['Authorization', 'Content-Type', 'If-Match', 'If-None-Match', 'Idempotency-Key', CORRELATION_HEADER],
    exposedHeaders: ['ETag', CORRELATION_HEADER, 'Retry-After', 'Idempotent-Replayed'],
  });
  app.use(requestContextMiddleware);
  app.use(accessLogMiddleware);

  const redis = app.get<Redis>(REDIS);
  for (const path of AUTH_PATHS) {
    app.use(`/${API_PREFIX}/${path}`, (req: import('express').Request, res: import('express').Response, next: import('express').NextFunction) => {
      consumeRateLimit(redis, `ip:${path}:${req.ip}`, env.authRateLimitPerMinute)
        .then(() => next())
        .catch((err) => {
          const problem = toProblem(err, req.originalUrl);
          if ((err as { retryAfter?: number }).retryAfter) res.setHeader('Retry-After', String((err as { retryAfter: number }).retryAfter));
          res.status(problem.status).type(PROBLEM_CONTENT_TYPE).send(JSON.stringify(problem));
        });
    });
  }
  app.enableShutdownHooks();

  if (env.apiDocs) {
    const document = buildOpenApi(app);
    SwaggerModule.setup(`${API_PREFIX}/docs`, app, () => document, { jsonDocumentUrl: `${API_PREFIX}/openapi.json`, customSiteTitle: 'SIL HR API' });
  }
}

/** The OpenAPI 3.1 document, generated from the controllers and zod schemas. */
export function buildOpenApi(app: INestApplication): OpenAPIObject {
  const env = loadEnv();
  const config = new DocumentBuilder()
    .setTitle('SIL HR API')
    .setDescription(
      [
        "The hospital's system of record for people and organisation structure.",
        '',
        '**Authentication.** Machine clients: `POST /api/v1/oauth/token` with `grant_type=client_credentials` (HTTP Basic client id and secret) and send the returned token as `Authorization: Bearer …`. Users: `POST /api/v1/auth/login`.',
        '',
        '**Conventions.** Cursor pagination (`limit`, `cursor` → `next_cursor`), `sort=field` or `-field`, `updated_since` for incremental sync (soft-deleted rows come back as `{id, deleted: true}` tombstones), `ETag` + `If-Match` on updates, `Idempotency-Key` on creating POSTs, RFC 9457 problem details, `X-Correlation-Id` echoed and carried into events.',
      ].join('\n'),
    )
    .setVersion('1.0.0')
    .addServer(env.publicBaseUrl)
    .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' })
    .addOAuth2({ type: 'oauth2', flows: { clientCredentials: { tokenUrl: '/api/v1/oauth/token', scopes: {} } } }, 'oauth2')
    .build();
  const doc = SwaggerModule.createDocument(app, config, { operationIdFactory: (controller, method) => `${controller.replace(/Controller$/, '')}_${method}` });
  return toOpenApi31(doc);
}

/** @nestjs/swagger emits 3.0; our schemas are JSON Schema 2020-12, so declare 3.1. */
function toOpenApi31(doc: OpenAPIObject): OpenAPIObject {
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (!node || typeof node !== 'object') return node;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) out[k] = walk(v);
    if (out.nullable === true && typeof out.type === 'string') {
      out.type = [out.type, 'null'];
      delete out.nullable;
    }
    return out;
  };
  const converted = walk(doc) as OpenAPIObject;
  converted.openapi = '3.1.0';
  return converted;
}
