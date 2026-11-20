const paymentPath = /^\/(?:pay|payment)\/([A-Za-z0-9_-]{43})$/;
const invalidPayment = 'Scan a payment QR from this kiosk.';

export function decodePaymentUrl(value, origin) {
  if (typeof value !== 'string' || value.length > 2048 ||
      /[\u0000-\u0020\u007f\\]/u.test(value)) throw new Error(invalidPayment);
  let url;
  let expected;
  try {
    url = new URL(value);
    expected = new URL(origin);
  } catch {
    throw new Error(invalidPayment);
  }
  const match = paymentPath.exec(url.pathname);
  if (!['http:', 'https:'].includes(expected.protocol) || expected.origin !== origin ||
      url.origin !== expected.origin || url.username || url.password || !match ||
      value !== url.origin + url.pathname) throw new Error(invalidPayment);
  return { reference: match[1] };
}

