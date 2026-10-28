// Scenario A: normal workload. One account, 20 users on three plans, a
// deterministic mix of accepted and rejected requests, unique request IDs.
import { check } from 'k6';
import { Counter, Trend } from 'k6/metrics';
import { consume, provision, summarize, verifyAccounting } from './lib.js';

const consumeRequests = new Counter('consume_requests');
const accepted = new Counter('decisions_accepted');
const rejected = new Counter('decisions_rejected');
const replayed = new Counter('decisions_replayed');
const latency = new Trend('consume_latency', true);

export const options = {
  scenarios: {
    normal: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '10s', target: 40 },
        { duration: '40s', target: 40 },
        { duration: '5s', target: 0 },
      ],
      gracefulRampDown: '5s',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    consume_latency: ['p(95)<500'],
    checks: ['rate>0.99'],
  },
};

export function setup() {
  return provision({
    name: `load-a-${Date.now()}`,
    // Large shared allowance so mostly per-user rules decide.
    accountPlan: { monthlyLimit: 1_000_000, perRequestLimit: 100 },
    userPlans: [
      { monthlyLimit: 1_000_000, perRequestLimit: 20, count: 10 }, // per-request rejections above 20
      { monthlyLimit: 1_000_000, perRequestLimit: 50, count: 6 },
      { monthlyLimit: 2_000, perRequestLimit: 50, count: 4 }, // exhaust monthly allowance during the run
    ],
  });
}

export default function (ctx) {
  // Deterministic workload derived from VU and iteration numbers.
  const n = __VU * 100_003 + __ITER;
  const userId = ctx.users[n % ctx.users.length];
  const units = ((__VU * 31 + __ITER * 17) % 30) + 1; // 1..30
  const res = consume(ctx.apiKey, userId, units, `a-${__VU}-${__ITER}-${ctx.accountId.slice(0, 8)}`);
  consumeRequests.add(1);
  latency.add(res.timings.duration);
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
  return summarize('scenario-a-normal', data);
}
