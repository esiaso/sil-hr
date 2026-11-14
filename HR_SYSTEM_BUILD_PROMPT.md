# Build prompt: SIL HR system (NestJS + Next.js + PostgreSQL)

> Paste everything below the line into a fresh coding-agent session opened in the
> empty `sil_hr_system` folder. It is self-contained.

---

## 1. What you are building and why

Build **SIL HR**, the human-resources and payroll system for a private hospital in
Kenya. It replaces an off-the-shelf Laravel HRM product that the organisation has
been evaluating. That product has the right feature breadth but was written as a
multi-tenant SaaS for resale: it carries subscription billing and thirty payment
gateways the hospital will never use, has no API at all, and cannot exchange data
with anything else. The hospital already runs other in-house systems (procurement
and inventory, a lab middleware, an HMIS) and is building more. Staff, departments
and reporting lines are needed by every one of them, so **the main reason for this
rebuild is that HR must be the organisation's system of record for people and
structure, and every other system must be able to read from it, react to it and
feed it.**

Treat integration as a first-class product feature with its own module, UI, tests
and documentation. It is not something to bolt on after the HR screens work.

### Reference material you should read first

- **The Laravel system being replaced** (read-only reference, do not modify):
  `/Users/isayaopondo/Library/Mobile Documents/com~apple~CloudDocs/WebServer/htdocs/hr`
  Laravel 12, Inertia + React 19, MySQL, spatie/laravel-permission. Start with
  `database/migrations/` (120 migrations), `app/Models/`, `routes/web.php`,
  `app/Models/PayrollRun.php`, `app/Models/AttendanceRecord.php`,
  `app/Http/Controllers/LeaveApplicationController.php` and
  `resources/js/pages/hr/`. Use it to understand fields, screens and workflows.
  Port the *behaviour users rely on*, not the code: section 4 lists what is wrong
  with it.
- **The sibling procurement system**, whose conventions this project follows:
  `/Users/isayaopondo/DevProducts/systems/sil_procurement` (read its `README.md`
  and `apps/api/src` layout). It is a pnpm monorepo with a NestJS 11 API, TypeORM
  on PostgreSQL, BullMQ on Redis, a shared zod package, Swagger at `/api/v1/docs`
  and a one-command Docker Compose start. Someone who knows that repo should feel
  at home in this one.

## 2. Stack and repository shape

| Concern | Choice |
|---|---|
| Monorepo | pnpm workspaces, Node 22+: `apps/api` (`@sil/hr-api`), `apps/web` (`@sil/hr-web`), `packages/shared` (`@sil/hr-shared`) |
| API | NestJS 11, TypeScript strict, REST under `/api/v1`, OpenAPI via `@nestjs/swagger` |
| Database | PostgreSQL 16+. TypeORM with explicit, reviewed migrations (never `synchronize`). This matches procurement; if you believe another ORM is clearly better, say so before starting rather than switching silently |
| Jobs | BullMQ on Redis, run in a separate worker process |
| Web | Next.js (App Router), React, TypeScript, Tailwind, TanStack Query, react-hook-form + zod |
| Validation | zod schemas in `packages/shared`, used by both API DTOs and web forms so the contract has one definition |
| Files | S3-compatible object storage (MinIO in Compose); the database stores object keys and metadata, never public paths |
| Auth | Local accounts (argon2id) plus OIDC single sign-on; see section 6.1 |
| Dev environment | `docker compose up --build` brings up Postgres, Redis, MinIO, Mailpit, API, worker and web, runs migrations and seeds a sample hospital |

The Next.js app is a client of the public REST API and uses no private back door.
If the web app needs an endpoint, that endpoint is part of the documented API. This
is what keeps the API honest enough for other systems to rely on.

Organise the API as NestJS modules by business domain (section 5), each with its
own entities, service, controller, DTOs and tests. Domain modules never call each
other's repositories; they call services or react to domain events.

