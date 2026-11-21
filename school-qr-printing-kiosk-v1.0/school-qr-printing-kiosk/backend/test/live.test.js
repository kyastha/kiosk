import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { WebSocket } from 'ws';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { attachLive } from '../src/live.js';
import { hash, token } from '../src/security.js';
import { createKioskSession, updateKioskActivity } from '../src/activity.js';

async function fixture(t) {
  const storage = await mkdtemp(join(tmpdir(), 'kiosk-live-'));
  const config = loadConfig({
    DATA_DIR: storage, SCHOOL_NAME: 'Live Test School',
    APP_SECRET: randomBytes(32).toString('hex'), AGENT_TOKEN: randomBytes(32).toString('hex'),
    ADMIN_PASSWORD: randomBytes(16).toString('hex'),
  });
  const { app, db } = createApp(config);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  const origin = `http://127.0.0.1:${port}`;
  config.publicOrigin = `http://localhost:${port}`;
  config.localOrigins = [config.publicOrigin, origin];
  const live = attachLive(server, { db, config });
  t.after(async () => {
    live.close();
    await new Promise(resolve => server.close(resolve));
    db.close();
    await rm(storage, { force: true, recursive: true });
  });

  const socket = (path, options = {}) => {
    const peer = new WebSocket(`ws://127.0.0.1:${port}${path}`, { origin, ...options });
    t.after(() => peer.terminate());
    return peer;
  };
  return { db, origin, live, socket, canonicalOrigin: config.publicOrigin };
}

function insertOrder(db, kiosk, created) {
  const id = randomUUID();
  const documentId = randomUUID();
  const key = token();
  db.prepare(`INSERT INTO documents (id, owner_hash, file_name, page_count, created_at)
    VALUES (?, ?, 'private.pdf', 1, ?)`).run(documentId, hash(token()), created);
  db.prepare(`INSERT INTO orders (
    id, document_id, customer_name, file_name, access_hash, printable_pages, copies,
    orientation, page_ranges, scaling, paper_size, printing_mode, price_per_page, total,
    payment_status, print_status, created_at, updated_at, kiosk
  ) VALUES (?, ?, 'Private Customer', 'private.pdf', ?, 1, 1, 'portrait', '', 'fit', 'A4',
    'Black & White', 500, 500, 'PENDING', 'PENDING_PAYMENT', ?, ?, ?)`)
    .run(id, documentId, hash(key), created, created, Number(kiosk));
  db.prepare(`INSERT INTO payments (order_id, provider, reference, amount, status, created_at, updated_at)
    VALUES (?, 'fake', ?, 500, 'PENDING', ?, ?)`).run(id, token(), created, created);
  return { id, key, path: `/ws/orders/${id}?key=${key}`, apiPath: `/api/orders/${id}?key=${key}` };
}

async function nextMessage(peer) {
  const [message] = await once(peer, 'message', { signal: AbortSignal.timeout(5000) });
  return JSON.parse(message.toString());
}

function refused(peer) {
  return new Promise((resolve, reject) => {
    peer.once('open', () => reject(new Error('Unexpected WebSocket upgrade')));
    peer.once('error', reject);
    peer.once('unexpected-response', (_request, response) => {
      response.resume();
      resolve(response.statusCode);
      peer.terminate();
    });
  });
}

test('kiosk WebSocket sends safe order and printer progress with current timestamps', async t => {
  const { db, socket } = await fixture(t);
  const peer = socket('/ws/kiosk');
  const empty = await nextMessage(peer);
  assert.equal(empty.order, null);
  assert.equal(empty.activity, null);
  assert.equal(empty.printingOrder, null);
  assert.deepEqual(empty.printer, { status: 'UNKNOWN', reasons: [], activeJobs: 0, lastSeen: null });
  const created = Date.now();
  const latest = insertOrder(db, true, created);
  insertOrder(db, true, created - 1000);
  insertOrder(db, false, created + 1000);
  assert.deepEqual((await nextMessage(peer)).order, {
    id: latest.id, paymentStatus: 'PENDING', printStatus: 'PENDING_PAYMENT',
    total: 500, updatedAt: new Date(created).toISOString(), paymentUpdatedAt: new Date(created).toISOString(),
  });

  const paidAt = created + 2000;
  db.prepare("UPDATE payments SET status = 'TEST_PAID', updated_at = ? WHERE order_id = ?").run(paidAt, latest.id);
  db.prepare("UPDATE orders SET payment_status = 'TEST_PAID', print_status = 'QUEUED', updated_at = ? WHERE id = ?")
    .run(paidAt, latest.id);
  assert.deepEqual((await nextMessage(peer)).order, {
    id: latest.id, paymentStatus: 'TEST_PAID', printStatus: 'QUEUED', updatedAt: new Date(paidAt).toISOString(),
    total: 500,
    paymentUpdatedAt: new Date(paidAt).toISOString(),
  });
  db.prepare("UPDATE orders SET print_status = 'COMPLETED', updated_at = ? WHERE id = ?").run(paidAt + 1000, latest.id);
  assert.deepEqual((await nextMessage(peer)).order, {
    id: latest.id, paymentStatus: 'TEST_PAID', printStatus: 'COMPLETED', updatedAt: new Date(paidAt + 1000).toISOString(),
    total: 500,
    paymentUpdatedAt: new Date(paidAt).toISOString(),
  });
  const reconnect = socket('/ws/kiosk');
  assert.equal((await nextMessage(reconnect)).order.printStatus, 'COMPLETED');
});

