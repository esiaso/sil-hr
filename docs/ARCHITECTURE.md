# SIL HR: architecture

SIL HR is the hospital's system of record for **people and organisation structure**.
Every other in-house system (procurement and inventory, the lab middleware, the HMIS,
finance) reads from it, reacts to its events and, where agreed, feeds it. Integration
is therefore a product module of its own, built first, not an add-on.

This document covers the module map, the entity outline for slices 1 and 2, the
cross-cutting conventions, and every place this build departs from the brief or from
`sil_procurement`, with the reason.

## 1. Repository shape

```
apps/api          @sil/hr-api     NestJS 11 modular monolith + BullMQ worker entry (src/worker.ts)
apps/web          @sil/hr-web     Next.js (App Router), React 19, Tailwind, TanStack Query, RHF + zod
packages/shared   @sil/hr-shared  enums, permission codes, scopes, zod schemas, event catalogue types,
                                  generated OpenAPI types + typed client (openapi-fetch)
docs/             ARCHITECTURE.md, DEPLOYMENT.md, INTEGRATION.md, openapi.json (checked in), manuals
docker/           Postgres init (test database), Keycloak realm (slice 2)
```

`docker compose up --build` starts Postgres 16, Redis 7, MinIO, Mailpit, the API, the
worker and the web app; the API runs migrations and seeds a sample hospital on boot
(idempotent). Host ports default to values that do not collide with `sil_procurement`
running on the same machine (see README).

## 2. Module map

Each module owns its entities, service(s), controller(s), zod schemas and tests.
**A module never touches another module's repositories**: it calls the other module's
exported service or reacts to a domain event. Cross-module reads that are pure lookups
(e.g. "does this department exist") go through the owning service.

### 2.1 Platform (slice 1 unless noted)

| Module | Owns | Responsibility |
|---|---|---|
| `common` | – | request context (correlation id, actor, scope), problem-details filter, zod validation pipe, cursor pagination, ETag/If-Match, Idempotency-Key, rate limiting, crypto (AES-256-GCM + blind index), UUID v7 |
| `identity-access` | `user`, `role`, `permission`, `role_permission`, `role_assignment`, `refresh_token`, `login_history`, `ip_allow_rule`, `mfa_recovery_code` | local login (argon2id), password policy, lockout, TOTP MFA, JWT access + rotating refresh tokens, login history, IP allow-list, data-scope resolution. OIDC (slice 2) |
| `api-clients` | `api_client`, `api_client_secret` | OAuth 2.0 client-credentials token endpoint, scopes, secret rotation, last-used tracking |
| `organisation` | `organisation`, `branch`, `department` (tree), `cost_centre`, `job_grade`, `position` | structure, headcount; reporting lines and org chart once employees exist (slice 2) |
| `audit` | `audit_log` (append-only) | row-level create/update/delete in the same transaction, plus explicit entries for logins, approvals, exports and sensitive reads |
| `numbering` | `numbering_scheme`, `number_sequence` | prefix/format/padding, yearly reset, gap-free allocation in the caller's transaction |
| `settings` | `setting` | typed, validated keys with defaults (currency, timezone, date format, week, leave-year start, password policy …) |
| `external-refs` | `external_ref` | (entity type, entity id) ↔ (system, external id) for every integratable entity |
| `documents` | `document`, `document_version` | S3 object keys, versioning, virus-scan hook, expiring signed download URLs |
| `notifications` | `notification`, `notification_template`, `email_outbox` | in-app + email (SMTP) through a channel interface; SMS channel added with the SMS gateway |
| `templates` | `letter_template` | merge-field letters to PDF/DOCX (slice 6) |
| `import-export` | `bulk_job` | CSV/XLSX bulk jobs with a status resource (slice 2) |
| `workflow` | `workflow_definition`, `workflow_step`, `workflow_instance`, `workflow_task`, `workflow_action`, `delegation` | generic approval engine (slice 3) |

### 2.2 Integration (slice 1 plumbing, filled out per slice)