## 3. Ground rules that apply everywhere

- **Single organisation, many sites.** Drop the SaaS tenancy. Model one
  organisation with branches (sites), departments, sub-departments/units and
  cost centres. Keep an `organisation_id` on root tables so a second legal entity
  could be added later, but build no tenant-switching, plans or billing.
- **Employees are not users.** An `employee` is a person the hospital employs. A
  `user` is a login. Link them optionally, one-to-one. Many staff (cleaners,
  casuals, locums) will never log in, and some users (auditors, integration
  service accounts) are not employees. Every HR table references `employee_id`.
- **Identifiers.** UUID v7 primary keys. Human-readable numbers (staff number,
  payslip number, contract number, requisition code) come from a configurable
  numbering service with prefix, padding and yearly reset. Every integratable
  entity also has an `external_refs` mapping (system, external id) so other
  systems' identifiers can be stored without schema changes.
- **Money and time.** Money is `numeric(14,2)` in the database and a decimal
  library in code, never JavaScript floats. Store timestamps as `timestamptz` in
  UTC; display in the organisation's configured timezone. Dates with no time
  (leave days, pay periods, birth dates) are `date`.
- **Configuration lives in the database.** Defaults are KES, Africa/Nairobi,
  DD/MM/YYYY, a Monday-to-Friday working week and a January leave year, but every
  one of these, plus statutory rates, working days, numbering and approval
  chains, is data an administrator edits. Nothing of the kind is hardcoded.
- **Effective dating.** Anything that changes over time and matters to payroll or
  audit keeps history with `effective_from` / `effective_to`: position
  assignments, salary structures, statutory rate tables, contracts, shift
  assignments. A payroll run for March must be reproducible in October.
- **Audit trail.** Every create, update, delete, approval, login and export is
  written to an append-only audit log with actor, time, IP, entity, and
  before/after values. Sensitive reads (salary, bank details, medical or
  disciplinary records) are logged too.
- **Soft delete and referential integrity.** People and their history are never
  hard-deleted by a UI action. Use real foreign keys and database constraints
  (unique, check, exclusion constraints for overlapping date ranges).
- **Personal data.** Kenya's Data Protection Act applies. Encrypt national ID,
  KRA PIN, bank account and health-related fields at the column level; mask them
  in list views and API responses unless the caller holds the specific scope;
  never put them in logs, events or URLs.
- **Status values** are lowercase snake_case enums shared through
  `packages/shared`. (The Laravel system mixes `pending` with `Pending Approval`.)

## 4. What to keep, drop and fix from the Laravel system

### Keep (functional scope to port)

Organisation structure; employee master with documents; leave; attendance, shifts
and timesheets; payroll and payslips; contracts and renewals; performance
(indicators, goals, review cycles, reviews); recruitment (requisitions, postings,
public careers page, candidates, interviews, feedback, assessments, offers,
onboarding checklists, convert candidate to employee); training (programmes,
sessions, attendance, assessments); employee lifecycle events (promotions,
transfers, resignations, terminations, warnings with improvement plans,
complaints, awards, trips and expenses); HR policy documents with read
acknowledgements; letter templates (joining letter, experience certificate, NOC,
offer, contract) rendered to PDF and DOCX; announcements; holidays; meetings with
rooms, attendees, minutes and action items; a combined calendar; dashboards for
admin and for the individual employee; CSV/XLSX import and export; roles and
granular permissions; login history; IP allow-listing; email templates.

### Drop

Subscription plans, plan orders and requests, coupons, referrals and payouts, all
payment gateways, the marketing landing page and CMS pages, newsletter, contact
form, the web installer, demo mode and its embedded fake data, cookie-consent
banner, the ChatGPT helper, user impersonation, per-tenant storage quotas, and the
in-app translation editor (keep the UI i18n-ready with English strings in files).

Asset *master data* also goes: the procurement system owns the asset register.
HR keeps only "which employee holds which asset", referencing procurement's asset
id, and uses it in the exit clearance checklist.

