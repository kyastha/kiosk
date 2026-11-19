import {
  ArrowLeft,
  CheckCircle2,
  CircleX,
  Download,
  ExternalLink,
  FlaskConical,
  Printer,
  QrCode,
  RefreshCw,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, dateTime, localLink, money, orderInfo, statusLabels, TEST_LABEL } from './api.js';
import { useLiveSnapshot } from './live.js';
import { PrintProgress } from './print-progress.jsx';
import { Details, ErrorMessage, Footer, Header, Loading, Status } from './ui.jsx';

function TestNotice() {
  return (
    <div className="notice notice-warning test-notice">
      <FlaskConical size={19} aria-hidden="true" />
      <strong>{TEST_LABEL}</strong>
    </div>
  );
}

function useResource(url, online, pollInterval = 0, shouldPoll) {
  const [value, setValue] = useState(null);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!online || !url) return;
    let timer;
    const controller = new AbortController();
    async function load() {
      try {
        const response = await api(url, { signal: controller.signal });
        setValue(response);
        setError('');
        if (shouldPoll && !shouldPoll(response)) return;
      } catch (problem) {
        if (problem.name === 'AbortError') return;
        setError(problem.message);
        if ([400, 401, 403, 404, 410].includes(problem.status)) return;
      }
      if (pollInterval && !controller.signal.aborted) timer = setTimeout(load, pollInterval);
    }
    load();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [url, online, pollInterval, revision, shouldPoll]);
  return { value, error, update: setValue, refresh: () => setRevision((count) => count + 1) };
}

