import { Check, CircleX, Maximize, Minimize, Printer, QrCode, Smartphone } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api, TEST_LABEL } from './api.js';
import { useLiveSnapshot } from './live.js';
import './kiosk.css';

const confirmationMs = 3000;
const displayStates = {
  idle: ['Ready to scan', 'Start a print order from your phone.', QrCode],
  pending: ['Checkout in progress', 'Review your cart and open test payment on your phone.', Smartphone],
  paid: ['Test payment accepted', 'Your job is in the print queue. Track it on your phone.', Check],
  failed: ['Test payment ended', 'Scan again to start a new print order.', CircleX],
};

function useDisplayPhase(order) {
  const [dismissed, setDismissed] = useState(null);
  const id = order?.id;
  const payment = order?.paymentStatus;
  const updatedAt = order?.updatedAt;
  const terminal = payment === 'TEST_PAID' || payment === 'FAILED';
  useEffect(() => {
    if (!id || !terminal || dismissed === id) return;
    const delay = Math.max(0, confirmationMs - (Date.now() - Date.parse(updatedAt)));
    const timer = setTimeout(() => setDismissed(id), Math.min(delay, confirmationMs));
    return () => clearTimeout(timer);
  }, [id, terminal, updatedAt, dismissed]);

  if (!id || dismissed === id) return 'idle';
  if (payment === 'PENDING') return 'pending';
  if (terminal && Date.now() - Date.parse(updatedAt) < confirmationMs) {
    return payment === 'TEST_PAID' ? 'paid' : 'failed';
  }
  return 'idle';
}

export default function Kiosk({ online }) {
  const { connected, value } = useLiveSnapshot('/ws/kiosk', online);
  const [config, setConfig] = useState(null);
  const [fullscreen, setFullscreen] = useState(Boolean(document.fullscreenElement));
  const [fullscreenError, setFullscreenError] = useState(false);
  const [qrError, setQrError] = useState(false);
  const display = useRef(null);
  const phase = useDisplayPhase(connected ? value?.order : null);
  const [title, description, Icon] = displayStates[phase];

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
          <p className="kiosk-eyebrow">01 / SCAN TO START</p>
          <h1>Print from<br /> your phone.</h1>
          <p className="kiosk-lede">Scan the QR code, add your files, then review and test pay on your phone.</p>
          <div className="kiosk-status" data-phase={phase} aria-live="polite">
            <div className="kiosk-status-inner" key={phase}>
              <span className="kiosk-status-icon"><Icon size={21} aria-hidden="true" /></span>
              <div><h2>{title}</h2><p>{description}</p></div>
            </div>
          </div>
        </section>
        <section className="kiosk-qr-card" aria-label="Permanent kiosk access QR">
          <div className="kiosk-qr-tag"><Smartphone size={15} aria-hidden="true" /> Open your camera</div>
          <img
            src="/api/kiosk/qr"
            width="360"
            height="360"
            alt="Scan this QR code to start printing"
            onError={() => setQrError(true)}
            onLoad={() => setQrError(false)}
          />
          {qrError ? <p role="status">The QR could not load. Refresh to try again.</p> : <p>Point your camera at the code</p>}
          {config?.onboardingUrl && <small>{new URL(config.onboardingUrl).host}</small>}
        </section>
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
