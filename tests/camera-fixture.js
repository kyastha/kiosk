import { expect } from '@playwright/test';

// Feed real QR pixels through a video stream so the browser runs its QR decoder.
export async function installCamera(context) {
  await context.addInitScript(() => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 640;
    const drawing = canvas.getContext('2d');
    const camera = {
      requests: [],
      streams: [],
      denied: false,
      supportsVideo: typeof canvas.captureStream === 'function',
      async show(source) {
        drawing.fillStyle = 'white';
        drawing.fillRect(0, 0, canvas.width, canvas.height);
        if (source) {
          const image = new Image();
          image.src = source;
          await image.decode();
          drawing.drawImage(image, 64, 64, 512, 512);
        }
      },
    };
    camera.show();
    setInterval(() => drawing.fillRect(0, 0, 1, 1), 100);
    window.__kioskCamera = camera;
    // Windows WebKit treats the loopback test URL as insecure; emulate HTTPS camera access.
    Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true });
    Object.defineProperty(window, 'BarcodeDetector', { configurable: true, value: undefined });
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: async constraints => {
          camera.requests.push(constraints);
          if (camera.denied) throw new DOMException('Camera permission denied', 'NotAllowedError');
          if (!camera.supportsVideo) throw new Error('This test engine cannot generate a camera stream. Paste the QR link below.');
          const stream = canvas.captureStream(10);
          camera.streams.push(stream);
          return stream;
        },
      },
    });
  });
}

export async function showCameraQr(page, buffer) {
  const source = buffer ? 'data:image/png;base64,' + buffer.toString('base64') : null;
  await page.evaluate(source => window.__kioskCamera.show(source), source);
}

export async function startPaymentScanner(page) {
  await page.getByRole('button', { name: 'Continue to pay' }).click();
  await expect(page).toHaveURL(/\/scan\?session=/);
  await expect(page.getByRole('heading', { name: 'Scan kiosk payment QR' })).toBeVisible();
  const live = await page.evaluate(() => window.__kioskCamera.supportsVideo);
  if (live) await expect(page.getByRole('button', { name: 'Stop camera' })).toBeVisible();
  else await expect(page.getByRole('alert')).toContainText('cannot generate a camera stream');
  await expect(page.getByLabel('Test PIN')).toHaveCount(0);
  expect(await page.evaluate(() => window.__kioskCamera.requests[0])).toEqual({
    audio: false, video: { facingMode: { ideal: 'environment' } },
  });
  return live;
}