export function Payment({ reference, online }) {
  const route = '/api/payments/' + encodeURIComponent(reference);
  const resource = useResource(reference && route, online);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState('');
  const payment = resource.value;
  const paid = payment?.paymentStatus === 'TEST_PAID';
  const failed = payment?.paymentStatus === 'FAILED';

  async function simulate(outcome) {
    if (busy || paid || failed) return;
    setBusy(true);
    setActionError('');
    try {
      resource.update(await api(route + '/simulate', { method: 'POST', body: { outcome } }));
    } catch (problem) {
      setActionError(problem.message);
      resource.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Header schoolName={payment?.schoolName} />
      <main id="main" tabIndex={-1} className="shell focused">
        <section className="card payment-card">
          <div className={'result-icon ' + (failed ? 'result-bad' : '')}>
            {paid ? <CheckCircle2 /> : failed ? <CircleX /> : <QrCode />}
          </div>
          <p className="eyebrow">PAYMENT SIMULATOR</p>
          <h1>{paid ? 'Test payment accepted' : failed ? 'Test payment failed' : 'Simulate payment'}</h1>
          <p className="muted">
            {paid || failed
              ? 'Return to the order tab for the latest print status.'
              : 'Choose an outcome for this school print order.'}
          </p>
          <TestNotice />
          <ErrorMessage
            message={actionError || resource.error || (!reference && 'This payment link is incomplete.')}
          >
            {!!reference && (
              <button type="button" className="text-button" disabled={!online} onClick={resource.refresh}>
                Refresh payment
              </button>
            )}
          </ErrorMessage>
          {!payment && !resource.error && reference && online && <Loading>Checking payment…</Loading>}
          {payment && (
            <>
              <Details
                rows={[
                  ['Order ID', payment.orderId],
                  ['School', payment.schoolName],
                  ['Amount', money(payment.total)],
                  [
                    'Status',
                    <Status value={payment.paymentStatus} label={statusLabels[payment.paymentStatus]} />,
                  ],
                ]}
              />
              {paid || failed ? (
                <a className="button secondary full" href="/">
                  <ArrowLeft size={18} aria-hidden="true" /> Return to kiosk
                </a>
              ) : (
                <div className="payment-actions">
                  <button
                    className="button primary full"
                    type="button"
                    onClick={() => simulate('success')}
                    disabled={busy || !online}
                  >
                    <CheckCircle2 size={20} aria-hidden="true" /> Payment Success
                  </button>
                  <button
                    className="button secondary full"
                    type="button"
                    onClick={() => simulate('failure')}
                    disabled={busy || !online}
                  >
                    <CircleX size={20} aria-hidden="true" /> Payment Failed
                  </button>
                </div>
              )}
              {busy && <Loading>Verifying test payment…</Loading>}
            </>
          )}
        </section>
        <Footer />
      </main>
    </>
  );
}

function PrintMessage({ status }) {
  const messages = {
    QUEUED: 'Your document is in the print queue. Keep this page open for updates.',
    PROCESSING: 'The kiosk is preparing your document for the printer.',
    SUBMITTED_TO_PRINTER: 'The job reached the printer queue. Wait for a completion update.',
    COMPLETED: 'The printer reports that your job is complete. Collect your pages at the kiosk.',
    COMPLETION_UNCONFIRMED:
      'The document was sent. Check the printer for your pages or ask a staff member for help.',
    RETRY_PENDING: 'A staff member can retry this job after checking the printer.',
    FAILED: 'Ask a staff member to check the printer. Keep your order ID handy.',
    CANCELLED: 'The print job was cancelled. Ask a staff member if you need help.',
  };
  return <p className="muted">{messages[status] || 'Waiting for a print status update.'}</p>;
}

const terminalPrintStates = ['COMPLETED', 'COMPLETION_UNCONFIRMED', 'CANCELLED'];
const shouldPollOrder = (order) =>
  order.paymentStatus !== 'FAILED' && !terminalPrintStates.includes(order.printStatus);

export function OrderStatus({ id, accessKey, online }) {
  const url =
    id && accessKey ? '/api/orders/' + encodeURIComponent(id) + '?key=' + encodeURIComponent(accessKey) : '';
  const live = useLiveSnapshot(url ? url.replace('/api/', '/ws/') : '', online);
  const resource = useResource(url, online && !live.connected, 2500, shouldPollOrder);
  const updateFallback = resource.update;
  useEffect(() => {
    if (live.connected && live.value) updateFallback(live.value);
  }, [live.connected, live.value, updateFallback]);
  const order = live.connected ? live.value : resource.value || live.value;
  const failed = order?.paymentStatus === 'FAILED';
  const paid = order?.paymentStatus === 'TEST_PAID';

  return (
    <>
      <Header schoolName={order?.schoolName} />
      <main id="main" tabIndex={-1} className="shell order-shell">
        <a className="text-button back-button" href="/">
          <ArrowLeft size={18} aria-hidden="true" /> New print order
        </a>
        {!order && (
          <div className="page-heading">
            <h1>Order status</h1>
          </div>
        )}
        <ErrorMessage message={(!live.connected && resource.error) || (!url && 'This order link is incomplete.')}>
          {url && (
            <button type="button" className="text-button" onClick={resource.refresh} disabled={!online}>
              <RefreshCw size={16} aria-hidden="true" /> Refresh status
            </button>
          )}
        </ErrorMessage>
        {!order && !resource.error && url && online && <Loading>Loading your order…</Loading>}
        {order && (
          <>
            <div className="page-heading">
              <p className="eyebrow">ORDER {order.id}</p>
              <h1>{paid ? 'Your print order' : failed ? 'Payment failed' : 'Complete test payment'}</h1>
              <p>
                {paid
                  ? 'Track your job and save your receipt.'
                  : failed
                    ? 'This order will stay out of the print queue.'
                    : 'Use the unique QR for this order or open the simulator here.'}
              </p>
            </div>
            <div className="setup-grid">
              <section className="card order-status-card">
                <div className="section-heading">
                  <span className="feature-icon">
                    {paid ? <Printer /> : failed ? <CircleX /> : <QrCode />}
                  </span>
                  <div>
                    <h2>{paid ? 'Print status' : 'Test payment'}</h2>
                    <p>{paid ? (live.connected ? 'Live updates' : 'Updates automatically') : money(order.total)}</p>
                  </div>
                </div>
                <TestNotice />
                <div aria-live="polite" className="current-status">
                  <Status
                    value={paid ? order.printStatus : order.paymentStatus}
                    label={statusLabels[paid ? order.printStatus : order.paymentStatus]}
                  />
                  {paid && <PrintMessage status={order.printStatus} />}
                </div>
                {paid && <PrintProgress status={order.printStatus} />}
                {paid && order.receiptUrl && (
                  <a className="button primary full" href={order.receiptUrl} download>
                    <Download size={20} aria-hidden="true" /> Download PDF receipt
                  </a>
                )}
                {failed && (
                  <a className="button secondary full" href="/">
                    Start a new order
                  </a>
                )}
                {!paid && !failed && (
                  <>
                    <div className="payment-qr">
                      <img
                        src={order.paymentQrUrl}
                        width="208"
                        height="208"
                        alt="Payment QR code for this order"
                      />
                    </div>
                    <p className="muted qr-caption">
                      Scan with another device, or open the simulator on this phone.
                      {order.paymentExpiresAt && (
                        <>
                          <br />
                          Expires {dateTime(order.paymentExpiresAt)} (Nepal time).
                        </>
                      )}
                    </p>
                    <a
                      className="button primary full"
                      href={localLink(order.paymentUrl)}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      Open payment simulator <ExternalLink size={17} aria-hidden="true" />
                    </a>
                  </>
                )}
              </section>
              <section className="card order-detail-card">
                <h2>Order summary</h2>
                <Details
                  rows={[
                    ...orderInfo(order),
                    ['Ordered', dateTime(order.createdAt)],
                    ...(paid && order.receiptNumber ? [['Receipt number', order.receiptNumber]] : []),
                  ]}
                />
                {order.items?.length > 1 && (
                  <ul className="order-cart-items" aria-label="Files in this order">
                    {order.items.map((item, index) => (
                      <li key={index}>
                        <div><strong>{item.fileName}</strong><small>{item.pageRanges || 'All pages'} · {item.printablePages} selected</small></div>
                        <span>{money(item.total)}</span>
                      </li>
                    ))}
                  </ul>
                )}
                <div className="price-row">
                  <span>Total</span>
                  <strong>{money(order.total)}</strong>
                </div>
              </section>
            </div>
          </>
        )}
        <Footer />
      </main>
    </>
  );
}
