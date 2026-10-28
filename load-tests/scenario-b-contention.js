// Scenario B: contention and retries. 100 VUs race for a small shared
// allowance; ~30% of requests reuse request IDs from a shared pool (retries,
// including concurrent duplicates). Accounting is verified afterwards.
import { check } from 'k6';
import { Counter, Trend } from 'k6/metrics';
import { consume, provision, summarize, verifyAccounting } from './lib.js';

const consumeRequests = new Counter('consume_requests');
const accepted = new Counter('decisions_accepted');
const rejected = new Counter('decisions_rejected');
const replayed = new Counter('decisions_replayed');
const conflicts = new Counter('idempotency_conflicts');
const latency = new Trend('consume_latency', true);

const USERS = 10;
const RETRY_POOL = 300;

export const options = {
  scenarios: {
    contention: { executor: 'constant-vus', vus: 100, duration: '30s' },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    idempotency_conflicts: ['count==0'],
    checks: ['rate>0.99'],
  },
};

export function setup() {
  return provision({
    name: `load-b-${Date.now()}`,
    // Users could jointly consume 6,000 but the account allows only 5,000:
    // both the shared and the individual limits are hit under contention.
    accountPlan: { monthlyLimit: 5_000, perRequestLimit: 50 },
    userPlans: [{ monthlyLimit: 600, perRequestLimit: 50, count: USERS }],
  });
}

export default function (ctx) {
  const n = __VU * 100_003 + __ITER;
  let requestId;
  let slot;
  if (n % 10 < 3) {
    // Retry pool: the payload is a pure function of the pool slot, so a reused
    // ID always carries the same payload and must be replayed, never re-charged.
    slot = n % RETRY_POOL;
    requestId = `b-pool-${slot}-${ctx.accountId.slice(0, 8)}`;
  } else {
    slot = n;
    requestId = `b-${__VU}-${__ITER}-${ctx.accountId.slice(0, 8)}`;
  }
  const userId = ctx.users[slot % USERS];
  const units = (slot % 40) + 1; // 1..40
  const res = consume(ctx.apiKey, userId, units, requestId);
  consumeRequests.add(1);
  latency.add(res.timings.duration);
  if (res.status === 409) conflicts.add(1);
  const ok = check(res, { 'consume returns 200': (r) => r.status === 200 });
  if (!ok) return;
  const body = res.json();
  // accepted/rejected count fresh decisions only; replays return a stored decision.
  if (body.replayed) replayed.add(1);
  else if (body.decision === 'accepted') accepted.add(1);
  else rejected.add(1);
}

export function teardown(ctx) {
  verifyAccounting(ctx.apiKey);
}

export function handleSummary(data) {
  return summarize('scenario-b-contention', data);
}
