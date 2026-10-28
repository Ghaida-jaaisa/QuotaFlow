import { useState } from 'react';
import type { Plan } from '../types';

interface SetupPanelProps {
  predefinedPlans: Plan[];
  adminToken: string;
  onAdminTokenChange: (token: string) => void;
  onCreateAccount: (name: string, planId: string) => Promise<void>;
  onUseKey: (apiKey: string) => void;
  onRunScenario: () => Promise<void>;
  busy: boolean;
}

export function SetupPanel(props: SetupPanelProps) {
  const accountPlans = props.predefinedPlans.filter((plan) => plan.scope === 'account');
  const [name, setName] = useState('My Company');
  const [planId, setPlanId] = useState('');
  const [key, setKey] = useState('');

  return (
    <section className="card">
      <h2>Get started</h2>
      <p className="muted">
        Run the scripted demo, create an account (its API key is shown once and kept in this browser), or paste an existing
        API key.
      </p>
      <div className="setup-grid">
        <div>
          <h3>Guided demo</h3>
          <p className="muted small">Creates a fresh account with deterministic plans and walks through every rule.</p>
          <button className="primary" disabled={props.busy} onClick={() => void props.onRunScenario()}>
            Run demo scenario
          </button>
        </div>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void props.onCreateAccount(name, planId);
          }}
        >
          <h3>Create account</h3>
          <label>
            Name
            <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={100} />
          </label>
          <label>
            Account plan
            <select value={planId} onChange={(e) => setPlanId(e.target.value)}>
              <option value="">Default (Starter)</option>
              {accountPlans.map((plan) => (
                <option key={plan.id} value={plan.id}>
                  {plan.name}: {plan.monthlyLimit.toLocaleString()}/mo, {plan.perRequestLimit}/req
                </option>
              ))}
            </select>
          </label>
          <button disabled={props.busy}>Create account</button>
        </form>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            props.onUseKey(key.trim());
          }}
        >
          <h3>Use an API key</h3>
          <label>
            X-API-Key
            <input value={key} onChange={(e) => setKey(e.target.value)} placeholder="qf_…" required />
          </label>
          <button disabled={props.busy}>Connect</button>
        </form>
      </div>
      <details className="small">
        <summary>Admin token (only if the API has ADMIN_TOKEN set)</summary>
        <label>
          X-Admin-Token
          <input
            type="password"
            value={props.adminToken}
            onChange={(e) => props.onAdminTokenChange(e.target.value)}
            placeholder="leave empty for open provisioning"
          />
        </label>
      </details>
    </section>
  );
}
