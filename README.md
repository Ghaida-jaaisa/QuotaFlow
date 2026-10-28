# QuotaFlow: Usage Metering & Quota Service

QuotaFlow is a service that other applications call **before** performing an
action, to ask: *may this user consume N units right now?* It enforces two
levels of limits at once: a shared allowance for the whole **account** and an
individual allowance for each **user**. It records every decision, and it stays
correct under retries and concurrent traffic.

- **API:** TypeScript, Express 5, Drizzle ORM, PostgreSQL 16, Zod
- **Client:** React + Vite web console (with a scripted end-to-end demo)
- **Tests:** 120 Vitest/Supertest tests against real PostgreSQL, including concurrency tests
- **Load tests:** k6 scenarios with measured results in [`load-tests/RESULTS.md`](load-tests/RESULTS.md)

---

## Contents

1. [Quick start](#1-quick-start)
2. [Architecture](#2-architecture)
3. [Concepts and business rules](#3-concepts-and-business-rules)
4. [Database design](#4-database-design)
5. [Concurrency, atomicity and idempotency](#5-concurrency-atomicity-and-idempotency)
6. [Security](#6-security)
7. [API reference](#7-api-reference)
8. [Example client and demo walkthrough](#8-example-client-and-demo-walkthrough)
9. [curl walkthrough](#9-curl-walkthrough)
10. [Testing](#10-testing)
11. [Performance testing](#11-performance-testing)
12. [Configuration](#12-configuration)
13. [Local development without Docker](#13-local-development-without-docker)
14. [Design decisions, assumptions and trade-offs](#14-design-decisions-assumptions-and-trade-offs)
15. [Known limitations and future work](#15-known-limitations-and-future-work)
16. [Troubleshooting](#16-troubleshooting)

---

## 1. Quick start

**Prerequisites:** Docker with Compose v2 (tested with Docker 29 / Compose v5).
Node.js 22.12+ is only needed for running tests or the CLI demo on the host.

```bash
cp .env.example .env          # then set POSTGRES_PASSWORD (any local value; URL-safe characters only)
docker compose up --build
```

| Service | URL | Notes |
|---|---|---|
| Web console | http://localhost:8080 | Proxies `/api/*` to the API |
| API | http://localhost:3000 | e.g. `curl localhost:3000/health/ready` |
| PostgreSQL | `127.0.0.1:5433` | Loopback only; credentials from `.env` |

Startup order is enforced by health checks:

1. `postgres` becomes healthy.
2. `migrate` (a one-shot container) applies migrations and seeds the
   predefined plans, then exits 0.
3. `api` starts and becomes healthy once `/health/ready` can query the database.
4. `web` starts.

If migrations fail, `api` never starts and `docker compose logs migrate`
shows why.

Open http://localhost:8080 and click **Run demo scenario**.

**Reset the demo database** (deletes all data in the named volume):

```bash
docker compose down -v && docker compose up --build
```

Data survives `docker compose restart` and `docker compose down`/`up`. Only
`-v` removes the volume.

---

## 2. Architecture

```
 Browser ──► web (nginx :80→8080) ──/api/*──► api (Express :3000) ──► postgres (:5432)
                                                  ▲
 k6 (profile "loadtest") ─────────────────────────┘
```

A single stateless API process holds no authoritative state in memory. All
counters, plans, keys and decisions live in PostgreSQL, so the API can be
restarted or scaled horizontally without coordination.

```
apps/api/
  src/
    server.ts                 process entry: config, pool, graceful shutdown
    app.ts                    Express wiring: logging, public vs. authenticated routes, errors
    config.ts                 Zod-validated environment (fails fast with a readable message)
    logger.ts                 pino with credential redaction
    clock.ts                  injectable "now" (tests pin UTC months)
    db/
      schema.ts               Drizzle schema: tables, FKs, unique and check constraints
      client.ts               pg pool + Drizzle instance and types
      migrate.ts              migrate + seed (CLI entry used by the `migrate` container)
      seed.ts                 predefined plans (idempotent)
      pgErrors.ts             SQLSTATE helpers (unique violation, retryable errors)
    domain/
      evaluate.ts             PURE rule evaluation + rejection precedence
      month.ts                UTC month arithmetic
    http/                     errors, auth middleware, validation, cursors, health
    modules/
      accounts/  users/  plans/   routes + services per resource
      usage/
        consume.service.ts    ★ the atomic consumption transaction
        decision.view.ts      builds responses from stored decision records
        history.service.ts    keyset-paginated request history
        usage.service.ts      monthly usage reads and series
  drizzle/                    generated, committed SQL migrations
  tests/unit, tests/integration
apps/web/
  src/api.ts                  typed fetch client (browser + Node)
  src/demo/scenario.ts        the reproducible demo (used by UI button and CLI)
  src/components/*            console panels
load-tests/                   k6 scenarios, SQL verification, results
```

Layering: **routes** parse and validate HTTP input with Zod, then call
**services**. Services run SQL and transactions and call the **pure domain**
functions (`evaluateConsumption`, month math), which have no I/O. Business
rules exist in exactly one place.

---

## 3. Concepts and business rules

| Concept | Meaning |
|---|---|
| **Account** | An integrating application or company. Has a name, an API key, an *account plan*, its own users, its own custom plans, and a shared monthly allowance. |
| **User** | An end user inside one account. Has a *user plan* and individual monthly usage. |
| **Plan** | Named limits: `monthlyLimit` and `perRequestLimit` (positive integers). Every plan has a **scope**: `account` plans can only be assigned to accounts, `user` plans only to users. |
| **Predefined plan** | Seeded, global, read-only: **Starter** (account, 10,000/month, 100/request), **Pro** (account, 100,000 / 1,000), **Basic** (user, 1,000 / 20), **Premium** (user, 5,000 / 100). New accounts default to Starter and new users to Basic. |
| **Custom plan** | Created by an account through the API, visible and assignable only by that account, editable (each edit increments `version`). |

### Rules

- **A. Monthly allowance.** Usage is accounted per **UTC calendar month**
  (`2026-10` = `2026-10-01T00:00Z` up to but not including
  `2026-11-01T00:00Z`). A new month starts at zero simply because it has a new
  counter row. Nothing is reset or deleted, and previous months remain
  queryable.
- **B. Per-request maximum.** `units` must not exceed the account plan's *and*
  the user plan's `perRequestLimit`.
- **C. Both levels must approve.** A request is accepted only if all four
  checks pass. It is accepted entirely or rejected entirely. There are no
  partial grants.
- **D. Shared and individual accounting.** An accepted request adds `units` to
  the account's month counter **and** the user's month counter in the same
  transaction. Account usage therefore always equals the sum of its users'
  usage (verified by tests and by `load-tests/verify-accounting.sql`).
  Rejected requests consume nothing. Users sharing a plan share its
  *definition*, not its usage.
- **E. Plan changes.**
  - Changes apply to requests sent after the change succeeded.
  - Editing a custom plan affects every entity assigned to it.
  - Switching plans or editing limits never touches usage counters, so current
    month usage carries over.
  - If a limit drops below current usage, `remaining` is reported as `0` (never
    negative) and further consumption at that level is rejected.

`remaining = max(0, monthlyLimit − usedUnits)`. Zero means *nothing left*, never "unlimited".

### Decision precedence and reason codes

When several limits fail at once, the first match in this fixed order is reported:

| # | `rejection.code` | `level` | `limitType` | `available` |
|---|---|---|---|---|
| 1 | `ACCOUNT_PER_REQUEST_LIMIT_EXCEEDED` | `account` | `per_request` | `null` |
| 2 | `USER_PER_REQUEST_LIMIT_EXCEEDED` | `user` | `per_request` | `null` |
| 3 | `ACCOUNT_MONTHLY_LIMIT_EXCEEDED` | `account` | `monthly` | remaining account units |
| 4 | `USER_MONTHLY_LIMIT_EXCEEDED` | `user` | `monthly` | remaining user units |

Why this order: per-request limits come first because they are properties of
the request itself, so retrying later can never help. Account rules come before
user rules because the account is the outer, shared boundary. Clients should
branch on `code`, never on `message`.

---

## 4. Database design

```
plans ─┬─< accounts (plan_id, plan_scope='account') ──< users (plan_id, plan_scope='user')
       │        │                                         │
       │        ├──< account_monthly_usage (account_id, month)   PK
       │        └──< plans (custom: account_id = owner)         │
       │                                                         ├──< user_monthly_usage (user_id, month) PK
       └──────────────< usage_requests (decision ledger) >──────┘
```

| Table | Purpose / key constraints |
|---|---|
| `plans` | `scope` enum; `monthly_limit > 0`, `per_request_limit > 0`; `CHECK ((account_id IS NULL) = (code IS NOT NULL))`, i.e. predefined XOR owned; `UNIQUE(account_id, scope, name)`; `UNIQUE(id, scope)` as a composite FK target. |
| `accounts` | `api_key_hash` UNIQUE (the raw key is never stored); `FK (plan_id, plan_scope) → plans(id, scope)` with `plan_scope` fixed to `'account'` by a CHECK. **The database itself refuses a user plan on an account.** |
| `users` | Same composite FK with `plan_scope = 'user'`; `UNIQUE(account_id, id)` so child rows can reference *(account, user)* together. |
| `account_monthly_usage` | PK `(account_id, month)`; `used_units >= 0`; `month` must be the 1st of a month. |
| `user_monthly_usage` | PK `(user_id, month)`; `FK (account_id, user_id) → users(account_id, id)`, so a usage row cannot belong to another account's user. |
| `usage_requests` | One row per evaluated request (accepted **and** rejected). `UNIQUE(account_id, request_id)` is the idempotency key. It snapshots the plan IDs, plan versions, all four limits, and account/user usage before and after. CHECKs guarantee that rejected rows have a reason and level and accepted rows don't, and that `*_used_after = *_used_before + (accepted ? units : 0)`. |

**Indexes.** These cover account lookup by key hash; users per account
`(account_id, created_at, id)`; monthly usage (the primary keys); idempotency
`(account_id, request_id)`; and history `(account_id, processed_at DESC, id DESC)`
and `(user_id, processed_at DESC, id DESC)`. Month filters on history are
expressed as `processed_at` ranges so they use the history indexes.

**Timestamps** are `timestamptz` (UTC). They are generated by the app clock at
millisecond precision, so keyset cursors round-trip exactly through JavaScript
`Date`s. This also makes month boundaries testable.

**Counters vs. ledger (the trade-off).** I chose **materialized monthly
counters, updated in the same transaction as the decision ledger**:

- *Pro:* checking a limit is a single-row read, independent of history size;
  the counter row doubles as the natural lock for serializing an account.
- *Con:* counters are derived data and could in theory drift from the ledger.
  Here they can't drift partially. Counters and the ledger row are written in
  one transaction (all or nothing), and CHECK constraints tie each ledger row's
  before/after values together. `load-tests/verify-accounting.sql` re-derives
  every counter from the ledger, and found 0 mismatches over 167k decisions.
- The alternative (a pure ledger with `SUM()` on every request) avoids derived
  data, but makes each decision cost proportional to monthly history and still
  needs a lock to prevent two requests both seeing the same sum.

**Migrations** are generated by Drizzle Kit from `schema.ts` and committed in
`apps/api/drizzle/`. They are applied by `node dist/db/migrate.js` (the
`migrate` container) and tracked in `drizzle.__drizzle_migrations`, so each
runs exactly once. **Predefined plans** are seeded right after migrating with
`INSERT … ON CONFLICT (code) DO NOTHING`, so repeated initialization is safe
and never alters plans already in use. Changing a predefined plan's limits
would be a deliberate new migration.

---

## 5. Concurrency, atomicity and idempotency

The heart of the system is
[`consume.service.ts`](apps/api/src/modules/usage/consume.service.ts). Each
consumption runs in one PostgreSQL transaction at READ COMMITTED isolation:

```
BEGIN
  -- no locks held yet; these steps run in parallel across requests
  a. SELECT decision WHERE (account_id, request_id)      → found? return it (fast-path retry)
  b. SELECT user ⋈ user_plan ⋈ account ⋈ account_plan     → not found? 404 (ownership check)
  -- critical section: the account-month row lock is held until COMMIT
  1. INSERT account_monthly_usage … ON CONFLICT DO UPDATE … RETURNING used_units   ← row lock
  2. SELECT decision WHERE (account_id, request_id)      → found? return it (authoritative re-check)
  3. INSERT user_monthly_usage … ON CONFLICT DO UPDATE … RETURNING used_units      ← row lock
  4. evaluateConsumption(...)                            (pure TypeScript, no I/O)
  5. INSERT usage_requests (decision + limit/usage snapshot)
  6. if accepted: one statement increments both counters
COMMIT
```

- **No overspending.** Step 1 makes every request for the same account and
  month queue on one row. Reading usage, deciding and writing therefore
  happen strictly one at a time per account-month, so two requests can never
  both spend the last units. (This is not a check in TypeScript followed by an
  update; the database lock covers the read and the write.)
- **Deadlock freedom.** Locks are always taken in the order account row, then
  user row, and nothing else locks these rows. A bounded retry (3 attempts
  with jitter) on `40001`/`40P01` exists as insurance and is not expected to fire.
- **Atomicity.** Ledger row and both counter increments commit together or not
  at all. A test injects a database failure into the *last* write (a trigger on
  the user counter) and asserts that the account counter and the ledger row
  were rolled back too, and that the request ID was not used up.
- **Idempotency.**
  - `UNIQUE (account_id, request_id)` is the guarantee. Concurrent duplicates
    in the same month serialize on the account lock, so the second one sees the
    first's committed decision at step 2 and replays it.
  - Duplicates that straddle a UTC month boundary lock *different* counter
    rows. For those, the unique constraint rejects the second insert, the
    transaction rolls back, and the service returns the winner's recorded
    decision.
  - Both paths are tested (20 concurrent duplicates; and two app instances
    with clocks on either side of midnight).

### Idempotency policy

| Situation | Result |
|---|---|
| Same account, same `requestId`, same `userId` and `units` | `200` with the **original** recorded decision (accepted or rejected), `replayed: true`, header `Idempotent-Replayed: true`. No units consumed. Identical even if plans or usage changed since. |
| Same `requestId`, different `userId` or `units` | `409 IDEMPOTENCY_KEY_REUSED`, with the original payload in `details`. |
| Same `requestId` in a different account | Independent; keys are scoped per account. |
| Request failed validation (`400`), auth (`401`), unknown user (`404`), or a server error (`500`) | **Not recorded.** The `requestId` stays unused, so the client can fix the problem and retry with the same ID. |
| Retention | Request IDs are unique **forever** within an account (no expiry); the ledger is never pruned. |

### Plan changes vs. in-flight consumption

A plan update is a single atomic `UPDATE … version = version + 1`. A
consumption reads both plans in one statement at the start of its transaction.
Therefore:

- every consumption request sent after a plan update has returned `200` is
  evaluated against the new limits;
- a request already in flight while the update commits uses one consistent
  version, either old or new and never a mix, and records which one
  (`account.planVersion`, `user.planVersion`);
- updates never wait for consumption, and consumption never waits for updates.

A concurrency test fires 60 consumptions and 3 plan updates simultaneously. It
checks that every decision is exactly what the rules give for its recorded
snapshot, and that the first request after the last update uses the final version.

### Historical explainability

Each ledger row stores everything needed to explain it later: plan IDs and
versions, all four limits, and usage before and after at both levels. API
responses for history and replays are built **only** from that row
([`decision.view.ts`](apps/api/src/modules/usage/decision.view.ts)), so
editing a plan cannot change what a past decision says.

---

## 6. Security

- **API keys:** `qf_` + 32 bytes from `crypto.randomBytes`, base64url (256
  bits of entropy). Only the SHA-256 hash is stored, plus an 11-character
  non-secret prefix for display. A fast hash is appropriate because the key is
  high-entropy random data, not a password, and it allows an indexed lookup.
  The raw key is returned **once**, in the `POST /v1/accounts` response
  (`Cache-Control: no-store`).
- **Authentication:** header `X-API-Key: <key>` on every `/v1` route except
  account provisioning and the predefined plan catalogue. Missing key →
  `401 MISSING_API_KEY`. Malformed or unknown key → `401 INVALID_API_KEY`
  (identical responses, so callers learn nothing). There's no caching, so a key
  stops working as soon as it is removed.
- **Authorization:** the account is derived **only** from the key. No endpoint
  accepts an account ID (unknown body fields are rejected by strict schemas).
  Every user or plan reference is checked against the authenticated account.
  Another account's resources return the **same 404** as nonexistent ones
  (`USER_NOT_FOUND`, `PLAN_NOT_FOUND`), so existence is not leaked. The
  `(account_id, user_id)` foreign keys enforce ownership again at the database level.
- **Provisioning:** if `ADMIN_TOKEN` is set, `POST /v1/accounts` requires a
  matching `X-Admin-Token` (constant-time comparison). If unset, provisioning
  is open self-service, which is convenient for the local demo, and the API
  logs a warning at startup. Provisioning can only create a *new, isolated*
  account; it grants no access to existing ones.
- **Logging:** pino redacts `X-API-Key`, `X-Admin-Token`, `Authorization`,
  `Cookie` and any `apiKey` field. A test captures real log output and asserts
  the key and token never appear. Error responses for unexpected failures are
  generic (`INTERNAL_ERROR`); details go only to server logs.
- **Input limits:** JSON bodies ≤ 16 KB; strict Zod schemas; limits ≤ 10⁹.

---

## 7. API reference

All bodies are JSON. Errors always have the shape
`{ "error": { "code": "...", "message": "...", "details"?: ... } }`.
Validation errors (`400 VALIDATION_ERROR`) list `details: [{ "path", "message" }]`.

### Conventions

- **Months:** `YYYY-MM`, UTC (e.g. `2026-10`). Invalid values → `400`.
- **Pagination:** `?limit=1..100` (default 20) and `?cursor=<opaque>`.
  Responses look like `{ "data": [...], "nextCursor": "..." | null }`. Ordering
  is stable: users by `(createdAt, id)` ascending, history by
  `(processedAt, id)` descending. Pass `nextCursor` back unchanged.
- **Missing vs. empty:** an unknown or foreign user → `404`; a valid user or
  month with no activity → `200` with zero usage or an empty page.

### Endpoint summary

| Method & path | Auth | Description |
|---|---|---|
| `GET /health/live` | – | Process is up |
| `GET /health/ready` | – | DB reachable and migrated (`503` otherwise) |
| `POST /v1/accounts` | admin token if configured | Create account; returns the API key once |
| `GET /v1/plans/predefined?scope=` | – | Predefined plan catalogue |
| `GET /v1/account` | key | Account, current plan, effective limits, current usage |
| `PUT /v1/account/plan` | key | Assign an account plan `{ planId }` |
| `GET /v1/account/usage?month=` | key | Account usage for a month (default: current) |
| `GET /v1/account/usage/monthly?from=&to=` | key | Gap-free month series (default: last 12 months, max 36) |
| `POST /v1/users` | key | Create user `{ name, planId? }` (default plan: Basic) |
| `GET /v1/users?limit=&cursor=` | key | List users with plan and current usage |
| `GET /v1/users/:userId` | key | User, plan, usage, account usage, effective limits |
| `PUT /v1/users/:userId/plan` | key | Assign a user plan `{ planId }` |
| `GET /v1/users/:userId/usage?month=` | key | User usage for a month |
| `GET /v1/users/:userId/usage/monthly?from=&to=` | key | User month series |
| `GET /v1/plans?scope=&kind=` | key | Predefined + own custom plans (`kind=predefined\|custom`) |
| `POST /v1/plans` | key | Create custom plan `{ name, scope, monthlyLimit, perRequestLimit }` |
| `GET /v1/plans/:planId` | key | Read a predefined or own custom plan |
| `PATCH /v1/plans/:planId` | key | Update own custom plan `{ name?, monthlyLimit?, perRequestLimit? }` |
| `POST /v1/usage/consume` | key | Evaluate and record a consumption `{ userId, units, requestId }` |
| `GET /v1/usage/requests?userId=&status=&month=&limit=&cursor=` | key | Decision history, newest first |

### Error codes

| HTTP | `code` | When |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Bad body/query/path (incl. malformed UUID, month, cursor, non-positive or non-integer units) |
| 400 | `INVALID_JSON` | Unparseable body |
| 401 | `MISSING_API_KEY` / `INVALID_API_KEY` | No key / malformed or unknown key |
| 401 / 403 | `MISSING_ADMIN_TOKEN` / `INVALID_ADMIN_TOKEN` | Provisioning when `ADMIN_TOKEN` is set |
| 403 | `PREDEFINED_PLAN_READ_ONLY` | `PATCH` on a predefined plan |
| 404 | `USER_NOT_FOUND` / `PLAN_NOT_FOUND` / `NOT_FOUND` | Unknown, or belongs to another account / unknown route |
| 409 | `IDEMPOTENCY_KEY_REUSED` | `requestId` reused with a different payload |
| 409 | `PLAN_NAME_TAKEN` | Duplicate custom plan name within an account and scope |
| 413 | `PAYLOAD_TOO_LARGE` | Body > 16 KB |
| 422 | `PLAN_SCOPE_MISMATCH` | User plan assigned to an account or vice versa |
| 500 | `INTERNAL_ERROR` | Unexpected failure (nothing is recorded) |

### `POST /v1/usage/consume`

Both outcomes return **`200`**: the request was evaluated and its decision
recorded. HTTP errors are reserved for requests that could not be evaluated.
Branch on `decision`.

```json
// request
{ "userId": "6f1c…", "units": 10, "requestId": "order-1234-charge" }
```

`requestId`: 1–128 characters from `[A-Za-z0-9._:-]`. `units`: integer,
1 to 10⁹. Both are required.

```json
// accepted
{
  "id": "07084ac9-…", "requestId": "order-1234-charge", "decision": "accepted",
  "userId": "6f1c…", "units": 10, "unitsAccepted": 10,
  "month": "2026-10", "processedAt": "2026-10-28T22:00:24.935Z",
  "rejection": null,
  "account": { "planId": "…", "planVersion": 1, "monthlyLimit": 10000, "perRequestLimit": 100, "usedUnits": 10,  "remaining": 9990 },
  "user":    { "planId": "…", "planVersion": 1, "monthlyLimit": 1000,  "perRequestLimit": 20,  "usedUnits": 10,  "remaining": 990 },
  "replayed": false
}
```

```json
// rejected
{
  "id": "619fb901-…", "requestId": "order-1235-charge", "decision": "rejected",
  "userId": "6f1c…", "units": 25, "unitsAccepted": 0, "month": "2026-10", "processedAt": "…",
  "rejection": {
    "code": "USER_PER_REQUEST_LIMIT_EXCEEDED", "level": "user", "limitType": "per_request",
    "limit": 20, "available": null,
    "message": "Requested units exceed the user plan's per-request limit."
  },
  "account": { "…": "…", "usedUnits": 10, "remaining": 9990 },
  "user":    { "…": "…", "usedUnits": 10, "remaining": 990 },
  "replayed": false
}
```

`account` and `user` show the limits the decision was evaluated against and
the usage **after** it (equal to before for rejections). `GET
/v1/usage/requests` returns the same objects without `replayed`.

### Other response shapes

```jsonc
// GET /v1/account
{ "id": "…", "name": "Acme", "apiKeyPrefix": "qf_MibTbOpw", "createdAt": "…",
  "plan": { "id": "…", "code": "starter", "name": "Starter", "scope": "account", "kind": "predefined",
            "monthlyLimit": 10000, "perRequestLimit": 100, "version": 1, "createdAt": "…", "updatedAt": "…" },
  "usage": { "month": "2026-10", "usedUnits": 120, "monthlyLimit": 10000, "perRequestLimit": 100, "remaining": 9880 } }

// POST /v1/accounts → 201: the same as above plus  "apiKey": "qf_…"   (only time it is returned)

// GET /v1/users/:userId
{ "id": "…", "accountId": "…", "name": "Alice", "createdAt": "…", "plan": { … },
  "usage":        { "month": "2026-10", "usedUnits": 30, "monthlyLimit": 40, "perRequestLimit": 20, "remaining": 10 },
  "accountUsage": { "month": "2026-10", "usedUnits": 85, "monthlyLimit": 100, "perRequestLimit": 50, "remaining": 15 },
  "effective":    { "maxUnitsPerRequest": 20, "availableThisMonth": 10 } }

// GET /v1/account/usage?month=2026-09   (also /v1/users/:id/usage)
{ "month": "2026-09", "usedUnits": 4200, "isCurrentMonth": false, "monthlyLimit": null, "remaining": null }
// For the current month, monthlyLimit/remaining reflect the plan assigned now. For past months they are
// null, because past months may have been governed by other plans; exact per-decision limits are in history.

// GET /v1/account/usage/monthly?from=2026-08&to=2026-10
{ "from": "2026-08", "to": "2026-10", "data": [ { "month": "2026-08", "usedUnits": 0 }, { "month": "2026-09", "usedUnits": 4200 }, { "month": "2026-10", "usedUnits": 120 } ] }
```

---

## 8. Example client and demo walkthrough

Open **http://localhost:8080**. Everything shown is fetched from the live API;
the client holds no business logic and no mock data.

- **Get started:** run the guided demo, create an account (choose Starter or
  Pro), or paste an existing API key. The key is kept in this browser's
  `localStorage` for convenience. **Disconnect** forgets it. If the API has
  `ADMIN_TOKEN` set, enter it under *Admin token*.
- **Account panel:** shared allowance bar, current plan and version, and a
  plan switcher.
- **Simulate an action:** pick a user, units and request ID. *Consume* shows
  the decision card (accepted or rejected, reason code, level, limits,
  remaining). Keep the same request ID and press Consume again to see a
  **REPLAYED** response that consumes nothing. Press *New ID* for a new operation.
- **Users:** per-user usage bars, a plan selector per user, and *Add user*.
- **Plans:** predefined plans (read-only) and custom plans with inline
  editable limits. *Save* applies to subsequent requests, and the version
  increments. Create new account or user plans.
- **Request history:** newest first, with the plan version each decision used;
  *Load older* follows the cursor.

### Reproducible demo scenario

**Run demo scenario** (or `npm run demo` on the host) provisions a **fresh**
account with deterministic limits, checks every step against the API
response, and then connects the console to that account:

| Setup | Limits |
|---|---|
| Account plan "Demo Account" | 100 units/month, 50/request |
| User plan "Demo Shared" (Alice, Bob) | 40 units/month, 20/request |
| Carol | predefined Premium (5,000/month, 100/request) |

| Step | Action | Expected |
|---|---|---|
| 1 | Alice consumes 10 | **accepted**; account 10/100, Alice 10/40 |
| 2a | Alice consumes 25 | **rejected** `USER_PER_REQUEST_LIMIT_EXCEEDED` (limit 20) |
| 2b | Alice consumes 20, then 15 | 15 **rejected** `USER_MONTHLY_LIMIT_EXCEEDED` (10 available) |
| 3 | Bob (same plan) consumes 5 | **accepted**; Bob 5/40 while Alice stays at 30/40 |
| 4 | Carol consumes 50, then 20 | 20 **rejected** `ACCOUNT_MONTHLY_LIMIT_EXCEEDED` (15 available), although Carol has 4,950 left |
| 5a | "Demo Account" raised to 200/month; Carol retries 20 with a new ID | **accepted**; account 105/200, plan version 2 |
| 5b | Alice switched to Premium; repeats 15 with a new ID | **accepted**; Alice keeps her 30 and reaches 45/5,000 |
| 6 | Step 1's request ID sent again | **replayed** original decision; account usage unchanged (120) |

Headless, against the running stack:

```bash
npm install                                 # once, on the host
npm run demo -- http://localhost:8080/api   # same code as the UI button; exits non-zero if any check fails
```

---

## 9. curl walkthrough

Replace values in `<ANGLE_BRACKETS>` with real values from earlier responses.
If `ADMIN_TOKEN` is set, add `-H "X-Admin-Token: <ADMIN_TOKEN>"` to the first call.

```bash
API=http://localhost:3000

# Create an account (the response contains "apiKey"; store it, it is shown only once)
curl -s -X POST $API/v1/accounts -H 'Content-Type: application/json' -d '{"name":"Acme"}'
KEY=<API_KEY_FROM_RESPONSE>

# Predefined plans (public) and a custom user plan
curl -s $API/v1/plans/predefined
curl -s -X POST $API/v1/plans -H "X-API-Key: $KEY" -H 'Content-Type: application/json' \
  -d '{"name":"Team","scope":"user","monthlyLimit":40,"perRequestLimit":20}'

# Create users: one on the default Basic plan, one on the custom plan
curl -s -X POST $API/v1/users -H "X-API-Key: $KEY" -H 'Content-Type: application/json' -d '{"name":"alice"}'
curl -s -X POST $API/v1/users -H "X-API-Key: $KEY" -H 'Content-Type: application/json' \
  -d '{"name":"bob","planId":"<CUSTOM_PLAN_ID>"}'

# Assign a plan to a user, and an account plan to the account
curl -s -X PUT $API/v1/users/<ALICE_ID>/plan -H "X-API-Key: $KEY" -H 'Content-Type: application/json' \
  -d '{"planId":"<PREMIUM_PLAN_ID>"}'
curl -s -X PUT $API/v1/account/plan -H "X-API-Key: $KEY" -H 'Content-Type: application/json' \
  -d '{"planId":"<PRO_PLAN_ID>"}'

# Consume units
curl -s -X POST $API/v1/usage/consume -H "X-API-Key: $KEY" -H 'Content-Type: application/json' \
  -d '{"userId":"<BOB_ID>","units":10,"requestId":"order-1001"}'

# Repeat the same request ID: same decision, "replayed": true, nothing consumed
curl -si -X POST $API/v1/usage/consume -H "X-API-Key: $KEY" -H 'Content-Type: application/json' \
  -d '{"userId":"<BOB_ID>","units":10,"requestId":"order-1001"}' | grep -iE 'idempotent-replayed|"replayed"'

# Same request ID, different payload: 409 IDEMPOTENCY_KEY_REUSED
curl -s -X POST $API/v1/usage/consume -H "X-API-Key: $KEY" -H 'Content-Type: application/json' \
  -d '{"userId":"<BOB_ID>","units":11,"requestId":"order-1001"}'

# Current usage, user detail with effective limits, and a previous month
curl -s $API/v1/account -H "X-API-Key: $KEY"
curl -s $API/v1/users/<BOB_ID> -H "X-API-Key: $KEY"
curl -s "$API/v1/account/usage?month=2026-09" -H "X-API-Key: $KEY"
curl -s "$API/v1/users/<BOB_ID>/usage/monthly?from=2026-01&to=2026-10" -H "X-API-Key: $KEY"

# Update a custom plan (affects every user on it, for subsequent requests)
curl -s -X PATCH $API/v1/plans/<CUSTOM_PLAN_ID> -H "X-API-Key: $KEY" -H 'Content-Type: application/json' \
  -d '{"monthlyLimit":100}'

# Paginated history (rejected only, for one user)
curl -s "$API/v1/usage/requests?userId=<BOB_ID>&status=rejected&limit=10" -H "X-API-Key: $KEY"
curl -s "$API/v1/usage/requests?limit=10&cursor=<NEXT_CURSOR>" -H "X-API-Key: $KEY"
```

---

## 10. Testing

Integration tests run against **real PostgreSQL**; nothing is mocked. The test
database (`TEST_DATABASE_URL`, default `quotaflow_test` on the Compose
Postgres) is created if missing, migrated, and **truncated once per run**.
Each test then isolates itself by creating fresh accounts, so tests don't
depend on execution order. Time-dependent tests use an injected clock, never
the wall clock.

```bash
npm install
docker compose up -d postgres     # or the whole stack
npm test                          # reads TEST_DATABASE_URL from .env
npm run typecheck                 # API + web, strict TypeScript
npm run build                     # compiles API, type-checks and bundles web
```

Last run: **10 files, 120 tests, all passing** (also stable across repeated
runs with `--sequence.shuffle`).

| File | Covers |
|---|---|
| `unit/evaluate.test.ts` | Spec example, every reason code, exact boundaries, precedence, clamped `remaining` |
| `unit/month.test.ts` | UTC month assignment across midnight and timezones, ranges, leap February |
| `unit/apiKey.test.ts` | Key format, uniqueness and entropy, hash-only storage, cursor tamper rejection |
| `integration/auth.test.ts` | Missing, invalid and valid keys; every protected route; cross-account users and plans (404, nothing recorded); malformed input; admin-token provisioning; **log redaction**; health incl. DB down (503) |
| `integration/plans.test.ts` | Seeded plans; predefined read-only; custom create/update/versioning; limit validation (0, negative, fractional, string, null, too large); scope mismatch (API **and** DB FK) |
| `integration/users.test.ts` | Defaults, effective limits, plan switch preserving usage, pagination with identical timestamps |
| `integration/consume.test.ts` | Accepted; all four rejections; precedence; exact-limit boundary; invalid units; rejected requests consume nothing; shared plan with independent usage; **UTC month rollover**; monthly series and history by month; plan update/switch/lowering below usage; historical explainability |
| `integration/concurrency.test.ts` | Retries; 409 conflict; rejected-request replay after limits change; **20 concurrent duplicates → one charge**; **duplicates racing across midnight**; **last account units** and **last user units** races (×10 rounds); 200-request mixed burst with ledger and counter invariants; plan updates during a burst; **rollback after an injected DB failure**; DB rejects inconsistent ledger rows |
| `integration/history.test.ts` | Stable keyset pagination with identical timestamps, filters, empty month, parameter validation |
| `integration/persistence.test.ts` | Data and idempotency survive closing every connection and restarting the app |

**Are the concurrency tests meaningful?** I checked them by mutation: with the
row-locking upserts replaced by plain reads, the race tests fail
(`last account units`, `last user units`, `mixed burst`). With the real code,
they pass.

---

## 11. Performance testing

k6 runs as a Compose service (profile `loadtest`) against the real API and
database:

```bash
docker compose up --build -d
docker compose --profile loadtest run --rm k6 run /scripts/scenario-a-normal.js
docker compose --profile loadtest run --rm k6 run /scripts/scenario-b-contention.js
docker compose exec -T postgres psql -U quotaflow -d quotaflow < load-tests/verify-accounting.sql
```

Measured on an Apple M5 laptop under Docker Desktop. Full details,
methodology and raw JSON are in [`load-tests/RESULTS.md`](load-tests/RESULTS.md).

| Scenario | Load | Throughput | p50 | p95 | Errors | Accounting |
|---|---|---|---|---|---|---|
| A: normal (1 account, 20 users, mixed outcomes) | 40 VUs, 55 s | **787–810 req/s** | 37 ms | 88–92 ms | 0% | account = Σ users = Σ accepted history ✔ |
| B: contention + 30% retries | 100 VUs, 30 s | **1,093 req/s** | 82 ms | 152 ms | 0% | **exactly 5,000 / 5,000**, 9,779 replays charged 0 ✔ |

**Bottleneck found:** with a single hot account, all consumptions serialize on
that account's monthly counter row. This is the mechanism that guarantees the
limit, so it's intended. Sampling `pg_stat_activity` showed 19 of 20
connections waiting on that lock, while the lock holder was mostly waiting on
round trips to the app. **Fix applied:** move the ownership/plan read and a
fast-path retry lookup before the lock, and merge the two counter updates into
one statement. That cut the round trips while holding the lock from 7 to 5,
and measured throughput rose 10–14% on A and 19% on B (variance between runs
was about 3%). All correctness tests still pass on the optimized code.

---

## 12. Configuration

| Variable | Used by | Default | Description |
|---|---|---|---|
| `POSTGRES_PASSWORD` | compose | **required** | Password for the Compose database (URL-safe characters) |
| `POSTGRES_USER` / `POSTGRES_DB` | compose | `quotaflow` | Database user / name |
| `POSTGRES_HOST_PORT` | compose | `5433` | Host port, bound to 127.0.0.1 |
| `DATABASE_URL` | api, migrate | built by compose | `postgres://user:pass@host:port/db` |
| `PORT` / `API_PORT` | api / compose | `3000` | API listen port / host port |
| `DB_POOL_MAX` | api | `20` | Max pooled DB connections |
| `LOG_LEVEL` | api | `info` | `fatal`…`trace`, or `silent` |
| `ADMIN_TOKEN` | api | empty | If set (≥16 chars), `POST /v1/accounts` requires `X-Admin-Token` |
| `WEB_PORT` | compose | `8080` | Host port of the web console |
| `TEST_DATABASE_URL` | tests | from `.env` | Database for integration tests (created and **truncated**) |

Configuration is validated with Zod at startup. An invalid value stops the
process with a message naming the variable.

---

## 13. Local development without Docker

```bash
npm install
# Point DATABASE_URL in .env at any PostgreSQL 14+ (e.g. the Compose one on :5433)
npm run db:migrate       # migrate + seed
npm run dev:api          # http://localhost:3000, reloads on change
npm run dev:web          # http://localhost:5173, proxies /api → localhost:3000
```

After changing `apps/api/src/db/schema.ts`, run `npm run db:generate` and
commit the new SQL file in `apps/api/drizzle/`.

---

## 14. Design decisions, assumptions and trade-offs

- **Row locks over SERIALIZABLE.** Locking one counter row gives strict per-account
  correctness with predictable behaviour and no retry storms. SERIALIZABLE would also
  be correct, but under contention it aborts and retries most competing
  transactions on the hot account.
- **Rejections are `200`.** A rejection is a successful, recorded evaluation.
  Clients branch on `decision` and `rejection.code`. HTTP 4xx/5xx means *not
  evaluated, not recorded*.
- **Rejected requests are recorded and idempotent.** A retried rejected request
  returns the same rejection even if limits were raised. To try again under new
  limits, the client uses a new `requestId` (it's a new logical operation).
- **Unknown users and validation failures aren't recorded.** There's nothing
  meaningful to evaluate, and recording them would use up the client's
  request ID for a typo.
- **Plan scope is immutable.** Changing it would invalidate existing
  assignments, so you create a new plan instead.
- **Plans are never deleted** (no endpoint). History references them by ID and
  carries its own limit snapshot anyway.
- **Past-month usage reports `usedUnits` only.** Limits for past months are
  `null` rather than guessed from today's plan. Exact historical limits are
  per-decision in the history.
- **Open provisioning by default** for a frictionless local demo, guarded by
  `ADMIN_TOKEN` when deployed.
- **Assumptions:** one resource type ("units"); monthly limits are hard caps
  with no overage; accounts and users are never deleted through the API; request
  IDs are client-chosen opaque strings.
- **No shared types package.** The web client mirrors response types in
  `apps/web/src/types.ts`. With one small client this was simpler than adding
  a build step for a shared package.

## 15. Known limitations and future work

- **Single hot account throughput** is bounded by serialization on its counter
  row (~0.8–1.1k req/s on the test laptop). Next steps if needed: a PL/pgSQL
  function so the critical section is a single round trip, or quota leases per
  API instance. Different accounts don't contend.
- **No API key rotation/revocation endpoint** (the schema supports it: replace
  `api_key_hash`). No rate limiting on provisioning or auth failures.
- **No account/user deletion, no plan deletion, no ledger retention policy**:
  the ledger grows without bound. Partitioning `usage_requests` by month would
  be the natural next step at scale.
- **Load test numbers come from a laptop** with the generator on the same host;
  they are relative evidence, not capacity planning.
- `npm audit` reports moderate advisories in the esbuild bundled with
  **drizzle-kit (dev-only)**. They concern esbuild's dev server, which this
  project never runs, and they don't ship in the production image (`--omit=dev`).

## 16. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `required variable POSTGRES_PASSWORD is missing a value` | `cp .env.example .env` and set `POSTGRES_PASSWORD`. |
| `api` never starts; `migrate` exited non-zero | `docker compose logs migrate`. Usually a wrong password after changing `.env` while the old volume kept the old one: `docker compose down -v` (deletes data) or restore the old password. |
| `password authentication failed` | Same as above: Postgres only applies `POSTGRES_PASSWORD` when it initializes an **empty** volume. |
| Port already in use (3000 / 5433 / 8080) | Set `API_PORT`, `POSTGRES_HOST_PORT` or `WEB_PORT` in `.env`. |
| `/health/ready` returns 503 | Database unreachable or not migrated; check `docker compose ps` and `logs postgres migrate`. |
| Web console shows "API unreachable" | `api` not healthy yet, or you're running `vite` without the API on `:3000` (set `API_PROXY_TARGET`). |
| Tests fail with `TEST_DATABASE_URL is not set` | Create `.env` from `.env.example` or export the variable; start Postgres with `docker compose up -d postgres`. |
| Tests fail with `ECONNREFUSED 127.0.0.1:5433` | The Compose Postgres isn't running, or uses another host port. |
| `Invalid configuration: - DATABASE_URL …` | The variable is missing or not a `postgres://` URL. The message names the field. |
| Demo in the UI fails with `401 MISSING_ADMIN_TOKEN` | The API has `ADMIN_TOKEN` set; enter it under *Admin token* (or `ADMIN_TOKEN=… npm run demo`). |
