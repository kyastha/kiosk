import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { installCamera, showCameraQr, startPaymentScanner } from './camera-fixture.js';

test.beforeEach(async ({ context }) => installCamera(context));

const warning = 'TEST PAYMENT — NO REAL MONEY TRANSFERRED';
const sample = await PDFDocument.create();
const font = await sample.embedFont(StandardFonts.Helvetica);
for (const text of ['Example print page one', 'Example print page two']) {
  sample.addPage([595, 842]).drawText(text, { font, x: 55, y: 740, size: 23 });
}
const fixture = {
  name: 'class-notes.pdf',
  mimeType: 'application/pdf',
  buffer: Buffer.from(await sample.save()),
};

async function createOrder(page, name) {
  await page.goto('/?kiosk=1');
  await expect(page.getByRole('heading', { name: 'Print from your phone.' })).toBeVisible();
  await page.getByLabel('Your name').fill(name);
  await page.getByLabel('Document file').setInputFiles(fixture);
  await page.getByRole('button', { name: 'Preview document' }).click();
  await expect(page.getByRole('img', { name: 'Preview of page 1' })).toBeVisible();
  await page.getByRole('button', { name: 'Next page' }).click();
  await expect(page.getByRole('img', { name: 'Preview of page 2' })).toBeVisible();
  await page.getByLabel('Copies', { exact: true }).fill('2');
  await page.getByLabel('Orientation').selectOption('landscape');
  await page.getByLabel('Pages to print').selectOption('custom');
  await page.getByLabel('Page range').fill('2');
  await page.getByRole('button', { name: 'Review order' }).click();
  await expect(page.getByRole('heading', { name: 'Review your order' })).toBeVisible();
  await expect(page.getByText('Landscape', { exact: true })).toBeVisible();
  await expect(page.getByText('NPR 10', { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => JSON.parse(sessionStorage.getItem('kiosk-reviewed-order'))?.statusUrl))
    .toBeTruthy();
  await page.goto(await page.evaluate(() => JSON.parse(sessionStorage.getItem('kiosk-reviewed-order')).statusUrl));
  await expect(page.getByRole('heading', { name: 'Complete test payment' })).toBeVisible();
}

async function scanPaymentQr(page) {
  const paymentQr = page.getByRole('img', { name: 'Payment QR code for this order' });
  const response = await page.request.get(await paymentQr.getAttribute('src'));
  expect(response.ok()).toBeTruthy();
  const statusUrl = new URL(page.url());
  const order = await (await page.request.get('/api' + statusUrl.pathname + statusUrl.search)).json();
  if (await startPaymentScanner(page)) {
    await showCameraQr(page, await response.body());
  } else {
    // Windows WebKit cannot synthesize video, so exercise the scanner's accessible link fallback.
    test.info().annotations.push({ type: 'camera-fixture', description: 'Video stream unavailable; verified pasted QR link fallback.' });
    await page.getByLabel('Payment QR link').fill(order.paymentUrl);
    await page.getByRole('button', { name: 'Open scanned payment' }).click();
  }
  await expect(page.getByLabel('Test PIN')).toBeVisible();
}

test('customer workflow renders the PDF, applies settings and releases a paid job', async ({
  page,
  request,
}) => {
  const kioskQr = await request.get('/api/kiosk/qr');
  expect(kioskQr.ok()).toBeTruthy();
  expect((await kioskQr.body()).subarray(1, 4).toString()).toBe('PNG');

  await createOrder(page, 'Aashna Sharma');
  const paymentQr = page.getByRole('img', { name: 'Payment QR code for this order' });
  await expect(paymentQr).toBeVisible();
  const qrPath = await paymentQr.getAttribute('src');
  expect(qrPath).not.toBe('/api/kiosk/qr');
  expect((await request.get(qrPath)).ok()).toBeTruthy();

  const statusUrl = new URL(page.url());
  const statusApi = '/api' + statusUrl.pathname + statusUrl.search;
  await scanPaymentQr(page);
  const simulator = page;
  await expect(simulator.getByText(warning, { exact: true })).toBeVisible();
  const demoPin = await simulator.getByTestId('demo-pin').innerText();
  const wrongPin = demoPin === '000000' ? '111111' : '000000';
  await simulator.getByLabel('Test PIN').fill(wrongPin);
  await simulator.getByRole('button', { name: /^Pay NPR/ }).click();
  await expect(simulator.getByRole('alert')).toContainText('demo PIN');
  await expect(simulator.getByLabel('Test PIN')).toBeVisible();
  const pendingOrder = await page.request.get(statusApi);
  expect(pendingOrder.ok()).toBeTruthy();
  expect((await pendingOrder.json()).paymentStatus).toBe('PENDING');
  await simulator.getByLabel('Test PIN').fill(demoPin);
  await simulator.getByRole('button', { name: /^Pay NPR/ }).click();
  await expect(simulator.getByRole('heading', { name: 'Test payment accepted' })).toBeVisible();
  await simulator.getByRole('link', { name: 'Track print order' }).click();

  await expect(page.getByRole('heading', { name: 'Your print order' })).toBeVisible({ timeout: 10000 });
  await expect(page.getByRole('list', { name: 'Print progress' }).locator('[aria-current="step"]')).toHaveText(
    'Queued',
  );
  const downloaded = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Download PDF receipt' }).click();
  const receipt = await downloaded;
  const bytes = await readFile(await receipt.path());
  expect(bytes.subarray(0, 4).toString()).toBe('%PDF');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    await page.evaluate(() => innerWidth),
  );
});

