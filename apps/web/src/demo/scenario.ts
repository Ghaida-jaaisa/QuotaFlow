import { QuotaFlowClient } from '../api';
import type { ConsumeResult, Plan } from '../types';

/**
 * Reproducible end-to-end demo against the real API. It provisions a fresh
 * account with deterministic custom plans, so results never depend on
 * pre-existing data:
 *
 *   Account plan "Demo Account":      100 units/month, 50 per request
 *   User plan "Demo Shared" (Alice, Bob): 40 units/month, 20 per request
 *   Carol: predefined Premium            (5,000 units/month, 100 per request)
 *
 * Every step states what it expects and checks it against the API response.
 */

export interface ScenarioStep {
  title: string;
  explanation: string;
  expected: string;
  actual: string;
  passed: boolean;
  result?: ConsumeResult;
}

export interface ScenarioOutcome {
  accountName: string;
  apiKey: string;
  steps: ScenarioStep[];
  passed: boolean;
}

export async function runDemoScenario(
  client: QuotaFlowClient,
  onStep: (step: ScenarioStep) => void = () => {},
): Promise<ScenarioOutcome> {
  const runTag = Date.now().toString(36);
  const steps: ScenarioStep[] = [];
  const record = (step: ScenarioStep) => {
    steps.push(step);
    onStep(step);
  };

  // --- Setup -------------------------------------------------------------
  const accountName = `Demo ${new Date().toISOString().slice(0, 16).replace('T', ' ')} (${runTag})`;
  const created = await client.createAccount(accountName);
  const api = client.withApiKey(created.apiKey);
  const accountPlan = await api.createPlan({ name: 'Demo Account', scope: 'account', monthlyLimit: 100, perRequestLimit: 50 });
  await api.assignAccountPlan(accountPlan.id);
  const sharedPlan = await api.createPlan({ name: 'Demo Shared', scope: 'user', monthlyLimit: 40, perRequestLimit: 20 });
  const premium = (await api.listPredefinedPlans()).data.find((plan: Plan) => plan.code === 'premium');
  if (!premium) throw new Error('Predefined Premium plan not found; is the database seeded?');
  const alice = await api.createUser('Alice', sharedPlan.id);
  const bob = await api.createUser('Bob', sharedPlan.id);
  const carol = await api.createUser('Carol', premium.id);
  record({
    title: 'Setup',
    explanation: 'Created a fresh account with deterministic custom plans and three users.',
    expected: 'Account on "Demo Account" (100/mo, 50/req); Alice & Bob share "Demo Shared" (40/mo, 20/req); Carol on Premium',
    actual: `account ${created.id.slice(0, 8)}…, users Alice, Bob, Carol`,
    passed: true,
  });

  const rid = (label: string) => `demo-${runTag}-${label}`;
  async function step(
    title: string,
    explanation: string,
    expected: string,
    action: () => Promise<ConsumeResult>,
    check: (result: ConsumeResult) => boolean,
  ): Promise<ConsumeResult> {
    const result = await action();
    const actual =
      result.decision === 'accepted'
        ? `accepted${result.replayed ? ' (replayed)' : ''}: account ${result.account.usedUnits}/${result.account.monthlyLimit}, user ${result.user.usedUnits}/${result.user.monthlyLimit}`
        : `rejected ${result.rejection?.code} at ${result.rejection?.level} level (limit ${result.rejection?.limit}, available ${result.rejection?.available ?? 'n/a'})`;
    record({ title, explanation, expected, actual, passed: check(result), result });
    return result;
  }

  // 1. Accepted request.
  const first = await step(
    '1. Accepted request',
    'Alice consumes 10 units. Both plans allow it.',
    'accepted; account 10/100, Alice 10/40',
    () => api.consume(alice.id, 10, rid('alice-10')),
    (r) => r.decision === 'accepted' && r.account.usedUnits === 10 && r.user.usedUnits === 10,
  );

  // 2. User-level rejections.
  await step(
    '2a. User per-request limit',
    'Alice asks for 25 units, but her plan allows at most 20 per request.',
    'rejected USER_PER_REQUEST_LIMIT_EXCEEDED; nothing consumed',
    () => api.consume(alice.id, 25, rid('alice-25')),
    (r) => r.rejection?.code === 'USER_PER_REQUEST_LIMIT_EXCEEDED' && r.account.usedUnits === 10,
  );
  await api.consume(alice.id, 20, rid('alice-20'));
  await step(
    '2b. User monthly limit',
    'Alice has used 30 of her 40 units; she asks for 15 more.',
    'rejected USER_MONTHLY_LIMIT_EXCEEDED with 10 available',
    () => api.consume(alice.id, 15, rid('alice-15')),
    (r) => r.rejection?.code === 'USER_MONTHLY_LIMIT_EXCEEDED' && r.rejection.available === 10,
  );

  // 3. Shared plan, independent usage (run before the account limit is hit).
  const bobResult = await step(
    '3. Shared plan, separate usage',
    'Bob is on the same "Demo Shared" plan as Alice and consumes 5 units.',
    'accepted; Bob 5/40 while Alice stays at 30/40 on the same plan',
    () => api.consume(bob.id, 5, rid('bob-5')),
    (r) => r.decision === 'accepted' && r.user.usedUnits === 5 && r.user.planId === sharedPlan.id,
  );

  // 4. Shared account limit.
  await api.consume(carol.id, 50, rid('carol-50'));
  await step(
    '4. Shared account limit',
    'Carol (Premium, thousands of units left) asks for 20, but the account has only 15 of 100 left.',
    'rejected ACCOUNT_MONTHLY_LIMIT_EXCEEDED with 15 available',
    () => api.consume(carol.id, 20, rid('carol-20-before')),
    (r) => r.rejection?.code === 'ACCOUNT_MONTHLY_LIMIT_EXCEEDED' && r.rejection.available === 15 && r.user.remaining > 1_000,
  );

  // 5. Plan update and plan switch change subsequent results.
  await api.updatePlan(accountPlan.id, { monthlyLimit: 200 });
  await step(
    '5a. Plan update',
    'The "Demo Account" plan is raised to 200 units/month. Carol retries with a new request ID.',
    'accepted; account 105/200 (usage preserved, new limit applied, plan version 2)',
    () => api.consume(carol.id, 20, rid('carol-20-after')),
    (r) => r.decision === 'accepted' && r.account.usedUnits === 105 && r.account.monthlyLimit === 200 && r.account.planVersion === 2,
  );
  await api.assignUserPlan(alice.id, premium.id);
  await step(
    '5b. Plan switch',
    'Alice moves from "Demo Shared" to Premium and repeats her 15-unit request with a new request ID.',
    'accepted; Alice keeps her 30 units and reaches 45/5000',
    () => api.consume(alice.id, 15, rid('alice-15-premium')),
    (r) => r.decision === 'accepted' && r.user.usedUnits === 45 && r.user.planId === premium.id,
  );

  // 6. Retry without double consumption.
  const accountBefore = (await api.getAccount()).usage.usedUnits;
  await step(
    '6. Idempotent retry',
    `Step 1's request ID is sent again. The service returns the original decision without consuming anything.`,
    `replayed; identical decision id; account usage stays at ${accountBefore}`,
    () => api.consume(alice.id, 10, rid('alice-10')),
    (r) => r.replayed && r.id === first.id && r.account.usedUnits === first.account.usedUnits,
  );
  const accountAfter = (await api.getAccount()).usage.usedUnits;
  record({
    title: 'Final check',
    explanation: 'Account usage is the sum of every accepted request, and the retry added nothing.',
    expected: `account usage ${accountBefore} before and after the retry; Bob still at ${bobResult.user.usedUnits}`,
    actual: `account usage ${accountAfter}; Bob at ${(await api.getUser(bob.id)).usage.usedUnits}`,
    passed: accountAfter === accountBefore && accountAfter === 120,
  });

  return { accountName, apiKey: created.apiKey, steps, passed: steps.every((s) => s.passed) };
}
