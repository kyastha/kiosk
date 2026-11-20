import { expect, test } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';

test('laptop display tracks the phone journey, shows payment QR, then retains print status after reset', async ({ page, context }, info) => {
  test.skip(info.project.name !== 'desktop', 'The public display is tested on the kiosk monitor layout.');
  await page.setViewportSize({ width: 1366, height: 768 });
  const agentHeaders = { Authorization: 'Bearer ' + process.env.KIOSK_BROWSER_AGENT_TOKEN };
  async function agent(path, data = {}) {
    const response = await context.request.post('/api/agent' + path, { headers: agentHeaders, data });
    expect(response.ok(), await response.text()).toBeTruthy();
    return response.json();
  }
  async function setJob(job, status) {
    return agent('/jobs/' + job.id + '/status', { attemptId: job.attemptId, status, cupsId: 17 });
  }

  const login = await context.request.post('/api/admin/login', {
    data: { username: 'browser-admin', password: process.env.KIOSK_BROWSER_ADMIN_PASSWORD },
  });
  expect(login.ok()).toBeTruthy();
  expect((await context.request.patch('/api/admin/printer', { data: { queue: 'Browser_A4' } })).ok()).toBeTruthy();
  await agent('/heartbeat', { queue: 'Browser_A4', status: 'IDLE', reasons: [], activeJobs: 0 });
  for (let count = 0; count < 20; count += 1) {
    const { job } = await agent('/claim');
    if (!job) break;
    await agent('/jobs/' + job.id + '/authorize', { attemptId: job.attemptId, queue: 'Browser_A4' });
    await setJob(job, 'SUBMITTED_TO_PRINTER');
    await setJob(job, 'COMPLETED');
    if (count === 19) throw new Error('Browser fixtures left more than 20 queued jobs.');
  }

  const monitorSocket = page.waitForEvent('websocket', {
    predicate: socket => new URL(socket.url()).pathname === '/ws/kiosk',
  });
  await page.goto('/kiosk');
  await monitorSocket;
  const qr = page.getByRole('img', { name: 'Scan this QR code to start printing' });
  const map = page.getByRole('list', { name: 'Print journey' });
  await expect(qr).toBeVisible();
  await expect.poll(() => qr.evaluate(image => image.naturalWidth)).toBeGreaterThan(0);
  await expect(page.getByRole('heading', { name: 'Ready to scan' })).toBeVisible();
  await expect(page.getByText('Live updates', { exact: true })).toBeVisible();
  await map.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Step details' })).toContainText('Preview each file');
  await expect(map.locator('[aria-current="step"]')).toContainText('Scan');
  if (await page.evaluate(() => document.fullscreenEnabled)) {
    await page.getByRole('button', { name: 'Fullscreen', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Exit fullscreen' })).toBeVisible();
    await page.getByRole('button', { name: 'Exit fullscreen' }).click();
  }

  const phone = await context.newPage();
  const config = await (await phone.request.get('/api/config')).json();
  expect(new URL(config.onboardingUrl).searchParams.get('kiosk')).toBe('1');
  const onboarding = new URL(config.onboardingUrl);
  await phone.goto(onboarding.pathname + onboarding.search);
  await expect(page.getByRole('heading', { name: 'Phone connected' })).toBeVisible();
  const session = await phone.evaluate(() => JSON.parse(sessionStorage.getItem('kiosk-checkout-session')));
  await phone.reload();
  await expect(phone.getByRole('heading', { name: 'Start a print order' })).toBeVisible();
  await expect.poll(() => phone.evaluate(() => JSON.parse(sessionStorage.getItem('kiosk-checkout-session'))?.sessionId))
    .toBe(session.sessionId);

  const pdf = await PDFDocument.create();
  pdf.addPage().drawText('Print kiosk monitor fixture');
  await phone.getByLabel('Your name').fill('Private kiosk customer');
  await phone.getByLabel('Document file').setInputFiles({
    name: 'private-kiosk-fixture.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await pdf.save()),
  });
  await expect(page.getByRole('heading', { name: 'Choosing files' })).toBeVisible();
  await expect(map.locator('[aria-current="step"]')).toContainText('Files');
  await phone.getByRole('button', { name: 'Preview document' }).click();
  await expect(phone.getByRole('img', { name: 'Preview of page 1' })).toBeVisible();
  await expect(map.locator('[aria-current="step"]')).toContainText('Settings');
  await phone.getByRole('button', { name: 'Review order' }).click();
  await expect(page.getByRole('heading', { name: 'Reviewing the order' })).toBeVisible();
  await phone.getByRole('button', { name: 'Edit settings' }).click();
  await expect(map.locator('[aria-current="step"]')).toContainText('Settings');
  await phone.getByRole('button', { name: 'Review order' }).click();

  const orderSocket = phone.waitForEvent('websocket', {
    predicate: socket => new URL(socket.url()).pathname.startsWith('/ws/orders/'),
  });
  await phone.getByRole('button', { name: 'Continue to payment' }).click();
  await orderSocket;

  await expect(page.getByRole('heading', { name: 'Checkout in progress' })).toBeVisible();
  const paymentQr = page.getByRole('img', { name: 'Scan this QR code for the current test payment' });
  await expect(paymentQr).toBeVisible();
  await expect.poll(() => paymentQr.evaluate(image => image.naturalWidth)).toBeGreaterThan(0);
  await expect(page.getByRole('region', { name: 'Order test payment QR' })).toContainText('NPR 5');
  expect(await paymentQr.getAttribute('src')).not.toBe(await qr.getAttribute('src'));
  await expect(qr).toBeVisible();
  await expect(page.getByText('Private kiosk customer')).toHaveCount(0);
  await expect(page.getByText('private-kiosk-fixture.pdf')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThanOrEqual(768);
  await page.screenshot({ path: info.outputPath('kiosk-payment-1366.png') });

  const popup = phone.waitForEvent('popup');
  await phone.getByRole('link', { name: 'Open payment simulator' }).click();
  const simulator = await popup;
  await simulator.getByLabel('Test PIN').fill(await simulator.getByTestId('demo-pin').innerText());
  await simulator.getByRole('button', { name: /^Pay NPR/ }).click();
  await expect(simulator.getByRole('heading', { name: 'Test payment accepted' })).toBeVisible();

  await expect(page.getByRole('heading', { name: 'Test payment accepted' })).toBeVisible();
  await expect(qr).toBeVisible();
  await expect(paymentQr).toHaveCount(0);
  await expect(phone.getByText('Live updates', { exact: true })).toBeVisible();
  await expect(phone.locator('.print-progress [aria-current="step"]')).toHaveText('Queued');
  await expect(phone.getByRole('link', { name: 'Download PDF receipt' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Ready to scan' })).toBeVisible();
  await expect(qr).toHaveAttribute('src', '/api/kiosk/qr');
  await expect(page.getByRole('region', { name: 'Step details' })).toContainText('permanent access QR');

  const printerDisplay = await context.newPage();
  await printerDisplay.goto('/printer');
  await expect(printerDisplay.getByRole('heading', { name: 'Queued', exact: true })).toBeVisible();
  const printing = page.getByRole('region', { name: 'Latest print job' });
  await expect(printing).toContainText('Queued');
  const { job } = await agent('/claim');
  expect(job).toBeTruthy();
  await expect(printing).toContainText('Preparing');
  await expect(printerDisplay.getByRole('heading', { name: 'Preparing', exact: true })).toBeVisible();
  await agent('/jobs/' + job.id + '/authorize', { attemptId: job.attemptId, queue: 'Browser_A4' });
  await setJob(job, 'SUBMITTED_TO_PRINTER');
  await expect(printing).toContainText('Sent to printer');
  await expect(printerDisplay.getByRole('heading', { name: 'Sent to printer', exact: true })).toBeVisible();
  await setJob(job, 'COMPLETED');
  await expect(printing).toContainText('Printer reports complete');
  await expect(printerDisplay.getByRole('heading', { name: 'Printer reports complete', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Ready to scan' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThanOrEqual(768);
  await page.screenshot({ path: info.outputPath('kiosk-completed-1366.png') });
});
