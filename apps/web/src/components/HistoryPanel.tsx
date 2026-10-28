import type { Decision, User } from '../types';

interface HistoryPanelProps {
  items: Decision[];
  users: User[];
  hasMore: boolean;
  onLoadMore: () => Promise<void>;
  busy: boolean;
}

export function HistoryPanel({ items, users, hasMore, onLoadMore, busy }: HistoryPanelProps) {
  const nameOf = (userId: string) => users.find((user) => user.id === userId)?.name ?? userId.slice(0, 8);
  return (
    <section className="card">
      <h2>Request history</h2>
      {items.length === 0 ? (
        <p className="muted">No requests yet.</p>
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Time (UTC)</th>
                <th>User</th>
                <th>Units</th>
                <th>Decision</th>
                <th>Account after</th>
                <th>User after</th>
                <th>Request ID</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id}>
                  <td className="small">{item.processedAt.replace('T', ' ').slice(0, 19)}</td>
                  <td>{nameOf(item.userId)}</td>
                  <td>{item.units}</td>
                  <td>
                    <span className={`badge ${item.decision === 'accepted' ? 'badge-ok' : 'badge-bad'}`}>{item.decision}</span>
                    {item.rejection && <div className="small">{item.rejection.code}</div>}
                  </td>
                  <td className="small">
                    {item.account.usedUnits}/{item.account.monthlyLimit} (v{item.account.planVersion})
                  </td>
                  <td className="small">
                    {item.user.usedUnits}/{item.user.monthlyLimit} (v{item.user.planVersion})
                  </td>
                  <td>
                    <code className="small">{item.requestId}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {hasMore && (
        <button disabled={busy} onClick={() => void onLoadMore()}>
          Load older
        </button>
      )}
    </section>
  );
}
