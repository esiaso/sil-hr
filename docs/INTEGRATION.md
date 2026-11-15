# Integrating with SIL HR

SIL HR is the hospital's system of record for **people and organisation structure**.
Procurement, the HMIS, the lab systems and finance read from it, react to its events and,
where agreed, feed it. This guide is for developers of those systems.

| You want to… | Use |
|---|---|
| Read departments, cost centres, positions (and, from slice 2, staff) | REST API with a client-credentials token |
| Keep a local copy in sync | `updated_since` incremental sync **plus** events |
| Be told when something changes | Webhooks (outside the hospital network) or the Redis Stream (inside) |
| Store HR's id against your own, or yours against HR's | `PUT /api/v1/external-refs` |

The API reference is generated from code: `GET /api/v1/docs` (Swagger UI) and
`GET /api/v1/openapi.json` (OpenAPI 3.1). The event catalogue: `GET /api/v1/events/catalogue`
(public) or **Integrations → Event catalogue** in the web app. Both are also checked in as
[`openapi.json`](openapi.json) and [`events.json`](events.json).

## 1. Get credentials

An HR administrator creates a client under **Integrations → API clients**, ticks only the
scopes your system needs, and gives you the client id and secret (the secret is shown once).

| Scope | Grants |
|---|---|
| `org:read` | organisation, branches, departments (+ tree), cost centres, job grades, positions |
| `employees:read` | staff directory, approver lookup, employee records (ID numbers and bank details masked), licences |
| `employees.sensitive:read` | unmasked national ID, passport, KRA PIN and bank details (`?include_sensitive=true`); every read is audited against your client |
| `scim` | the SCIM 2.0 endpoints under `/scim/v2` |
| `events:read` | event catalogue |
| `external_refs:write` | read and write your system's identifiers in `external_ref` |
| `documents:read` | download documents |
| `leave:read` | leave requests (`/api/v1/leave/requests`), balances and the team calendar |
| `attendance:read` | daily attendance, rosters and timesheets (`/api/v1/attendance/days`, `/api/v1/rosters`) |
| `attendance:write` | post clock events (`POST /api/v1/clock-events`, §7) |
| `medical:read` | medical cover: eligibility and remaining limits by member number (§9) |
| `medical:write` | medical billing: place holds, post and reverse claims (§9) |
| `payroll.journal:read` | payroll journals of approved runs (`GET /api/v1/payroll/runs/{id}/journal`, §8) |

## 2. Get a token

OAuth 2.0 client credentials (RFC 6749 §4.4). Tokens are EdDSA-signed JWTs valid for
15 minutes; cache one and fetch a new one shortly before `expires_in`.

```bash
curl -s -u "$CLIENT_ID:$CLIENT_SECRET" \
  -d grant_type=client_credentials -d scope=org:read \
  http://localhost:3310/api/v1/oauth/token
# {"access_token":"eyJ…","token_type":"Bearer","expires_in":900,"scope":"org:read"}
```

The public keys are at `/api/v1/.well-known/jwks.json` if you want to inspect tokens.
Disabling a client, revoking a secret or removing a scope takes effect immediately, even
for tokens already issued. When an administrator rotates your secret, the previous one keeps
working for the grace period they choose (24 hours by default).

## 3. Read

```bash
TOKEN=…   # from step 2
curl -s -H "Authorization: Bearer $TOKEN" "http://localhost:3310/api/v1/departments?limit=100&sort=code"
curl -s -H "Authorization: Bearer $TOKEN" "http://localhost:3310/api/v1/departments/tree"
```

Every collection follows the same rules:

* **Cursor pagination.** `limit` (1–500, default 50) and `cursor`. The response is
  `{ "data": [...], "next_cursor": "…" | null }`. Pass `next_cursor` back until it is null.
* **Sorting.** `sort=code` or `sort=-code`; the allowed fields are listed in the OpenAPI doc.
* **Incremental sync.** `updated_since=<ISO timestamp>` returns everything changed after
  it, oldest change first, **including soft-deleted records as tombstones**
  `{ "id": "…", "deleted": true, "deleted_at": "…" }`. Store the largest `updated_at` you
  saw and use it next time (overlap by a few seconds; processing is idempotent by id).
* **Errors** are RFC 9457 `application/problem+json`: `type`, `title`, `status`, `detail`,
  a stable `code`, `errors[]` for field validation, and `correlation_id`. Quote the
  correlation id when reporting a problem.