| Module | Owns | Responsibility |
|---|---|---|
| `events` | `outbox_event` | `OutboxService.record(manager, event)` inside the business transaction; the code-generated **event catalogue** (type, version, zod schema → JSON Schema) |
| `event-publishing` | – | worker loop draining the outbox (`FOR UPDATE SKIP LOCKED`) to every `EventPublisher` adapter: **webhooks** and **Redis Streams** |
| `webhooks` | `webhook_subscription`, `webhook_delivery`, `webhook_attempt` | per-event-type subscriptions, HMAC-SHA256 signing, exponential backoff, dead-letter, replay, auto-pause |
| `scim` | – | SCIM 2.0 `/scim/v2/Users` and `/Groups` over employees and departments (slice 2) |
| `directory` | – | consumer-shaped read endpoints: staff directory, department tree, cost centres, approver lookup (slice 2) |
| `connectors` | `connector_instance`, `connector_run`, `connector_credential` | connector interface (configure, test, pull/receive, map, health), runs in the worker (slice 4 onwards) |
| `fhir` | – | Practitioner / PractitionerRole for the HMIS (slice 9) |

### 2.3 HR domains (slices 2–9)

`employees`, `leave`, `time-attendance`, `payroll`, `contracts`, `lifecycle`
(promotions, transfers, resignations, terminations), `onboarding-offboarding`,
`employee-relations`, `recruitment`, `performance`, `training`, `travel-expenses`,
`policy-documents`, `announcements`, `meetings`, `calendar`, `reports`, `self-service`.
Each submits approvals to `workflow` and listens for its outcome; none carries an
`approved_by` column.

## 3. Cross-cutting conventions

**Identifiers.** Primary keys are UUID v7, generated by a `uuid_generate_v7()` SQL
function installed by the first migration (PostgreSQL 16 has no built-in v7), so raw
SQL inserts and seeds get them too. Human-readable numbers come from `numbering`.

**Organisation scoping.** Root tables carry `organisation_id`. There is exactly one
organisation row in this build; no tenant switching.

**Access control.** Permissions are `resource:action` codes defined once in
`packages/shared/src/permissions.ts`; roles are data. A **role assignment** binds a user
to a role *with a data scope*: `own`, `direct_reports`, `department`, `branch` or
`organisation`, plus the department/branch it applies to. At request time the guard
resolves the caller's permissions and, per permission, the union of their scopes into a
`ScopeFilter` (`{ all } | { branchIds, departmentIds (incl. descendants), employeeIds }`).
Services apply it with one helper, `scope.apply(qb, { branch, department, employee })`,
which is the only place scope SQL is written. Single-row reads outside scope return 404.

**Authentication.** Humans and machines both call the API with a bearer JWT (EdDSA,
15-minute lifetime, `kid` for key rotation). Humans get one by login (+ TOTP) and keep
it fresh with a rotating, reuse-detected refresh token; machine clients use OAuth 2.0
client credentials. Every token carries `sub`, `typ` (`user` | `client`) and, for
clients, `scope`. The web app keeps tokens in httpOnly cookies on its own origin (see §5).

**Validation.** zod schemas in `packages/shared` are the contract. A `ZodValidationPipe`
validates bodies and queries; `@ZodBody(schema)` / `@ZodQuery(schema)` also register the
schema in OpenAPI (zod 4 native JSON Schema output). The web forms use the same schemas
with `@hookform/resolvers/zod`.

**API conventions** (every endpoint unless stated):
- `/api/v1`, OpenAPI 3.1 generated from code, served at `/api/v1/docs` and
  `/api/v1/openapi.json`, checked in at `docs/openapi.json`, compared by a test (a change
  to the contract must be committed deliberately; removing a path or required field
  fails `pnpm openapi:check`).
- Collections: `?limit=&cursor=` (opaque, keyset on `(updated_at, id)` or the sort key),
  `?sort=field,-field`, field filters, `?updated_since=` (includes soft-deleted rows as
  tombstones `{ id, deleted: true, deleted_at }`). Response `{ data, next_cursor }`.
- `ETag` on single resources (from `version` column); `If-Match` required on
  PUT/PATCH/DELETE of versioned resources, 412 on mismatch, 428 if missing.
- `Idempotency-Key` honoured on every POST that creates or pays (stored with request hash
  and response for 24 h; same key + different body → 422).
- Errors are RFC 9457 `application/problem+json` with `type`, `title`, `status`,
  `detail`, `instance`, `correlation_id`, and `errors[]` for validation.
- `X-Correlation-Id` accepted or generated, echoed, logged, put on jobs and on events
  (`correlationid` CloudEvents extension).
- Rate limits per client/user and per IP for auth endpoints (Redis).

