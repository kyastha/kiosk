import { createHmac } from 'node:crypto';
import { equal, token } from './security.js';

export const testNotice = 'TEST PAYMENT — NO REAL MONEY TRANSFERRED';

export class PaymentProvider {
  create() { throw new Error('Payment creation is unavailable.'); }
  verify() { throw new Error('Payment verification is unavailable.'); }
  verifyCallback() { throw new Error('Payment callbacks are unavailable.'); }
  reconcile() { throw new Error('Payment reconciliation is unavailable.'); }
}

export class FakePaymentProvider extends PaymentProvider {
  constructor(secret) {
    super();
    this.secret = secret;
    this.name = 'FAKE';
  }

  create() {
    return { provider: this.name, reference: token() };
  }

  demoPin(payment) {
    const challenge = createHmac('sha256', this.secret)
      .update(JSON.stringify(['fake-payment-pin-v1', payment.reference, payment.amount])).digest();
    return String(challenge.readUInt32BE(0) % 1_000_000).padStart(6, '0');
  }

  sign({ id, reference, amount, outcome }) {
    return createHmac('sha256', this.secret)
      .update(JSON.stringify(['fake-payment-v1', id, reference, amount, outcome])).digest('hex');
  }

  simulate(payment, outcome) {
    const event = { id: token(), reference: payment.reference, amount: payment.amount, outcome };
    return { ...event, signature: this.sign(event) };
  }

  verify(event, payment) {
    return payment.provider === this.name && event.reference === payment.reference &&
      event.amount === payment.amount && ['success', 'failure'].includes(event.outcome) &&
      typeof event.signature === 'string' && equal(event.signature, this.sign(event));
  }

  verifyCallback(event, payment) { return this.verify(event, payment); }

  reconcile(payment) {
    return { reference: payment.reference, amount: payment.amount, status: payment.status, eventId: payment.event_id };
  }
}

// Implement the provider contract after receiving official merchant onboarding and sandbox documentation.
export class FonepayPaymentProvider extends PaymentProvider {}
