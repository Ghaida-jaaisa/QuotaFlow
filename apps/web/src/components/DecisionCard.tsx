import type { ConsumeResult } from '../types';

export function DecisionCard({ result }: { result: ConsumeResult }) {
  const accepted = result.decision === 'accepted';
  return (
    <div className={`decision ${accepted ? 'decision-accepted' : 'decision-rejected'}`}>
      <div className="decision-head">
        <span className={`badge ${accepted ? 'badge-ok' : 'badge-bad'}`}>{result.decision.toUpperCase()}</span>
        {result.replayed && <span className="badge badge-info">REPLAYED · nothing consumed</span>}
        <code>{result.requestId}</code>
      </div>
      {result.rejection && (
        <p className="decision-reason">
          <code>{result.rejection.code}</code> at <strong>{result.rejection.level}</strong> level: {result.rejection.message}{' '}
          (limit {result.rejection.limit.toLocaleString()}
          {result.rejection.available !== null && `, available ${result.rejection.available.toLocaleString()}`})
        </p>
      )}
      <dl className="decision-grid">
        <dt>Units</dt>
        <dd>
          {result.unitsAccepted} of {result.units} accepted
        </dd>
        <dt>Account</dt>
        <dd>
          {result.account.usedUnits.toLocaleString()} / {result.account.monthlyLimit.toLocaleString()} · {result.account.remaining.toLocaleString()} left ·
          max {result.account.perRequestLimit}/req · plan v{result.account.planVersion}
        </dd>
        <dt>User</dt>
        <dd>
          {result.user.usedUnits.toLocaleString()} / {result.user.monthlyLimit.toLocaleString()} · {result.user.remaining.toLocaleString()} left ·
          max {result.user.perRequestLimit}/req · plan v{result.user.planVersion}
        </dd>
        <dt>Month</dt>
        <dd>{result.month} (UTC)</dd>
      </dl>
    </div>
  );
}