### Fix (known defects; do not reproduce them)

1. **Tenancy by `created_by`.** Every query filters on who created the row. Replace
   with organisation/branch/department scoping enforced centrally (section 5.1).
2. **`employee_id` points at `users.id`.** See "Employees are not users" above.
3. **Leave.** Balance checks use the current year instead of the year of the
   leave; the initial allocation reads a column that does not exist and silently
   falls back to 10 days; pending requests do not reserve balance, so two requests
   can both be approved against the same days; public holidays are not excluded;
   no half-days; payroll counts leave in calendar days while applications count
   working days; approval is a single step by anyone with the permission.
4. **Attendance.** Clock times are stored as bare `time` with no timezone and one
   row per day, so night shifts and split shifts are guesses; the policy's
   half-day threshold is ignored in favour of half the shift length; overtime is a
   single flat hourly amount.
5. **Payroll.** No statutory deductions and no progressive tax; salary components
   are a JSON array of ids on one row with no history; processing is neither
   transactional nor idempotent and jumps straight from draft to completed with no
   review, approval or lock; floats throughout; no proration for joiners and
   leavers; no loans, advances or arrears; no payment file; no accounting entry.
6. **Biometric devices.** The controller calls the ZKTeco API synchronously inside
   a web request with no timeout and stores the device credentials in plain
   settings rows.
7. **Webhooks.** Two hardcoded event types, no signature, no retry, sent inline in
   the request. Replace wholesale (section 6.3).
8. **Approvals** are an `approved_by` column copied onto a dozen tables. Build one
   workflow engine (section 5.2) and use it everywhere.
9. **No API and no audit log.** Covered by sections 3 and 6.
10. **Fat controllers** (one is 2,900 lines). Business rules belong in services
    with unit tests; controllers validate, authorise and delegate.

## 5. Domain modules

Each bullet is a NestJS module. Field lists in the Laravel migrations are the
starting point; improve them where section 4 says so.

### 5.1 Platform

- **identity-access**: users, roles, permissions (`resource:action`, e.g.
  `leave_request:approve`), plus *data scope* on each role assignment: own record,
  direct reports, department, branch, or whole organisation. Scope is applied in
  one place (a repository-level filter), not re-implemented per controller. MFA
  (TOTP), password policy, session and refresh-token management, login history,
  IP allow-list. Seed roles: System Admin, HR Manager, HR Officer, Payroll
  Officer, Finance Approver, Department Head, Line Manager, Recruiter, Employee,
  Auditor (read-only).
- **organisation**: organisation, branches, departments (tree), cost centres,
  job grades, designations/positions with headcount, reporting lines (each
  employee has a manager; the org chart and approval routing derive from it).
- **audit**, **numbering**, **settings**, **notifications** (email, SMS and in-app
  through pluggable channels, with editable templates), **documents** (object
  storage, virus-scan hook, versioning, expiring signed download URLs),
  **templates** (merge-field letter templates to PDF/DOCX), **import-export**.

### 5.2 Workflow engine

A generic approval service: a *workflow definition* per request type (leave,
regularisation, requisition, offer, contract, promotion, transfer, termination,
trip, payroll run, and so on) with ordered steps. Each step resolves its approver
by rule (line manager, department head, named role, named person, or amount/grade
thresholds) and supports delegation while the approver is on leave, escalation
after a timeout, rejection with reason, and return-for-correction. Every domain
module submits to this engine and listens for its outcome rather than carrying
its own approval columns.

### 5.3 HR domains

- **employees**: personal details, national ID/passport, KRA PIN, NSSF and SHA
  numbers, next of kin and emergency contacts, dependants, bank and mobile-money
  details, qualifications, employment type (permanent, contract, casual, locum,
  intern), status lifecycle (`onboarding → probation → active → on_notice →
  exited`, plus `suspended`), position history, document checklist with
  verification. **Professional licences** are first-class: licensing body,
  licence number, issue and expiry date, with reminders before expiry and a flag
  that other systems can read (a clinician with a lapsed licence matters to the
  HMIS).