**Money and time.** `numeric(14,2)` columns read as strings and handled with
`decimal.js` (never JS numbers). Timestamps are `timestamptz` UTC; calendar dates are
`date` (strings `YYYY-MM-DD` in code). Display timezone and format are settings.

**Effective dating.** History tables use `effective_from date not null`,
`effective_to date null` and an exclusion constraint
(`EXCLUDE USING gist (subject_id WITH =, daterange(effective_from, effective_to, '[]') WITH &&)`)
so overlaps are impossible at the database level. Slice 1 uses it for nothing yet;
slice 2 uses it for position assignments.

**Audit.** A TypeORM subscriber writes `audit_log` rows in the same transaction as each
insert/update/delete (only changed fields on update; encrypted columns written as
`[ENCRYPTED]`). Logins, exports, approvals and sensitive reads are written explicitly.
A trigger rejects UPDATE/DELETE/TRUNCATE on `audit_log`. Actor is the user or the API
client.

**Soft delete.** People and structure rows have `deleted_at`; the UI never hard-deletes.
Real foreign keys, unique and check constraints throughout.

**Personal data.** Sensitive columns (national ID, KRA PIN, bank account, health fields)
are AES-256-GCM encrypted in the application with a versioned key
(`v1:<iv>:<tag>:<ct>`), plus an HMAC blind index where uniqueness or lookup is needed.
Responses mask them (`****1234`) unless the caller holds the matching `*.sensitive:read`
permission/scope, in which case the read is audited. They never appear in logs, events
or URLs.

**Enums.** Lowercase snake_case, defined in `packages/shared/src/enums.ts`, stored as
Postgres enums or `varchar` + check constraint.

**Logs and ops.** pino JSON logs with correlation id and actor; `/api/v1/health`
(liveness) and `/api/v1/health/ready` (database, Redis, object storage); Prometheus
metrics at `/api/v1/metrics` (protected); graceful shutdown in API and worker.

## 4. Events and webhooks

1. A service changes data and calls `outbox.record(manager, { type, subject, data })`
   in the **same transaction**. Rollback ⇒ no event.
2. The worker claims unpublished rows (`FOR UPDATE SKIP LOCKED`, batch, ordered by id),
   hands each CloudEvents 1.0 envelope to every `EventPublisher` adapter, and marks the
   row published. Publisher down ⇒ the row stays and is retried.
3. **Redis Streams adapter**: `XADD hr.events * …` (stream name configurable, trimmed by
   `MAXLEN ~`). **Webhook adapter**: fans the event out into one `webhook_delivery` per
   matching active subscription and enqueues a BullMQ job per delivery.
4. Delivery: `POST` the envelope with headers `Webhook-Id`, `Webhook-Timestamp`,
   `Webhook-Signature: v1,<base64 HMAC-SHA256(secret, id.timestamp.body)>` (the Standard
   Webhooks scheme, so off-the-shelf verifiers work). Timeout 10 s. 2xx = delivered.
   Otherwise retry with exponential backoff and jitter (default 8 attempts over ~1 day),
   then `dead_lettered`. Replay from the UI re-enqueues a new attempt chain.
   After N consecutive dead-letters (setting) the subscription is `paused` and admins are
   notified.

Event types are registered in code (`events/catalogue.ts`) with a zod payload schema
and a description; `GET /api/v1/events/catalogue` and the web page are generated from
it, and the JSON Schemas are snapshot-tested. Slice 1 emits
`hr.organisation.department.created.v1`, `hr.organisation.department.updated.v1` (named
`hr.department.changed.v1` in the brief; see §7) and the branch / cost-centre equivalents.

## 5. Web application

Next.js App Router. The browser talks only to the Next.js origin. Route handlers under
`/auth/*` call the public `/api/v1/auth/*` endpoints and keep the access and refresh
tokens in httpOnly, `SameSite=Lax`, secure-in-production cookies; `/api/v1/*` on the
web origin is a transparent reverse proxy to the API that adds the bearer token. No
endpoint exists only for the web app: the proxy can only reach the public API. Server
components call the same API with the same typed client. Navigation is generated from a
route table filtered by the caller's permissions.

## 6. Entity outline: slices 1 and 2

