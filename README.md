# SIL HR

Human resources and payroll for a private hospital in Kenya, and the organisation's
**system of record for people and structure**. Procurement, the HMIS, the lab systems and
finance read staff, departments and reporting lines from it, react to its events, and feed
it. Integration is a product module of its own (API clients, webhooks, event catalogue),
not an afterthought.

It replaces an evaluated off-the-shelf Laravel HRM. The brief is in
[`HR_SYSTEM_BUILD_PROMPT.md`](HR_SYSTEM_BUILD_PROMPT.md); the design, and every place it
departs from the brief, is in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). The repository
follows the conventions of `sil_procurement`.

**Slice 1 (this release): foundations.** Authentication (local accounts, TOTP, rotating
refresh tokens), RBAC with data scopes, organisation structure (branches, department tree,
cost centres, job grades, positions with headcount), audit trail, numbering, settings,
documents in object storage, the API conventions (cursor pagination, incremental sync with
tombstones, ETag/If-Match, Idempotency-Key, problem details, correlation ids, rate limits),
OAuth client credentials for other systems, and the transactional outbox publishing to
signed webhooks and a Redis Stream. Later slices: employees and self-service, workflow and
leave, time and attendance, payroll, lifecycle, recruitment, performance and training,
remaining connectors, hardening (brief §9).

Defaults are KES, Africa/Nairobi, DD/MM/YYYY, a Monday–Friday week and a January leave
year. **All of them are database settings, not code.**

---

## Quick start (Docker only)

```bash
docker compose up --build
```

| What | URL |
|---|---|
| Web app | http://localhost:3300 |
| API | http://localhost:3310/api/v1 |
| OpenAPI (Swagger UI) | http://localhost:3310/api/v1/docs (JSON at `/api/v1/openapi.json`) |
| Event catalogue | http://localhost:3310/api/v1/events/catalogue, or Integrations → Event catalogue |
| Mailpit (every email the system sends) | http://localhost:8026 |
| Webhook sink (verifies and shows sample webhook deliveries) | http://localhost:8099/hooks |
| MinIO console | http://localhost:9011 |

Host ports are chosen not to collide with `sil_procurement` (which uses 3000, 8080, 5432…)
and can be changed in `.env` (`WEB_PORT`, `API_PORT`, `POSTGRES_PORT`, `REDIS_PORT`,
`MINIO_PORT`, `MAILPIT_UI_PORT`, `WEBHOOK_SINK_PORT`).

On first start the API runs the migrations and seeds a sample hospital: two branches
(Main Hospital, Satellite Clinic), 20 departments in a tree (Clinical Services → Nursing →
Medical/Surgical/Maternity/ICU…), 14 cost centres, 8 job grades, 17 positions with
headcount and licensing bodies, one user per role, and a webhook subscription to the
development sink. **All names, numbers and addresses are made up.**

### Sample logins

Every sample user's password is `SEED_DEFAULT_PASSWORD` (development value:
`Hospital#Dev2026`, in [`docker-compose.yml`](docker-compose.yml) and
[`.env.example`](.env.example)).

| Username | Role | Data scope |
|---|---|---|
| `admin` | System Admin | organisation |
| `hr.manager` | HR Manager | organisation |
| `hr.officer` | HR Officer | Main Hospital branch only |
| `payroll` | Payroll Officer | organisation |
| `finance` | Finance Approver | organisation |
| `head.nursing` | Department Head | Nursing and everything under it |
| `line.manager` | Line Manager | direct reports (meaningful from slice 2) |
| `recruiter` | Recruiter | organisation |
| `employee` | Employee | own record (meaningful from slice 2) |
| `auditor` | Auditor (read-only) | organisation |

### Running the tests

```bash
docker compose --profile test run --build --rm test
```

This builds the test image from the current code and runs:

