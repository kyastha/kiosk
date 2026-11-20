import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { PDFDocument } from 'pdf-lib';
import {
  activityLifetime, bindKioskOrder, createKioskSession, kioskResultLifetime, kioskSnapshot, updateKioskActivity,
} from '../src/activity.js';
import { createCartOrder } from '../src/cart.js';
import { openDatabase } from '../src/db.js';
import { applyPaymentEvent, createOrder, findOrder, paymentLifetime, pdfPath } from '../src/orders.js';
import { FakePaymentProvider } from '../src/payments.js';
import { hash } from '../src/security.js';

function fixture(t) {
  const db = openDatabase(':memory:');
  db.prepare("INSERT INTO settings VALUES (1, 'Test school', 500, 10, 20, 100, 24)").run();
  t.after(() => db.close());
  const config = { appSecret: 'activity test secret', publicOrigin: 'http://localhost:3000' };
  const provider = new FakePaymentProvider(config.appSecret);
  const ownerHash = hash('first browser');
  const documentId = randomUUID();
  db.prepare(`INSERT INTO documents (id, owner_hash, file_name, page_count, created_at)
    VALUES (?, ?, 'Private notes.pdf', 1, ?)`).run(documentId, ownerHash, Date.now());
  const input = { documentId, customerName: 'Private name', copies: 1, orientation: 'portrait', scaling: 'fit' };
  const order = (values = {}, owner = ownerHash, key = randomUUID()) => createOrder(db, config, provider, {
    input: { ...input, ...values }, ownerHash: owner, idempotencyKey: key,
  });
  return { db, config, provider, ownerHash, input, order };
}

test('kiosk scan activity resumes per owner and rejects cross-browser changes and stale sequences', t => {
  const { db, ownerHash } = fixture(t);
  const session = createKioskSession(db, ownerHash);
  assert.deepEqual(createKioskSession(db, ownerHash, session), session);
  assert.deepEqual(updateKioskActivity(db, ownerHash, { ...session, stage: 'UPLOADING', fileCount: 2, sequence: 2 }),
    { sessionId: session.sessionId, sequence: 2 });
  updateKioskActivity(db, ownerHash, { ...session, stage: 'SELECTING', fileCount: 0, sequence: 1 });
  assert.equal(kioskSnapshot(db).activity.stage, 'UPLOADING');
  updateKioskActivity(db, ownerHash, { ...session, stage: 'SELECTING', fileCount: 1, sequence: 3 });
  assert.equal(kioskSnapshot(db).activity.stage, 'SELECTING');
  assert.throws(() => updateKioskActivity(db, hash('other browser'), { ...session, stage: 'REVIEW' }), { status: 404 });
  assert.throws(() => createKioskSession(db, hash('other browser'), session), { status: 404 });
  assert.throws(() => updateKioskActivity(db, ownerHash, { ...session, stage: 'PAID' }), { status: 400 });
  assert.throws(() => updateKioskActivity(db, ownerHash, { ...session, stage: 'SELECTING', fileCount: 9 }), { status: 400 });
  assert.throws(() => updateKioskActivity(db, ownerHash, { ...session, stage: 'SELECTING', sequence: -1 }), { status: 400 });
  assert.throws(() => createKioskSession(db, null), { status: 401 });
});

test('expired activity disappears and scanning again creates a new owned session', t => {
  const { db, ownerHash } = fixture(t);
  const session = createKioskSession(db, ownerHash);
  db.prepare('UPDATE kiosk_sessions SET updated_at = ? WHERE id = ?')
    .run(Date.now() - activityLifetime - 1, session.sessionId);
  assert.equal(kioskSnapshot(db).activity, null);
  assert.throws(() => updateKioskActivity(db, ownerHash, { ...session, stage: 'REVIEW' }), { status: 409 });
  const replacement = createKioskSession(db, ownerHash, session);
  assert.notEqual(replacement.sessionId, session.sessionId);
  assert.equal(kioskSnapshot(db).activity.sessionId, replacement.sessionId);
});

test('a bound order exposes only its payment QR and safe summary on the shared kiosk', t => {
  const { db, ownerHash, order, provider } = fixture(t);
  const session = createKioskSession(db, ownerHash);
  const result = order({ sessionId: session.sessionId });
  const initial = kioskSnapshot(db);
  assert.deepEqual(initial.activity, {
    sessionId: session.sessionId, stage: 'PAYMENT', fileCount: 1, updatedAt: initial.activity.updatedAt,
  });
  assert.deepEqual(Object.keys(initial.order).sort(),
    ['id', 'paymentQrUrl', 'paymentStatus', 'printStatus', 'total', 'updatedAt', 'paymentUpdatedAt'].sort());
  assert.equal(initial.order.id, result.id);
  assert.equal(initial.order.total, result.total);
  assert.equal(initial.order.paymentQrUrl, result.paymentQrUrl);
  const publicJson = JSON.stringify(initial);
  for (const secret of ['Private name', 'Private notes.pdf', 'receiptUrl', 'statusUrl', 'access_hash', 'owner_hash']) {
    assert.equal(publicJson.includes(secret), false);
  }
  assert.throws(() => updateKioskActivity(db, ownerHash, { ...session, stage: 'REVIEW' }), { status: 409 });
  const payment = db.prepare('SELECT * FROM payments WHERE order_id = ?').get(result.id);
  applyPaymentEvent(db, provider, payment, provider.simulate(payment, 'success'));
  const paid = kioskSnapshot(db);
  assert.equal(paid.order.paymentStatus, 'TEST_PAID');
  assert.equal(paid.order.paymentQrUrl, undefined);
  assert.equal(paid.printingOrder.id, result.id);
  db.prepare("UPDATE orders SET print_status = 'COMPLETED', updated_at = ? WHERE id = ?").run(Date.now(), result.id);
  assert.equal(kioskSnapshot(db).printingOrder.printStatus, 'COMPLETED');
  const expired = kioskSnapshot(db, Date.now() + kioskResultLifetime + 1);
  assert.equal(expired.order, null);
  assert.equal(expired.printingOrder, null);
});

