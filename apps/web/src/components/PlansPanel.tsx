import { useState } from 'react';
import type { Plan, Scope } from '../types';

interface PlansPanelProps {
  plans: Plan[];
  onCreatePlan: (input: { name: string; scope: Scope; monthlyLimit: number; perRequestLimit: number }) => Promise<void>;
  onUpdatePlan: (planId: string, input: { monthlyLimit: number; perRequestLimit: number }) => Promise<void>;
  busy: boolean;
}

export function PlansPanel({ plans, onCreatePlan, onUpdatePlan, busy }: PlansPanelProps) {
  const [form, setForm] = useState({ name: '', scope: 'user' as Scope, monthlyLimit: '100', perRequestLimit: '10' });
  return (
    <section className="card">
      <h2>Plans</h2>
      <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Scope</th>
            <th>Monthly</th>
            <th>Per request</th>
            <th>Version</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {plans.map((plan) =>
            plan.kind === 'custom' ? (
              <EditablePlanRow key={`${plan.id}-${plan.version}`} plan={plan} onSave={onUpdatePlan} busy={busy} />
            ) : (
              <tr key={plan.id} className="muted">
                <td>
                  {plan.name} <span className="badge">predefined</span>
                </td>
                <td>{plan.scope}</td>
                <td>{plan.monthlyLimit.toLocaleString()}</td>
                <td>{plan.perRequestLimit.toLocaleString()}</td>
                <td>v{plan.version}</td>
                <td className="small">read-only</td>
              </tr>
            ),
          )}
        </tbody>
      </table>
      </div>
      <form
        className="row"
        onSubmit={(event) => {
          event.preventDefault();
          void onCreatePlan({
            name: form.name,
            scope: form.scope,
            monthlyLimit: Number(form.monthlyLimit),
            perRequestLimit: Number(form.perRequestLimit),
          }).then(() => setForm((f) => ({ ...f, name: '' })));
        }}
      >
        <input placeholder="Custom plan name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
        <select value={form.scope} onChange={(e) => setForm({ ...form, scope: e.target.value as Scope })}>
          <option value="user">user plan</option>
          <option value="account">account plan</option>
        </select>
        <input type="number" title="Monthly limit" value={form.monthlyLimit} onChange={(e) => setForm({ ...form, monthlyLimit: e.target.value })} />
        <input type="number" title="Per-request limit" value={form.perRequestLimit} onChange={(e) => setForm({ ...form, perRequestLimit: e.target.value })} />
        <button disabled={busy}>Create plan</button>
      </form>
    </section>
  );
}

function EditablePlanRow({ plan, onSave, busy }: { plan: Plan; onSave: PlansPanelProps['onUpdatePlan']; busy: boolean }) {
  const [monthly, setMonthly] = useState(String(plan.monthlyLimit));
  const [perRequest, setPerRequest] = useState(String(plan.perRequestLimit));
  const dirty = monthly !== String(plan.monthlyLimit) || perRequest !== String(plan.perRequestLimit);
  return (
    <tr>
      <td>
        {plan.name} <span className="badge badge-info">custom</span>
      </td>
      <td>{plan.scope}</td>
      <td>
        <input type="number" className="narrow" value={monthly} onChange={(e) => setMonthly(e.target.value)} />
      </td>
      <td>
        <input type="number" className="narrow" value={perRequest} onChange={(e) => setPerRequest(e.target.value)} />
      </td>
      <td>v{plan.version}</td>
      <td>
        <button
          disabled={busy || !dirty}
          onClick={() => void onSave(plan.id, { monthlyLimit: Number(monthly), perRequestLimit: Number(perRequest) })}
        >
          Save
        </button>
      </td>
    </tr>
  );
}
