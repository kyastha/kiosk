import { audit, transact } from './db.js';
import { paymentLifetime } from './orders.js';
import { equal, HttpError } from './security.js';

const maxPinAttempts = 5;

function currentPayment(db, payment) {
  const current = db.prepare('SELECT * FROM payments WHERE id = ? AND reference = ?')
    .get(payment.id, payment.reference);
  if (!current) throw new HttpError(404, 'Payment unavailable.');
  return current;
}

export function demoPaymentView(db, provider, payment) {
  const current = currentPayment(db, payment);
  const expiresAt = current.created_at + paymentLifetime;
  const remaining = Math.max(0, maxPinAttempts - current.pin_attempts);
  return {
    demoPin: current.status === 'PENDING' && remaining && Date.now() < expiresAt ? provider.demoPin(current) : null,
    pinAttemptsRemaining: current.status === 'PENDING' ? remaining : 0,
    expiresAt: new Date(expiresAt).toISOString(),
  };
}

export function prepareDemoPayment(db, provider, payment, input) {
  const { outcome, pin, amount } = input || {};
  if (!['success', 'failure'].includes(outcome)) throw new HttpError(400, 'Choose a demo payment result.');
  const result = transact(db, () => {
    const current = currentPayment(db, payment);
    // A terminal response can be safely replayed. applyPaymentEvent preserves the first result.
    if (current.status !== 'PENDING') return { event: provider.simulate(current, outcome) };
    if (Date.now() >= current.created_at + paymentLifetime) {
      return { event: provider.simulate(current, 'failure') };
    }
    if (outcome === 'failure') return { event: provider.simulate(current, outcome) };
    if (!Number.isSafeInteger(amount) || amount !== current.amount) {
      audit(db, 'fake-provider', 'PAYMENT_AMOUNT_REJECTED', current.order_id);
      return { error: new HttpError(400, 'The amount must match this order total exactly.') };
    }
    if (current.pin_attempts >= maxPinAttempts) {
      return { error: new HttpError(429, 'This test payment is locked after five incorrect PIN attempts.') };
    }
    if (typeof pin !== 'string' || !/^\d{6}$/.test(pin) || !equal(pin, provider.demoPin(current))) {
      const attempts = current.pin_attempts + 1;
      db.prepare('UPDATE payments SET pin_attempts = ? WHERE id = ?').run(attempts, current.id);
      audit(db, 'fake-provider', 'PAYMENT_PIN_REJECTED', current.order_id, {
        attemptsRemaining: maxPinAttempts - attempts,
      });
      return { error: new HttpError(attempts === maxPinAttempts ? 429 : 401,
        attempts === maxPinAttempts
          ? 'This test payment is locked after five incorrect PIN attempts.'
          : 'Enter the six-digit demo PIN shown on this test payment page.') };
    }
    return { event: provider.simulate(current, outcome) };
  });
  // Errors are raised after committing the rejected-attempt counter.
  if (result.error) throw result.error;
  return result.event;
}
