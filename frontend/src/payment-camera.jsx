import { useEffect, useRef, useState } from 'react';
import { Camera } from 'lucide-react';
import { api, localLink } from './api.js';
import { decodeFrame, decodePaymentUrl } from './payment-scan.js';
import { ErrorMessage } from './ui.jsx';

async function readPhoto(file) {
  if (typeof createImageBitmap === 'function') {
    try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); }
    catch { /* Use the device's other image decoder for supported camera formats. */ }
  }
  const source = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('The camera photo could not be read. Please retake it.'));
    reader.readAsDataURL(file);
  });
  const image = new Image();
  image.src = source;
  await image.decode();
  return image;
}

export default function PaymentCamera({ sessionId, paymentOrigin, online, onVerified }) {
  const input = useRef(null);
  const attempt = useRef(0);
  const request = useRef(null);
  const [selecting, setSelecting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const cancel = () => setSelecting(false);
    const element = input.current;
    element.addEventListener('cancel', cancel);
    window.addEventListener('focus', cancel);
    return () => {
      attempt.current += 1;
      request.current?.abort();
      element.removeEventListener('cancel', cancel);
      window.removeEventListener('focus', cancel);
    };
  }, [sessionId]);

  useEffect(() => {
    if (online) return;
    attempt.current += 1;
    request.current?.abort();
    setSelecting(false);
    setBusy(false);
  }, [online]);

  function openCamera() {
    if (busy || selecting || !online) return;
    attempt.current += 1;
    request.current?.abort();
    setError('');
    input.current.value = '';
    setSelecting(true);
    try {
      // Native capture must be requested directly within the button's user gesture.
      input.current.click();
    } catch {
      setSelecting(false);
      setError('The camera could not open. Try the live scanner below.');
    }
  }

  async function capture(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    setSelecting(false);
    if (!file) return;
    const current = ++attempt.current;
    setBusy(true);
    setError('');
    let photo;
    try {
      if (!file.type.startsWith('image/') || file.type === 'image/svg+xml' || file.size > 20 * 1024 * 1024) {
        throw new Error('Take a camera photo or choose an image up to 20 MB.');
      }
      try { photo = await readPhoto(file); }
      catch { throw new Error('This photo format could not be read. Retake the QR as a JPEG or PNG.'); }
      if (attempt.current !== current) return;
      const width = photo.width || photo.naturalWidth;
      const height = photo.height || photo.naturalHeight;
      if (!width || !height || width * height > 60_000_000) {
        throw new Error('Use a smaller photo focused on the payment QR.');
      }
      const scale = Math.min(1, 1280 / Math.max(width, height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(height * scale));
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) throw new Error('The photo could not be processed. Try the live scanner below.');
      context.drawImage(photo, 0, 0, canvas.width, canvas.height);
      const decoded = decodeFrame(context.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height);
      if (!decoded) throw new Error('No payment QR was found. Retake a clear photo with the full code visible.');
      const { reference } = decodePaymentUrl(decoded, paymentOrigin);
      const controller = new AbortController();
      request.current = controller;
      const result = await api('/api/kiosk/scan-payment', {
        method: 'POST', body: { sessionId, reference }, signal: controller.signal,
      });
      if (attempt.current !== current) return;
      const destination = new URL(localLink(result.paymentUrl));
      destination.searchParams.set('session', sessionId);
      onVerified?.();
      window.location.assign(destination.href);
    } catch (problem) {
      if (attempt.current === current && problem.name !== 'AbortError') setError(problem.message);
    } finally {
      photo?.close?.();
      if (attempt.current === current) {
        request.current = null;
        setBusy(false);
      }
    }
  }

  return (
    <div className="native-payment-camera">
      <input ref={input} type="file" accept="image/*" capture="environment" aria-label="Capture payment QR"
        className="visually-hidden" tabIndex={-1} onChange={capture} />
      <button type="button" className="button primary full" onClick={openCamera} disabled={!online || busy || selecting}>
        <Camera size={19} aria-hidden="true" />
        {busy ? 'Checking payment QR…' : selecting ? 'Opening camera…' : 'Continue to pay'}
      </button>
      <p className="price-note">Take a photo of the payment QR on the kiosk screen to continue.</p>
      <ErrorMessage message={error} />
      <a className="text-button" href={'/scan?session=' + encodeURIComponent(sessionId)}>Use live scanner</a>
    </div>
  );
}