- **leave**: leave types, policies by grade/employment type/gender, accrual
  (monthly or annual, prorated for joiners), carry-forward with caps and expiry,
  half-days, holiday- and roster-aware day counting, a **ledger-based balance**
  (accrual, taken, reserved, adjustment and carry-forward entries; the balance is
  the sum, never an editable number), encashment, team leave calendar, and
  approval through the workflow engine. Approved leave appears in attendance and
  payroll automatically.
- **time-attendance**: shift definitions (including night and split shifts),
  **rosters** assigning employees to shifts per day for 24/7 departments, raw
  clock events stored immutably as `timestamptz` with their source (web, mobile,
  device, import), a daily attendance summary derived from events plus roster
  plus policy, late/early/overtime rules with grace periods, regularisation
  requests, timesheets, and overtime with configurable multipliers for normal
  days, rest days and public holidays.
- **payroll**: earning and deduction components (fixed, percentage, formula),
  effective-dated salary structures per employee, loans and advances with
  repayment schedules, one-off items (arrears, bonuses, recoveries), and a
  **statutory engine driven by effective-dated rate tables** covering PAYE bands
  and reliefs, NSSF tiers, SHIF, the Affordable Housing Levy, NITA and HELB.
  Verify current rates against KRA, NSSF and SHA publications when seeding and
  keep them editable; rates change most years. A run moves through
  `draft → calculated → under_review → approved → paid → closed`; calculation is
  deterministic, idempotent and re-runnable until approval, then locked. Show a
  variance report against the previous period before approval. Outputs: payslips
  (PDF, emailed or self-service), bank and M-Pesa bulk-payment files, statutory
  return files (KRA P10, NSSF, SHA, Housing Levy), P9 forms at year end, and a
  payroll journal by cost centre for the finance system. Prorate joiners,
  leavers and unpaid leave. Write worked-example unit tests for every statutory
  calculation.
- **contracts**, **performance**, **recruitment** (with a public careers page and
  application form in the Next.js app), **onboarding-offboarding** (checklists
  with tasks assigned to HR, IT, facilities and the line manager; exit clearance
  that checks assets held, outstanding loans and leave balance; final dues),
  **training** (with CPD points for clinical staff), **employee-relations**
  (warnings, improvement plans, complaints with restricted visibility,
  awards), **travel-expenses**, **policy-documents**, **announcements**,
  **meetings**, **calendar**, **reports-dashboards** (headcount, turnover, leave
  liability, overtime cost, payroll cost by department, licence expiry,
  contract expiry; all exportable).
- **self-service**: every employee can view their profile, payslips and P9s,
  apply for leave, clock in and out, request regularisation, acknowledge policy
  documents, see their roster, and update contact details subject to HR approval.
  Managers get a team view and an approvals inbox.

## 6. Integration architecture

This section is the reason for the project. Build it as an `integration` module
group with its own admin screens.

### 6.1 Identity

- The system is an **OIDC relying party** so staff can sign in through the
  organisation's identity provider when one is deployed (Keycloak in Compose for
  development). Local accounts remain available as a fallback.
- **Machine clients** authenticate with OAuth 2.0 client credentials and receive
  short-lived JWTs carrying scopes such as `employees:read`,
  `employees.sensitive:read`, `org:read`, `attendance:write`, `leave:read`,
  `payroll.journal:read`. Administrators create clients, choose scopes, rotate
  secrets and see last-used times in the UI. Every call by a machine client is
  audited against that client.
- **SCIM 2.0** `/scim/v2/Users` and `/Groups` endpoints expose employees and
  departments so an identity provider or another application can provision and
  deprovision accounts from HR data. Offboarding an employee must reliably
  propagate.

