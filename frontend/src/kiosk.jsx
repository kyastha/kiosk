import {
  Check, CheckCheck, CircleX, ClipboardCheck, Files, Maximize, Minimize,
  Printer, QrCode, ScanLine, Settings2, Smartphone,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api, money, statusLabels, TEST_LABEL } from './api.js';
import { useLiveSnapshot } from './live.js';
import './kiosk.css';

const confirmationMs = 3000;
const displayStates = {
  idle: ['Ready to scan', 'Start a print order from your phone.', QrCode],
  SCANNED: ['Phone connected', 'Enter your name and choose files on your phone.', Smartphone],
  SELECTING: ['Choosing files', 'Add the documents you want to print.', Files],
  UPLOADING: ['Preparing your files', 'The kiosk is preparing PDF previews.', Files],
  SETTINGS: ['Choosing print settings', 'Check the preview, pages and number of copies on your phone.', Settings2],
  REVIEW: ['Reviewing the order', 'Confirm the selected pages and exact total on your phone.', ClipboardCheck],
  pending: ['Checkout in progress', 'Tap Continue to pay on your phone, then photograph this payment QR.', Smartphone],
  paid: ['Test payment accepted', 'Your job is in the print queue. Track it on your phone.', Check],
  failed: ['Test payment ended', 'Scan again to start a new print order.', CircleX],
};
const steps = [
  ['Scan', ScanLine, 'Scan the permanent access QR with your phone camera to begin.'],
  ['Files', Files, 'Enter your name and select up to eight files on your phone.'],
  ['Settings', Settings2, 'Preview each file and choose pages, copies, orientation and scaling.'],
  ['Review', ClipboardCheck, 'Check every file and the total price before continuing.'],
  ['Test payment', QrCode, 'Continue to pay opens the camera. Photograph the payment QR, then enter the demo PIN on your phone.'],
  ['Printing', Printer, 'Follow the print queue and collect your pages when the printer reports completion.'],
];
const journeyStages = { SCANNED: 0, SELECTING: 1, UPLOADING: 1, SETTINGS: 2, REVIEW: 3, pending: 4, paid: 5, failed: 4 };

function useDisplayPhase(activity, order) {
  const [dismissed, setDismissed] = useState(null);
  const id = activity?.sessionId || order?.id;
  const payment = order?.paymentStatus;
  const terminal = payment === 'TEST_PAID' || payment === 'FAILED';
  const updatedAt = order?.paymentUpdatedAt ?? order?.updatedAt;
  useEffect(() => {
    if (!id || !terminal || dismissed === id) return;
    const elapsed = Date.now() - Date.parse(updatedAt);
    const delay = Number.isFinite(elapsed) ? Math.max(0, confirmationMs - elapsed) : confirmationMs;
    const timer = setTimeout(() => setDismissed(id), Math.min(delay, confirmationMs));
    return () => clearTimeout(timer);
  }, [id, terminal, updatedAt, dismissed]);

  if (!id || dismissed === id) return 'idle';
  if (terminal) {
    if (Date.now() - Date.parse(updatedAt) >= confirmationMs) return 'idle';
    return payment === 'TEST_PAID' ? 'paid' : 'failed';
  }
  if (payment === 'PENDING') return 'pending';
  return displayStates[activity?.stage] ? activity.stage : 'idle';
}

function JourneyMap({ phase, activity, journeyKey }) {
  const [selection, setSelection] = useState(null);
  const current = journeyStages[phase] ?? 0;
  const selected = selection?.journeyKey === journeyKey ? selection.index : current;
  const [label, , detail] = steps[selected];
  const count = activity?.fileCount;

  return (
    <section className="kiosk-journey" aria-labelledby="journey-title">
      <div className="kiosk-section-title">
        <h2 id="journey-title">Your print journey</h2>
        <span>Tap a step to explore</span>
      </div>
      <ol className="kiosk-map" aria-label="Print journey">
        {steps.map(([name, Icon], index) => (
          <li key={name} data-reached={phase !== 'idle' && index < current} data-active={index === current}>
            <button
              type="button"
              aria-current={index === current ? 'step' : undefined}
              aria-pressed={selected === index}
              aria-controls="journey-detail"
              onClick={() => setSelection({ journeyKey, index })}
            >
              <span className="kiosk-map-icon"><Icon size={20} aria-hidden="true" /></span>
              <span>{name}</span>
              {phase !== 'idle' && index < current && <CheckCheck className="kiosk-step-done" size={14} aria-hidden="true" />}
            </button>
          </li>
        ))}
      </ol>
      <div id="journey-detail" className="kiosk-map-detail" role="region" aria-label="Step details">
        <strong>{label}</strong>
        <p>{detail}</p>
        {selected === 1 && count > 0 && phase !== 'idle' && (
          <small>{count} {count === 1 ? 'file selected' : 'files selected'}</small>
        )}
      </div>
    </section>
  );
}

