import { useState } from 'react';
import type { Plan, User } from '../types';
import { UsageBar } from './UsageBar';

interface UsersPanelProps {
  users: User[];
  plans: Plan[];
  onCreateUser: (name: string, planId: string) => Promise<void>;
  onAssignPlan: (userId: string, planId: string) => Promise<void>;
  busy: boolean;
}

export function UsersPanel({ users, plans, onCreateUser, onAssignPlan, busy }: UsersPanelProps) {
  const userPlans = plans.filter((plan) => plan.scope === 'user');
  const [name, setName] = useState('');
  const [planId, setPlanId] = useState('');
  return (
    <section className="card">
      <h2>Users</h2>
      {users.length === 0 && <p className="muted">No users yet.</p>}
      <ul className="user-list">
        {users.map((user) => (
          <li key={user.id}>
            <div className="card-head">
              <strong>{user.name}</strong>
              <select value={user.plan.id} disabled={busy} onChange={(e) => void onAssignPlan(user.id, e.target.value)}>
                {userPlans.map((plan) => (
                  <option key={plan.id} value={plan.id}>
                    {plan.name}: {plan.monthlyLimit.toLocaleString()}/mo, {plan.perRequestLimit}/req
                  </option>
                ))}
              </select>
            </div>
            <UsageBar used={user.usage.usedUnits} limit={user.usage.monthlyLimit} />
            <p className="muted small">
              <code>{user.id}</code> · max {user.plan.perRequestLimit}/request
            </p>
          </li>
        ))}
      </ul>
      <form
        className="row"
        onSubmit={(event) => {
          event.preventDefault();
          void onCreateUser(name, planId).then(() => setName(''));
        }}
      >
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="New user name" required maxLength={100} />
        <select value={planId} onChange={(e) => setPlanId(e.target.value)}>
          <option value="">Default (Basic)</option>
          {userPlans.map((plan) => (
            <option key={plan.id} value={plan.id}>
              {plan.name}
            </option>
          ))}
        </select>
        <button disabled={busy}>Add user</button>
      </form>
    </section>
  );
}