### 6.2 Public API

- Versioned REST at `/api/v1`, described by an OpenAPI 3.1 document that is
  generated from code, published at `/api/v1/docs`, checked into the repo, and
  compared in CI so a breaking change fails the build. Generate a typed
  TypeScript client into `packages/shared` and use it in the web app.
- Conventions on every collection: cursor pagination, filtering and sorting,
  `updated_since` for incremental sync (soft-deleted records are returned with a
  tombstone so consumers can remove them), `ETag`/`If-Match` for optimistic
  concurrency, `Idempotency-Key` on every POST that creates or pays something,
  RFC 9457 problem-details errors, per-client rate limits, and a correlation id
  carried through logs, jobs and outgoing events.
- **Directory endpoints** designed for consumers rather than for the HR screens:
  a lean staff directory (id, staff number, name, department, position, manager,
  status, work email and phone, licence status), the department tree, cost
  centres, and "who approves for this person or department". These are what
  procurement, HMIS and the lab systems will call most.
- Bulk endpoints for import and export of large sets, processed as jobs with a
  status resource.

### 6.3 Events out

- Every state change that another system could care about is written to a
  **transactional outbox** table in the same database transaction as the change,
  then published by the worker. No event is emitted for a change that rolled
  back, and none is lost if the publisher is down.
- Envelope follows **CloudEvents 1.0**. Event types are versioned and documented
  in a catalogue page generated from code, for example
  `hr.employee.hired.v1`, `hr.employee.updated.v1`, `hr.employee.transferred.v1`,
  `hr.employee.exited.v1`, `hr.department.changed.v1`,
  `hr.leave.approved.v1`, `hr.licence.expired.v1`, `hr.payroll.run.approved.v1`.
  Payloads carry ids and non-sensitive fields; consumers fetch detail through
  the API with their own scopes.
- **Webhooks**: administrators register subscriptions per event type and target
  URL. Deliveries are HMAC-SHA256 signed with a per-subscription secret and
  timestamp, retried with exponential backoff, moved to a dead-letter state
  after the final attempt, and replayable from a delivery log in the UI.
  Subscriptions that keep failing are paused with a notification.
- Put publishing behind a `EventPublisher` port with a webhook adapter and one
  broker adapter (Redis Streams, since Redis is already present) so NATS, Kafka
  or RabbitMQ can be added later without touching domain code.

### 6.4 Data in: connector framework

Define a small connector interface (configure, test connection, pull or receive,
map, report health) and run connectors in the worker on schedules or in response
to inbound calls. Store credentials encrypted. Every sync writes a run record
with counts and errors, visible in the UI. Deliver these connectors:

| Connector | Direction | Notes |
|---|---|---|
| Biometric attendance (ZKTeco BioTime) | in | Scheduled pull of transactions plus a push endpoint for devices; maps device user id to employee; deduplicates; feeds raw clock events |
| Generic attendance | in | Authenticated `POST /api/v1/clock-events` batch endpoint for any other time source |
| Procurement (`sil_procurement`) | both | HR publishes staff, departments, cost centres and approvers; HR reads asset assignments for exit clearance. Read that repo's API to agree the contract |
| HMIS | out | Practitioner registry as FHIR R4 `Practitioner` and `PractitionerRole` resources, including licence status |
| Finance / general ledger | out | Payroll journal per run as an API resource and a file export, mapped through a configurable chart-of-accounts table |
| Bank and M-Pesa | out | Bulk salary payment files in configurable formats |
| Statutory bodies | out | Return files in the formats the portals accept |
| Email, SMS, calendar | out | SMTP, a pluggable SMS gateway, and ICS feeds for leave and meetings |

Where an external system's contract is unknown, build the adapter against a
clearly documented assumed contract with a mock server in the tests, and list it
in the README as needing confirmation. Do not invent certainty.

### 6.5 Ownership of shared data

