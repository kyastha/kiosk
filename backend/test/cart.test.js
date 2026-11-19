import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, realpath, rm, truncate, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { PDFDocument } from 'pdf-lib';
import { createCartOrder, maxCartFiles, quoteCart } from '../src/cart.js';
import { openDatabase } from '../src/db.js';
import { applyPaymentEvent, authorizeOrder, createOrder, findOrder, orderView, ownedDocument, pdfPath } from '../src/orders.js';
import { FakePaymentProvider } from '../src/payments.js';
import { makeReceipt } from '../src/receipts.js';
import { hash } from '../src/security.js';

async function setup(t, pageLimit = 100) {
  const temp = await realpath(tmpdir());
  const documents = await mkdtemp(join(temp, 'kiosk-cart-test-'));
  const db = openDatabase(':memory:');
  t.after(async () => {
    db.close();
    if (dirname(documents) === temp) await rm(documents, { recursive: true, force: true });
  });
  db.prepare('INSERT INTO settings VALUES (1, ?, 500, 10, 20, ?, 24)').run('Test school', pageLimit);
  const config = { documents, publicOrigin: 'http://localhost:3000', appSecret: 'test secret', schoolName: 'Test school' };
  return { config, db, provider: new FakePaymentProvider(config.appSecret), ownerHash: hash('owner') };
}