```
organisation 1─* branch 1─* department (parent_id → department, tree)
organisation 1─* cost_centre        department *─1 cost_centre (default for its staff)
organisation 1─* job_grade          position *─1 department, *─1 job_grade,
                                    reports_to_position_id → position, headcount
user ─0..1── employee (slice 2; employee.user_id unique nullable)
user 1─* role_assignment *─1 role *─* permission      role_assignment: scope_type,
                                                       scope_branch_id | scope_department_id
user 1─* refresh_token, login_history, mfa_recovery_code
api_client 1─* api_client_secret                       api_client.scopes text[]
audit_log (bigint identity, append-only)
numbering_scheme 1─* number_sequence (scheme, period)
setting (key, value jsonb)
external_ref (entity_type, entity_id, system, external_id) unique (system, entity_type, external_id)
document 1─* document_version (object_key, sha256, size, mime, scan_status)
outbox_event (bigint identity, cloud event fields, published_at)
webhook_subscription 1─* webhook_delivery 1─* webhook_attempt
idempotency_key (scope, key, request_hash, response)

── slice 2 ──
employee: staff_no, names, dob, gender, national_id_enc + _bidx, passport_enc, kra_pin_enc + _bidx,
          nssf_no, sha_no, contacts, work email/phone, employment_type, status, hire_date,
          exit_date, branch/department/position (current, denormalised from assignment),
          manager_id → employee, deleted_at, version
employee_position_assignment: employee, position, department, branch, cost_centre, manager,
          effective_from/to (exclusion constraint)
employee_status_history, next_of_kin, emergency_contact, dependant, bank_account (enc),
mobile_money_account, qualification, professional_licence (body, number, issue, expiry,
status derived, reminder sent at), employee_document (→ document, document_type,
verification), document_type (required per employment type)
```

## 7. Departures from the brief (and from `sil_procurement`)

| # | Departure | Why |
|---|---|---|
| D1 | **Stack versions.** NestJS 11 and TypeORM 0.3 (latest within those majors) even though NestJS 12 and TypeORM 1.x are now published. | The brief names NestJS 11 and procurement runs TypeORM 0.3; staying on the same majors keeps the two repos interchangeable for developers. Upgrading both together is a later, separate decision. |
| D2 | **Auth model differs from procurement.** Procurement uses Redis server sessions + CSRF tokens. HR uses JWT access + rotating refresh tokens for humans, and client credentials for machines. | One authentication path for the web app and other systems keeps the API honest (brief §2). CSRF is still covered: tokens live in `SameSite=Lax` httpOnly cookies on the web origin and the proxy only forwards to the bearer-token API. |
| D3 | **zod instead of class-validator** for DTOs. | Brief §2: one contract definition shared with the web forms. |
| D4 | **OpenAPI 3.1.** `@nestjs/swagger` emits 3.0; the document builder output is post-processed to 3.1 (`nullable` → type unions, version string) and the zod JSON Schemas are emitted in 3.1 form. | Brief §6.2 asks for 3.1. |
| D5 | **Event type names** use `hr.<area>.<entity>.<verb>.v1` for structure events (`hr.organisation.department.updated.v1`) but keep the brief's exact names for people events (`hr.employee.hired.v1`, …). The brief's `hr.department.changed.v1` is published as `created`/`updated`/`deleted` variants. | Consumers can subscribe to precisely what they need; a single "changed" event forces every consumer to diff. If you'd rather have the single name, it is a catalogue change before any consumer exists. |
| D6 | **Webhook signature format** follows the Standard Webhooks spec (`Webhook-Id/Timestamp/Signature`, HMAC-SHA256). | Meets the brief (HMAC-SHA256 + timestamp) and gives consumers ready-made verification libraries in most languages. |
| D7 | **Keycloak** is added to Compose in slice 2 (with OIDC), not slice 1. | Slice 1 has no OIDC work; keeping it out keeps the first `docker compose up` light. |
| D8 | **Data scopes `own` and `direct_reports`** are modelled and resolved in slice 1 but only become meaningful when employees and reporting lines exist (slice 2). Slice 1 tests scope enforcement with branch/department scopes over organisation data. | Employees are slice 2. |
| D9 | **Procurement contract.** Procurement today stores departments with its own `code` and `cost_centre_code`, and asset custodians as a procurement `user_id` + free-text name; it has no HR integration yet. HR will publish departments/cost centres with codes and expose staff so procurement can map custodians to `employee_id`. The asset-assignment read HR needs for exit clearance does not exist in procurement's API yet; it will be built against a documented assumed contract with a mock until procurement adds it. | Brief §6.4: do not invent certainty. Listed in the README as needing confirmation. |