* **API** (Jest + Supertest) against real PostgreSQL (`silhr_test`, wiped and re-migrated
  each run), Redis (DB 1) and MinIO: login, lockout, forced password change, TOTP and
  recovery codes, refresh-token rotation and reuse detection, logout and disable taking
  effect immediately, IP allow-list; client credentials, scopes, secret rotation and
  revocation; branch- and department-scoped authorisation; ETag/If-Match, Idempotency-Key,
  cursor pagination, `updated_since` tombstones, problem details; department subtree moves
  and cycle checks; the audit trail (diffs, redaction, append-only trigger, rollback);
  numbering under concurrency, yearly reset and rollback; documents in object storage with
  signed links and content sniffing; outbox → signed webhook end to end, retries,
  dead-letter, auto-pause with notification, replay, test events, the Redis Stream;
  OpenAPI and event-catalogue contract snapshots; unit tests for encryption, signatures
  (Standard Webhooks test vector), numbering formats, scope matching, formatting.
* **Web** (Vitest + Testing Library): permission-filtered navigation, problem display,
  dialog keyboard behaviour.

### Contract checks

`docs/openapi.json` (OpenAPI 3.1) and `docs/events.json` are generated from code and checked
in. The test suite fails if the generated contract differs from the committed one, and names
any breaking change (removed operation, new required parameter, removed event type). After
an intended API change:

```bash
pnpm openapi:update      # regenerates both files and the typed client in packages/shared
```

---

## Local development (without the API/web containers)

Prerequisites: Node 22 LTS, pnpm 10 (`corepack enable`), Docker for the backing services.

```bash
cp .env.example .env
docker compose up -d postgres redis minio mailpit
pnpm install
pnpm build:shared
pnpm dev:api          # http://localhost:3310/api/v1 (migrates and seeds on start)
pnpm dev:web          # http://localhost:3300
pnpm test             # api + web tests (needs postgres, redis and minio running)
```

With `JOBS_MODE=inline` (the `.env.example` default) the API runs the background jobs
itself; `pnpm dev:worker` with `JOBS_MODE=queue` runs them in a separate process as in
production.

| Command | Purpose |
|---|---|
| `pnpm db:migrate` | run pending migrations |
| `pnpm db:seed` / `pnpm --filter @sil/hr-api db:seed -- --reference-only` | seed reference (+ sample) data |
| `pnpm typecheck` | type-check every package |
| `pnpm openapi:update` | regenerate the OpenAPI document, event catalogue and typed client |

---

## Repository

```
apps/api         @sil/hr-api     NestJS 11, TypeORM 0.3 on PostgreSQL 16, BullMQ worker (src/worker.ts)
apps/web         @sil/hr-web     Next.js 16 (App Router), React 19, Tailwind 4, TanStack Query, RHF + zod
packages/shared  @sil/hr-shared  zod schemas (the contract), enums, permissions and scopes,
                                 event catalogue, generated OpenAPI types and typed client
docs/            ARCHITECTURE, INTEGRATION (for developers of other systems), DEPLOYMENT,
                 openapi.json, events.json
```

The web app is a client of the public REST API: its `/api/v1/*` route is a transparent
proxy that adds the user's token from an httpOnly cookie. There is no private endpoint.

## Integrating another system

Read **[docs/INTEGRATION.md](docs/INTEGRATION.md)**: credentials and scopes, tokens,
pagination and incremental sync, the event envelope, verifying webhook signatures (Node,
PHP, Python), the Redis Stream, data ownership and external references.

## Production

Follow **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)** (keys, first administrator, health,
metrics, backup and restore). With `NODE_ENV=production` the API refuses to start on
development keys or sample data.

## Needs confirmation

* **Procurement contract.** Procurement records asset custodians as its own user id plus
  free text and has no "assets held by person" query. The exit-clearance check (slice 6)
  will use an assumed endpoint and a mock until procurement adds it. See
  [INTEGRATION.md §6](docs/INTEGRATION.md#6-contracts-that-still-need-confirmation).
* **Hospital facts** needed in later slices: pay-cycle dates, leave entitlements, the
  salary bank's file format, M-Pesa bulk method, the identity provider, licensing bodies
  and reminder lead times, chart of accounts.
