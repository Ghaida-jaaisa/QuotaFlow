import type { Account, Plan } from '../types';
import { UsageBar } from './UsageBar';

interface AccountPanelProps {
  account: Account;
  plans: Plan[];
  onAssignPlan: (planId: string) => Promise<void>;
  onDisconnect: () => void;
  busy: boolean;
}

export function AccountPanel({ account, plans, onAssignPlan, onDisconnect, busy }: AccountPanelProps) {
  const accountPlans = plans.filter((plan) => plan.scope === 'account');
  return (
    <section className="card">
      <div className="card-head">
        <h2>{account.name}</h2>
        <button className="link" onClick={onDisconnect}>
          Disconnect
        </button>
      </div>
      <p className="muted small">
        Account <code>{account.id}</code> · key <code>{account.apiKeyPrefix}…</code> · month {account.usage.month} (UTC)
      </p>
      <UsageBar label="Shared account allowance" used={account.usage.usedUnits} limit={account.usage.monthlyLimit} />
      <p className="small">
        Plan <strong>{account.plan.name}</strong> ({account.plan.kind}, v{account.plan.version}):{' '}
        {account.plan.monthlyLimit.toLocaleString()} units/month, {account.plan.perRequestLimit.toLocaleString()} per request
      </p>
      <label className="inline">
        Switch account plan
        <select value={account.plan.id} disabled={busy} onChange={(e) => void onAssignPlan(e.target.value)}>
          {accountPlans.map((plan) => (
            <option key={plan.id} value={plan.id}>
              {plan.name} ({plan.kind}): {plan.monthlyLimit.toLocaleString()}/mo, {plan.perRequestLimit}/req
            </option>
          ))}
        </select>
      </label>
    </section>
  );
}
