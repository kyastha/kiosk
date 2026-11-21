import { randomUUID } from 'node:crypto';
import { transact } from './db.js';
import { paymentLifetime } from './orders.js';
import { HttpError } from './security.js';

export const activityLifetime = 10 * 60_000;
export const kioskResultLifetime = 15_000;
const stages = new Set(['SCANNED', 'SELECTING', 'UPLOADING', 'SETTINGS', 'REVIEW']);
const sessionIdFormat = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;
const activePrint = "('QUEUED','PROCESSING','SUBMITTED_TO_PRINTER','RETRY_PENDING')";
const printerStates = new Set(['UNKNOWN', 'UNCONFIGURED', 'OFFLINE', 'ERROR', 'BUSY', 'READY']);
const reasonFormat = /^(?:media-empty|media-needed|media-jam|toner-empty|toner-low|marker-supply-empty|marker-supply-low|cover-open|door-open|offline|paused|shutdown|connecting-to-device|not-accepting-jobs|printer-stopped)(?:-(?:warning|error|report))?$/;

function ownedSession(db, sessionId, ownerHash) {
  if (typeof sessionId !== 'string' || !sessionIdFormat.test(sessionId) || !ownerHash) {
    throw new HttpError(404, 'Kiosk session unavailable.');
  }
  const session = db.prepare('SELECT * FROM kiosk_sessions WHERE id = ? AND owner_hash = ?').get(sessionId, ownerHash);
  if (!session) throw new HttpError(404, 'Kiosk session unavailable.');
  return session;
}

export function assertKioskSession(db, sessionId, ownerHash, orderId = null) {
  const session = ownedSession(db, sessionId, ownerHash);
  if (session.order_id && session.order_id !== orderId) throw new HttpError(409, 'Start a new kiosk session for this order.');
  if (!session.order_id && session.updated_at <= Date.now() - activityLifetime) {
    throw new HttpError(409, 'This kiosk session expired. Scan the kiosk QR again.');
  }
  return session;
}

export function createKioskSession(db, ownerHash, { sessionId } = {}) {
  if (!ownerHash) throw new HttpError(401, 'Open the kiosk website to start a session.');
  return transact(db, () => {
    const now = Date.now();
    if (sessionId !== undefined) {
      const session = ownedSession(db, sessionId, ownerHash);
      if (!session.order_id && session.updated_at > now - activityLifetime) {
        return { sessionId: session.id, sequence: session.sequence };
      }
    }
    // Activity contains no historical transaction data and can expire independently of orders.
    db.prepare(`DELETE FROM kiosk_sessions WHERE updated_at < ? AND
      (order_id IS NULL OR order_id IN (SELECT id FROM orders WHERE payment_status <> 'PENDING'
        AND print_status NOT IN ${activePrint}))`).run(now - 86_400_000);
    const id = randomUUID();
    db.prepare(`INSERT INTO kiosk_sessions (id, owner_hash, stage, created_at, updated_at)
      VALUES (?, ?, 'SCANNED', ?, ?)`).run(id, ownerHash, now, now);
    return { sessionId: id, sequence: 0 };
  });
}

export function updateKioskActivity(db, ownerHash, { sessionId, stage, fileCount, sequence } = {}) {
  if (!stages.has(stage)) throw new HttpError(400, 'Choose a valid kiosk activity.');
  if (fileCount !== undefined && (!Number.isInteger(fileCount) || fileCount < 0 || fileCount > 8)) {
    throw new HttpError(400, 'The file count must be between 0 and 8.');
  }
  if (sequence !== undefined && (!Number.isSafeInteger(sequence) || sequence < 0 || sequence > 1_000_000_000)) {
    throw new HttpError(400, 'Invalid kiosk activity sequence.');
  }
  return transact(db, () => {
    const session = assertKioskSession(db, sessionId, ownerHash);
    const next = sequence ?? session.sequence + 1;
    if (next <= session.sequence) return { sessionId: session.id, sequence: session.sequence };
    if (next > 1_000_000_000) throw new HttpError(409, 'Start a new kiosk session.');
    db.prepare('UPDATE kiosk_sessions SET stage = ?, file_count = ?, sequence = ?, updated_at = ? WHERE id = ?')
      .run(stage, fileCount ?? session.file_count, next, Date.now(), session.id);
    return { sessionId: session.id, sequence: next };
  });
}

export function bindKioskOrder(db, sessionId, ownerHash, orderId) {
  const session = assertKioskSession(db, sessionId, ownerHash, orderId);
  const order = db.prepare(`SELECT o.id, o.cart_items FROM orders o JOIN documents d ON d.id = o.document_id
    WHERE o.id = ? AND (o.cart_owner_hash = ? OR (o.cart_owner_hash IS NULL AND d.owner_hash = ?))`)
    .get(orderId, ownerHash, ownerHash);
  if (!order) throw new HttpError(404, 'Order unavailable.');
  if (session.order_id) return;
  const fileCount = order.cart_items ? JSON.parse(order.cart_items).length : 1;
  db.prepare("UPDATE kiosk_sessions SET order_id = ?, stage = 'PAYMENT', file_count = ?, updated_at = ? WHERE id = ?")
    .run(order.id, fileCount, Date.now(), session.id);
  db.prepare('UPDATE orders SET kiosk = 1 WHERE id = ?').run(order.id);
}

