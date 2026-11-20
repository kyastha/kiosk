import { useEffect, useRef, useState } from 'react';
import { api, localLink } from './api.js';
import { decodePaymentUrl } from './payment-scan.js';
import { ErrorMessage, Header } from './ui.jsx';
import './scanner.css';

export default function Scanner({ online }) {
  const sessionId = new URLSearchParams(window.location.search).get('session');
  const [config, setConfig] = useState(null);
  const [error, setError] = useState('');
  const [running, setRunning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [value, setValue] = useState('');
  const video = useRef(null);
  const stream = useRef(null);
  const generation = useRef(0);
  const timer = useRef(null);
  const active = useRef(true);
  let returnUrl = '/';
  try {
    const record = JSON.parse(sessionStorage.getItem('kiosk-reviewed-order'));
    const candidate = new URL(record.statusUrl, window.location.origin);
    if (record.sessionId === sessionId && candidate.origin === window.location.origin && candidate.pathname === '/orders/' + record.orderId) returnUrl = candidate.href;
  } catch { /* A new checkout is available if there is no stored review. */ }

  function stop() {
    generation.current += 1;
    clearTimeout(timer.current);
    stream.current?.getTracks().forEach(track => track.stop());
    stream.current = null;
    if (video.current) video.current.srcObject = null;
    setRunning(false);
  }

  useEffect(() => {
    const controller = new AbortController();
    api('/api/config', { signal: controller.signal }).then(setConfig).catch(problem => {
      if (problem.name !== 'AbortError') setError(problem.message);
    });
    return () => { active.current = false; controller.abort(); stop(); };
  }, []);

  useEffect(() => { if (!online) stop(); }, [online]);

  async function openPayment(decoded) {
    if (!config || busy) return;
    stop();
    setBusy(true);
    setError('');
    try {
      const { reference } = decodePaymentUrl(decoded, new URL(config.onboardingUrl).origin);
      const result = await api('/api/kiosk/scan-payment', {
        method: 'POST', body: { sessionId, reference },
      });
      if (!active.current) return;
      const destination = new URL(localLink(result.paymentUrl));
      destination.searchParams.set('session', sessionId);
      window.location.assign(destination.href);
    } catch (problem) {
      setError(problem.message);
      setBusy(false);
    }
  }

  async function start() {
    stop();
    setError('');
    const attempt = generation.current;
    try {
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
        throw new Error('Camera access needs HTTPS and camera permission. You can paste the payment QR link below.');
      }
      if (!window.BarcodeDetector) {
        throw new Error('Camera QR scanning is unavailable in this browser. Use your phone camera to copy the payment link and paste it below.');
      }
      const detector = new window.BarcodeDetector({ formats: ['qr_code'] });
      const camera = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' } } });
      if (generation.current !== attempt) { camera.getTracks().forEach(track => track.stop()); return; }
      stream.current = camera;
      video.current.srcObject = camera;
      await video.current.play();
      setRunning(true);
      async function scan() {
        if (generation.current !== attempt) return;
        try {
          const results = await detector.detect(video.current);
          if (generation.current !== attempt) return;
          if (results[0]?.rawValue) { await openPayment(results[0].rawValue); return; }
          timer.current = setTimeout(scan, 250);
        } catch {
          if (generation.current === attempt) { stop(); setError('The camera could not read the QR. Try again or paste its link.'); }
        }
      }
      scan();
    } catch (problem) {
      if (generation.current === attempt) {
        stop();
        setError(problem.name === 'NotAllowedError' ? 'Allow camera access to scan the kiosk payment QR.' : problem.message);
      }
    }
  }

  return <>
    <Header schoolName={config?.schoolName} />
    <main className="shell focused" id="main">
      <section className="card payment-card scanner-card">
        <h1>Scan kiosk payment QR</h1>
        <p>Point your camera at the payment QR beside your total on the kiosk screen.</p>
        <video className="scanner-video" ref={video} muted playsInline aria-label="Payment QR camera preview" />
        <ErrorMessage message={error || (!sessionId && 'Open the scanner from your reviewed order.')} />
        <button className="button primary full" onClick={running ? stop : start} disabled={!config || !sessionId || busy || !online}>
          {running ? 'Stop camera' : 'Start camera'}
        </button>
        <form onSubmit={event => { event.preventDefault(); openPayment(value.trim()); }}>
          <label className="field"><span>Payment QR link</span><input type="url" value={value} onChange={event => setValue(event.target.value)} required placeholder="Paste the link read by your phone camera" /></label>
          <button className="button secondary full" disabled={!config || !sessionId || busy || !online}>{busy ? 'Checking your payment…' : 'Open scanned payment'}</button>
        </form>
        <a href={returnUrl}>Return to your order</a>
      </section>
    </main>
  </>;
}