async function upload({ db, config, ownerHash }, fileName, widths) {
  const id = randomUUID();
  const pdf = await PDFDocument.create();
  for (const width of widths) pdf.addPage([width, 400]);
  await writeFile(pdfPath(config, id), await pdf.save());
  db.prepare('INSERT INTO documents (id, owner_hash, file_name, page_count, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, ownerHash, fileName, widths.length, Date.now());
  return id;
}

function cart(items, changes) {
  return { customerName: 'Anita', copies: 2, orientation: 'portrait', scaling: 'fit', items, ...changes };
}

function checkout({ db, config, provider, ownerHash }, input, idempotencyKey = randomUUID()) {
  return createCartOrder(db, config, provider, { input, ownerHash, idempotencyKey });
}

test('cart quotes selected pages once and merges them in file order for one paid print job', async t => {
  const context = await setup(t);
  const { db, config, provider, ownerHash } = context;
  const first = await upload(context, 'Worksheet.pdf', [101, 102, 103, 104]);
  const second = await upload(context, 'Notes.pdf', [201, 202]);
  const input = cart([{ documentId: first, pageRanges: '4,2,2' }, { documentId: second }], { kiosk: true });
  const quoted = quoteCart(db, input, ownerHash);
  const items = [
    { fileName: 'Worksheet.pdf', printablePages: 2, pageRanges: '2,4', total: 2000 },
    { fileName: 'Notes.pdf', printablePages: 2, pageRanges: '', total: 2000 },
  ];
  assert.deepEqual(quoted.items, items);
  assert.equal(quoted.total, 4000);
  assert.equal(quoted.printablePages, 4);
  const order = await checkout(context, { ...input, expectedTotal: quoted.total });
  const row = authorizeOrder(db, order.id, new URL(order.statusUrl).searchParams.get('key'));
  assert.deepEqual(order.items, items);
  assert.deepEqual(orderView(row).items, items);
  assert.equal(order.kiosk, true);
  assert.equal(order.pageRanges, '');
  assert.equal(order.printStatus, 'PENDING_PAYMENT');
  assert.equal(db.prepare('SELECT count(*) AS count FROM print_jobs').get().count, 0);
  assert.throws(() => ownedDocument(db, row.document_id, ownerHash), { status: 404 });
  const merged = await PDFDocument.load(await readFile(pdfPath(config, row.document_id)));
  assert.deepEqual(merged.getPages().map(page => page.getWidth()), [102, 104, 201, 202]);
  const payment = db.prepare('SELECT * FROM payments WHERE order_id = ?').get(order.id);
  const event = provider.simulate(payment, 'success');
  assert.equal(payment.amount, 4000);
  assert.equal(applyPaymentEvent(db, provider, payment, event), 'TEST_PAID');
  assert.equal(applyPaymentEvent(db, provider, payment, event), 'TEST_PAID');
  assert.equal(db.prepare('SELECT count(*) AS count FROM print_jobs').get().count, 1);
  const receipt = await makeReceipt(config, findOrder(db, order.id));
  assert.ok((await PDFDocument.load(receipt)).getPageCount() >= 1);
});

test('cart rejects unowned files, duplicates, oversized selections and stale prices', async t => {
  const context = await setup(t, 3);
  const { db, ownerHash } = context;
  const first = await upload(context, 'First.pdf', [100, 110]);
  const second = await upload(context, 'Second.pdf', [200, 210]);
  const third = await upload({ ...context, ownerHash: hash('other owner') }, 'Private.pdf', [300]);
  const input = cart([{ documentId: first }]);
  assert.throws(() => quoteCart(db, cart([{ documentId: first }, { documentId: third }]), ownerHash), { status: 404 });
  assert.throws(() => quoteCart(db, cart([{ documentId: first }, { documentId: first }]), ownerHash), { status: 400 });
  assert.throws(() => quoteCart(db, cart([{ documentId: first }, { documentId: second }]), ownerHash), {
    status: 400, message: /at most 3 pages across all files/,
  });
  assert.throws(() => quoteCart(db, cart(Array(maxCartFiles + 1).fill({ documentId: first })), ownerHash), { status: 400 });
  assert.throws(() => quoteCart(db, cart([]), ownerHash), { status: 400 });
  assert.throws(() => quoteCart(db, cart([{ documentId: first, pageRanges: null }]), ownerHash), { status: 400 });
  await assert.rejects(checkout(context, { ...input, expectedTotal: 1 }), { status: 409 });
  assert.equal(db.prepare('SELECT count(*) AS count FROM orders').get().count, 0);
});

test('concurrent retries reuse one cart and replay after original upload retention', async t => {
  const context = await setup(t);
  const { db, config } = context;
  const first = await upload(context, 'First.pdf', [100]);
  const second = await upload(context, 'Second.pdf', [200]);
  const input = cart([{ documentId: first }, { documentId: second }], { expectedTotal: 2000 });
  const key = randomUUID();
  const orders = await Promise.all([checkout(context, input, key), checkout(context, input, key)]);
  assert.deepEqual(orders[0], orders[1]);
  assert.equal(db.prepare('SELECT count(*) AS count FROM payments').get().count, 1);
  assert.equal((await readdir(config.documents)).length, 3);
  await assert.rejects(checkout(context, { ...input, items: [...input.items].reverse() }, key), { status: 409 });
  db.prepare('UPDATE settings SET price_per_page = 700 WHERE id = 1').run();
  db.prepare('UPDATE documents SET deleted_at = ? WHERE id = ?').run(Date.now(), first);
  await unlink(pdfPath(config, first));
  assert.deepEqual(await checkout(context, input, key), orders[0]);
  await assert.rejects(checkout(context, input), { status: 404 });
  const secondOwner = hash('second owner');
  const otherContext = { ...context, ownerHash: secondOwner };
  const otherId = await upload(otherContext, 'Other.pdf', [300]);
  const otherOrder = await checkout(otherContext, cart([{ documentId: otherId }]), key);
  assert.notEqual(otherOrder.id, orders[0].id);
});

test('cart processing limits and order insertion failures leave no draft payment or merged file', async t => {
  const context = await setup(t);
  const { db, config } = context;
  const file = await upload(context, 'First.pdf', [100]);
  const input = cart([{ documentId: file }]);
  await assert.rejects(checkout({ ...context, provider: { create() { throw new Error('Provider unavailable'); } } }, input), {
    message: 'Provider unavailable',
  });
  const original = pdfPath(config, file);
  await truncate(original, 80 * 1024 ** 2 + 1);
  await assert.rejects(checkout(context, input), { status: 413 });
  assert.deepEqual(await readdir(config.documents), [`${file}.pdf`]);
  assert.equal(db.prepare('SELECT count(*) AS count FROM payments').get().count, 0);
  assert.equal(db.prepare('SELECT count(*) AS count FROM documents').get().count, 1);
});

test('single-document checkout preserves range behavior and records the kiosk marker', async t => {
  const context = await setup(t);
  const { db, config, provider, ownerHash } = context;
  const documentId = await upload(context, 'Original.pdf', [100, 200]);
  const input = { documentId, customerName: 'Anita', copies: 1, orientation: 'portrait', scaling: 'fit',
    kiosk: true, pageRanges: '2' };
  const key = randomUUID();
  const order = createOrder(db, config, provider, { input, ownerHash, idempotencyKey: key });
  assert.equal(order.kiosk, true);
  assert.equal(order.pageRanges, '2');
  assert.equal(order.items, undefined);
  assert.equal(findOrder(db, order.id).document_id, documentId);
  assert.deepEqual(createOrder(db, config, provider, { input, ownerHash, idempotencyKey: key }), order);
});

test('migration preserves a pre-cart order and its original request identifier', async t => {
  const context = await setup(t);
  const { config, provider, ownerHash } = context;
  const path = join(config.documents, 'legacy.sqlite');
  const dbBefore = new DatabaseSync(path);
  dbBefore.exec(await readFile(new URL('../migrations/001_initial.sql', import.meta.url), 'utf8'));
  dbBefore.exec('PRAGMA user_version=1');
  const input = { documentId: randomUUID(), customerName: 'Anita', copies: 1, orientation: 'portrait', scaling: 'fit',
    pageRanges: '2' };
  const key = randomUUID();
  const id = randomUUID();
  const now = Date.now();
  const oldHash = hash(JSON.stringify({
    customerName: 'Anita', copies: 1, orientation: 'portrait', scaling: 'fit', scalePercent: null, paperSize: 'A4',
    printingMode: 'Black & White', pageRanges: '2', printablePages: 1,
  }));
  dbBefore.prepare('INSERT INTO documents (id, owner_hash, file_name, page_count, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(input.documentId, ownerHash, 'Legacy.pdf', 2, now);
  dbBefore.prepare(`INSERT INTO orders VALUES (?, ?, 'Anita', 'Legacy.pdf', 'old access hash', ?, ?, 1, 1,
    'portrait', '2', 'fit', NULL, 'A4', 'Black & White', 500, 500, 'PENDING', 'PENDING_PAYMENT', ?, ?)`)
    .run(id, input.documentId, key, oldHash, now, now);
  dbBefore.prepare(`INSERT INTO payments (order_id, provider, reference, amount, status, created_at, updated_at)
    VALUES (?, 'FAKE', 'old reference', 500, 'PENDING', ?, ?)`).run(id, now, now);
  dbBefore.close();

  const migrated = openDatabase(path);
  try {
    const order = createOrder(migrated, config, provider, { input, ownerHash, idempotencyKey: key });
    assert.equal(order.id, id);
    assert.equal(order.kiosk, false);
    assert.equal(order.items, undefined);
    assert.equal(order.total, 500);
  } finally {
    migrated.close();
  }
});