test('file errors and offline state are visible on a phone-size layout', async ({ page, context }) => {
  await page.route('**/api/config', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 250));
    await route.continue();
  });
  await page.goto('/');
  await expect(page.getByRole('status')).toHaveText('Connecting to the kiosk…');
  await expect(page.getByRole('heading', { name: 'Start a print order' })).toBeVisible();
  await page
    .getByLabel('Document file')
    .setInputFiles({ name: 'clip.mp4', mimeType: 'video/mp4', buffer: Buffer.from('video') });
  await expect(page.getByRole('alert')).toContainText('Choose a PDF');
  await context.setOffline(true);
  await expect(page.getByText('You’re offline.', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Preview document' })).toBeDisabled();
  await context.setOffline(false);
});

test('failed simulation keeps the order out of the print queue', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'Payment failure uses the same browser-independent route.');
  await createOrder(page, 'Failure example');
  await scanPaymentQr(page);
  const simulator = page;
  await simulator.getByRole('button', { name: 'Payment Failed' }).click();
  await expect(simulator.getByRole('heading', { name: 'Test payment failed' })).toBeVisible();
  await simulator.getByRole('link', { name: 'Track print order' }).click();
  await expect(page.getByRole('heading', { name: 'Payment failed' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Download PDF receipt' })).toHaveCount(0);
});

test('going offline during QR validation stops the camera and prevents stale payment navigation', async ({ page, context }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'Camera cancellation uses the same scanner on every layout.');
  await createOrder(page, 'Interrupted camera validation');
  const statusUrl = new URL(page.url());
  const qrPath = await page.getByRole('img', { name: 'Payment QR code for this order' }).getAttribute('src');
  const image = await (await page.request.get(qrPath)).body();
  let release;
  let verified;
  const held = new Promise(resolve => { release = resolve; });
  const validationReady = new Promise(resolve => { verified = resolve; });
  await page.route('**/api/kiosk/scan-payment', async route => {
    const response = await route.fetch();
    verified();
    await held;
    await route.fulfill({ response }).catch(() => {});
  });
  try {
    await startPaymentScanner(page);
    await showCameraQr(page, image);
    await validationReady;
    await context.setOffline(true);
    await expect(page.getByRole('button', { name: 'Start camera' })).toBeDisabled();
    expect(await page.evaluate(() => window.__kioskCamera.streams.every(stream =>
      stream.getTracks().every(track => track.readyState === 'ended')))).toBeTruthy();
    release();
    await context.setOffline(false);
    await expect(page.getByRole('button', { name: 'Start camera' })).toBeEnabled();
    await expect(page).toHaveURL(/\/scan\?session=/);
    await expect(page.getByLabel('Test PIN')).toHaveCount(0);
    const order = await page.request.get('/api' + statusUrl.pathname + statusUrl.search);
    expect((await order.json()).paymentStatus).toBe('PENDING');
  } finally {
    release();
    await context.setOffline(false);
  }
});

