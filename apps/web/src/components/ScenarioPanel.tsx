import type { ScenarioStep } from '../demo/scenario';

export function ScenarioPanel({ steps, running, onClose }: { steps: ScenarioStep[]; running: boolean; onClose: () => void }) {
  const passed = steps.filter((step) => step.passed).length;
  return (
    <section className="card">
      <div className="card-head">
        <h2>Demo scenario {running ? '(running…)' : `· ${passed}/${steps.length} checks passed`}</h2>
        {!running && (
          <button className="link" onClick={onClose}>
            Hide
          </button>
        )}
      </div>
      <ol className="steps">
        {steps.map((step) => (
          <li key={step.title} className={step.passed ? 'step-pass' : 'step-fail'}>
            <div className="card-head">
              <strong>{step.title}</strong>
              <span className={`badge ${step.passed ? 'badge-ok' : 'badge-bad'}`}>{step.passed ? 'PASS' : 'FAIL'}</span>
            </div>
            <p className="small">{step.explanation}</p>
            <p className="small">
              <span className="muted">Expected:</span> {step.expected}
              <br />
              <span className="muted">Actual:</span> {step.actual}
            </p>
          </li>
        ))}
      </ol>
    </section>
  );
}
