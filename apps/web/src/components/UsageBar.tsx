interface UsageBarProps {
  used: number;
  limit: number;
  label?: string;
}

/** Usage against a monthly limit; turns amber near and red at the limit. */
export function UsageBar({ used, limit, label }: UsageBarProps) {
  const ratio = limit > 0 ? Math.min(1, used / limit) : 1;
  const tone = ratio >= 1 ? 'full' : ratio >= 0.8 ? 'warn' : 'ok';
  const remaining = Math.max(0, limit - used);
  return (
    <div className="usage">
      <div className="usage-text">
        {label && <span className="usage-label">{label}</span>}
        <span>
          <strong>{used.toLocaleString()}</strong> / {limit.toLocaleString()} used · {remaining.toLocaleString()} left
        </span>
      </div>
      <div className="usage-track" role="progressbar" aria-valuenow={used} aria-valuemax={limit} aria-valuemin={0}>
        <div className={`usage-fill usage-${tone}`} style={{ width: `${ratio * 100}%` }} />
      </div>
    </div>
  );
}