| D10 | **SCIM is read-only.** `/scim/v2/Users` and `/Groups` serve employees and departments; POST/PUT/PATCH/DELETE answer 405. | HR is the system of record: the identity provider pulls people from HR (and sees `active: false` on exit or suspension) instead of writing into HR. |
| D11 | **The staff directory is organisation-wide** for anyone with `directory:read`, whatever their data scope. It carries names, positions, departments and work contacts only. | Every system and every member of staff needs to find colleagues; personal data stays behind `employee:read` and its scope. |
| D12 | **Refresh-token reuse has a 30-second grace window.** A token presented again within 30 s of its first use gets another token in the same family; later reuse still revokes the whole family. | Browsers send several requests at once when the access token expires; without the window each simultaneous refresh signed the user out. |
| D13 | **SSO never creates accounts.** The first OIDC sign-in links an existing user by verified email; later ones match the IdP subject. | Accounts follow HR records (and SCIM), not the IdP. |

| D14 | **Leave crossing a leave-year boundary** is refused for accruing types (annual) and must be split; allowance types (maternity, paternity, study) may cross and are charged to the year they start. | Each year's accrued balance pays for its own days; a 90-day maternity leave cannot reasonably be split. |
| D15 | **Workflow steps never repeat a signer.** If the natural approver already approved an earlier step (e.g. the ward manager is also the head of the ward), the step climbs to their manager. Workflow administrators may act on any shared-queue task. | Two-step chains exist for a second pair of eyes; the brief's "rejection with reason, return for correction, delegation, escalation" are all implemented in the one engine. |
| D16 | **Roster-aware day counting** is wired as a hook that the time-and-attendance module fills (`registerScheduleProvider`): for rostered staff a leave day is a day with a rostered shift; for everyone else the configured working week. | Done in slice 4. |

