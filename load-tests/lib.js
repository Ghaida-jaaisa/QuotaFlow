// Shared helpers for the k6 scenarios. Runs inside k6 (not Node).
import http from 'k6/http';
import { check, fail } from 'k6';

export const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';

export function jsonHeaders(apiKey) {
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['X-API-Key'] = apiKey;
  if (!apiKey && __ENV.ADMIN_TOKEN) headers['X-Admin-Token'] = __ENV.ADMIN_TOKEN;
  return { headers, tags: { name: 'setup' } };
}

function post(path, body, apiKey, method = 'POST') {
  const res = http.request(method, `${BASE_URL}${path}`, JSON.stringify(body), jsonHeaders(apiKey));
  if (res.status >= 300) fail(`${method} ${path} -> ${res.status} ${res.body}`);
  return res.json();
}

/**
 * Provisions a fresh account with deterministic custom plans and users.
 * `userPlans` is a list of { monthlyLimit, perRequestLimit, count }.
 */
export function provision({ name, accountPlan, userPlans }) {
  const account = post('/v1/accounts', { name });
  const key = account.apiKey;
  const plan = post('/v1/plans', { name: `${name} account`, scope: 'account', ...accountPlan }, key);
  post('/v1/account/plan', { planId: plan.id }, key, 'PUT');
  const users = [];
  userPlans.forEach((spec, index) => {
    const userPlan = post(
      '/v1/plans',
      { name: `${name} user ${index}`, scope: 'user', monthlyLimit: spec.monthlyLimit, perRequestLimit: spec.perRequestLimit },
      key,
    );
    for (let i = 0; i < spec.count; i++) {
      users.push(post('/v1/users', { name: `u${index}-${i}`, planId: userPlan.id }, key).id);
    }
  });
  return { apiKey: key, accountId: account.id, users };
}

export function consume(apiKey, userId, units, requestId) {
  return http.post(`${BASE_URL}/v1/usage/consume`, JSON.stringify({ userId, units, requestId }), {
    headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
    tags: { name: 'consume' },
  });
}

/**
 * Post-run accounting verification through the public API:
 *   - account usage <= account limit, each user <= user limit
 *   - account usage == sum of user usage
 *   - account usage == sum of accepted units in the request history
 */
export function verifyAccounting(apiKey) {
  const get = (path) => {
    const res = http.get(`${BASE_URL}${path}`, { headers: { 'X-API-Key': apiKey }, tags: { name: 'verify' } });
    if (res.status !== 200) fail(`GET ${path} -> ${res.status}`);
    return res.json();
  };
  const account = get('/v1/account');
  const users = get('/v1/users?limit=100').data;
  const userSum = users.reduce((sum, u) => sum + u.usage.usedUnits, 0);
  const usersWithinLimits = users.every((u) => u.usage.usedUnits <= u.usage.monthlyLimit);

  let acceptedUnits = 0;
  let acceptedRecords = 0;
  let cursor = null;
  do {
    const page = get(`/v1/usage/requests?status=accepted&limit=100${cursor ? `&cursor=${cursor}` : ''}`);
    for (const record of page.data) {
      acceptedUnits += record.units;
      acceptedRecords += 1;
    }
    cursor = page.nextCursor;
  } while (cursor);

  const summary = {
    accountUsed: account.usage.usedUnits,
    accountLimit: account.usage.monthlyLimit,
    sumOfUserUsage: userSum,
    acceptedUnitsInHistory: acceptedUnits,
    acceptedRecords,
  };
  console.log(`ACCOUNTING ${JSON.stringify(summary)}`);
  const ok = check(summary, {
    'account usage <= account limit': (s) => s.accountUsed <= s.accountLimit,
    'every user usage <= user limit': () => usersWithinLimits,
    'account usage == sum of user usage': (s) => s.accountUsed === s.sumOfUserUsage,
    'account usage == accepted units in history': (s) => s.accountUsed === s.acceptedUnitsInHistory,
  });
  if (!ok) fail('accounting verification failed');
  return summary;
}

/** Compact, dependency-free end-of-test summary plus a JSON file under results/. */
export function summarize(name, data) {
  const m = data.metrics;
  const val = (metric, key) => (m[metric] && m[metric].values[key] !== undefined ? m[metric].values[key] : 0);
  const report = {
    scenario: name,
    generatedAt: new Date().toISOString(),
    durationSeconds: Math.round(data.state.testRunDurationMs / 100) / 10,
    totalHttpRequests: val('http_reqs', 'count'),
    consumeRequests: val('consume_requests', 'count'),
    accepted: val('decisions_accepted', 'count'),
    rejected: val('decisions_rejected', 'count'),
    replayed: val('decisions_replayed', 'count'),
    consumeThroughputPerSecond: Math.round((val('consume_requests', 'count') / (data.state.testRunDurationMs / 1000)) * 10) / 10,
    consumeLatencyMs: {
      median: round(val('consume_latency', 'med')),
      p90: round(val('consume_latency', 'p(90)')),
      p95: round(val('consume_latency', 'p(95)')),
      max: round(val('consume_latency', 'max')),
    },
    httpErrorRate: val('http_req_failed', 'rate'),
    checksPassRate: val('checks', 'rate'),
    thresholds: Object.fromEntries(
      Object.entries(m)
        .filter(([, metric]) => metric.thresholds)
        .map(([key, metric]) => [key, Object.fromEntries(Object.entries(metric.thresholds).map(([t, r]) => [t, r.ok]))]),
    ),
  };
  const text = `\n=== ${name} ===\n${JSON.stringify(report, null, 2)}\n`;
  return { stdout: text, [`/scripts/results/${name}.json`]: JSON.stringify(report, null, 2) };
}

function round(value) {
  return Math.round(value * 100) / 100;
}
