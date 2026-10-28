import { useEffect, useState } from 'react';
import type { ConsumeResult, User } from '../types';
import { DecisionCard } from './DecisionCard';

const newRequestId = () => `ui-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

interface ConsumePanelProps {
  users: User[];
  onConsume: (userId: string, units: number, requestId: string) => Promise<ConsumeResult | undefined>;
  busy: boolean;
}

export function ConsumePanel({ users, onConsume, busy }: ConsumePanelProps) {
  const [userId, setUserId] = useState('');
  const [units, setUnits] = useState('10');
  const [requestId, setRequestId] = useState(newRequestId);
  const [last, setLast] = useState<ConsumeResult>();

  useEffect(() => {
    if (!users.some((user) => user.id === userId)) setUserId(users[0]?.id ?? '');
  }, [users, userId]);

  return (
    <section className="card">
      <h2>Simulate an action</h2>
      <form
        className="consume-form"
        onSubmit={(event) => {
          event.preventDefault();
          // Units go to the API exactly as typed so its validation is visible too.
          void onConsume(userId, Number(units), requestId).then((result) => {
            if (result) setLast(result);
          });
        }}
      >
        <label>
          User
          <select value={userId} onChange={(e) => setUserId(e.target.value)} required>
            {users.map((user) => (
              <option key={user.id} value={user.id}>
                {user.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Units
          <input type="number" value={units} onChange={(e) => setUnits(e.target.value)} step="any" required />
        </label>
        <label className="grow">
          Request ID <span className="muted small">(keep it to retry; new ID = new operation)</span>
          <div className="row">
            <input value={requestId} onChange={(e) => setRequestId(e.target.value)} required />
            <button type="button" onClick={() => setRequestId(newRequestId())}>
              New ID
            </button>
          </div>
        </label>
        <button className="primary" disabled={busy || !userId}>
          Consume
        </button>
      </form>
      {last && <DecisionCard result={last} />}
    </section>
  );
}
