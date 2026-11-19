import { expect, test } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';

test('fullscreen display keeps its onboarding QR and resets after test payment over WebSockets', async ({ page, context }, info) => {
  test.skip(info.project.name !== 'desktop', 'The public display is tested on the kiosk monitor layout.');
  const monitorSocket = page.waitForEvent('websocket', { predicate: socket => new URL(socket.url()).pathname === '/ws/kiosk' });
  await page.goto('/kiosk');
  await monitorSocket;
  const qr = page.getByRole('img', { name: 'Scan this QR code to start printing' });
  await expect(qr).toBeVisible();
  await expect.poll(() => qr.evaluate(image => image.naturalWidth)).toBeGreaterThan(0);
  await expect(page.getByRole('heading', { name: 'Ready to scan' })).toBeVisible();
  await expect(page.getByText('Live updates', { exact: true })).toBeVisible();
  if (await page.evaluate(() => document.fullscreenEnabled)) {
    await page.getByRole('button', { name: 'Fullscreen', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Exit fullscreen' })).toBeVisible();
    await page.getByRole('button', { name: 'Exit fullscreen' }).click();
  }

  const phone = await context.newPage();
  const config = await (await phone.request.get('/api/config')).json();
  expect(new URL(config.onboardingUrl).searchParams.get('kiosk')).toBe('1');
  await phone.goto(new URL(config.onboardingUrl).pathname + new URL(config.onboardingUrl).search);
  const pdf = await PDFDocument.create();
  pdf.addPage().drawText('Print kiosk monitor fixture');
  await phone.getByLabel('Your name').fill('Private kiosk customer');
  await phone.getByLabel('Document file').setInputFiles({
    name: 'private-kiosk-fixture.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await pdf.save()),
  });
  await phone.getByRole('button', { name: 'Preview document' }).click();
  await expect(phone.getByRole('img', { name: 'Preview of page 1' })).toBeVisible();
  await phone.getByRole('button', { name: 'Review order' }).click();
  const orderSocket = phone.waitForEvent('websocket', { predicate: socket => new URL(socket.url()).pathname.startsWith('/ws/orders/') });
  await phone.getByRole('button', { name: 'Continue to payment' }).click();
  await orderSocket;

  await expect(page.getByRole('heading', { name: 'Checkout in progress' })).toBeVisible();
  await expect(qr).toBeVisible();
  await expect(page.getByText('Private kiosk customer')).toHaveCount(0);
  await expect(page.getByText('private-kiosk-fixture.pdf')).toHaveCount(0);
  const popup = phone.waitForEvent('popup');
  await phone.getByRole('link', { name: 'Open payment simulator' }).click();
  const simulator = await popup;
  await simulator.getByRole('button', { name: 'Payment Success' }).click();
  await expect(simulator.getByRole('heading', { name: 'Test payment accepted' })).toBeVisible();

  await expect(page.getByRole('heading', { name: 'Test payment accepted' })).toBeVisible();
  await expect(qr).toBeVisible();
  await expect(phone.getByText('Live updates', { exact: true })).toBeVisible();
  await expect(phone.locator('.print-progress [aria-current="step"]')).toHaveText('Queued');
  await expect(phone.getByRole('link', { name: 'Download PDF receipt' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Ready to scan' })).toBeVisible();
  await expect(qr).toHaveAttribute('src', '/api/kiosk/qr');
});
