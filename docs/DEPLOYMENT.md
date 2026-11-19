# Deploying PeopleTrack

This covers a production deployment of slice 1. It will grow with each slice (OIDC and the
identity provider in slice 2, connectors from slice 4).

## Processes

| Process | Image target | Command | Notes |
|---|---|---|---|
| API | `api` | `node dist/src/main.js` | Stateless; run 2+ behind a load balancer. Runs migrations on boot when `DB_MIGRATIONS_RUN=true` (run them from one instance, or as a release step with `pnpm --filter @sil/hr-api db:migrate:prod`). |
| Worker | `api` | `node dist/src/worker.js` | Publishes the outbox, delivers webhooks, sends mail. Safe to run several (work is claimed with `SKIP LOCKED` and leases). |
| Web | `web` | `node apps/web/server.js` | Next.js; needs `HR_API_INTERNAL_URL` pointing at the API. |

Dependencies: PostgreSQL 16+, Redis 7+ (rate limits, job scheduling, event stream), an
S3-compatible object store, an SMTP relay.

Put TLS in front of the web app and the API (nginx, Traefik or the load balancer). The API
should be reachable by other systems at a stable URL (`PUBLIC_BASE_URL`); the browser only
needs the web origin.

## Configuration

With `NODE_ENV=production` the API refuses to start on the development keys or with sample
data enabled.

| Variable | Production value |
|---|---|
| `NODE_ENV` | `production` |
| `DATABASE_URL` | dedicated database and role (owner of the schema for migrations) |
| `REDIS_URL` | Redis with persistence (AOF) |
| `JWT_SIGNING_KEY` | `openssl rand -hex 32`. Signs access tokens (Ed25519 seed). |
| `JWT_PREVIOUS_SIGNING_KEY` | set to the old key for one token lifetime when rotating |
| `DATA_ENCRYPTION_KEY` | `openssl rand -hex 32`. Encrypts personal data columns, TOTP secrets, webhook secrets. **Back it up separately from the database: without it encrypted data is unrecoverable.** |
| `BLIND_INDEX_KEY` | `openssl rand -hex 32`. Keys the searchable hashes of encrypted values. Never change it without re-indexing. |
| `PUBLIC_BASE_URL` | `https://hr-api.<hospital domain>` |
| `CORS_ORIGINS` | the web origin, if browsers call the API directly (the bundled web app does not) |
| `TRUST_PROXY` | `true` behind a reverse proxy, so audit IPs are the client's |
| `S3_ENDPOINT`, `S3_PUBLIC_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY` | object store; `S3_PUBLIC_ENDPOINT` is what browsers use for signed download links |
| `SMTP_URL`, `MAIL_FROM` | mail relay |
| `JOBS_MODE` | `queue` (worker process) |
| `SEED_ON_START` | `true` on first boot with `SEED_SAMPLE=false`: loads reference data only (permissions, built-in roles, numbering, templates) |
| `METRICS_TOKEN` | bearer token for the Prometheus scraper at `/api/v1/metrics` |
| `COOKIE_SECURE` (web) | `true` (default in production) |
| `API_DOCS` | leave on; the docs are part of the product |

## First administrator

With `SEED_SAMPLE=false` no users exist. Create the first System Admin from a shell in an
API container:

```bash
node -e "
const { NestFactory } = require('@nestjs/core');
const { AppModule } = require('./dist/src/app.module');
const { UsersService } = require('./dist/src/modules/identity-access/users.service');
const { DataSource } = require('typeorm');
(async () => {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  const [role] = await app.get(DataSource).query(\"SELECT id FROM role WHERE code = 'system_admin'\");
  await app.get(UsersService).create({ username: 'admin', display_name: 'System Administrator', password: process.env.ADMIN_PASSWORD, roles: [{ role_id: role.id, scope: 'organisation' }] });
  await app.close();
})();"
```

They must change the password at first sign-in. Turn on two-factor sign-in for every
administrator (My account → Two-factor sign-in).

## Health, logs and metrics

* `GET /api/v1/health`: liveness (process up).
* `GET /api/v1/health/ready`: readiness; `503` unless the database, Redis and object store
  answer within 2 s.
* Logs are JSON on stdout (pino): one `request` line per HTTP request, with
  `correlation_id`, actor, status and duration. Secrets and personal data are never logged.
* `GET /api/v1/metrics` (Prometheus): HTTP latency histogram, events published, process
  metrics.
* Both API and worker shut down gracefully on SIGTERM (in-flight requests and jobs finish).

Watch: unpublished outbox events (**Integrations → Outbox → Unpublished only**), paused
webhook subscriptions, and the `silhr_http_request_duration_seconds` p95.

## Backup and restore

What to back up:

1. **PostgreSQL**: everything except files. Nightly `pg_dump -Fc`, plus WAL archiving or
   managed point-in-time recovery for anything tighter than a day.
2. **Object storage**: the documents bucket (versioning on the bucket is recommended).
3. **Keys**: `DATA_ENCRYPTION_KEY`, `BLIND_INDEX_KEY`, `JWT_SIGNING_KEY`, kept in the
   secrets manager, backed up separately from the data.

Redis holds nothing that cannot be lost: rate-limit counters, job schedules and the event
stream (consumers resync with `updated_since`).

```bash
# backup
pg_dump -Fc -d "$DATABASE_URL" -f silhr-$(date +%F).dump
mc mirror --overwrite prod/silhr-documents backup/silhr-documents-$(date +%F)

# restore into an empty database, then start the API (migrations bring it up to date)
createdb silhr_restore
pg_restore -d silhr_restore --no-owner silhr-2026-11-14.dump
mc mirror backup/silhr-documents-2026-11-14 prod/silhr-documents
```

Restore drill: restore the latest dump into a scratch database monthly, start an API
against it with the production keys, sign in and download a document.

The audit log is append-only (a trigger refuses UPDATE, DELETE and TRUNCATE). To archive
old entries, a DBA must disable the trigger deliberately, which itself shows up in the
PostgreSQL logs.

## Upgrades

1. Back up.
2. Deploy the new images; one API instance runs migrations (or run them first as a job).
3. Roll the remaining API, worker and web instances.

Migrations are hand-written and reviewed; `synchronize` is never used.

## Timeouts

Payroll calculation for the whole hospital runs in one request (under a minute for 2,000
staff; see PERFORMANCE.md). Give the reverse proxy and load balancer a read timeout of at
least 120 seconds for the API.