function PaymentQr({ order }) {
  const [error, setError] = useState(false);
  return (
    <section className="kiosk-qr-card kiosk-payment-card" aria-label="Order test payment QR">
      <div className="kiosk-qr-tag"><QrCode size={15} aria-hidden="true" /> Payment for this order</div>
      <strong className="kiosk-payment-total">{money(order.total)}</strong>
      <img
        key={order.paymentQrUrl}
        src={order.paymentQrUrl}
        width="280"
        height="280"
        alt="Scan this QR code for the current test payment"
        onLoad={() => setError(false)}
        onError={() => setError(true)}
      />
      <p>{error ? 'The payment QR could not load. Refresh the kiosk screen.' : 'Photograph this QR to continue to test payment'}</p>
      <small>{TEST_LABEL}</small>
    </section>
  );
}

function PrintingStatus({ order, connected }) {
  if (!order) return null;
  return (
    <section className="kiosk-printing-status" aria-label="Latest print job" aria-live="polite">
      <span className="kiosk-status-icon"><Printer size={20} aria-hidden="true" /></span>
      <div>
        <strong>{statusLabels[order.printStatus] || 'Waiting for print status'}</strong>
        <p>{order.printStatus === 'COMPLETED' ? 'Collect your printed pages at the kiosk.' : 'Latest paid print job'}</p>
      </div>
      {!connected && <small>Reconnecting for updates</small>}
    </section>
  );
}

export default function Kiosk({ online }) {
  const { connected, value } = useLiveSnapshot('/ws/kiosk', online);
  const [config, setConfig] = useState(null);
  const [fullscreen, setFullscreen] = useState(Boolean(document.fullscreenElement));
  const [fullscreenError, setFullscreenError] = useState(false);
  const [qrError, setQrError] = useState(false);
  const display = useRef(null);
  const activity = value?.activity;
  const order = value?.order;
  const phase = useDisplayPhase(activity, order);
  const [title, description, Icon] = displayStates[phase];
  const pendingPayment = phase === 'pending' && order?.paymentQrUrl && Number.isSafeInteger(order.total);
  const journeyKey = activity?.sessionId || order?.id || 'idle';

  useEffect(() => {
    if (!online) return;
    const controller = new AbortController();
    api('/api/config', { signal: controller.signal }).then(setConfig).catch(() => {});
    return () => controller.abort();
  }, [online, connected]);

  useEffect(() => {
    const update = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', update);
    return () => document.removeEventListener('fullscreenchange', update);
  }, []);

  async function toggleFullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else if (display.current.requestFullscreen) await display.current.requestFullscreen();
      else throw new Error('Fullscreen API unavailable');
      setFullscreenError(false);
    } catch {
      setFullscreenError(true);
    }
  }

  return (
    <main className="kiosk-display" id="main" ref={display}>
      <header className="kiosk-top">
        <div className="kiosk-brand">
          <span><Printer size={23} aria-hidden="true" /></span>
          <div><strong>{config?.schoolName || 'School Printing Service'}</strong><small>Self-service printing</small></div>
        </div>
        <button type="button" className="kiosk-fullscreen" onClick={toggleFullscreen}>
          {fullscreen ? <Minimize size={18} aria-hidden="true" /> : <Maximize size={18} aria-hidden="true" />}
          {fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
        </button>
      </header>
      {fullscreenError && <p className="kiosk-fullscreen-error" role="status">Use your browser’s fullscreen command.</p>}
      <div className="kiosk-content">
        <section className="kiosk-copy">
          <p className="kiosk-eyebrow">SCAN / UPLOAD / PRINT</p>
          <h1>Print from<br /> your phone.</h1>
          <p className="kiosk-lede">Scan the access QR, then use your phone to prepare your print.</p>
          <div className="kiosk-status" data-phase={phase} aria-live="polite">
            <div className="kiosk-status-inner" key={phase}>
              <span className="kiosk-status-icon"><Icon size={21} aria-hidden="true" /></span>
              <div><h2>{title}</h2><p>{description}</p></div>
            </div>
          </div>
          <JourneyMap
            key={phase === 'idle' ? 'idle' : journeyKey}
            phase={phase}
            activity={activity}
            journeyKey={phase === 'idle' ? 'idle' : journeyKey}
          />
          <PrintingStatus order={value?.printingOrder} connected={connected} />
        </section>
        <div className="kiosk-qr-grid" data-payment={Boolean(pendingPayment)}>
          {!pendingPayment && <section className="kiosk-qr-card" aria-label="Permanent kiosk access QR">
            <div className="kiosk-qr-tag"><Smartphone size={15} aria-hidden="true" /> Start here · Access QR</div>
            <img
              src="/api/kiosk/qr"
              width="320"
              height="320"
              alt="Scan this QR code to start printing"
              onError={() => setQrError(true)}
              onLoad={() => setQrError(false)}
            />
            {qrError ? <p role="status">The QR could not load. Refresh to try again.</p> : <p>Open your phone camera to begin</p>}
            {config?.onboardingUrl && <small>{new URL(config.onboardingUrl).host}</small>}
          </section>}
          {pendingPayment && <PaymentQr key={order.id} order={order} />}
        </div>
      </div>
      <footer className="kiosk-foot">
        <span className="kiosk-connection" data-connected={connected}>
          <span aria-hidden="true" />{connected ? 'Live updates' : online ? 'Connecting to live updates' : 'Offline'}
        </span>
        <span>{TEST_LABEL}</span>
      </footer>
    </main>
  );
}