Document, and enforce in code, who owns what: HR owns employees, departments,
positions, reporting lines and cost-centre membership. Procurement owns assets
and suppliers. The identity provider owns credentials. Finance owns the chart of
accounts. HR stores foreign identifiers only through `external_refs`.

## 7. Web application

- Responsive, keyboard-accessible, usable on a phone for self-service (clock in,
  leave, payslips). Server components for data-heavy read pages, client
  components for forms and tables.
- Navigation grouped by the domains in section 5, filtered by permission.
  Consistent list pages (search, filters, saved views, column chooser, export),
  detail pages with a tabbed employee profile, and an approvals inbox.
- An **Integrations** admin area: API clients and scopes, webhook subscriptions
  and delivery log with replay, connector configuration and sync history, event
  catalogue, and a link to the API docs.
- A public careers site at `/careers` with job detail and application form.

## 8. Quality bar

- Unit tests for all business rules (leave day counting, accrual, attendance
  derivation, every payroll and statutory calculation with worked examples).
  Integration tests against a real PostgreSQL for each module's API. End-to-end
  tests (Playwright) for the critical journeys: hire an employee, apply for and
  approve leave, sync attendance, run and approve payroll, receive a signed
  webhook, offboard an employee and observe deprovisioning.
- Contract tests: the OpenAPI document and the event schemas are snapshot-tested.
- Security: authorisation tests proving scope enforcement (a line manager cannot
  read another department's salaries; a machine client without the sensitive
  scope gets masked fields), rate limiting, input validation on every endpoint,
  no secrets in the repo.
- Operations: health and readiness endpoints, structured JSON logs with
  correlation ids, metrics, graceful shutdown, a documented backup and restore
  procedure, and a `docs/DEPLOYMENT.md`.
- Documentation: a README in the style of the procurement one (quick start, URLs,
  sample logins per role), an integration guide for developers of other systems
  with runnable examples, and short user manuals per role.

## 9. Delivery in slices

Build in vertical slices. Each slice ends with migrations, seed data, tests
passing, `docker compose up` working, and the README updated. Do not start a
slice until the previous one is green.

1. **Foundations**: monorepo, Compose, auth and RBAC with data scopes,
   organisation structure, audit, numbering, settings, documents, the API
   conventions from 6.2, and the outbox with one event flowing to a signed
   webhook. Integration plumbing goes in first so every later slice emits events
   and exposes endpoints as it is built.
2. **Employees and self-service**: employee master, licences, documents,
   directory endpoints, import/export, SCIM, OIDC.
3. **Workflow engine and leave.**
4. **Time and attendance**: shifts, rosters, clock events, biometric connector.
5. **Payroll**: components, structures, statutory engine, run lifecycle,
   payslips, payment and statutory files, journal export.
6. **Lifecycle**: contracts, promotions, transfers, onboarding and offboarding,
   employee relations, letters.
7. **Recruitment** and the careers site.
8. **Performance and training.**
9. **Remaining connectors** (procurement, HMIS, finance), announcements,
   meetings, calendar, reports and dashboards.
10. **Hardening**: end-to-end suite, security review, performance on a seeded
    dataset of 2,000 employees and three years of attendance, manuals.

## 10. How to work

- Before writing code, read the two reference codebases, then write a short
  `docs/ARCHITECTURE.md` with the module map, the entity-relationship outline for
  slice 1 and 2, and any place you intend to depart from this brief and why. Then
  start slice 1.
- Ask before deciding anything that changes scope, or that depends on facts
  about the hospital you cannot find in the repositories (pay-cycle dates,
  leave entitlements, the bank's file format, which identity provider is in
  use). For everything else, choose the conventional option, note it in the
  architecture document, and keep going.
- When this brief and the Laravel system disagree, this brief wins. When this
  brief is silent, the Laravel system's behaviour is the default.
- Report progress honestly at the end of each slice: what works, what is
  stubbed, what is untested, and what needs a decision.