test('kiosk feed publishes a scan before checkout and reconnects to the selected session', async t => {
  const { db, socket } = await fixture(t);
  const peer = socket('/ws/kiosk');
  await nextMessage(peer);
  const ownerHash = hash('first browser');
  const session = createKioskSession(db, ownerHash);
  assert.equal((await nextMessage(peer)).activity.stage, 'SCANNED');
  updateKioskActivity(db, ownerHash, { ...session, stage: 'UPLOADING', fileCount: 2, sequence: 1 });
  const snapshot = await nextMessage(peer);
  assert.equal(snapshot.activity.fileCount, 2);
  assert.equal(snapshot.order, null);
  const reconnect = socket('/ws/kiosk');
  assert.deepEqual(await nextMessage(reconnect), snapshot);
  const next = createKioskSession(db, hash('other browser'));
  assert.equal((await nextMessage(peer)).activity.sessionId, next.sessionId);
  updateKioskActivity(db, ownerHash, { ...session, stage: 'REVIEW', fileCount: 2, sequence: 2 });
  const finalReconnect = socket('/ws/kiosk');
  assert.equal((await nextMessage(finalReconnect)).activity.sessionId, next.sessionId);
});

test('private WebSocket matches the order API, ignores writes and revokes changed keys', async t => {
  const { db, origin, socket } = await fixture(t);
  const order = insertOrder(db, false, Date.now());
  const peer = socket(order.path);
  const initial = await nextMessage(peer);
  const response = await fetch(origin + order.apiPath);
  assert.equal(response.status, 200);
  assert.deepEqual(initial, await response.json());

  peer.send(JSON.stringify({ printStatus: 'COMPLETED' }));
  assert.equal(db.prepare('SELECT print_status AS status FROM orders WHERE id = ?').get(order.id).status, 'PENDING_PAYMENT');
  db.prepare("UPDATE orders SET print_status = 'QUEUED' WHERE id = ?").run(order.id);
  assert.equal((await nextMessage(peer)).printStatus, 'QUEUED');

  const revoked = once(peer, 'close', { signal: AbortSignal.timeout(5000) });
  const replacement = token();
  db.prepare('UPDATE orders SET access_hash = ? WHERE id = ?').run(hash(replacement), order.id);
  const newPeer = socket(`/ws/orders/${order.id}?key=${replacement}`);
  assert.equal((await nextMessage(newPeer)).printStatus, 'QUEUED');
  assert.equal((await revoked)[0], 1008);
  assert.equal(await refused(socket(order.path)), 404);
});

test('WebSocket upgrades require a recognized Origin, matching Host and private key', async t => {
  const { db, canonicalOrigin, socket } = await fixture(t);
  const order = insertOrder(db, true, Date.now());
  assert.equal(await refused(socket('/ws/kiosk', { origin: 'https://another.example' })), 403);
  assert.equal(await refused(socket('/ws/kiosk', { origin: canonicalOrigin })), 403);
  assert.equal(await refused(socket('/ws/kiosk', { origin: undefined })), 403);
  assert.equal(await refused(socket('/ws/kiosk', { headers: { 'Sec-Fetch-Site': 'cross-site' } })), 403);
  assert.equal(await refused(socket(`/ws/orders/${order.id}`)), 404);
  assert.equal(await refused(socket(`/ws/orders/${order.id}?key=${token()}`)), 404);
});

test('WebSocket limits each feed and closes subscribers during shutdown', async t => {
  const { live, socket } = await fixture(t);
  const clients = Array.from({ length: 16 }, () => socket('/ws/kiosk'));
  await Promise.all(clients.map(nextMessage));
  assert.equal(await refused(socket('/ws/kiosk')), 429);
  const closed = clients.map(peer => once(peer, 'close', { signal: AbortSignal.timeout(5000) }));
  live.close();
  assert.deepEqual(await Promise.all(closed).then(events => events.map(([code]) => code)), Array(16).fill(1001));
});
