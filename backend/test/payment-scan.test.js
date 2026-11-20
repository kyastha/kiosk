import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodePaymentUrl } from '../../frontend/src/payment-scan.js';

const origin = 'https://print.example.edu.np';
const reference = 'a'.repeat(43);
const paymentUrl = origin + '/pay/' + reference;

test('scanner accepts exact kiosk payment URLs and extracts only the opaque reference', () => {
  assert.equal(reference.length, 43);
  assert.deepEqual(decodePaymentUrl(paymentUrl, origin), { reference });
  assert.deepEqual(decodePaymentUrl(origin + '/payment/' + reference, origin), { reference });
  assert.deepEqual(decodePaymentUrl('http://localhost:3000/pay/' + reference, 'http://localhost:3000'), { reference });
});

test('scanner rejects foreign origins, credentials and paths that change payment meaning', () => {
  const invalid = [
    null, {}, '', reference, '/pay/' + reference,
    'https://elsewhere.example/pay/' + reference,
    'http://print.example.edu.np/pay/' + reference,
    'https://print.example.edu.np:444/pay/' + reference,
    'https://user:password@print.example.edu.np/pay/' + reference,
    'https://print.example.edu.np@elsewhere.example/pay/' + reference,
    origin + '/pay/' + reference + '?amount=1',
    origin + '/pay/' + reference + '?',
    origin + '/pay/' + reference + '#success',
    origin + '/pay/' + reference + '#',
    origin + '/pay/' + reference + '/',
    origin + '/pay/' + reference.slice(1),
    origin + '/pay/' + reference + 'a',
    origin + '/pay/%61' + reference.slice(1),
    origin + '/pay/../pay/' + reference,
    origin + '//pay/' + reference,
    origin + '/kiosk/' + reference,
    origin + '/pay/' + reference + '\n',
    origin + '\\pay\\' + reference,
    ' ' + paymentUrl,
    'javascript:alert(1)',
    'data:text/plain,' + paymentUrl,
  ];
  for (const value of invalid) {
    assert.throws(() => decodePaymentUrl(value, origin), /Scan a payment QR from this kiosk\./);
  }
  assert.throws(() => decodePaymentUrl(paymentUrl, origin + '/'), /Scan a payment QR/);
});

