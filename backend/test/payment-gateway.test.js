import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { openDatabase } from '../src/db.js';
import { applyPaymentEvent, createOrder, paymentLifetime } from '../src/orders.js';
import { demoPaymentView, prepareDemoPayment } from '../src/payment-gateway.js';
import { FakePaymentProvider } from '../src/payments.js';
import { hash } from '../src/security.js';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'kiosk-demo-payment-'));
  const config = loadConfig({
    DATA_DIR: directory, APP_SECRET: randomBytes(32).toString('hex'), AGENT_TOKEN: randomBytes(32).toString('hex'),
    ADMIN_PASSWORD: randomBytes(16).toString('hex'),
  });
  const db = openDatabase(join(directory, 'test.sqlite'));
  t.after(async () => {
    db.close();
    await rm(directory, { recursive: true, force: true });
  });
  db.prepare("INSERT INTO settings VALUES (1, 'Test School', 500, 10, 20, 100, 24)").run();
  const documentId = randomUUID();
  const ownerHash = hash('test-owner');
  db.prepare("INSERT INTO documents(id,owner_hash,file_name,page_count,created_at) VALUES (?,?,'worksheet.pdf',2,?)")
    .run(documentId, ownerHash, Date.now());
  const provider = new FakePaymentProvider(config.appSecret);
  const order = createOrder(db, config, provider, { ownerHash, input: {
    documentId, customerName: 'Student', copies: 1, orientation: 'portrait', scaling: 'fit',
  } });
  const payment = db.prepare('SELECT * FROM payments WHERE order_id = ?').get(order.id);
  const view = () => demoPaymentView(db, provider, payment);
  const prepare = (input = {}) => prepareDemoPayment(db, provider, payment, {
    outcome: 'success', pin: provider.demoPin(payment), amount: payment.amount, ...input,
  });
  const apply = input => applyPaymentEvent(db, provider, payment, prepare(input));
  return { db, config, provider, payment, view, prepare, apply };
}

test('each server challenge is six digits and requires the exact stored amount', async t => {
  const { db, payment, provider, prepare, view } = await fixture(t);
  const challenge = view();
  assert.match(challenge.demoPin, /^\d{6}$/);
  assert.equal(challenge.pinAttemptsRemaining, 5);
  assert.equal(challenge.expiresAt, new Date(payment.created_at + paymentLifetime).toISOString());
  for (const amount of [payment.amount + 1, String(payment.amount), NaN, undefined]) {
    assert.throws(() => prepare({ amount }), error => error.status === 400);
  }
  const event = prepare();
  assert.ok(provider.verifyCallback(event, payment));
  assert.equal(event.amount, payment.amount);
  assert.equal(view().pinAttemptsRemaining, 5);
  assert.equal(db.prepare('SELECT count(*) AS count FROM print_jobs').get().count, 0);
});

test('five incorrect test PINs persist across retries and lock the payment', async t => {
  const { db, payment, provider, prepare, view } = await fixture(t);
  const wrong = provider.demoPin(payment) === '000000' ? '000001' : '000000';
  for (let attempt = 1; attempt <= 5; attempt++) {
    assert.throws(() => prepare({ pin: wrong }), error => error.status === (attempt === 5 ? 429 : 401));
    assert.equal(view().pinAttemptsRemaining, 5 - attempt);
  }
  assert.equal(view().demoPin, null);
  assert.throws(() => prepare(), error => error.status === 429);
  assert.equal(db.prepare('SELECT status FROM payments WHERE id = ?').get(payment.id).status, 'PENDING');
  assert.equal(db.prepare('SELECT count(*) AS count FROM print_jobs').get().count, 0);
  const audit = db.prepare("SELECT detail FROM audit_logs WHERE action = 'PAYMENT_PIN_REJECTED'").all();
  assert.equal(audit.length, 5);
  assert.ok(audit.every(({ detail }) => !detail.includes(wrong)));
});

test('a valid PIN releases one paid print job and terminal retries preserve the first result', async t => {
  const { db, apply, view } = await fixture(t);
  assert.equal(apply(), 'TEST_PAID');
  assert.equal(view().demoPin, null);
  assert.equal(apply({ pin: undefined, amount: undefined }), 'TEST_PAID');
  assert.equal(apply({ outcome: 'failure' }), 'TEST_PAID');
  assert.equal(db.prepare('SELECT count(*) AS count FROM print_jobs').get().count, 1);
});

test('failed and expired demo payments never release a print job', async t => {
  const failed = await fixture(t);
  assert.equal(failed.apply({ outcome: 'failure', pin: undefined, amount: undefined }), 'FAILED');
  assert.equal(failed.apply(), 'FAILED');
  assert.equal(failed.db.prepare('SELECT count(*) AS count FROM print_jobs').get().count, 0);
  const expired = await fixture(t);
  expired.db.prepare('UPDATE payments SET created_at = ? WHERE id = ?')
    .run(Date.now() - paymentLifetime, expired.payment.id);
  assert.equal(expired.view().demoPin, null);
  assert.equal(expired.apply(), 'FAILED');
  assert.equal(expired.db.prepare('SELECT count(*) AS count FROM print_jobs').get().count, 0);
});

test('the payment HTTP route cannot bypass PIN or immutable amount validation', async t => {
  const { db, config, payment } = await fixture(t);
  const { app } = createApp(config, { database: db });
  const server = app.listen(0, '127.0.0.1');
  t.after(() => new Promise(resolve => server.close(resolve)));
  await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + server.address().port;
  const path = origin + '/api/payments/' + payment.reference;
  async function submit(body, status) {
    const response = await fetch(path + '/simulate', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: config.publicOrigin },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, status);
    return response.json();
  }
  const challenge = await (await fetch(path)).json();
  await submit({ outcome: 'success', amount: payment.amount }, 401);
  await submit({ outcome: 'success', amount: payment.amount + 1, pin: challenge.demoPin }, 400);
  assert.equal(db.prepare('SELECT count(*) AS count FROM print_jobs').get().count, 0);
  assert.equal(db.prepare('SELECT status FROM payments WHERE id = ?').get(payment.id).status, 'PENDING');
  const result = await submit({ outcome: 'success', amount: challenge.total, pin: challenge.demoPin }, 200);
  assert.equal(result.paymentStatus, 'TEST_PAID');
  assert.equal(result.demoPin, null);
  await submit({ outcome: 'success' }, 200);
  assert.equal(db.prepare('SELECT count(*) AS count FROM print_jobs').get().count, 1);
});