test('customer reviews multiple files with individual page ranges and one payment QR', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'Cart integration is covered on desktop.');
  await page.goto('/');
  await page.getByLabel('Your name').fill('Multi-file example');
  await page
    .getByLabel('Document file')
    .setInputFiles([fixture, { ...fixture, name: 'worksheet.pdf' }, { ...fixture, name: 'remove-me.pdf' }]);
  await page.getByRole('button', { name: 'Remove remove-me.pdf' }).click();
  await expect(page.getByText('2 of 8 files added')).toBeVisible();
  await page.getByRole('button', { name: 'Preview documents' }).click();
  await expect(page.getByRole('img', { name: 'Preview of page 1' })).toBeVisible();
  await page.getByRole('button', { name: 'worksheet.pdf', exact: true }).click();
  await expect(page.getByRole('button', { name: 'worksheet.pdf', pressed: true })).toBeVisible();
  await expect(page.getByRole('img', { name: 'Preview of page 1' })).toBeVisible();
  await page.getByLabel('Pages to print').selectOption('custom');
  await page.getByLabel('Page range').fill('2');
  await page.getByLabel('Copies', { exact: true }).fill('2');
  await page.getByRole('button', { name: 'Review order' }).click();

  const files = page.getByRole('list', { name: 'Files in your order' });
  await expect(files.getByRole('listitem').filter({ hasText: 'class-notes.pdf' })).toContainText('All pages');
  await expect(files.getByRole('listitem').filter({ hasText: 'worksheet.pdf' })).toContainText('Pages 2');
  await expect(page.getByText('NPR 30', { exact: true })).toBeVisible();
  await page.goto(await page.evaluate(() => JSON.parse(sessionStorage.getItem('kiosk-reviewed-order')).statusUrl));
  await expect(page.getByRole('img', { name: 'Payment QR code for this order' })).toHaveCount(1);
});

test('staff sign-in, orders, reports and printer configuration', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'Staff integration is covered on desktop.');
  await page.goto('/admin');
  await expect(page.getByRole('heading', { name: 'Administrator sign in' })).toBeVisible();
  await page.getByLabel('Username').fill('browser-admin');
  await page.getByLabel('Password').fill(process.env.KIOSK_BROWSER_ADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
  await expect(page.getByText(warning, { exact: true })).toBeVisible();

  const navigation = page.getByRole('navigation', { name: 'Administrator sections' });
  await navigation.getByRole('button', { name: 'Orders', exact: true }).click();
  await page.getByLabel('Order ID or customer').fill('Unmatched order');
  await page.getByRole('button', { name: 'Apply filters' }).click();
  await expect(page.getByText('No matching orders.')).toBeVisible();

  await navigation.getByRole('button', { name: 'Printer', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Permanent kiosk QR' })).toBeVisible();
  await page.getByLabel('CUPS queue name').fill('Test_Printer');
  await page.getByRole('button', { name: 'Save printer' }).click();
  await expect(page.getByText('Test_Printer', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Queue test page' }).click();
  await expect(page.getByText('Test page queued.', { exact: false })).toBeVisible();

  await navigation.getByRole('button', { name: 'Settings' }).click();
  await expect(page.getByLabel('Price per page (NPR)')).toHaveValue('5.00');
  await navigation.getByRole('button', { name: 'Reports' }).click();
  await expect(page.getByRole('heading', { name: 'Daily activity' })).toBeVisible();
  const downloaded = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Export CSV' }).click();
  expect((await downloaded).suggestedFilename()).toContain('.csv');

  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { name: 'Administrator sign in' })).toBeVisible();
});