function publicOrder(row, allowPaymentQr, now) {
  if (!row?.orderId) return null;
  const order = {
    id: row.orderId, total: row.total, paymentStatus: row.paymentStatus, printStatus: row.printStatus,
    updatedAt: new Date(Math.max(row.orderUpdatedAt, row.paymentUpdatedAt)).toISOString(),
    paymentUpdatedAt: new Date(row.paymentUpdatedAt).toISOString(),
  };
  if (allowPaymentQr && row.paymentStatus === 'PENDING' && row.orderCreatedAt + paymentLifetime > now) {
    order.paymentQrUrl = `/api/payments/${row.reference}/qr`;
  }
  return order;
}

const publicOrderColumns = `o.id AS orderId, o.total, o.payment_status AS paymentStatus,
  o.print_status AS printStatus, o.created_at AS orderCreatedAt, o.updated_at AS orderUpdatedAt,
  p.updated_at AS paymentUpdatedAt, p.reference`;

function publicPrinter(db, now) {
  const row = db.prepare('SELECT status, reasons, active_jobs, last_seen FROM printers WHERE id = 1').get();
  if (!row) return null;
  const stale = row.last_seen !== null && now - row.last_seen > 120_000;
  const status = stale ? 'OFFLINE' : printerStates.has(row.status) ? row.status : 'UNKNOWN';
  const reasons = JSON.parse(row.reasons);
  const safeReasons = reasons.filter(reason => typeof reason === 'string' && reasonFormat.test(reason));
  if (stale) safeReasons.push('offline');
  else if (reasons.length && !safeReasons.length && status === 'ERROR') safeReasons.push('Printer needs attention.');
  return { status, reasons: [...new Set(safeReasons)].slice(0, 10), activeJobs: row.active_jobs,
    lastSeen: row.last_seen === null ? null : new Date(row.last_seen).toISOString() };
}

export function kioskSnapshot(db, now = Date.now()) {
  const session = db.prepare(`SELECT s.id AS sessionId, s.stage, s.file_count AS fileCount, s.updated_at AS activityUpdatedAt,
      ${publicOrderColumns} FROM kiosk_sessions s LEFT JOIN orders o ON o.id = s.order_id
      LEFT JOIN payments p ON p.order_id = o.id
    WHERE (o.id IS NULL AND s.updated_at > ?) OR (o.payment_status = 'PENDING' AND o.created_at > ?)
      OR (o.payment_status = 'TEST_PAID' AND o.print_status IN ${activePrint})
      OR max(o.updated_at, p.updated_at) > ?
    ORDER BY CASE WHEN o.payment_status = 'PENDING' AND o.created_at > ? THEN 0 ELSE 1 END,
      CASE WHEN o.payment_status = 'PENDING' THEN o.created_at END ASC,
      s.created_at DESC, s.rowid DESC LIMIT 1`)
    .get(now - activityLifetime, now - paymentLifetime, now - kioskResultLifetime, now - paymentLifetime);
  let order = publicOrder(session, true, now);
  let activity = null;
  if (session) {
    const stage = !session.orderId ? session.stage : session.paymentStatus === 'PENDING' ? 'PAYMENT'
      : session.paymentStatus === 'TEST_PAID' ? 'PAID' : 'FAILED';
    activity = { sessionId: session.sessionId, stage, fileCount: session.fileCount,
      updatedAt: new Date(session.activityUpdatedAt).toISOString() };
  } else {
    // Earlier clients only marked orders with kiosk=true and have no activity session.
    const legacy = db.prepare(`SELECT ${publicOrderColumns} FROM orders o JOIN payments p ON p.order_id = o.id
      WHERE o.kiosk = 1 AND NOT EXISTS (SELECT 1 FROM kiosk_sessions s WHERE s.order_id = o.id)
      AND ((o.payment_status = 'PENDING' AND o.created_at > ?)
        OR (o.payment_status = 'TEST_PAID' AND o.print_status IN ${activePrint})
        OR max(o.updated_at, p.updated_at) > ?)
      ORDER BY o.created_at DESC, o.id DESC LIMIT 1`).get(now - paymentLifetime, now - kioskResultLifetime);
    order = publicOrder(legacy, false, now);
  }
  const printing = db.prepare(`SELECT ${publicOrderColumns} FROM orders o JOIN payments p ON p.order_id = o.id
    WHERE o.kiosk = 1 AND o.payment_status = 'TEST_PAID'
      AND (o.print_status IN ${activePrint} OR o.updated_at > ?)
    ORDER BY CASE WHEN o.print_status IN ('PROCESSING','SUBMITTED_TO_PRINTER') THEN 0
      WHEN o.print_status IN ('QUEUED','RETRY_PENDING') THEN 1 ELSE 2 END, o.updated_at DESC, o.id DESC LIMIT 1`)
    .get(now - kioskResultLifetime);
  return { order, activity, printingOrder: publicOrder(printing, false, now), printer: publicPrinter(db, now) };
}
