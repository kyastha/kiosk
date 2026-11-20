import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { openDatabase } from '../src/db.js';
import { createKioskSession } from '../src/activity.js';
import { createOrder, applyPaymentEvent, paymentLifetime } from '../src/orders.js';
import { cancelReview, scanPayment } from '../src/review.js';
import { FakePaymentProvider } from '../src/payments.js';
import { hash } from '../src/security.js';

function fixture(t) {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const config = { publicOrigin: 'https://print.example.edu.np', appSecret: 'review-test-secret' };
  db.prepare("INSERT INTO settings VALUES(1,'Test',500,10,20,100,24)").run();
  const owner = hash('review-owner');
  const documentId = randomUUID();
  db.prepare("INSERT INTO documents(id,owner_hash,file_name,page_count,created_at) VALUES(?,?,'test.pdf',2,?)").run(documentId,owner,Date.now());
  const session = createKioskSession(db,owner);
  const provider = new FakePaymentProvider(config.appSecret);
  const create = () => createOrder(db,config,provider,{ownerHash:owner,idempotencyKey:randomUUID(),input:{documentId,sessionId:session.sessionId,customerName:'Test',copies:1,orientation:'portrait',scaling:'fit'}});
  const order = create();
  const key = new URL(order.statusUrl).searchParams.get('key');
  const payment = db.prepare('SELECT * FROM payments WHERE order_id=?').get(order.id);
  return {db,config,owner,session,provider,create,order,key,payment};
}

test('review QR binds the exact total to its browser session and rejects other sessions', t => {
  const f=fixture(t);
  const input={sessionId:f.session.sessionId,reference:f.payment.reference};
  const result=scanPayment(f.db,f.config,f.owner,input);
  assert.equal(result.total,1000);
  assert.equal(result.orderId,f.order.id);
  assert.throws(()=>scanPayment(f.db,f.config,hash('other'),input),{status:404});
  assert.throws(()=>scanPayment(f.db,f.config,f.owner,{...input,reference:'z'.repeat(43)}),{status:404});
  f.db.prepare('UPDATE payments SET created_at=? WHERE id=?').run(Date.now()-paymentLifetime-1,f.payment.id);
  assert.throws(()=>scanPayment(f.db,f.config,f.owner,input),{status:410});
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM print_jobs').get().n,0);
});

test('editing invalidates the prior QR and releases the session for a new unique payment',t=>{
  const f=fixture(t);
  assert.throws(()=>cancelReview(f.db,f.order.id,f.key,hash('other')),{status:404});
  const cancelled=cancelReview(f.db,f.order.id,f.key,f.owner);
  assert.deepEqual(cancelReview(f.db,f.order.id,f.key,f.owner),cancelled);
  const second=f.create();
  assert.notEqual(second.paymentUrl,f.order.paymentUrl);
  assert.equal(applyPaymentEvent(f.db,f.provider,f.payment,f.provider.simulate(f.payment,'success')),'FAILED');
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM print_jobs').get().n,0);
  cancelReview(f.db,f.order.id,f.key,f.owner);
  assert.equal(f.db.prepare('SELECT order_id FROM kiosk_sessions WHERE id=?').get(f.session.sessionId).order_id,second.id);
});

test('a paid review cannot be cancelled or detached from its session',t=>{
  const f=fixture(t);
  applyPaymentEvent(f.db,f.provider,f.payment,f.provider.simulate(f.payment,'success'));
  assert.throws(()=>cancelReview(f.db,f.order.id,f.key,f.owner),{status:409});
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM print_jobs').get().n,1);
  assert.equal(f.db.prepare('SELECT order_id FROM kiosk_sessions WHERE id=?').get(f.session.sessionId).order_id,f.order.id);
});
