import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { PDFDocument } from 'pdf-lib';
import { createApp } from '../backend/src/app.js';
import { loadConfig } from '../backend/src/config.js';
import { applyPaymentEvent, parsePageRanges, paymentLifetime, pdfPath } from '../backend/src/orders.js';
import { FakePaymentProvider } from '../backend/src/payments.js';

const password = 'integration-test-password';
const appSecret = 'integration-app-secret-only-for-tests';
const agentToken = 'integration-agent-token-only-for-tests';
const agent = { Authorization: 'Bearer ' + agentToken };
const fixtureDate = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Kathmandu' }).format();
const customer = {};
let config, db, maintain, server, origin, url, fixture, admin;
let orderId, paymentRef, orderStatus, jobId, attemptId;

before(async () => {
  const root = await mkdtemp(join(tmpdir(), 'school-kiosk-api-'));
  server = createServer().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  origin = 'http://localhost:' + port;
  url = 'http://127.0.0.1:' + port;
  config = loadConfig({ PUBLIC_ORIGIN: origin, APP_SECRET: appSecret, AGENT_TOKEN: agentToken, ADMIN_PASSWORD: password, DATA_DIR: root });
  const instance = createApp(config);
  ({ db, maintain } = instance);
  server.on('request', instance.app);
  const document = await PDFDocument.create();
  for (let page = 0; page < 4; page += 1) document.addPage().drawText('Kiosk integration fixture');
  fixture = new Uint8Array(await document.save());
});

after(async () => {
  if (server) {
    server.close();
    await once(server, 'close');
  }
  db?.close();
  if (config) await rm(config.storage, { recursive: true, force: true });
});

