import {
  ArrowRight,
  Check,
  ChevronLeft,
  ChevronRight,
  CloudDownload,
  FileText,
  LockKeyhole,
  Printer,
  ScanLine,
  Trash2,
  Upload,
  UserRound,
} from 'lucide-react';
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { api, localLink, money, orderInfo } from './api.js';
import { Details, ErrorMessage, Footer, Header, Loading } from './ui.jsx';
import { useKioskActivity } from './activity.js';
import PaymentCamera from './payment-camera.jsx';
import './cart.css';

const Preview = lazy(() => import('./preview.jsx'));
const fileExtensions = [
  '.pdf',
  '.jpg',
  '.jpeg',
  '.png',
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
  '.ppt',
  '.pptx',
  '.txt',
];
const allPages = { type: 'all', value: '' };
const initialOptions = {
  copies: 1,
  orientation: 'portrait',
  scaling: 'fit',
  scalePercent: 100,
};

function requestKey() {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

function Progress({ step }) {
  return (
    <ol className="progress" aria-label="Print order progress">
      {['Upload', 'Print settings', 'Payment'].map((name, index) => (
        <li
          key={name}
          className={step >= index ? 'step-active' : ''}
          aria-current={step === index ? 'step' : undefined}
        >
          <span>{step > index ? <Check size={15} aria-hidden="true" /> : index + 1}</span>
          {name}
        </li>
      ))}
    </ol>
  );
}

function Welcome({ config }) {
  return (
    <section className="hero" aria-labelledby="welcome">
      <div className="hero-copy">
        <p className="eyebrow">
          <span className="live-dot" /> STUDENT &amp; STAFF PRINTING
        </p>
        <h1 id="welcome">
          Print from
          <br />
          your phone.
        </h1>
        <p className="hero-caption">
          Upload your files, choose your settings and collect your pages at the school kiosk.
        </p>
        <div className="hero-meta">
          <span>A4 · Black &amp; white</span>
          {config && <span>{money(config.pricePerPage)} per page</span>}
        </div>
      </div>
      <div className="hero-art" aria-hidden="true">
        <div className="orbit orbit-outer" />
        <div className="orbit orbit-inner" />
        <div className="art-paper">
          <span />
          <span />
          <span />
        </div>
        <div className="art-printer">
          <i />
          <b />
        </div>
        <div className="art-output">
          <span />
          <span />
        </div>
        <span className="art-scan">
          <ScanLine size={23} />
        </span>
      </div>
    </section>
  );
}

function UploadStep({ config, customerName, setName, online, cart, setCart, onContinue, activity }) {
  const maxDocuments = config.maxCartFiles ?? 8;
  const fileRef = useRef(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [drivePicker, setDrivePicker] = useState(null);
  const [driveError, setDriveError] = useState('');
  const [driveAttempt, setDriveAttempt] = useState(0);

  useEffect(() => {
    if (!config.drive || !online) return;
    let active = true;
    setDriveError('');
    import('./drive.js')
      .then(({ prepareDrivePicker }) => prepareDrivePicker())
      .then((pick) => {
        if (active) setDrivePicker(() => pick);
      })
      .catch(() => {
        if (active) setDriveError('Google Drive could not load. You can upload a file from your device.');
      });
    return () => {
      active = false;
    };
  }, [config.drive, online, driveAttempt]);

  function choose(files) {
    const accepted = [];
    const errors = [];
    for (const file of files) {
      if (cart.length + accepted.length >= maxDocuments) {
        errors.push('You can add up to ' + maxDocuments + ' files per order.');
        break;
      }
      const extension = file.name.includes('.') ? '.' + file.name.split('.').pop().toLowerCase() : '';
      if (!fileExtensions.includes(extension)) {
        errors.push(
          'Choose a PDF, image, Word, Excel, PowerPoint or text file instead of ' + file.name + '.',
        );
      } else if (file.size > config.maxFileMb * 1024 * 1024) {
        errors.push(file.name + ' exceeds the ' + config.maxFileMb + ' MB limit.');
      } else {
        accepted.push({ key: requestKey(), file });
      }
    }
    if (accepted.length) {
      setCart((current) => [...current, ...accepted]);
      activity?.report('SELECTING', cart.length + accepted.length);
    }
    setError(errors.join(' '));
  }

  async function fromDrive() {
    if (!drivePicker) return;
    setBusy('Opening Google Drive…');
    setError('');
    try {
      const file = await drivePicker(config.drive, config.maxFileMb);
      if (file) choose([file]);
    } catch (problem) {
      setError(problem.message);
    } finally {
      setBusy('');
    }
  }

  async function submit(event) {
    event.preventDefault();
    if (!cart.length || busy || !online) return;
    if (!customerName.trim()) {
      setError('Enter your name to continue.');
      return;
    }
    setError('');
    setBusy('Connecting to the kiosk…');
    let sessionId;
    try {
      activity?.report('UPLOADING', cart.length);
      sessionId = await activity?.session();
    } catch (problem) {
      setError(problem.message);
      setBusy('');
      return;
    }
    for (const [index, entry] of cart.entries()) {
      if (entry.document) continue;
      setBusy('Preparing document ' + (index + 1) + ' of ' + cart.length + '…');
      const body = new FormData();
      body.set('file', entry.file);
      try {
        const document = await api('/api/documents', {
          method: 'POST', body, headers: sessionId ? { 'X-Kiosk-Session': sessionId } : {},
        });
        setCart((current) =>
          current.map((item) => (item.key === entry.key ? { key: item.key, document } : item)),
        );
      } catch (problem) {
        setError(entry.file.name + ' — ' + problem.message);
        activity?.report('SELECTING', cart.length);
        setBusy('');
        return;
      }
    }
    setBusy('');
    onContinue();
  }

  return (
    <form className="card upload-card" onSubmit={submit}>
      <div className="section-heading">
        <span className="feature-icon">
          <Upload size={22} aria-hidden="true" />
        </span>
        <div>
          <h2>Start a print order</h2>
          <p>Enter your name and add up to {maxDocuments} files.</p>
        </div>
      </div>
      <label className="field">
        <span>Your name</span>
        <span className="input-icon">
          <UserRound size={18} aria-hidden="true" />
          <input
            autoComplete="name"
            value={customerName}
            onChange={(event) => setName(event.target.value)}
            placeholder="e.g. Aashna Sharma"
            required
            maxLength={100}
            disabled={!!busy}
          />
        </span>
      </label>
      <input
        type="file"
        id="document-input"
        className="visually-hidden"
        aria-label="Document file"
        accept={fileExtensions.join(',')}
        multiple
        ref={fileRef}
        onChange={(event) => {
          choose(event.target.files);
          event.target.value = '';
        }}
        tabIndex={-1}
      />
      <button
        type="button"
        className="dropzone"
        disabled={!!busy || cart.length >= maxDocuments}
        onClick={() => fileRef.current?.click()}
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault();
          if (!busy) choose(event.dataTransfer.files);
        }}
      >
        <span className="drop-icon">
          <FileText aria-hidden="true" />
        </span>
        <strong>{cart.length ? 'Add more files' : 'Choose files'}</strong>
        <span>PDF, image, Office or TXT · Up to {config.maxFileMb} MB each</span>
      </button>
      {config.drive && (
        <button
          type="button"
          className="button secondary drive-button"
          onClick={fromDrive}
          disabled={!drivePicker || !online || !!busy || cart.length >= maxDocuments}
        >
          <CloudDownload size={19} aria-hidden="true" /> Choose from Google Drive
        </button>
      )}
      {cart.length > 0 && (
        <div className="cart-files">
          <p className="muted">
            {cart.length} of {maxDocuments} files added
          </p>
          <ul role="list" aria-label="Files to print">
            {cart.map(({ key, file, document }) => {
              const name = document?.fileName ?? file.name;
              return (
                <li key={key}>
                  <FileText size={18} aria-hidden="true" />
                  <span>{name}</span>
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={'Remove ' + name}
                    disabled={!!busy}
                    onClick={() => {
                      setCart((current) => current.filter((item) => item.key !== key));
                      activity?.report('SELECTING', cart.length - 1);
                      setError('');
                    }}
                  >
                    <Trash2 size={17} aria-hidden="true" />
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
      <ErrorMessage message={error} />
      <ErrorMessage message={driveError}>
        <button
          type="button"
          className="text-button"
          disabled={!online}
          onClick={() => setDriveAttempt((value) => value + 1)}
        >
          Retry Google Drive
        </button>
      </ErrorMessage>
      {busy && <Loading>{busy}</Loading>}
      <button className="button primary full" disabled={!cart.length || !online || !!busy} type="submit">
        {cart.length > 1 ? 'Preview documents' : 'Preview document'}
        <ArrowRight size={19} aria-hidden="true" />
      </button>
    </form>
  );
}

function SettingsStep({
  documents,
  customerName,
  config,
  online,
  onBack,
  kiosk,
  options,
  setOptions,
  ranges,
  setRanges,
  activity,
}) {
  const [previewId, setPreviewId] = useState(documents[0].id);
  const [quoteResult, setQuoteResult] = useState(null);
  const [quoteRevision, setQuoteRevision] = useState(0);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const [review, setReview] = useState(false);
  const [reviewedOrder, setReviewedOrder] = useState(null);
  const orderKey = useRef(null);
  useEffect(() => {
    if (!reviewedOrder) activity?.report(review ? 'REVIEW' : 'SETTINGS', documents.length);
  }, [activity, review, documents.length, reviewedOrder]);
  const document = documents.find((item) => item.id === previewId) ?? documents[0];
  const range = ranges[document.id] ?? allPages;
  const items = documents.map((item) => ({
    documentId: item.id,
    pageRanges: ranges[item.id]?.type === 'custom' ? ranges[item.id].value : '',
  }));
  const multiple = items.length > 1;
  const missingRange = documents.find(({ id }) => ranges[id]?.type === 'custom' && !ranges[id].value.trim());
  const input = JSON.stringify({
    ...(multiple ? { items } : items[0]),
    customerName: customerName.trim(),
    copies: Number(options.copies),
    orientation: options.orientation,
    scaling: options.scaling,
    ...(options.scaling === 'custom' ? { scalePercent: Number(options.scalePercent) } : {}),
  });
  const canQuote =
    online &&
    options.copies !== '' &&
    !missingRange &&
    (options.scaling !== 'custom' || options.scalePercent !== '');

  useEffect(() => {
    if (!canQuote) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      api('/api/quote', { method: 'POST', body: JSON.parse(input), signal: controller.signal })
        .then((data) => setQuoteResult({ input, data }))
        .catch((problem) => {
          if (problem.name !== 'AbortError') setQuoteResult({ input, error: problem.message });
        });
    }, 280);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [input, canQuote, quoteRevision]);

  function set(key, value) {
    setOptions((current) => ({ ...current, [key]: value }));
    setError('');
  }

  function setRange(change) {
    setRanges((current) => ({ ...current, [document.id]: { ...range, ...change } }));
    setError('');
  }

  const matchingQuote = quoteResult?.input === input ? quoteResult : null;
  const quote = canQuote && matchingQuote?.data;

  async function create(event) {
    event.preventDefault();
    if (!quote || creating) return;
    setCreating(true);
    setError('');
    try {
      if (orderKey.current?.input !== input) orderKey.current = { input, key: requestKey() };
      if (!orderKey.current.sessionReady) {
        orderKey.current.sessionId = await activity?.session();
        orderKey.current.sessionReady = true;
      }
      const sessionId = orderKey.current.sessionId;
      const order = await api('/api/orders', {
        method: 'POST',
        headers: { 'Idempotency-Key': orderKey.current.key },
        body: {
          ...JSON.parse(input), expectedTotal: quote.total, ...(kiosk ? { kiosk: true } : {}),
          ...(sessionId ? { sessionId } : {}),
        },
      });
      setReviewedOrder({ ...order, sessionId });
      setReview(true);
      if (sessionId) sessionStorage.setItem('kiosk-reviewed-order', JSON.stringify({ sessionId, orderId: order.id, statusUrl: localLink(order.statusUrl) }));
      window.scrollTo({ top: 0 });
    } catch (problem) {
      setError(problem.message);
      setCreating(false);
      if (problem.status === 409) {
        orderKey.current = null;
        setReview(false);
        setQuoteResult(null);
        setQuoteRevision((value) => value + 1);
      }
    } finally {
      setCreating(false);
    }
  }

  async function editReview() {
    if (!reviewedOrder || creating) return;
    setCreating(true);
    setError('');
    try {
      const key = new URL(reviewedOrder.statusUrl).searchParams.get('key');
      await api('/api/orders/' + reviewedOrder.id + '/cancel-review', { method: 'POST', body: { key } });
      setReviewedOrder(null);
      orderKey.current = null;
      setReview(false);
    } catch (problem) {
      setError(problem.message);
      if (problem.status === 409) window.location.assign(localLink(reviewedOrder.statusUrl));
    } finally { setCreating(false); }
  }

  if (review) {
    return (
      <section className="card upload-card review-card">
        <button className="text-button" type="button" onClick={editReview} disabled={creating}>
          <ChevronLeft size={18} aria-hidden="true" /> Edit settings
        </button>
        <h1>Review your order</h1>
        <p className="muted">Confirm your files, settings and price.</p>
        {quote && (
          <>
            {multiple && (
              <ul className="cart-review" role="list" aria-label="Files in your order">
                {quote.items.map((item, index) => (
                  <li key={documents[index].id}>
                    <div>
                      <strong>{item.fileName}</strong>
                      <small>
                        {item.pageRanges ? 'Pages ' + item.pageRanges : 'All pages'}
                        {' · '}
                        {item.printablePages} selected
                      </small>
                    </div>
                    <strong>{money(item.total)}</strong>
                  </li>
                ))}
              </ul>
            )}
            <Details rows={orderInfo({ ...quote, customerName, fileName: document.fileName })} />
            <div className="price-row">
              <span>Total</span>
              <strong>{money(quote.total)}</strong>
            </div>
          </>
        )}
        {!online && <p className="muted">Reconnect to continue to payment.</p>}
        <ErrorMessage message={error} />
        {reviewedOrder?.sessionId ? (
          <PaymentCamera key={reviewedOrder.id} sessionId={reviewedOrder.sessionId}
            paymentOrigin={new URL(reviewedOrder.paymentUrl).origin} online={online && !creating}
            onVerified={() => activity?.complete()} />
        ) : (
          <a className="button primary full" href={reviewedOrder && localLink(reviewedOrder.statusUrl)}>View order</a>
        )}
      </section>
    );
  }

  return (
    <>
      <button type="button" className="text-button back-button" onClick={onBack}>
        <ChevronLeft size={18} aria-hidden="true" /> {multiple ? 'Change files' : 'Change document'}
      </button>
      <div className="page-heading">
        <p className="eyebrow">PRINT SETUP</p>
        <h1>Preview and configure</h1>
        <p>
          {multiple
            ? 'Check each file and choose its pages. Other settings apply to all files.'
            : 'Check your document and select what to print.'}
        </p>
      </div>
      <div className="setup-grid">
        <section className="card preview-card" aria-labelledby="preview-heading">
          <div className="section-heading">
            <span className="feature-icon">
              <FileText size={22} aria-hidden="true" />
            </span>
            <div>
              <h2 id="preview-heading">Document preview</h2>
              <p className="break-word">
                {document.fileName} · {document.pageCount} {document.pageCount === 1 ? 'page' : 'pages'}
              </p>
            </div>
          </div>
          {multiple && (
            <div className="cart-previews" role="group" aria-label="Choose a file to preview">
              {documents.map((item) => (
                <button
                  type="button"
                  className="button secondary"
                  key={item.id}
                  aria-pressed={item.id === document.id}
                  onClick={() => setPreviewId(item.id)}
                >
                  {item.fileName}
                </button>
              ))}
            </div>
          )}
          <Suspense fallback={<Loading>Loading PDF preview…</Loading>}>
            <Preview key={document.id} url={document.previewUrl} pageCount={document.pageCount} />
          </Suspense>
        </section>
        <form
          className="card settings-card"
          onSubmit={create}
        >
          <div className="section-heading">
            <span className="feature-icon">
              <Printer size={21} aria-hidden="true" />
            </span>
            <div>
              <h2>Print settings</h2>
              <p>A4 · Black &amp; white{multiple && ' · Shared copies, orientation and scaling'}</p>
            </div>
          </div>
          <div className="form-grid">
            <label className="field">
              <span>Copies</span>
              <input
                type="number"
                min={1}
                max={config.maxCopies}
                step={1}
                required
                value={options.copies}
                onChange={(event) => set('copies', event.target.value)}
              />
            </label>
            <label className="field">
              <span>Orientation</span>
              <select
                value={options.orientation}
                onChange={(event) => set('orientation', event.target.value)}
              >
                <option value="portrait">Portrait</option>
                <option value="landscape">Landscape</option>
              </select>
            </label>
          </div>
          {multiple && (
            <label className="field">
              <span>File for page selection</span>
              <select value={document.id} onChange={(event) => setPreviewId(event.target.value)}>
                {documents.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.fileName}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="field">
            <span>Pages to print</span>
            <select value={range.type} onChange={(event) => setRange({ type: event.target.value })}>
              <option value="all">All pages ({document.pageCount})</option>
              <option value="custom">Custom range</option>
            </select>
          </label>
          {range.type === 'custom' && (
            <label className="field">
              <span>Page range</span>
              <input
                placeholder="e.g. 1-3, 5"
                value={range.value}
                onChange={(event) => setRange({ value: event.target.value })}
                required
                maxLength={2000}
              />
            </label>
          )}
          <label className="field">
            <span>Scaling</span>
            <select value={options.scaling} onChange={(event) => set('scaling', event.target.value)}>
              <option value="fit">Fit to page</option>
              <option value="actual">Actual size</option>
              <option value="custom">Custom scale</option>
            </select>
          </label>
          {options.scaling === 'custom' && (
            <label className="field">
              <span>Scale (%)</span>
              <input
                type="number"
                min={25}
                max={200}
                step={1}
                required
                value={options.scalePercent}
                onChange={(event) => set('scalePercent', event.target.value)}
              />
            </label>
          )}
          <div className="price-row" aria-live="polite">
            <span>Estimated total</span>
            <strong>{quote ? money(quote.total) : '—'}</strong>
          </div>
          {quote && (
            <p className="price-note">
              {quote.printablePages} {quote.printablePages === 1 ? 'page' : 'pages'} × {quote.copies}{' '}
              {quote.copies === 1 ? 'copy' : 'copies'} × {money(quote.pricePerPage)}
            </p>
          )}
          <ErrorMessage message={error || (canQuote && matchingQuote?.error)} />
          {missingRange && (
            <p className="price-note">
              Enter a page range for {missingRange.fileName} to calculate the total.
            </p>
          )}
          {canQuote && !matchingQuote && <Loading>Calculating price…</Loading>}
          <button className="button primary full" type="submit" disabled={!quote || creating}>
            {creating ? 'Preparing payment QR…' : 'Review order'}
            <ArrowRight size={19} aria-hidden="true" />
          </button>
        </form>
      </div>
    </>
  );
}

export function Checkout({ online }) {
  const [config, setConfig] = useState(null);
  const [error, setError] = useState('');
  const [customerName, setName] = useState('');
  const [cart, setCart] = useState([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [options, setOptions] = useState(initialOptions);
  const [ranges, setRanges] = useState({});
  const [attempt, setAttempt] = useState(0);
  const kiosk = new URLSearchParams(window.location.search).get('kiosk') === '1';
  const activity = useKioskActivity(Boolean(config), online);

  useEffect(() => {
    if (!online) return;
    const controller = new AbortController();
    api('/api/config', { signal: controller.signal })
      .then((data) => {
        setConfig(data);
        setError('');
      })
      .catch((problem) => {
        if (problem.name !== 'AbortError') setError(problem.message);
      });
    return () => controller.abort();
  }, [online, attempt]);

  function changeStep(value) {
    setSettingsOpen(value);
    activity?.report(value ? 'SETTINGS' : 'SELECTING', cart.length);
    window.scrollTo({ top: 0 });
  }

  return (
    <>
      <Header schoolName={config?.schoolName} />
      <main className="shell checkout" id="main" tabIndex={-1}>
        {!settingsOpen && <Welcome config={config} />}
        <Progress step={settingsOpen ? 1 : 0} />
        <ErrorMessage message={error}>
          <button type="button" className="text-button" onClick={() => setAttempt((value) => value + 1)}>
            Try again <ChevronRight size={17} aria-hidden="true" />
          </button>
        </ErrorMessage>
        {!config && !error && online && <Loading>Connecting to the kiosk…</Loading>}
        {config &&
          (!settingsOpen ? (
            <div className="upload-layout">
              <UploadStep
                config={config}
                customerName={customerName}
                setName={setName}
                online={online}
                cart={cart}
                setCart={setCart}
                onContinue={() => changeStep(true)}
                activity={activity}
              />
              <aside className="how-card">
                <p className="eyebrow">HOW IT WORKS</p>
                <h2>Ready in three steps</h2>
                <ol>
                  <li>
                    <span>01</span>
                    <div>
                      <strong>Add your files</strong>
                      <p>Upload one or more files from your device.</p>
                    </div>
                  </li>
                  <li>
                    <span>02</span>
                    <div>
                      <strong>Review your print</strong>
                      <p>Check the PDF, pages, copies and price.</p>
                    </div>
                  </li>
                  <li>
                    <span>03</span>
                    <div>
                      <strong>Test pay and collect</strong>
                      <p>Track your job and download your receipt.</p>
                    </div>
                  </li>
                </ol>
                <p className="privacy-note">
                  <LockKeyhole size={16} aria-hidden="true" /> No school account required. Your files stay
                  private.
                </p>
              </aside>
            </div>
          ) : (
            <SettingsStep
              documents={cart.map((entry) => entry.document)}
              customerName={customerName}
              config={config}
              online={online}
              kiosk={kiosk}
              options={options}
              setOptions={setOptions}
              ranges={ranges}
              setRanges={setRanges}
              onBack={() => changeStep(false)}
              activity={activity}
            />
          ))}
        <Footer />
      </main>
    </>
  );
}