test('a newer scan suppresses another phone payment while preserving safe printer progress', t => {
  const { db, ownerHash, order, provider } = fixture(t);
  const first = createKioskSession(db, ownerHash);
  const original = order({ sessionId: first.sessionId });
  const next = createKioskSession(db, hash('second browser'));
  const snapshot = kioskSnapshot(db);
  assert.equal(snapshot.activity.sessionId, next.sessionId);
  assert.equal(snapshot.order, null);
  const payment = db.prepare('SELECT * FROM payments WHERE order_id = ?').get(original.id);
  applyPaymentEvent(db, provider, payment, provider.simulate(payment, 'success'));
  const withPrint = kioskSnapshot(db);
  assert.equal(withPrint.activity.sessionId, next.sessionId);
  assert.equal(withPrint.order, null);
  assert.equal(withPrint.printingOrder.id, original.id);
  assert.equal(withPrint.printingOrder.paymentQrUrl, undefined);
});

test('session binding and request identifiers prevent cross-order and cross-owner reassignment', t => {
  const { db, ownerHash, order } = fixture(t);
  const session = createKioskSession(db, ownerHash);
  const key = randomUUID();
  const first = order({ sessionId: session.sessionId }, ownerHash, key);
  assert.deepEqual(order({ sessionId: session.sessionId }, ownerHash, key), first);
  assert.throws(() => order({ sessionId: session.sessionId }), { status: 409 });
  const newSession = createKioskSession(db, ownerHash, session);
  assert.notEqual(newSession.sessionId, session.sessionId);
  assert.throws(() => order({ sessionId: newSession.sessionId }, ownerHash, key), { status: 409 });
  const foreignSession = createKioskSession(db, hash('other owner'));
  assert.throws(() => order({ sessionId: foreignSession.sessionId }), { status: 404 });
  assert.throws(() => bindKioskOrder(db, foreignSession.sessionId, hash('other owner'), first.id), { status: 404 });
  assert.equal(db.prepare('SELECT count(*) AS n FROM orders').get().n, 1);
  assert.equal(db.prepare('SELECT count(*) AS n FROM payments').get().n, 1);
});

test('simultaneous cart submissions can bind one order to a kiosk session', async t => {
  const { db, ownerHash, provider, config, input } = fixture(t);
  const root = await realpath(tmpdir());
  const documents = await mkdtemp(join(root, 'kiosk-activity-test-'));
  t.after(async () => {
    if (dirname(documents) === root) await rm(documents, { recursive: true, force: true });
  });
  config.documents = documents;
  const pdf = await PDFDocument.create();
  pdf.addPage();
  await writeFile(pdfPath(config, input.documentId), await pdf.save());
  const session = createKioskSession(db, ownerHash);
  const request = { ...input, items: [{ documentId: input.documentId }], sessionId: session.sessionId };
  const results = await Promise.allSettled([1, 2].map(() => createCartOrder(db, config, provider, {
    input: request, ownerHash, idempotencyKey: randomUUID(),
  })));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.status, 409);
  const bound = db.prepare('SELECT order_id FROM kiosk_sessions WHERE id = ?').get(session.sessionId);
  assert.equal(findOrder(db, bound.order_id).kiosk, 1);
  assert.equal(db.prepare('SELECT count(*) AS n FROM orders').get().n, 1);
});

test('legacy kiosk orders keep a safe fallback and printer errors omit raw driver text', t => {
  const { db, order } = fixture(t);
  const created = order({ kiosk: true });
  const initial = kioskSnapshot(db);
  assert.equal(initial.order.id, created.id);
  assert.equal(initial.order.paymentQrUrl, undefined);
  db.prepare("UPDATE printers SET status = 'ERROR', reasons = ?, reported_queue = 'private-queue', last_seen = ? WHERE id = 1")
    .run(JSON.stringify(['media-empty-error', 'private.pdf failed at /home/school/private']), Date.now());
  const snapshot = kioskSnapshot(db);
  assert.deepEqual(snapshot.printer.reasons, ['media-empty-error']);
  assert.equal(JSON.stringify(snapshot).includes('private-queue'), false);
  assert.equal(JSON.stringify(snapshot).includes('/home/school'), false);
  assert.equal(kioskSnapshot(db, Date.now() + paymentLifetime + 1).order, null);
});