| D17 | **Clock events are immutable.** A database trigger refuses any change except attaching a person to an unmatched punch. Corrections are new `regularisation` punches added after approval, never edits. Each punch has a `dedup_key` (source system + its own id, or person + time), so re-pulls and device retries are harmless. | Payroll and disputes need the raw record as it arrived. |
| D18 | **Attendance days are derived, not entered.** `attendance_day` is recomputed from punches, the schedule, leave, holidays and settings whenever any of them changes (and on demand). A night shift's punches belong to the day it started. The unpaid break is taken off only after 5 hours of work. | One rule set, one place to fix; changing the grace setting and pressing Recalculate re-grades the period. |
| D19 | **Shift settings live on departments and are inherited.** A department is `standing` (one shift on the working week) or `rostered`; a sub-department without its own setting uses its nearest ancestor's. | Matches how the hospital runs: Finance on 08:00 to 17:00, wards on day and night or three shifts. |
| D20 | **Overtime is counted only under a rule.** Rules are per kind of day (working day, rest day, public holiday) with an optional multiplier, a threshold and an approval flag; none are seeded. | The hospital has no overtime rates yet; payroll (slice 5) reads the rules. |
| D21 | **Device pushes are public endpoints guarded by registration**, not tokens: ZKTeco ADMS answers only serial numbers listed on a connector; Hikvision pushes are accepted only from the connector's IP addresses. | These terminals cannot send bearer tokens. Put them on a separate VLAN in production. |
| D22 | **Payroll money is decimal end to end.** Columns are `numeric(14,2)`, the API returns amounts as strings, and every calculation runs in decimal.js with half-up rounding per payslip line. | Brief: money is never a JS number. |
| D23 | **Statutory rates are data with dates.** `statutory_rate` rows (PAYE, NSSF, SHIF, HOUSING_LEVY, NITA, ALLOWABLE) cannot overlap (exclusion constraint); a new open-ended table closes the previous one; a table an approved payroll used cannot change. The calculation reads the tables in force on the last day of the month and stores their ids on each payslip. | A March payroll must be reproducible in October. |
| D24 | **Approved payslips are immutable at the database level** (triggers on `payslip` and `payslip_line`). Salary and pay-item changes dated inside an approved month are refused; differences are paid as arrears (one-off items). | Changing an approved payroll would make payslips, returns and the journal disagree. |
| D25 | **A mid-month salary change uses the new salary for the whole month** and warns; the payroll officer adds arrears or a recovery for the difference. | Splitting a month across two salaries is rare and policy-dependent; the warning keeps it visible. |
| D26 | **Loan balances are derived** from repayments on approved payslips (principal − repaid), never stored; a loan settles itself on the approval that pays it off. | One source of truth, as with the leave ledger. |
| D27 | **Payslip emails are notices, not attachments.** Staff are told their payslip is ready and download it after signing in. | A PDF with pay and PIN in an email is a privacy risk; password-protected attachments can be added if the hospital wants them. |
| D28 | **The web app follows the NextAdmin dashboard style** (Inter, a zinc canvas with the content in a rounded panel, a sidebar with icons and collapsible groups, page search on ⌘K, light and dark themes) but none of its code is copied: the free template's repository carries no licence file. Everything is served from our own origin: Inter from `@fontsource-variable/inter` (OFL), icons from `lucide-react` (ISC), the logo drawn inline. No page requests another host. | The hospital asked for that look with every resource local. |
| D29 | **Medical usage is a ledger, never a balance.** `medical_ledger` is append-only (a trigger refuses updates and deletes); remaining = limit + top-ups + carry-over − claims + reversals ± adjustments − active holds. Holds are released by a release entry (claimed, cancelled or expired by the hourly sweep), and each limit is locked (`pg_advisory_xact_lock`) while a claim or hold is checked, so concurrent desks cannot spend it twice. | The same discipline as the leave ledger; disputes are settled by reading the entries. |
| D30 | **Shared limits live on the principal.** For a family-shared category every entry's `pool_member_id` is the staff member; for a per-person category it is the person treated. Each limit is counted once in reports, under its holder. | One rule for "who has spent what" whichever way the scheme shares. |
| D31 | **Claims record what the scheme paid, not a diagnosis.** A claim stores the invoice total, the member's co-payment and the scheme's share (after the per-visit cap), the facility, department and invoice reference. No clinical detail is held in HR. | Billing needs amounts; diagnoses belong in the HMIS. |
| D32 | **Billing staff see cover only.** The billing role has `medical:lookup` and `medical_claim:write`: member cards, limits, holds and usage, never salaries, IDs or HR records. Every lookup is written to the audit trail. | The brief's separation of billing from HR data. |
| D33 | **Medical contributions reach payroll through a provider hook** (`PayrollService.registerItemsProvider`): the medical module adds a `MEDICAL` deduction for the month from the dated rate in force, counting dependants covered at the month end; ended cover adds nothing. | Payroll stays unaware of medical rules; leaving the scheme stops the deduction with no payroll change. |
| D34 | **Lifecycle changes are requests, applied on approval.** Promotions, transfers, confirmations, renewals and exits reuse the employee service's own transfer and status operations inside the approval's transaction, so the effective-dated assignment history, account deactivation and events are the same as for a direct HR action. | One way to change a person; approvals add control without a second code path. |
| D35 | **An exit has two moments.** Approval sets the status to on notice, starts offboarding and clearance and publishes `hr.employee.offboarding_started.v1`; completion (on or after the last day) sets exited, ends access and publishes `hr.employee.exited.v1`. Completion needs procurement cleared, the blocking checklist tasks done and final dues posted, or a recorded reason to go ahead. | Access must not end before the last day, and must end the moment the exit is done. |
| D36 | **Final dues are payroll inputs, not a separate payment.** Leave pay and notice pay become one-off items in the exit month; each loan's instalment becomes its balance, so the last payslip recovers it; the leave is encashed in the leave ledger. | The final payslip, statutory returns and journal then include everything, with no side calculation. |
| D37 | **Complaints are restricted by name, not by role.** A restricted case is visible only to the users listed on it and to the complainant (who does not see internal notes or who else is named); HR scope does not reach it, and the person complained about does not see it. | Grievances need confidentiality that a role-wide permission cannot give. |
| D38 | **Letters are plain-text templates with merge fields**, rendered to PDF (pdfkit) or Word (docx). Unknown fields are refused when a template is saved; missing values show as [field] rather than vanishing. | Easy for HR to edit, and nothing silently drops out of a legal letter. |

## 8. Open questions for the hospital (not needed for slice 1)

Pay-cycle dates and payment day; leave entitlements per type/grade; the salary bank and
its bulk file format; whether M-Pesa B2C bulk or a bank-mediated file is used; which
identity provider is (or will be) deployed; licensing bodies to track (KMPDC, NCK,
PPB, KMLTTB, …) and reminder lead times; chart of accounts for the payroll journal.
