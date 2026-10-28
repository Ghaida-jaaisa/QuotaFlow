import { useCallback, useEffect, useMemo, useState } from 'react';
import { describeError, QuotaFlowClient } from './api';
import { AccountPanel } from './components/AccountPanel';
import { ConsumePanel } from './components/ConsumePanel';
import { HistoryPanel } from './components/HistoryPanel';
import { PlansPanel } from './components/PlansPanel';
import { ScenarioPanel } from './components/ScenarioPanel';
import { SetupPanel } from './components/SetupPanel';
import { UsersPanel } from './components/UsersPanel';
import { runDemoScenario, type ScenarioStep } from './demo/scenario';
import { readStored, writeStored } from './storage';
import type { Account, Decision, Plan, User } from './types';

const API_BASE = '/api';
const KEY_STORAGE = 'quotaflow.apiKey';

interface AccountData {
  account: Account;
  users: User[];
  plans: Plan[];
  history: Decision[];
  historyCursor: string | null;
}

export function App() {
  const [apiKey, setApiKey] = useState(() => readStored(KEY_STORAGE));
  const [adminToken, setAdminToken] = useState('');
  const [predefined, setPredefined] = useState<Plan[]>([]);
  const [data, setData] = useState<AccountData>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [scenario, setScenario] = useState<{ steps: ScenarioStep[]; running: boolean }>();

  const publicClient = useMemo(() => new QuotaFlowClient(API_BASE, undefined, adminToken || undefined), [adminToken]);
  const client = useMemo(() => (apiKey ? publicClient.withApiKey(apiKey) : undefined), [publicClient, apiKey]);

  const connect = useCallback((key: string) => {
    writeStored(KEY_STORAGE, key);
    setApiKey(key);
  }, []);

  // Everything shown comes from the API; this reloads it after each change.
  const refresh = useCallback(async () => {
    if (!client) return;
    const [account, users, plans, history] = await Promise.all([
      client.getAccount(),
      client.listUsers(),
      client.listPlans(),
      client.listRequests({ limit: 15 }),
    ]);
    setData({ account, users: users.data, plans: plans.data, history: history.data, historyCursor: history.nextCursor });
  }, [client]);

  /** Runs an API action, surfaces errors, and refreshes the view. */
  const run = useCallback(
    async <T,>(action: () => Promise<T>, success?: string): Promise<T | undefined> => {
      setBusy(true);
      setError(undefined);
      setNotice(undefined);
      try {
        const result = await action();
        if (success) setNotice(success);
        await refresh();
        return result;
      } catch (caught) {
        setError(describeError(caught));
        return undefined;
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  useEffect(() => {
    publicClient
      .listPredefinedPlans()
      .then((plans) => setPredefined(plans.data))
      .catch((caught: unknown) => setError(`API unreachable: ${describeError(caught)}`));
  }, [publicClient]);

  useEffect(() => {
    if (!client) {
      setData(undefined);
      return;
    }
    refresh().catch((caught: unknown) => {
      setError(describeError(caught));
      // A rejected stored key should not trap the user on an empty screen.
      writeStored(KEY_STORAGE, '');
      setApiKey('');
    });
  }, [client, refresh]);

  async function createAccount(name: string, planId: string) {
    await run(async () => {
      const created = await publicClient.createAccount(name, planId || undefined);
      setNotice(`Account created. API key (shown only once, saved in this browser): ${created.apiKey}`);
      connect(created.apiKey);
    });
  }

  async function runScenario() {
    setScenario({ steps: [], running: true });
    setError(undefined);
    setBusy(true);
    try {
      const outcome = await runDemoScenario(publicClient, (step) =>
        setScenario((current) => ({ running: true, steps: [...(current?.steps ?? []), step] })),
      );
      connect(outcome.apiKey);
      setNotice(`Connected to demo account "${outcome.accountName}". Explore it below or keep experimenting.`);
    } catch (caught) {
      setError(`Demo failed: ${describeError(caught)}`);
    } finally {
      setScenario((current) => ({ steps: current?.steps ?? [], running: false }));
      setBusy(false);
    }
  }

  async function loadMoreHistory() {
    if (!client || !data?.historyCursor) return;
    const page = await client.listRequests({ limit: 15, cursor: data.historyCursor }).catch((caught: unknown) => {
      setError(describeError(caught));
      return undefined;
    });
    if (page) {
      setData({ ...data, history: [...data.history, ...page.data], historyCursor: page.nextCursor });
    }
  }

  return (
    <div className="layout">
      <header>
        <h1>QuotaFlow</h1>
        <p className="muted">Usage metering &amp; quota console, backed by the live API and PostgreSQL.</p>
      </header>
      {error && (
        <div className="alert alert-error" role="alert">
          {error}
        </div>
      )}
      {notice && <div className="alert alert-info">{notice}</div>}

      {scenario && <ScenarioPanel steps={scenario.steps} running={scenario.running} onClose={() => setScenario(undefined)} />}

      {!data || !client ? (
        <SetupPanel
          predefinedPlans={predefined}
          adminToken={adminToken}
          onAdminTokenChange={setAdminToken}
          onCreateAccount={createAccount}
          onUseKey={connect}
          onRunScenario={runScenario}
          busy={busy}
        />
      ) : (
        <>
          <div className="toolbar">
            <button disabled={busy} onClick={() => void runScenario()}>
              Run demo scenario (new account)
            </button>
            <button disabled={busy} onClick={() => void run(refresh)}>
              Refresh
            </button>
          </div>
          <AccountPanel
            account={data.account}
            plans={data.plans}
            busy={busy}
            onAssignPlan={(planId) => run(() => client.assignAccountPlan(planId), 'Account plan updated.').then(() => undefined)}
            onDisconnect={() => connect('')}
          />
          <div className="columns">
            <ConsumePanel users={data.users} busy={busy} onConsume={(userId, units, requestId) => run(() => client.consume(userId, units, requestId))} />
            <UsersPanel
              users={data.users}
              plans={data.plans}
              busy={busy}
              onCreateUser={(name, planId) => run(() => client.createUser(name, planId || undefined), `User ${name} created.`).then(() => undefined)}
              onAssignPlan={(userId, planId) => run(() => client.assignUserPlan(userId, planId), 'User plan updated.').then(() => undefined)}
            />
          </div>
          <PlansPanel
            plans={data.plans}
            busy={busy}
            onCreatePlan={(input) => run(() => client.createPlan(input), `Plan ${input.name} created.`).then(() => undefined)}
            onUpdatePlan={(planId, input) =>
              run(() => client.updatePlan(planId, input), 'Plan updated; new limits apply to subsequent requests.').then(() => undefined)
            }
          />
          <HistoryPanel items={data.history} users={data.users} hasMore={data.historyCursor !== null} onLoadMore={loadMoreHistory} busy={busy} />
        </>
      )}
    </div>
  );
}
