import { CircleAlert, LoaderCircle, Printer, Shield, WifiOff } from 'lucide-react';

export function Brand({ schoolName = 'School Print Kiosk' }) {
  return (
    <a href="/" className="brand" aria-label="School Print Kiosk home">
      <span className="brand-mark">
        <Printer size={22} aria-hidden="true" />
      </span>
      <span className="brand-text">
        <strong>School Print Kiosk</strong>
        <small>{schoolName}</small>
      </span>
    </a>
  );
}

export function Header({ schoolName, children }) {
  return (
    <header className="topbar">
      <div className="topbar-inner">
        <Brand schoolName={schoolName} />
        {children}
      </div>
    </header>
  );
}

export function Footer() {
  return (
    <footer className="footer">
      <span>
        <Shield size={15} aria-hidden="true" /> Private document handling
      </span>
      <a href="/admin">Staff access</a>
    </footer>
  );
}

export function ErrorMessage({ message, children }) {
  if (!message) return null;
  return (
    <div className="notice notice-error" role="alert">
      <CircleAlert size={19} aria-hidden="true" />
      <div>
        {message}
        {children}
      </div>
    </div>
  );
}

export function OfflineNotice() {
  return (
    <div className="notice notice-warning global-notice" role="alert">
      <WifiOff size={20} aria-hidden="true" /> You’re offline. Reconnect to the school network to continue.
    </div>
  );
}

export function Loading({ children = 'Loading…' }) {
  return (
    <div className="loading" role="status">
      <LoaderCircle size={20} aria-hidden="true" />
      {children}
    </div>
  );
}

export function Details({ rows, className = '' }) {
  return (
    <dl className={'details ' + className}>
      {rows.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value ?? '—'}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Status({ value, label }) {
  const tone = ['TEST_PAID', 'COMPLETED', 'AVAILABLE', 'IDLE', 'ONLINE', 'READY'].includes(value)
    ? 'good'
    : ['FAILED', 'PAYMENT_FAILED', 'OFFLINE', 'ERROR', 'STOPPED'].includes(value)
      ? 'bad'
      : [
            'QUEUED',
            'PROCESSING',
            'SUBMITTED_TO_PRINTER',
            'RETRY_PENDING',
            'PENDING',
            'PENDING_PAYMENT',
          ].includes(value)
        ? 'waiting'
        : 'neutral';
  return <span className={'status status-' + tone}>{label || value || 'Unknown'}</span>;
}
