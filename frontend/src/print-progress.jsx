import './print-progress.css';

const steps = ['Paid', 'Queued', 'Preparing', 'Sent', 'Complete'];
const stages = {
  QUEUED: 1,
  PROCESSING: 2,
  SUBMITTED_TO_PRINTER: 3,
  COMPLETION_UNCONFIRMED: 3,
  COMPLETED: 4,
};

export function PrintProgress({ status }) {
  const stage = stages[status];
  if (stage === undefined) return null;
  return (
    <ol className="print-progress" aria-label="Print progress">
      {steps.map((label, index) => (
        <li key={label} data-reached={index <= stage} aria-current={index === stage ? 'step' : undefined}>
          <span className="print-progress-dot" aria-hidden="true" />
          <span>{label}</span>
        </li>
      ))}
    </ol>
  );
}
