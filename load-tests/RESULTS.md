# Load test results

All numbers below were **measured** on 2026-10-28 with the scripts in this
directory. Raw k6 summaries are in [`results/`](results/). They are
environment-specific: treat them as relative evidence (before/after, and
correctness under load), not as production capacity figures.

## Environment

| | |
|---|---|
| Host | Apple M5, macOS 27.0.1 |
| Docker | Docker Desktop 29.9.2, VM with 10 CPUs / 7.7 GiB |
| Services | `api` (1 Node 22 process, pool 20), `postgres:16-alpine` (default config), all via `docker compose` |
| Load generator | `grafana/k6:1.3.0` on the same Compose network, calling `http://api:3000` directly |
| Logging | API at `LOG_LEVEL=info` (one JSON line per request), as in the default setup |

## How to reproduce

```bash
docker compose up --build -d
docker compose --profile loadtest run --rm k6 run /scripts/scenario-a-normal.js
docker compose --profile loadtest run --rm k6 run /scripts/scenario-b-contention.js
# Cross-check counters against the decision ledger for every account (all queries must return 0 rows):
docker compose exec -T postgres psql -U quotaflow -d quotaflow < load-tests/verify-accounting.sql
```

Each scenario provisions its own fresh account and plans in `setup()`, so runs
are independent and never depend on existing data. Workloads are derived from
`__VU`/`__ITER` (no randomness), so the request mix is the same on every run.

## Scenarios

**A: normal workload** (`scenario-a-normal.js`). One account (1,000,000 units/month,
100/request), 20 users on three custom plans (10 × 20/request, 6 × 50/request,
4 × 2,000/month). Each request is 1–30 units with a unique request ID, so
there's a natural mix of acceptances, per-request rejections, and monthly
rejections once the 2,000-unit users run out. Profile: ramp 0→40 VUs over 10s,
hold 40 VUs for 40s, ramp down 5s. Closed model, no think time.

**B: contention and retries** (`scenario-b-contention.js`). A small shared
allowance: account 5,000 units/month (50/request), 10 users at 600/month each
(jointly 6,000 > 5,000, so both levels bind). 100 constant VUs for 30s. 30% of
requests reuse request IDs from a 300-entry pool, with the payload a pure
function of the pool slot. That produces sequential retries *and* concurrent
duplicates, which must be replayed, never charged twice.

Both scenarios verify accounting in `teardown()` through the public API:
account usage ≤ limit, every user ≤ its limit, account usage = Σ user usage =
Σ accepted units in the paginated request history.

## Results

### Baseline (first implementation)

| Scenario | Consume requests | Fresh accepted | Fresh rejected | Replayed | Throughput | p50 | p95 | max | HTTP errors |
|---|---|---|---|---|---|---|---|---|---|
| A (40 VUs) | 39,898 | 25,773 | 14,125 | 0 | 713 req/s | 42.6 ms | 100.5 ms | 283 ms | 0% |
| B (100 VUs) | 27,760 | 248 ¹ | – | 8,242 | 922 req/s | 101.9 ms | 153.1 ms | 308 ms | 0% |

¹ The baseline B run counted replays of accepted decisions inside "accepted"
(6,303 accepted responses). The script was then fixed to count fresh
decisions only. 248 is the number of distinct accepted records reported by the
teardown verification.

### After optimization (current code)

| Scenario | Consume requests | Fresh accepted | Fresh rejected | Replayed | Throughput | p50 | p95 | max | HTTP errors |
|---|---|---|---|---|---|---|---|---|---|
| A, run 1 | 46,035 | 29,670 | 16,365 | 0 | 810 req/s | 37.2 ms | 87.7 ms | 264 ms | 0% |
| A, run 2 | 44,975 | 29,004 | 15,971 | 0 | 787 req/s | 37.7 ms | 91.6 ms | 487 ms | 0% |
| B | 32,914 | 251 | 22,884 | 9,779 | 1,093 req/s | 82.0 ms | 151.5 ms | 374 ms | 0% |

Run-to-run variance on A was about 3% (810 vs 787 req/s). The improvement over
baseline (+10–14% throughput on A, +19% on B, −20% p50 on B) is larger than
that, but these are single-digit numbers of runs on a laptop.

### Correctness under load (every run)

| Check | A | B |
|---|---|---|
| Account usage ≤ limit | 378,576 ≤ 1,000,000 ✔ | **5,000 ≤ 5,000** ✔ (exactly exhausted, never exceeded) |
| Account usage = Σ user usage | ✔ | ✔ |
| Account usage = Σ accepted units in history | ✔ (29,670 records) | ✔ (251 records) |
| Idempotency conflicts (409) | n/a | 0 |
| Replays charged | n/a | 0 (9,779 replays, usage unchanged) |

`verify-accounting.sql` run after all load tests, over **167,587** recorded
decisions in the database: 0 counter/ledger mismatches, 0 account/user-sum
mismatches, 0 accepted decisions above their limit snapshot, 0 duplicate request IDs.

## Bottleneck analysis

While Scenario A ran, `pg_stat_activity` was sampled once per second:

```
Lock:transactionid | active              | 19   <- waiting for the account's counter row lock
Client:ClientRead  | idle in transaction |  1   <- the lock holder, waiting for the app's next statement
```

API container CPU was about 56% and Postgres about 78%, so neither was
saturated. The bottleneck is by design: **every consumption for one account
in one month serializes on that account's monthly counter row**, which is what
guarantees the shared limit can never be overrun. With one hot account,
throughput ≈ 1 / (time the lock is held), and the lock holder spent its time
waiting on network round trips between statements.

### Optimization applied

The critical section was shortened without weakening any guarantee:

1. The fast-path idempotency lookup and the user/plan read moved **before** the
   lock. Retries return without queueing; the plan read still happens after
   the request starts, so any plan update that has already returned 200 still
   applies.
2. The duplicate check stays **under** the lock (authoritative), backed by the
   unique constraint.
3. The two counter increments were merged into one SQL statement.

Round trips while holding the lock (after acquiring it, including COMMIT):
7 → 5 for accepted requests, 5 → 4 for rejected ones. The full test suite (including the concurrency tests that fail
when the row locks are removed) passes on the optimized code.

### Not done, deliberately

- **No caching** of API keys, plans or usage: it would make authorization or
  limit decisions stale.
- **No Redis / sharded counters**: unnecessary at this load. For very hot
  accounts the next steps would be (a) moving the critical section into a
  single PL/pgSQL function (one round trip under the lock) or (b) allocating
  per-instance quota leases from the account counter. Both trade simplicity
  for throughput.
- Multi-account throughput was not measured; different accounts lock
  different rows and do not serialize on each other.
