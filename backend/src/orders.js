import { createHmac, randomUUID } from 'node:crypto';
import { readdir, rm, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { audit, transact } from './db.js';
import { HttpError, equal, hash, validateToken } from './security.js';
import { assertKioskSession, bindKioskOrder } from './activity.js';

export const paymentLifetime = 30 * 60_000;
const hour = 60 * 60_000;

export function settings(db) {
  return db.prepare(`SELECT school_name AS schoolName, price_per_page AS pricePerPage,
    max_copies AS maxCopies, max_file_mb AS maxFileMb, max_pages AS maxPages,
    retention_hours AS retentionHours FROM settings WHERE id = 1`).get();
}

export function pdfPath(config, id) {
  return join(config.documents, `${id}.pdf`);
}

export function parsePageRanges(value, pageCount) {
  if (typeof value !== 'string' || value.length > 2000) throw new HttpError(400, 'Enter valid page ranges.');
  if (!value.trim()) return { pageRanges: '', printablePages: pageCount };
  const selected = new Set();
  for (const entry of value.split(',')) {
    const match = /^\s*(\d{1,3})(?:\s*-\s*(\d{1,3}))?\s*$/.exec(entry);
    if (!match) throw new HttpError(400, 'Use ranges like 1–3, 5 with a hyphen between page numbers.');
    const start = Number(match[1]);
    const end = match[2] === undefined ? start : Number(match[2]);
    if (start < 1 || end < start || end > pageCount) throw new HttpError(400, `Select pages from 1 to ${pageCount}.`);
    for (let page = start; page <= end; page += 1) selected.add(page);
  }
  const spans = [];
  for (const page of [...selected].sort((a, b) => a - b)) {
    const last = spans.at(-1);
    if (last && last[1] + 1 === page) last[1] = page;
    else spans.push([page, page]);
  }
  return { pageRanges: spans.map(([start, end]) => start === end ? String(start) : `${start}-${end}`).join(','),
    printablePages: selected.size };
}

export function ownedDocument(db, documentId, ownerHash) {
  if (typeof documentId !== 'string' || !ownerHash) throw new HttpError(404, 'Document unavailable.');
  const document = db.prepare('SELECT * FROM documents WHERE id = ? AND owner_hash = ? AND deleted_at IS NULL')
    .get(documentId, ownerHash);
  if (!document) throw new HttpError(404, 'Document unavailable.');
  return document;
}

export function normalizePrintSettings(input, limits) {
  const { copies, orientation, scaling } = input;
  const customerName = typeof input.customerName === 'string' ? input.customerName.trim() : '';
  if (!customerName || customerName.length > 100 || /[\u0000-\u001f\u007f]/u.test(customerName)) {
    throw new HttpError(400, 'Enter a name between 1 and 100 characters.');
  }
  if (!Number.isInteger(copies) || copies < 1 || copies > limits.maxCopies) {
    throw new HttpError(400, `Choose between 1 and ${limits.maxCopies} copies.`);
  }
  if (!['portrait', 'landscape'].includes(orientation)) throw new HttpError(400, 'Choose portrait or landscape.');
  if (!['fit', 'actual', 'custom'].includes(scaling)) throw new HttpError(400, 'Choose a scaling mode.');
  const scalePercent = scaling === 'custom' ? input.scalePercent : null;
  if (scaling === 'custom' && (!Number.isInteger(scalePercent) || scalePercent < 25 || scalePercent > 200)) {
    throw new HttpError(400, 'Enter a scale from 25% to 200%.');
  }
  return { customerName, copies, orientation, scaling, scalePercent, paperSize: 'A4',
    printingMode: 'Black & White' };
}

export function normalizeOrder(input, document, limits) {
  const { pageRanges = '' } = input;
  return { ...normalizePrintSettings(input, limits), ...parsePageRanges(pageRanges, document.page_count) };
}

export function quote(input, document, limits) {
  if (document.page_count > limits.maxPages) throw new HttpError(400, `The document exceeds the current ${limits.maxPages}-page limit.`);
  const normalized = normalizeOrder(input, document, limits);
  return { ...normalized, pricePerPage: limits.pricePerPage,
    total: normalized.printablePages * normalized.copies * limits.pricePerPage };
}

export const orderSelect = `SELECT o.*, p.reference, p.receipt_number, p.updated_at AS payment_updated_at,
  j.id AS job_id, j.error AS print_error, j.retry_safe
  FROM orders o JOIN payments p ON p.order_id = o.id LEFT JOIN print_jobs j ON j.order_id = o.id`;

export function findOrder(db, id) {
  return db.prepare(`${orderSelect} WHERE o.id = ?`).get(id);
}

export function orderKey(config, id, ownerHash) {
  return createHmac('sha256', config.appSecret).update(`order-v1:${id}:${ownerHash}`).digest('base64url');
}

export function orderView(row, config, key) {
  const details = {
    id: row.id, customerName: row.customer_name, fileName: row.file_name, createdAt: new Date(row.created_at).toISOString(),
    printablePages: row.printable_pages, copies: row.copies, pricePerPage: row.price_per_page, total: row.total,
    paperSize: row.paper_size, printingMode: row.printing_mode, orientation: row.orientation, pageRanges: row.page_ranges,
    scaling: row.scaling, scalePercent: row.scale_percent, paymentStatus: row.payment_status, printStatus: row.print_status,
    paymentExpiresAt: new Date(row.created_at + paymentLifetime).toISOString(),
    receiptNumber: row.receipt_number, kiosk: Boolean(row.kiosk),
  };
  if (row.cart_items) details.items = JSON.parse(row.cart_items);
  if (!key) return { ...details, paymentReference: row.reference, printError: row.print_error, retrySafe: Boolean(row.retry_safe) };
  const paymentUrl = `${config.publicOrigin}/pay/${row.reference}`;
  return { ...details, statusUrl: `${config.publicOrigin}/orders/${row.id}?key=${key}`,
    paymentUrl, paymentQrUrl: `/api/payments/${row.reference}/qr`,
    receiptUrl: row.receipt_number ? `/api/orders/${row.id}/receipt?key=${key}` : null };
}

export function authorizeOrder(db, id, key) {
  const order = validateToken(key) && findOrder(db, id);
  if (!order || !equal(order.access_hash, hash(key))) throw new HttpError(404, 'Order unavailable.');
  return order;
}

export function validateOrderIdentifier(idempotencyKey) {
  if (idempotencyKey && !/^[a-z0-9-]{16,100}$/i.test(idempotencyKey)) throw new HttpError(400, 'Invalid request identifier.');
}

export function checkExpectedTotal(input, values) {
  if (input.expectedTotal !== undefined && input.expectedTotal !== values.total) {
    throw new HttpError(409, 'The price has changed. Review the updated quote before paying.');
  }
}

export function insertOrder(db, config, provider, {
  document, values, ownerHash, idempotencyKey, requestHash, kiosk = false, items, sessionId,
}) {
  const id = randomUUID();
  const key = orderKey(config, id, ownerHash);
  const { reference, provider: providerName } = provider.create();
  const now = Date.now();
  db.prepare(`INSERT INTO orders (id, document_id, customer_name, file_name, access_hash, idempotency_key, request_hash,
    printable_pages, copies, orientation, page_ranges, scaling, scale_percent, paper_size, printing_mode,
    price_per_page, total, payment_status, print_status, created_at, updated_at, kiosk, cart_items, cart_owner_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', 'PENDING_PAYMENT', ?, ?, ?, ?, ?)`)
    .run(id, document.id, values.customerName, document.file_name, hash(key), idempotencyKey || null, requestHash,
      values.printablePages, values.copies, values.orientation, values.pageRanges, values.scaling, values.scalePercent,
      values.paperSize, values.printingMode, values.pricePerPage, values.total, now, now,
      Number(kiosk), items ? JSON.stringify(items) : null, items ? ownerHash : null);
  db.prepare(`INSERT INTO payments (order_id, provider, reference, amount, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'PENDING', ?, ?)`).run(id, providerName, reference, values.total, now, now);
  audit(db, 'customer', 'PAYMENT_CREATED', id, { provider: providerName, amount: values.total });
  if (sessionId !== undefined) bindKioskOrder(db, sessionId, ownerHash, id);
  return orderView(findOrder(db, id), config, key);
}

export function createOrder(db, config, provider, { input, ownerHash, idempotencyKey }) {
  validateOrderIdentifier(idempotencyKey);
  return transact(db, () => {
    const document = ownedDocument(db, input.documentId, ownerHash);
    // Hash the settings separately from the rate so retries keep the original quote.
    const normalized = normalizeOrder(input, document, { maxCopies: 100 });
    const kiosk = input.kiosk === true || input.sessionId !== undefined;
    const request = kiosk ? { ...normalized, kiosk } : normalized;
    if (input.sessionId !== undefined) request.sessionId = input.sessionId;
    const requestHash = hash(JSON.stringify(request));
    if (idempotencyKey) {
      const existing = db.prepare('SELECT id, request_hash FROM orders WHERE document_id = ? AND idempotency_key = ?')
        .get(document.id, idempotencyKey);
      if (existing) {
        if (!equal(existing.request_hash, requestHash)) throw new HttpError(409, 'This request identifier has already been used.');
        if (input.sessionId !== undefined) assertKioskSession(db, input.sessionId, ownerHash, existing.id);
        return orderView(findOrder(db, existing.id), config, orderKey(config, existing.id, ownerHash));
      }
    }
    if (input.sessionId !== undefined) assertKioskSession(db, input.sessionId, ownerHash);
    const values = quote(input, document, settings(db));
    checkExpectedTotal(input, values);
    return insertOrder(db, config, provider, { document, values, ownerHash, idempotencyKey, requestHash, kiosk,
      sessionId: input.sessionId });
  });
}

function failPayment(db, payment, now, action, eventId = null) {
  db.prepare("UPDATE payments SET status = 'FAILED', event_id = ?, updated_at = ? WHERE id = ?").run(eventId, now, payment.id);
  db.prepare("UPDATE orders SET payment_status = 'FAILED', print_status = 'PAYMENT_FAILED', updated_at = ? WHERE id = ?")
    .run(now, payment.order_id);
  audit(db, 'fake-provider', action, payment.order_id);
}

export function applyPaymentEvent(db, provider, payment, event) {
  return transact(db, () => {
    const current = db.prepare('SELECT * FROM payments WHERE id = ?').get(payment.id);
    if (!provider.verifyCallback(event, current)) {
      audit(db, 'fake-provider', 'PAYMENT_REJECTED', current.order_id);
      return null;
    }
    if (current.status !== 'PENDING' || db.prepare('SELECT id FROM payments WHERE event_id = ?').get(event.id)) {
      audit(db, 'fake-provider', 'PAYMENT_REPLAY', current.order_id);
      return current.status;
    }
    const now = Date.now();
    const document = db.prepare('SELECT d.deleted_at FROM documents d JOIN orders o ON o.document_id = d.id WHERE o.id = ?')
      .get(current.order_id);
    if (now >= current.created_at + paymentLifetime || document.deleted_at !== null) {
      failPayment(db, current, now, 'PAYMENT_EXPIRED');
      return 'FAILED';
    }
    if (event.outcome === 'failure') {
      failPayment(db, current, now, 'PAYMENT_FAILED', event.id);
      return 'FAILED';
    }
    const receipt = `TEST-${String(current.id).padStart(7, '0')}`;
    db.prepare("UPDATE payments SET status = 'TEST_PAID', receipt_number = ?, event_id = ?, updated_at = ? WHERE id = ?")
      .run(receipt, event.id, now, current.id);
    db.prepare("UPDATE orders SET payment_status = 'TEST_PAID', print_status = 'QUEUED', updated_at = ? WHERE id = ?")
      .run(now, current.order_id);
    db.prepare("INSERT INTO print_jobs (id, order_id, status, created_at, updated_at) VALUES (?, ?, 'QUEUED', ?, ?)")
      .run(randomUUID(), current.order_id, now, now);
    audit(db, 'fake-provider', 'PAYMENT_TEST_PAID', current.order_id, { amount: current.amount, receipt });
    return 'TEST_PAID';
  });
}

export function expirePayments(db) {
  const now = Date.now();
  transact(db, () => {
    for (const payment of db.prepare("SELECT * FROM payments WHERE status = 'PENDING' AND created_at <= ?").all(now - paymentLifetime)) {
      failPayment(db, payment, now, 'PAYMENT_EXPIRED');
    }
  });
}

export async function maintainStorage(db, config) {
  expirePayments(db);
  const now = Date.now();
  db.prepare('DELETE FROM admin_sessions WHERE expires_at <= ?').run(now);
  const cutoff = now - settings(db).retentionHours * hour;
  const documents = transact(db, () => {
    db.prepare(`UPDATE documents AS d SET deleted_at = ? WHERE deleted_at IS NULL AND created_at <= ?
      AND NOT EXISTS (
        SELECT 1 FROM orders o WHERE o.document_id = d.id AND (o.updated_at > ? OR
          o.print_status IN ('PENDING_PAYMENT','QUEUED','PROCESSING','SUBMITTED_TO_PRINTER','RETRY_PENDING'))
      )`).run(now, cutoff, cutoff);
    return db.prepare('SELECT id FROM documents WHERE deleted_at IS NOT NULL AND purged_at IS NULL LIMIT 500').all();
  });
  for (const { id } of documents) {
    await unlink(pdfPath(config, id)).catch(error => {
      if (error.code !== 'ENOENT') throw error;
    });
    db.prepare('UPDATE documents SET purged_at = ? WHERE id = ?').run(Date.now(), id);
  }
  // Sweep stale working directories and PDFs left by a process interruption.
  const orphanCutoff = now - hour;
  for (const [directory, type] of [[config.workRoot, 'conversion'], [config.documents, 'pdf']]) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name);
      const info = await stat(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
      if (!info || info.mtimeMs >= orphanCutoff) continue;
      if (type === 'conversion' && entry.isDirectory() && entry.name.startsWith('conversion-')) {
        await rm(file, { recursive: true, force: true });
      }
      if (type === 'pdf' && entry.isFile() && /^[a-f0-9-]{36}\.pdf(?:\.partial)?$/.test(entry.name)) {
        const id = entry.name.slice(0, 36);
        if (entry.name.endsWith('.partial') || !db.prepare('SELECT id FROM documents WHERE id = ?').get(id)) {
          await rm(file, { force: true });
        }
      }
    }
  }
}