function send(path, { method = 'GET', json, body, headers = {} } = {}) {
  return fetch(url + path, {
    method, body: json === undefined ? body : JSON.stringify(json),
    headers: { Origin: origin, ...(json === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
  });
}

async function expectJson(path, options, status = 200) {
  const result = await send(path, options);
  const data = await result.json();
  assert.equal(result.status, status, JSON.stringify(data));
  return data;
}

function optionsFor(doc = customer.document, overrides = {}) {
  return { documentId: doc.id, customerName: '=Anita', copies: 2, orientation: 'landscape',
    pageRanges: '3-4, 2, 3', scaling: 'custom', scalePercent: 90, ...overrides };
}

function upload(bytes, name, type, headers = customer.headers) {
  const body = new FormData();
  body.append('file', new Blob([bytes], { type }), name);
  return send('/api/documents', { method: 'POST', body, headers });
}

const post = (json, headers = customer.headers) => ({ method: 'POST', json, headers });
const patch = json => ({ method: 'PATCH', json, headers: admin });

test('kiosk config and permanent QR work without accounts; admin and agent endpoints require authorization', async () => {
  const response = await send('/api/config');
  assert.equal(response.status, 200);
  const cookie = response.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.match(response.headers.get('content-security-policy'), /object-src 'none'/);
  customer.headers = { Cookie: cookie.split(';')[0] };
  assert.equal((await response.json()).pricePerPage, 500);
  const png = await send('/api/kiosk/qr');
  assert.match(png.headers.get('content-type'), /^image\/png/);
  assert.equal(Buffer.from(await png.arrayBuffer()).subarray(1, 4).toString(), 'PNG');
  await expectJson('/api/admin/overview', {}, 401);
  await expectJson('/api/agent/claim', post({}, {}), 401);
  await expectJson('/api/admin/login', post({ username: 'admin', password: 'wrong' }, {}), 401);
  const login = await send('/api/admin/login', post({ username: 'admin', password }, {}));
  assert.equal(login.status, 200);
  admin = { Cookie: login.headers.get('set-cookie').split(';')[0] };
  await expectJson('/api/admin/session', { headers: admin });
  await expectJson('/api/admin/settings', { ...patch({ pricePerPage: 550 }), headers: { ...admin, Origin: 'https://elsewhere.example' } }, 403);
});

test('uploads enforce actual format, size and page limit; preview is private', async () => {
  await expectJson('/api/admin/settings', patch({ maxPages: 3, maxFileMb: 1 }));
  assert.equal((await upload(fixture, 'lesson.pdf', 'application/pdf')).status, 422);
  assert.equal((await upload(Buffer.alloc(1024 ** 2 + 1), 'huge.txt', 'text/plain')).status, 413);
  assert.ok([400, 415, 422].includes((await upload(fixture, 'movie.mp4', 'video/mp4')).status));
  assert.ok([400, 415, 422].includes((await upload('bad', 'lesson.pdf', 'application/pdf')).status));
  await expectJson('/api/admin/settings', patch({ maxPages: 100 }));
  const response = await upload(fixture, 'पाठ.pdf', 'application/pdf');
  assert.equal(response.status, 201, await response.clone().text());
  customer.document = await response.json();
  assert.equal(customer.document.fileName, 'पाठ.pdf');
  assert.equal(customer.document.pageCount, 4);
  assert.equal((await send(customer.document.previewUrl)).status, 404);
  const preview = await send(customer.document.previewUrl, { headers: customer.headers });
  assert.equal(preview.status, 200);
  assert.equal((await PDFDocument.load(await preview.arrayBuffer())).getPageCount(), 4);
});

test('same-origin loopback aliases can check out, but other origins and cross-site requests are rejected', async () => {
  const headers = { ...customer.headers, Origin: url, 'Sec-Fetch-Site': 'same-origin' };
  const quote = await expectJson('/api/quote', post(optionsFor(), headers));
  assert.equal(quote.total, 3000);
  await expectJson('/api/quote', post(optionsFor(), { ...headers, Origin: 'http://127.0.0.1:5173' }), 403);
  await expectJson('/api/quote', post(optionsFor(), { ...headers, Origin: url.replace('127.0.0.1', '[::1]') }), 403);
  await expectJson('/api/quote', post(optionsFor(), { ...headers, 'Sec-Fetch-Site': 'cross-site' }), 403);
});

test('quote counts unique selected pages; order takes an immutable rate snapshot and deduplicates submits', async () => {
  assert.deepEqual(parsePageRanges('4,2-3,3,1', 4), { pageRanges: '1-4', printablePages: 4 });
  await expectJson('/api/quote', post(optionsFor(undefined, { customerName: '  ' })), 400);
  await expectJson('/api/quote', post(optionsFor(undefined, { pageRanges: '1-5' })), 400);
  const input = optionsFor(undefined, { total: 1 });
  const quote = await expectJson('/api/quote', post(input));
  assert.equal(quote.total, 3000);
  assert.equal(quote.pageRanges, '2-4');
  await expectJson('/api/orders', post({ ...input, expectedTotal: 1 }), 409);
  const headers = { ...customer.headers, 'Idempotency-Key': 'checkout-id-000000001' };
  const order = await expectJson('/api/orders', post({ ...input, expectedTotal: 3000 }, headers), 201);
  orderId = order.id;
  paymentRef = new URL(order.paymentUrl).pathname.split('/').at(-1);
  orderStatus = new URL(order.statusUrl);
  assert.equal(order.total, 3000);
  assert.equal(order.printStatus, 'PENDING_PAYMENT');
  const [accessQr, paymentQr] = await Promise.all(['/api/kiosk/qr', order.paymentQrUrl]
    .map(path => send(path).then(result => result.arrayBuffer())));
  assert.notDeepEqual(Buffer.from(accessQr), Buffer.from(paymentQr));
  await expectJson('/api/admin/settings', patch({ pricePerPage: 600 }));
  const repeated = await expectJson('/api/orders', post({ ...input, expectedTotal: 3000 }, headers), 201);
  assert.equal(repeated.id, orderId);
  assert.equal(repeated.pricePerPage, 500);
  await expectJson('/api/orders', post({ ...input, copies: 3 }, headers), 409);
  await expectJson('/api/orders/' + orderId, {}, 404);
  const unauthorized = await expectJson('/api/orders/' + orderId + '/receipt' + orderStatus.search, {}, 409);
  assert.match(unauthorized.error, /after payment/);
});

test('backend rejects forged events, unpaid and failed payments never print, duplicate success releases one job', async () => {
  const provider = new FakePaymentProvider(appSecret);
  const payment = db.prepare('SELECT * FROM payments WHERE order_id = ?').get(orderId);
  const signed = provider.simulate(payment, 'success');
  assert.equal(applyPaymentEvent(db, provider, payment, { ...signed, amount: 1 }), null);
  assert.equal(applyPaymentEvent(db, provider, payment, { ...signed, signature: 'forged' }), null);
  const failed = await expectJson('/api/orders', post(optionsFor()), 201);
  const failRef = new URL(failed.paymentUrl).pathname.split('/').at(-1);
  await expectJson('/api/payments/' + failRef + '/simulate', post({ outcome: 'failure' }));
  const retry = await expectJson('/api/payments/' + failRef + '/simulate', post({ outcome: 'success' }));
  assert.equal(retry.paymentStatus, 'FAILED');
  await expectJson('/api/payments/unknown/simulate', post({ outcome: 'success' }), 404);
  await expectJson('/api/payments/' + paymentRef + '/simulate', post({ status: 'TEST_PAID' }), 400);
  assert.deepEqual(await expectJson('/api/agent/claim', post({}, agent)), { job: null });
  const gateway = await expectJson('/api/payments/' + paymentRef);
  assert.equal(gateway.total, payment.amount);
  assert.match(gateway.demoPin, /^\d{6}$/);
  await expectJson('/api/payments/' + paymentRef + '/simulate', post({ outcome: 'success', amount: 1, pin: gateway.demoPin }), 400);
  await expectJson('/api/payments/' + paymentRef + '/simulate', post({ outcome: 'success', amount: payment.amount }), 401);
  assert.equal(db.prepare('SELECT count(*) AS count FROM print_jobs').get().count, 0);
  const outcomes = await Promise.all(Array.from({ length: 3 }, () =>
    expectJson('/api/payments/' + paymentRef + '/simulate', post({ outcome: 'success', amount: payment.amount, pin: provider.demoPin(payment) }))));
  assert.ok(outcomes.every(result => result.paymentStatus === 'TEST_PAID' && result.total === 3000));
  assert.equal(db.prepare('SELECT count(*) AS count FROM print_jobs WHERE order_id = ?').get(orderId).count, 1);
  assert.equal(db.prepare("SELECT count(*) AS count FROM audit_logs WHERE action = 'PAYMENT_REPLAY' AND order_id = ?").get(orderId).count, 2);
  const paid = await expectJson('/api' + orderStatus.pathname + orderStatus.search);
  assert.equal(paid.printStatus, 'QUEUED');
  const receipt = await send(paid.receiptUrl);
  assert.equal(receipt.status, 200);
  assert.match(receipt.headers.get('content-disposition'), /attachment.*TEST-/);
  assert.ok((await PDFDocument.load(await receipt.arrayBuffer())).getPageCount() >= 1);
});

test('attempts are sticky across polls, retries are operator controlled, and submission authorization is single-use', async () => {
  const offline = await expectJson('/api/agent/heartbeat', post({ queue: 'School_A4', status: 'OFFLINE', reasons: ['media-empty'], activeJobs: 0 }, agent));
  assert.equal(offline.queue, null);
  assert.deepEqual(await expectJson('/api/agent/claim', post({ recoveryOnly: true }, agent)), { job: null });
  const { job } = await expectJson('/api/agent/claim', post({}, agent));
  jobId = job.id;
  assert.equal(job.status, 'PROCESSING');
  assert.equal(job.pageRanges, '2-4');
  assert.equal((await send(job.documentUrl)).status, 401);
  assert.equal((await send(job.documentUrl, { headers: agent })).status, 200);
  const again = await expectJson('/api/agent/claim', post({ recoveryOnly: true }, agent));
  assert.equal(again.job.attemptId, job.attemptId);
  await expectJson('/api/agent/jobs/' + jobId + '/status', post({ attemptId: job.attemptId, status: 'RETRY_PENDING',
    retrySafe: true, error: 'Out of paper' }, agent));
  assert.deepEqual(await expectJson('/api/agent/claim', post({}, agent)), { job: null });
  assert.equal((await expectJson('/api/admin/jobs/' + orderId + '/retry', post({}, admin))).printStatus, 'QUEUED');
  const retried = (await expectJson('/api/agent/claim', post({}, agent))).job;
  attemptId = retried.attemptId;
  assert.equal(retried.attemptNumber, 2);
  assert.notEqual(attemptId, job.attemptId);
  const path = '/api/agent/jobs/' + jobId;
  await expectJson(path + '/authorize', post({ attemptId: job.attemptId, queue: 'School_A4' }, agent), 409);
  const reservations = await Promise.all([1, 2].map(() =>
    expectJson(path + '/authorize', post({ attemptId, queue: 'School_A4' }, agent))));
  assert.equal(reservations.filter(item => item.authorized).length, 1);
  await expectJson(path + '/status', post({ attemptId, status: 'RETRY_PENDING', retrySafe: true }, agent), 409);
  await expectJson(path + '/status', post({ attemptId, status: 'COMPLETED', cupsId: 23 }, agent), 409);
  await expectJson(path + '/status', post({ attemptId, status: 'SUBMITTED_TO_PRINTER', cupsId: '23', error: 'Out of paper' }, agent));
  const submitted = await expectJson('/api' + orderStatus.pathname + orderStatus.search);
  assert.equal(submitted.printStatus, 'SUBMITTED_TO_PRINTER');
  await expectJson('/api/admin/jobs/' + orderId + '/cancel', post({}, admin), 409);
  await expectJson(path + '/status', post({ attemptId, status: 'COMPLETED', cupsId: 23 }, agent));
  await expectJson(path + '/status', post({ attemptId, status: 'COMPLETED', cupsId: 23 }, agent));
  assert.deepEqual(await expectJson('/api/agent/claim', post({}, agent)), { job: null });
  assert.equal((await send(path + '/document', { headers: agent })).status, 404);
});

test('reports and printer tests are auditable, CSV formula injection is neutralized', async () => {
  const { orders, total } = await expectJson('/api/admin/orders?q=anita&from=' + fixtureDate, { headers: admin });
  assert.equal(total, 2);
  assert.ok(orders.every(order => !order.statusUrl && order.paymentReference));
  const details = await expectJson('/api/admin/orders/' + orderId, { headers: admin });
  assert.equal(details.attempts.length, 2);
  assert.equal(details.attempts[0].cupsId, '23');
  assert.ok(details.events.some(event => event.action === 'PRINT_COMPLETED'));
  const report = await expectJson('/api/admin/reports', { headers: admin });
  assert.equal(report.totalPages, 6);
  assert.equal(report.totalCopies, 2);
  assert.equal(report.testAmount, 3000);
  const csv = await send('/api/admin/reports.csv', { headers: admin });
  assert.match(await csv.text(), /"'=Anita"/);
  await expectJson('/api/admin/printer', { method: 'PATCH', json: { queue: 'Test_Queue' }, headers: admin });
  const { jobId: testJob } = await expectJson('/api/admin/printer/test', post({}, admin), 201);
  assert.equal((await expectJson('/api/agent/claim', post({}, agent))).job.id, testJob);
  assert.equal((await send('/api/agent/jobs/' + testJob + '/document', { headers: agent })).status, 200);
});

test('expired payment releases no job; retention purges PDFs without deleting orders', async () => {
  const expired = await expectJson('/api/orders', post(optionsFor()), 201);
  const reference = new URL(expired.paymentUrl).pathname.split('/').at(-1);
  db.prepare('UPDATE payments SET created_at = ? WHERE order_id = ?').run(Date.now() - paymentLifetime - 5000, expired.id);
  const result = await expectJson('/api/payments/' + reference + '/simulate', post({ outcome: 'success' }));
  assert.equal(result.paymentStatus, 'FAILED');
  assert.equal(db.prepare('SELECT count(*) AS count FROM print_jobs WHERE order_id = ?').get(expired.id).count, 0);
  db.prepare('UPDATE documents SET created_at = 0 WHERE id = ?').run(customer.document.id);
  db.prepare('UPDATE orders SET updated_at = 0 WHERE document_id = ?').run(customer.document.id);
  await maintain();
  await assert.rejects(readFile(pdfPath(config, customer.document.id)), { code: 'ENOENT' });
  assert.equal((await send(customer.document.previewUrl, { headers: customer.headers })).status, 404);
  const { receiptUrl } = await expectJson('/api' + orderStatus.pathname + orderStatus.search);
  assert.equal((await send(receiptUrl)).status, 200);
});

test('login rate limit blocks repeated attempts and logout invalidates the session', async () => {
  const logout = await expectJson('/api/admin/logout', post({}, admin));
  assert.equal(logout.ok, true);
  await expectJson('/api/admin/session', { headers: admin }, 401);
  let last;
  for (let attempt = 0; attempt < 8; attempt += 1) last = await send('/api/admin/login', post({ username: 'admin', password: 'bad' }, {}));
  assert.equal(last.status, 429);
});

test('a backend restart preserves paid orders, receipts and outstanding printer work', async () => {
  server.close();
  await once(server, 'close');
  db.close();
  const restarted = createApp(config);
  ({ db, maintain } = restarted);
  server = restarted.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  url = 'http://127.0.0.1:' + server.address().port;
  const order = await expectJson('/api' + orderStatus.pathname + orderStatus.search);
  assert.equal(order.paymentStatus, 'TEST_PAID');
  assert.equal(order.printStatus, 'COMPLETED');
  assert.equal((await send(order.receiptUrl)).status, 200);
  const { job } = await expectJson('/api/agent/claim', post({}, agent));
  assert.equal(job.status, 'PROCESSING');
  assert.equal(job.attemptNumber, 1);
});
