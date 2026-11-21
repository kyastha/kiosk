export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

export async function api(path, { method = 'GET', body, signal, headers = {} } = {}) {
  const form = body instanceof FormData;
  let response;
  try {
    response = await fetch(path, {
      method,
      signal,
      credentials: 'same-origin',
      headers: { ...(body === undefined || form ? {} : { 'Content-Type': 'application/json' }), ...headers },
      body: body === undefined || form ? body : JSON.stringify(body),
      cache: 'no-store',
    });
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    throw new ApiError('Cannot reach the kiosk. Connect to the school network and try again.', 0);
  }
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new ApiError(
      data?.error || 'The kiosk could not complete that request. Please try again.',
      response.status,
    );
  }
  if (!data && response.status !== 204) {
    throw new ApiError('The kiosk returned an unexpected response. Please try again.', response.status);
  }
  return data;
}

export const TEST_LABEL = 'TEST PAYMENT — NO REAL MONEY TRANSFERRED';
const moneyFormat = new Intl.NumberFormat('en-NP', { maximumFractionDigits: 2 });
export const money = (paisa) => 'NPR ' + moneyFormat.format(paisa / 100);
const dateFormat = new Intl.DateTimeFormat('en-NP', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'Asia/Kathmandu',
});
export const dateTime = (time) =>
  time && Number.isFinite(new Date(time).valueOf()) ? dateFormat.format(new Date(time)) : '—';

export const statusLabels = {
  PENDING: 'Awaiting payment',
  PENDING_PAYMENT: 'Awaiting payment',
  TEST_PAID: 'Test paid',
  PAYMENT_FAILED: 'Payment failed',
  PAID: 'Paid',
  QUEUED: 'Queued',
  PROCESSING: 'Preparing',
  SUBMITTED_TO_PRINTER: 'Sent to printer',
  COMPLETED: 'Printer reports complete',
  COMPLETION_UNCONFIRMED: 'Sent · output unconfirmed',
  RETRY_PENDING: 'Waiting to retry',
  FAILED: 'Failed',
  CANCELLED: 'Cancelled',
};
export const scaleLabels = { fit: 'Fit to page', actual: 'Actual size', custom: 'Custom scale' };

export function orderInfo(order) {
  const multiple = order.items?.length > 1;
  return [
    ['Customer', order.customerName],
    ...(multiple
      ? [['Documents', order.items.length]]
      : [['Document', order.fileName], ['Pages', order.pageRanges || 'All pages']]),
    ['Printable pages', order.printablePages],
    ['Copies', order.copies],
    ['Paper and mode', 'A4 · Black & white'],
    ['Orientation', order.orientation === 'landscape' ? 'Landscape' : 'Portrait'],
    ['Scaling', order.scaling === 'custom' ? order.scalePercent + '%' : scaleLabels[order.scaling]],
    ['Price per page', money(order.pricePerPage)],
  ].filter(([, value]) => value !== undefined && value !== null);
}

export function localLink(url) {
  const path = new URL(url, window.location.origin);
  return window.location.origin + path.pathname + path.search + path.hash;
}
