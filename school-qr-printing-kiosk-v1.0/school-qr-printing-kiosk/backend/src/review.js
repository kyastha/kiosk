import { assertKioskSession } from './activity.js';
import { audit, transact } from './db.js';
import { authorizeOrder, paymentLifetime } from './orders.js';
import { HttpError, validateToken } from './security.js';

function ownedReview(db, id, key, ownerHash) {
  const order = authorizeOrder(db, id, key);
  if (!ownerHash || !db.prepare(`SELECT o.id FROM orders o JOIN documents d ON d.id = o.document_id
    WHERE o.id = ? AND (o.cart_owner_hash = ? OR (o.cart_owner_hash IS NULL AND d.owner_hash = ?))`)
    .get(id, ownerHash, ownerHash)) {
    throw new HttpError(404, 'Order unavailable.');
  }
  return order;
}

export function cancelReview(db, id, key, ownerHash) {
  return transact(db, () => {
    const order = ownedReview(db, id, key, ownerHash);
    const payment = db.prepare('SELECT status FROM payments WHERE order_id = ?').get(id);
    if (order.payment_status === 'FAILED' && order.print_status === 'CANCELLED' && payment.status === 'FAILED') {
      const previous = db.prepare(`SELECT detail FROM audit_logs
        WHERE order_id = ? AND action = 'ORDER_REVIEW_CANCELLED' ORDER BY id DESC LIMIT 1`).get(id);
      if (previous) return { orderId: id, cancelled: true, ...JSON.parse(previous.detail) };
    }
    if (order.payment_status !== 'PENDING' || payment.status !== 'PENDING' || order.print_status !== 'PENDING_PAYMENT'
        || db.prepare('SELECT id FROM print_jobs WHERE order_id = ?').get(id)) {
      throw new HttpError(409, 'This order can no longer be edited. Check its payment and print status.');
    }
    const now = Date.now();
    db.prepare("UPDATE payments SET status = 'FAILED', updated_at = ? WHERE order_id = ?").run(now, id);
    db.prepare("UPDATE orders SET payment_status = 'FAILED', print_status = 'CANCELLED', updated_at = ? WHERE id = ?")
      .run(now, id);
    const session = db.prepare('SELECT id, sequence FROM kiosk_sessions WHERE order_id = ? AND owner_hash = ?')
      .get(id, ownerHash);
    const detail = { sessionId: session?.id ?? null };
    if (session) {
      detail.sequence = Math.min(1_000_000_000, session.sequence + 1);
      db.prepare(`UPDATE kiosk_sessions SET order_id = NULL, stage = 'SETTINGS', sequence = ?, updated_at = ?
        WHERE id = ? AND order_id = ?`).run(detail.sequence, now, session.id, id);
    }
    audit(db, 'customer', 'ORDER_REVIEW_CANCELLED', id, detail);
    return { orderId: id, cancelled: true, ...detail };
  });
}

export function scanPayment(db, config, ownerHash, { sessionId, reference } = {}) {
  if (!validateToken(reference)) throw new HttpError(404, 'Payment QR unavailable.');
  return transact(db, () => {
    const payment = db.prepare(`SELECT p.*, o.payment_status, o.print_status
      FROM payments p JOIN orders o ON o.id = p.order_id WHERE p.reference = ?`).get(reference);
    if (!payment) throw new HttpError(404, 'Payment QR unavailable.');
    let session;
    try {
      session = assertKioskSession(db, sessionId, ownerHash, payment.order_id);
    } catch (error) {
      if (error.status === 404 || error.status === 409) throw new HttpError(404, 'This payment QR does not match your session.');
      throw error;
    }
    if (session.order_id !== payment.order_id) throw new HttpError(404, 'This payment QR does not match your session.');
    if (payment.status === 'FAILED' || payment.payment_status === 'FAILED' || payment.print_status === 'CANCELLED') {
      throw new HttpError(409, 'This payment has ended. Return to your order to continue.');
    }
    if (payment.status === 'PENDING' && Date.now() >= payment.created_at + paymentLifetime) {
      throw new HttpError(410, 'This payment QR expired. Return to your order to start again.');
    }
    return { orderId: payment.order_id, total: payment.amount,
      paymentUrl: `${config.publicOrigin}/pay/${payment.reference}` };
  });
}