* **Rate limits** are per client (default 600 requests/minute). Over the limit you get
  `429` with `Retry-After`.
* **Correlation.** Send `X-Correlation-Id`; it is echoed, logged, and copied into any event
  your request causes (`correlationid` extension).

Writes (for clients granted them) also use:

* **`If-Match`** with the `ETag` you read, on every PATCH/DELETE. Missing → `428`; stale →
  `412` with the current version.
* **`Idempotency-Key`** on POSTs that create something. A retry with the same key and body
  returns the first response (`Idempotent-Replayed: true`); the same key with a different
  body is refused with `422`.

### Typed TypeScript client

`packages/shared` contains a client generated from the OpenAPI document:

```ts
import { createHrClient } from '@sil/hr-shared/client';

const hr = createHrClient({ baseUrl: 'http://localhost:3310', token: () => getCachedToken() });
const { data, error } = await hr.GET('/api/v1/departments', { params: { query: { limit: 100 } } });
```

Other languages: generate a client from `/api/v1/openapi.json`.

### Directory endpoints (what most systems need)

| Endpoint | Returns |
|---|---|
| `GET /api/v1/directory/staff` | lean staff list: id, staff number, names, status, employment type, branch, department (id, code, name), position (id, title), cost centre, manager id, work email and phone, clinical flag, licence status and earliest licence expiry. Filters: `department_id` (+ `include_sub_departments=true`), `branch_id`, `cost_centre_id`, `status`, `is_clinical`, `staff_number`, `work_email`, `search`, `updated_since`. Leavers are left out unless you ask for `status=exited` or sync with `updated_since`. |
| `GET /api/v1/directory/staff/{id}` | one entry |
| `GET /api/v1/directory/approvers?employee_id=…` or `?department_id=…` | the line manager, the department head (holder of the department's top position, searching up the tree if vacant) and the full management chain |
| `GET /api/v1/departments/tree`, `GET /api/v1/cost-centres` | structure |

```bash
curl -s -H "Authorization: Bearer $TOKEN" "http://localhost:3310/api/v1/directory/staff?department_id=$NURSING&include_sub_departments=true&is_clinical=true"
curl -s -H "Authorization: Bearer $TOKEN" "http://localhost:3310/api/v1/directory/approvers?employee_id=$EMPLOYEE"
```

### SCIM 2.0 (identity providers)

`/scim/v2/Users` (employees) and `/scim/v2/Groups` (departments), with `ServiceProviderConfig` and `ResourceTypes`. Read-only: HR is the system of record, so writes answer 405. A user is `active: false` once the employee exits or is suspended, which is how offboarding reaches the IdP. Filters: `userName eq`, `externalId eq` (staff number), `active eq`, `meta.lastModified gt` for incremental pulls; Groups: `displayName eq`, `externalId eq` (department code). The enterprise extension carries `employeeNumber`, `department`, `costCenter` and `manager`. ID numbers are never exposed through SCIM.

## 4. Events

Every change another system could care about is written to a transactional outbox in the
same database transaction as the change and published by the worker. So: **no event for a
change that rolled back, and none lost while the publisher is down** (they are published
when it comes back). Delivery is **at least once**: de-duplicate on the event `id`.

Envelope: [CloudEvents 1.0](https://cloudevents.io), structured mode:

```json
{
  "specversion": "1.0",
  "id": "0199b1a2-…",
  "source": "urn:sil:hr",
  "type": "hr.organisation.department.updated.v1",
  "subject": "<department id>",
  "time": "2026-11-14T08:15:02.120Z",
  "datacontenttype": "application/json",
  "dataschema": "http://localhost:3310/api/v1/events/catalogue#hr.organisation.department.updated.v1",
  "correlationid": "…",
  "data": { "id": "…", "code": "NURS", "name": "Nursing", "branch_id": "…", "parent_id": null,
            "cost_centre_id": "…", "status": "active", "path": [], "changed_fields": ["name"] }
}
```

Payloads carry ids and non-sensitive fields only. Fetch detail through the API with your
own scopes. Event types are versioned: a breaking change is published as a new `.v2`
alongside the old type for a transition period, and a published type is never removed
without notice (a contract test enforces this).

People events (slice 2): `hr.employee.hired.v1`, `hr.employee.updated.v1` (sensitive fields are named in `changed_fields` but never carry values), `hr.employee.transferred.v1` (with `effective_from` and `previous` placement), `hr.employee.status_changed.v1`, `hr.employee.exited.v1`, `hr.employee.manager_changed.v1`, `hr.licence.updated.v1`, `hr.licence.expiring.v1` (once per licence and expiry date), `hr.licence.expired.v1` (the HMIS should stop treating the practitioner as licensed).

Leave events (slice 3): `hr.leave.approved.v1` (dates, half days, days counted, paid or not: attendance should mark those days as leave and payroll prorate unpaid leave) and `hr.leave.cancelled.v1` (approved leave withdrawn; the person is expected at work).

Structure events (slice 1): `hr.organisation.branch.created|updated.v1`,
`hr.organisation.department.created|updated|deleted.v1`,
`hr.organisation.cost_centre.created|updated.v1`, `hr.organisation.position.created|updated.v1`.
Moving a department publishes `updated` for it and for every department beneath it.

### Webhooks

An administrator registers your URL under **Integrations → Webhooks** with the event types
you want, and gives you the signing secret (`whsec_…`, shown once). Each delivery is a
`POST` of the CloudEvent with these headers ([Standard Webhooks](https://www.standardwebhooks.com)):

| Header | Value |
|---|---|
| `webhook-id` | Delivery id. **Identical on every retry**: use it to de-duplicate. |
| `webhook-timestamp` | Unix seconds when this attempt was signed. |
| `webhook-signature` | `v1,<base64 HMAC-SHA256(secret, "{id}.{timestamp}.{raw body}")>` |
| `content-type` | `application/cloudevents+json` |

The HMAC key is the base64-decoded part of the secret after `whsec_`. Verify the
signature over the **raw** body, reject timestamps more than 5 minutes from your clock, and
answer `2xx` within 10 seconds (queue your own processing). Anything else is retried with
backoff: 30 s, 2 min, 10 min, 30 min, 1 h, 3 h, 6 h, 12 h (±10 %), then the delivery is
dead-lettered. After 5 dead-lettered deliveries in a row the subscription is paused and HR
administrators are notified; they resume it and replay from the delivery log.

Node.js:

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

export function verifyWebhook(secret, headers, rawBody) {
  const id = headers['webhook-id'], ts = Number(headers['webhook-timestamp']);
  if (!id || !Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > 300) return false;
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const expected = Buffer.from('v1,' + createHmac('sha256', key).update(`${id}.${ts}.${rawBody}`).digest('base64'));
  return String(headers['webhook-signature']).split(' ').some((s) => {
    const b = Buffer.from(s);
    return b.length === expected.length && timingSafeEqual(b, expected);
  });
}
```

PHP (Laravel):

```php
function verifyWebhook(string $secret, array $h, string $raw): bool {
    $ts = (int) ($h['webhook-timestamp'] ?? 0);
    if (abs(time() - $ts) > 300) return false;
    $key = base64_decode(preg_replace('/^whsec_/', '', $secret));
    $expected = 'v1,' . base64_encode(hash_hmac('sha256', "{$h['webhook-id']}.{$ts}.{$raw}", $key, true));
    foreach (explode(' ', $h['webhook-signature'] ?? '') as $sig) if (hash_equals($expected, $sig)) return true;
    return false;
}
```

Python:

```python
import base64, hmac, hashlib, time

def verify_webhook(secret, headers, raw_body: bytes) -> bool:
    ts = int(headers.get("webhook-timestamp", "0"))
    if abs(time.time() - ts) > 300:
        return False
    key = base64.b64decode(secret.removeprefix("whsec_"))
    mac = hmac.new(key, f"{headers['webhook-id']}.{ts}.".encode() + raw_body, hashlib.sha256).digest()
    expected = "v1," + base64.b64encode(mac).decode()
    return any(hmac.compare_digest(expected, s) for s in headers.get("webhook-signature", "").split(" "))
```

In development, the `webhook-sink` container is subscribed to every event and verifies each
signature: browse <http://localhost:8099/hooks> to see what HR sent. Its source
(`apps/api/src/tools/webhook-sink.ts`) is a complete consumer in 50 lines.

### Redis Stream (inside the network)

Every event is also appended to the Redis Stream `silhr:events` (fields `id`, `type`,
`event` = the JSON envelope). Use a consumer group so each of your instances gets each event
once:

```bash
redis-cli XGROUP CREATE silhr:events procurement $ MKSTREAM
redis-cli XREADGROUP GROUP procurement worker-1 COUNT 100 BLOCK 5000 STREAMS silhr:events '>'
redis-cli XACK silhr:events procurement <entry-id>
```

The stream is trimmed to about a million entries. If you fall further behind than that,
resynchronise with `updated_since`.

## 5. Ownership of shared data

| Data | Owner | Others |
|---|---|---|
| Employees, departments, positions, reporting lines, cost-centre membership | **HR** | read through the API / events; never edit locally |
| Assets, suppliers | Procurement | HR stores only "which employee holds which asset" by procurement's asset id |
| Credentials (when SSO is deployed) | Identity provider | HR provisions accounts from HR data (SCIM, slice 2) |
| Chart of accounts | Finance | HR maps payroll lines to it through a configurable table (slice 5) |

Another system's identifiers are stored in HR only through `external_ref`
(`entity_type`, `entity_id`, `system`, `external_id`): one id per system per record, and an
external id maps to exactly one record.

```bash
curl -s -X PUT -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"entity_type":"department","entity_id":"<hr id>","system":"procurement","external_id":"DEPT-0007"}' \
  http://localhost:3310/api/v1/external-refs
curl -s -H "Authorization: Bearer $TOKEN" "http://localhost:3310/api/v1/external-refs?system=procurement&external_id=DEPT-0007"
```

## 6. Contracts that still need confirmation

These adapters will be built against the assumed contracts below, with mock servers in the
tests, until the owning team confirms them.

| System | Assumption | Status |
|---|---|---|
| Procurement → HR: assets held by an employee (exit clearance) | `GET /api/v1/assets?custodianEmployeeId=` on procurement, with HR's employee id stored as the custodian. Today procurement stores the custodian as **its own user id plus free text**, and has no such query. | **Needs procurement change** (slice 6) |
| HR → procurement: staff, departments, cost centres, approvers | Procurement consumes HR events / API and maps its `department.code` and `cost_centre_code` to HR's codes via `external_ref`. | To agree with the procurement team |
| ZKTeco BioTime (pull) | `POST /jwt-api-token-auth/`, then `GET /iclock/api/transactions/?start_time=&end_time=&page=` (BioTime 8 personnel API). `punch_state` 0 = in, 1 = out. | **Needs a trial against the hospital's BioTime** |
| ZKTeco devices (ADMS push) | Device server set to SIL HR; `POST /iclock/cdata?SN=…&table=ATTLOG` with tab-separated `PIN, time, state` lines. | **Needs a trial with the hospital's model and firmware** |
| Hikvision terminals (ISAPI) | Digest auth; `POST /ISAPI/AccessControl/AcsEvent?format=json` (major 5, minor 75), paged by `searchResultPosition`; push as `AccessControllerEvent` JSON or multipart `event_log`. | **Needs a trial with the hospital's model and firmware** |
| HMIS | FHIR R4 `Practitioner` / `PractitionerRole` with licence status. | Slice 9 |
| Finance / GL | Payroll journal per run as an API resource and a file. | Slice 5 |

## 7. Time and attendance sources

Punches are stored once (a repeat of the same punch is ignored) and never edited. Every
source ends up in the same place, and attendance is worked out from them.

**Any system** (a canteen terminal, an access-control server, a spreadsheet import) posts
batches with the `attendance:write` client scope. Name the person by `employee_id`,
`staff_number` or `device_user_id`, and send your own `external_id` so a resend is ignored:

```bash
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"events":[{"staff_number":"SIL-0042","occurred_at":"2026-11-14T04:58:00Z","direction":"in","device_id":"GATE-1","external_id":"gate1:88123"}]}' \
  http://localhost:3310/api/v1/clock-events
# {"accepted":1,"duplicates":0,"unmatched":0,"errors":[]}
```

**ZKTeco and Hikvision terminals** are set up under **Integrations → Device connectors**.
Both vendors work either way round:

| Kind | Who connects | Set up |
|---|---|---|
| ZKTeco BioTime server | SIL HR pulls every N minutes | BioTime address and an API user; SIL HR re-reads 15 minutes before its last cursor so late uploads are not missed |
| ZKTeco devices (ADMS / iclock push) | Devices push to SIL HR | Set the device's cloud server to SIL HR's host; list each serial number on the connector |
| Hikvision terminal (ISAPI) | SIL HR pulls every N minutes | Terminal address and its admin user (digest auth) |
| Hikvision terminals (HTTP listening) | Terminals push to SIL HR | Set the listening URL shown on the connector; list the terminals' IP addresses |

Device user ids are matched to people by **staff number** (enrol staff on the device under
their staff number) or by a **mapping table** kept on the connector. Punches from a user no
one recognises are kept, shown on the connector as unmatched, and attached to the person
as soon as they are mapped. A connector turns **degraded** while unmatched punches remain
and **failing** when a pull fails (holders of `connector:manage` are notified once).

Every roster change publishes `hr.roster.changed.v1`; approved leave already publishes
`hr.leave.approved.v1`.

## 8. Payroll journal (finance)

When a payroll is approved HR publishes `hr.payroll.run.approved.v1`, and
`hr.payroll.run.paid.v1` when finance records the payment. A finance system with the
`payroll.journal:read` scope then fetches the journal:

```bash
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:3310/api/v1/payroll/runs/$RUN_ID/journal
# {"period":"2026-10","lines":[{"account":"5100","cost_centre_code":"CC-NUR","description":"Salaries and wages","debit":"1820400.00","credit":"0.00"}, …],
#  "total_debit":"7531465.96","total_credit":"7531465.96","unmapped":[]}
```

Earnings and employer contributions are debited to expense accounts per cost centre;
PAYE, NSSF, SHIF, the Housing Levy, loans and other deductions, employer contribution
liabilities and net salaries are credited. Debits always equal credits. Accounts come
from HR's mapping table (Payroll setup → Accounts): a row per component code, with
defaults for anything unmapped. Until the chart of accounts is confirmed the accounts are
placeholders starting `TBD-`, and `unmapped` lists them; post nothing while it is
not empty.

## 9. Staff medical scheme (HMIS billing)

Staff and their dependants carry member numbers such as `SMS-SIL00042-00` (the
staff member) and `-01`, `-02` (dependants). The HMIS billing module checks cover
before treatment and posts what the scheme pays.

```bash
# Is this member covered for outpatient care today, and how much is left?
curl -s -H "Authorization: Bearer $TOKEN" \
  "http://localhost:3310/api/v1/medical/eligibility?member_number=SMS-SIL00042-01&category_code=outpatient"
# {"eligible":true,"reason":null,"member":{…},"balances":[{"category_code":"outpatient","remaining":"83350.00","co_pay_pct":10,"per_visit_cap":"20000.00",…}]}

# Reserve an amount on admission (released when claimed, released, or on expires_on)
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' -H "Idempotency-Key: adm-77812" \
  -d '{"member_number":"SMS-SIL00042-00","category_code":"inpatient","amount":"120000.00","expires_on":"2026-12-31","external_ref":"ADM-77812"}' \
  http://localhost:3310/api/v1/medical/holds

# Post the bill. The scheme pays the invoice less co-payment, up to the per-visit cap.
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' -H "Idempotency-Key: bill-99120" \
  -d '{"member_number":"SMS-SIL00042-00","category_code":"inpatient","occurred_on":"2026-12-03","invoice_amount":"110000.00","facility":"SIL Hospital","invoice_ref":"INV-99120","external_ref":"BILL-99120","hold_id":"<hold id>"}' \
  http://localhost:3310/api/v1/medical/claims
# {"status":"posted","claim":{…,"amount":"110000.00"},"remaining":"890000.00","message":null}

# A wrong bill is reversed (never edited)
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{"reason":"Billed to the wrong patient"}' \
  http://localhost:3310/api/v1/medical/claims/<claim id>/reverse
```

* Send an `Idempotency-Key` on every POST: a retry returns the first answer
  (`Idempotent-Replayed: true`) and posts nothing twice. `external_ref` (your bill
  number) is also unique per source, so a repeat with a new key is refused as a duplicate.
* A claim over the remaining limit, or inside a waiting period, answers
  `"status": "pending_approval"` with an `application_id` when the scheme sends such
  claims for approval (the default), or `422 over_limit` when it refuses them. Nothing
  is charged to the limit until HR approves.
* Events: `hr.medical.enrolled.v1` (accept the member number from `cover_start`),
  `hr.medical.claim_posted.v1`, `hr.medical.limit_threshold.v1` (80% and 100%) and
  `hr.medical.cover_ended.v1` (stop accepting the number after `cover_end`). No event or
  endpoint carries a diagnosis.
