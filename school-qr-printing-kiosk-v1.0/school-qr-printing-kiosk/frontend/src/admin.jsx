import {
  Activity,
  ArrowLeft,
  BarChart3,
  CalendarDays,
  ClipboardList,
  CreditCard,
  Download,
  Gauge,
  ListOrdered,
  LogOut,
  Printer,
  QrCode,
  Search,
  Settings2,
  ShieldCheck,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, dateTime, money, orderInfo, statusLabels, TEST_LABEL } from './api.js';
import { Details, ErrorMessage, Header, Loading, Status } from './ui.jsx';

const tabs = [
  ['overview', 'Overview', Gauge],
  ['orders', 'Orders', ClipboardList],
  ['payments', 'Payments', CreditCard],
  ['jobs', 'Print jobs', ListOrdered],
  ['printer', 'Printer', Printer],
  ['settings', 'Settings', Settings2],
  ['reports', 'Reports', BarChart3],
];
const jobFilters = [
  'QUEUED',
  'PROCESSING',
  'SUBMITTED_TO_PRINTER',
  'RETRY_PENDING',
  'FAILED',
  'COMPLETED',
  'COMPLETION_UNCONFIRMED',
  'CANCELLED',
];
const paymentFilters = ['TEST_PAID', 'FAILED', 'PENDING'];
const pageSize = 25;

function useAdminQuery(path, online, interval = 0) {
  const [result, setResult] = useState(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!online || !path) return;
    const controller = new AbortController();
    let timer;
    async function load() {
      try {
        const data = await api(path, { signal: controller.signal });
        setResult({ path, data });
      } catch (problem) {
        if (problem.name === 'AbortError') return;
        setResult({ path, error: problem.message });
        if (problem.status === 401) return;
      }
      if (interval && !controller.signal.aborted) timer = setTimeout(load, interval);
    }
    load();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [path, online, interval, revision]);

  const current = result?.path === path ? result : null;
  return {
    data: current?.data,
    error: current?.error,
    pending: online && !!path && !current,
    refresh: () => setRevision((value) => value + 1),
  };
}

function AdminPageTitle({ title, text, children }) {
  return (
    <div className="admin-title">
      <div>
        <p className="eyebrow">KIOSK ADMIN</p>
        <h1>{title}</h1>
        <p>{text}</p>
      </div>
      {children}
    </div>
  );
}

function AdminState({ query }) {
  return (
    <>
      <ErrorMessage message={query.error}>
        <button className="text-button" type="button" onClick={query.refresh}>
          Try again
        </button>
      </ErrorMessage>
      {query.pending && <Loading>Loading dashboard data…</Loading>}
    </>
  );
}

function StatGrid({ values }) {
  return (
    <div className="stats-grid">
      {values.map(([label, value]) => (
        <div className="card stat-card" key={label}>
          <span>{label}</span>
          <strong>{value ?? '—'}</strong>
        </div>
      ))}
    </div>
  );
}

function Overview({ online }) {
  const query = useAdminQuery('/api/admin/overview', online, 5000);
  const stats = query.data;
  return (
    <>
      <AdminPageTitle title="Overview" text="Monitor the school print kiosk." />
      <div className="notice notice-warning">
        <strong>{TEST_LABEL}</strong>
      </div>
      <AdminState query={query} />
      {stats && (
        <>
          <StatGrid
            values={[
              ['Total orders', stats.totalOrders],
              ['Successful test payments', stats.testPaid],
              ['Failed test payments', stats.failedPayments],
              ['Test transaction total', money(stats.testAmount)],
              ['Pending print jobs', stats.pendingJobs],
              ['Completed print jobs', stats.completedJobs],
              ['Output unconfirmed', stats.unconfirmedJobs],
              ['Failed print jobs', stats.failedJobs],
            ]}
          />
          <section className="card panel">
            <div className="section-heading">
              <span className="feature-icon">
                <Activity size={22} />
              </span>
              <div>
                <h2>Printer status</h2>
                <p>Last reported by the kiosk print agent.</p>
              </div>
            </div>
            <PrinterSummary printer={stats.printer} />
          </section>
        </>
      )}
    </>
  );
}

function PrinterSummary({ printer }) {
  if (!printer) return <p className="muted">Waiting for the kiosk print agent.</p>;
  const reasons = Array.isArray(printer.reasons) ? printer.reasons.join(', ') : printer.reasons;
  return (
    <Details
      rows={[
        ['CUPS queue', printer.queue || 'Unconfigured'],
        ['Status', <Status value={printer.status} />],
        ['Availability and errors', reasons || 'No errors reported'],
        ['Agent last seen', dateTime(printer.lastSeen)],
        [
          'Active CUPS jobs',
          Array.isArray(printer.activeJobs) ? printer.activeJobs.length : printer.activeJobs,
        ],
      ]}
    />
  );
}

function DateFilters({ from, to, update }) {
  return (
    <>
      <label className="field">
        <span>From date</span>
        <input type="date" value={from} onChange={(event) => update('from', event.target.value)} />
      </label>
      <label className="field">
        <span>To date</span>
        <input
          type="date"
          value={to}
          min={from || undefined}
          onChange={(event) => update('to', event.target.value)}
        />
      </label>
    </>
  );
}

function OrderTable({ orders, onOrder, mode }) {
  if (!orders.length) return <p className="empty">No matching orders.</p>;
  return (
    <div className="table-scroll" tabIndex={0} aria-label="Order results">
      <table>
        <thead>
          <tr>
            <th>Order</th>
            <th>Customer</th>
            <th>Created (Nepal)</th>
            <th>Test payment</th>
            <th>Printing</th>
            <th>Amount</th>
            {mode === 'payments' && <th>Payment reference</th>}
          </tr>
        </thead>
        <tbody>
          {orders.map((order) => (
            <tr key={order.id}>
              <td>
                <button type="button" className="text-button order-link" onClick={() => onOrder(order.id)}>
                  {order.id}
                </button>
              </td>
              <td>{order.customerName}</td>
              <td>{dateTime(order.createdAt)}</td>
              <td>
                <Status value={order.paymentStatus} label={statusLabels[order.paymentStatus]} />
              </td>
              <td>
                <Status value={order.printStatus} label={statusLabels[order.printStatus]} />
              </td>
              <td>{money(order.total)}</td>
              {mode === 'payments' && <td className="reference-cell">{order.paymentReference || '—'}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RecordHistory({ order }) {
  return (
    <>
      <h3>Print attempts</h3>
      {order.attempts?.length ? (
        <ul className="record-list">
          {order.attempts.map((attempt, index) => (
            <li key={attempt.id || index}>
              <div>
                <strong>Attempt {attempt.attemptNumber ?? index + 1}</strong>
                <Status value={attempt.status} label={statusLabels[attempt.status]} />
              </div>
              <small>
                {dateTime(attempt.createdAt || attempt.startedAt)}
                {attempt.cupsId ? ' · CUPS ' + attempt.cupsId : ''}
              </small>
              {attempt.error && <p>{attempt.error}</p>}
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">No attempts recorded.</p>
      )}
      <h3>Activity</h3>
      {order.events?.length ? (
        <ul className="record-list">
          {order.events.map((event, index) => (
            <li key={event.id || index}>
              <strong>{event.action || event.type}</strong>
              <small>{dateTime(event.createdAt || event.timestamp)}</small>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">No activity recorded.</p>
      )}
    </>
  );
}

function OrderDetail({ id, online, close, changed }) {
  const query = useAdminQuery('/api/admin/orders/' + encodeURIComponent(id), online);
  const order = query.data?.order || query.data;
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [confirm, setConfirm] = useState('');
  const canRetry =
    order?.paymentStatus === 'TEST_PAID' &&
    ['FAILED', 'RETRY_PENDING'].includes(order.printStatus) &&
    (order.retrySafe === true || order.retrySafe === 1);
  const canCancel =
    order?.paymentStatus === 'TEST_PAID' && ['QUEUED', 'RETRY_PENDING'].includes(order.printStatus);

  async function act(action) {
    setBusy(action);
    setError('');
    setMessage('');
    try {
      await api('/api/admin/jobs/' + encodeURIComponent(id) + '/' + action, { method: 'POST', body: {} });
      setMessage(action === 'retry' ? 'Retry queued.' : 'Print job cancelled.');
      query.refresh();
      changed();
    } catch (problem) {
      setError(problem.message);
    } finally {
      setBusy('');
      setConfirm('');
    }
  }

  return (
    <section className="card panel admin-detail" aria-label="Order details">
      <button type="button" className="text-button" onClick={close}>
        <ArrowLeft size={16} aria-hidden="true" /> Back to order list
      </button>
      <h2>Order details</h2>
      <p className="muted break-word">{id}</p>
      <AdminState query={query} />
      {order && (
        <>
          <Details
            rows={[
              ...orderInfo(order),
              ['Created', dateTime(order.createdAt)],
              ['Test payment reference', order.paymentReference],
              [
                'Payment status',
                <Status value={order.paymentStatus} label={statusLabels[order.paymentStatus]} />,
              ],
              ['Print status', <Status value={order.printStatus} label={statusLabels[order.printStatus]} />],
              ['Print error', order.printError],
              ['Test transaction amount', money(order.total)],
            ]}
          />
          {order.printStatus === 'FAILED' && !canRetry && (
            <p className="muted">
              This attempt requires printer reconciliation before a retry can be released.
            </p>
          )}
          <ErrorMessage message={error} />
          {message && (
            <p className="notice notice-success" role="status">
              {message}
            </p>
          )}
          {(canRetry || canCancel) && (
            <div className="inline-actions">
              {canRetry && (
                <button
                  className="button secondary"
                  type="button"
                  disabled={!!busy || !online}
                  onClick={() => setConfirm('retry')}
                >
                  Retry print job
                </button>
              )}
              {canCancel && (
                <button
                  className="button secondary"
                  type="button"
                  disabled={!!busy || !online}
                  onClick={() => setConfirm('cancel')}
                >
                  Cancel print job
                </button>
              )}
            </div>
          )}
          {confirm && (
            <div className="notice notice-warning confirmation">
              <p>
                {confirm === 'retry'
                  ? 'Queue another attempt for this order?'
                  : 'Cancel this queued print job?'}
              </p>
              <div className="inline-actions">
                <button
                  className="button primary"
                  type="button"
                  disabled={!!busy || !online}
                  onClick={() => act(confirm)}
                >
                  Confirm {confirm}
                </button>
                <button
                  className="button secondary"
                  type="button"
                  disabled={!!busy}
                  onClick={() => setConfirm('')}
                >
                  Go back
                </button>
              </div>
            </div>
          )}
          <RecordHistory order={order} />
        </>
      )}
    </section>
  );
}

function Orders({ mode, online }) {
  const initial = {
    q: '',
    from: '',
    to: '',
    paymentStatus: mode === 'payments' ? 'TEST_PAID' : '',
    printStatus: mode === 'jobs' ? 'QUEUED' : '',
  };
  const [filters, setFilters] = useState(initial);
  const [search, setSearch] = useState(initial);
  const [page, setPage] = useState(0);
  const [id, setId] = useState('');
  const dateQuery = new URLSearchParams(Object.entries(search).filter(([, value]) => value !== ''));
  const params = new URLSearchParams(dateQuery);
  params.set('limit', pageSize);
  params.set('offset', page * pageSize);
  const query = useAdminQuery('/api/admin/orders?' + params.toString(), online, mode === 'jobs' ? 5000 : 0);
  const { orders = [], total = 0 } = query.data || {};
  const titles = {
    orders: ['Orders', 'Find orders by customer, order ID or date.'],
    payments: ['Test payments', 'Review simulated transactions and their references.'],
    jobs: ['Print jobs', 'Review the queue, previous attempts and print failures.'],
  };

  function update(key, value) {
    setFilters((current) => ({ ...current, [key]: value }));
  }

  return (
    <>
      <AdminPageTitle title={titles[mode][0]} text={titles[mode][1]}>
        {mode === 'payments' && (
          <a className="button secondary" href={'/api/admin/reports.csv?' + dateQuery.toString()} download>
            <Download size={18} /> Export CSV
          </a>
        )}
      </AdminPageTitle>
      <div className="notice notice-warning">
        <strong>{TEST_LABEL}</strong>
      </div>
      {id ? (
        <OrderDetail id={id} online={online} close={() => setId('')} changed={query.refresh} />
      ) : (
        <>
          <form
            className="card panel filters"
            onSubmit={(event) => {
              event.preventDefault();
              setSearch({ ...filters, q: filters.q.trim() });
              setPage(0);
              query.refresh();
            }}
          >
            <label className="field search-field">
              <span>Order ID or customer</span>
              <span className="input-icon">
                <Search size={17} />
                <input
                  value={filters.q}
                  onChange={(event) => update('q', event.target.value)}
                  placeholder="Search orders"
                  maxLength={100}
                />
              </span>
            </label>
            <DateFilters {...filters} update={update} />
            {mode !== 'jobs' && (
              <label className="field">
                <span>Payment status</span>
                <select
                  value={filters.paymentStatus}
                  onChange={(event) => update('paymentStatus', event.target.value)}
                >
                  <option value="">All payments</option>
                  {paymentFilters.map((status) => (
                    <option value={status} key={status}>
                      {statusLabels[status]}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {mode !== 'payments' && (
              <label className="field">
                <span>Print status</span>
                <select
                  value={filters.printStatus}
                  onChange={(event) => update('printStatus', event.target.value)}
                >
                  {mode !== 'jobs' && <option value="">All statuses</option>}
                  {jobFilters.map((status) => (
                    <option value={status} key={status}>
                      {statusLabels[status]}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <button className="button primary" type="submit" disabled={!online}>
              Apply filters
            </button>
          </form>
          <AdminState query={query} />
          {query.data && (
            <section className="card table-card">
              <OrderTable orders={orders} onOrder={setId} mode={mode} />
              <div className="pagination">
                <span>
                  {total ? page * pageSize + 1 : 0}–{page * pageSize + orders.length} of {total}
                </span>
                <div className="inline-actions">
                  <button
                    className="button secondary"
                    type="button"
                    disabled={page === 0}
                    onClick={() => setPage(page - 1)}
                  >
                    Previous
                  </button>
                  <button
                    className="button secondary"
                    type="button"
                    disabled={(page + 1) * pageSize >= total}
                    onClick={() => setPage(page + 1)}
                  >
                    Next
                  </button>
                </div>
              </div>
            </section>
          )}
        </>
      )}
    </>
  );
}

function PrinterForm({ printer, online, changed }) {
  const [queue, setQueue] = useState(printer?.queue || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  async function run(path, method, body, success) {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const result = await api(path, { method, body });
      setMessage(success + (result?.jobId ? ' Job ' + result.jobId + '.' : ''));
      changed();
    } catch (problem) {
      setError(problem.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card panel">
      <h2>Printer configuration</h2>
      <p className="muted">Enter the exact CUPS queue name configured on the Linux kiosk.</p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          run('/api/admin/printer', 'PATCH', { queue: queue.trim() }, 'Printer configuration saved.');
        }}
      >
        <label className="field">
          <span>CUPS queue name</span>
          <input value={queue} onChange={(event) => setQueue(event.target.value)} required maxLength={100} />
        </label>
        <div className="inline-actions">
          <button className="button primary" type="submit" disabled={!online || busy || !queue.trim()}>
            Save printer
          </button>
          <button
            className="button secondary"
            type="button"
            disabled={!online || busy || !printer?.queue}
            onClick={() => run('/api/admin/printer/test', 'POST', {}, 'Test page queued.')}
          >
            Queue test page
          </button>
        </div>
      </form>
      <ErrorMessage message={error} />
      {message && (
        <p className="notice notice-success" role="status">
          {message}
        </p>
      )}
    </section>
  );
}

function PrinterPage({ online }) {
  const query = useAdminQuery('/api/admin/overview', online, 5000);
  const printer = query.data?.printer;
  return (
    <>
      <AdminPageTitle title="Printer" text="Check the CUPS connection and queue." />
      <AdminState query={query} />
      {query.data && (
        <div className="admin-columns">
          <section className="card panel">
            <h2>Connection</h2>
            <PrinterSummary printer={printer} />
            {Array.isArray(printer?.activeJobs) && printer.activeJobs.length > 0 && (
              <>
                <h3>Current queue</h3>
                <ul className="record-list">
                  {printer.activeJobs.map((job, index) => (
                    <li key={job.id || job.cupsId || index}>
                      <strong>{job.id || job.cupsId || job.name || String(job)}</strong>
                      <small>{job.status}</small>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </section>
          <PrinterForm printer={printer} online={online} changed={query.refresh} />
        </div>
      )}
      <section className="card panel qr-admin">
        <div>
          <span className="feature-icon">
            <QrCode />
          </span>
          <h2>Permanent kiosk QR</h2>
          <p className="muted">Open the display on the kiosk monitor or place a printed code next to the printer.</p>
          <a className="button primary" href="/kiosk" target="_blank" rel="noopener">
            <QrCode size={18} /> Open kiosk display
          </a>
          <a className="button secondary" href="/api/kiosk/qr" download="school-print-kiosk.png">
            <Download size={18} /> Download access QR
          </a>
        </div>
        <img src="/api/kiosk/qr" width="180" height="180" alt="Permanent kiosk access QR" />
      </section>
    </>
  );
}

function SettingsForm({ config, online, changed }) {
  const [settings, setSettings] = useState(() => ({
    schoolName: config.schoolName,
    pricePerPage: (config.pricePerPage / 100).toFixed(2),
    maxCopies: config.maxCopies,
    maxFileMb: config.maxFileMb,
    maxPages: config.maxPages,
    retentionHours: config.retentionHours,
  }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  function update(key, value) {
    setSettings((current) => ({ ...current, [key]: value }));
    setSaved(false);
  }

  async function save(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api('/api/admin/settings', {
        method: 'PATCH',
        body: {
          schoolName: settings.schoolName.trim(),
          pricePerPage: Math.round(Number(settings.pricePerPage) * 100),
          maxCopies: Number(settings.maxCopies),
          maxFileMb: Number(settings.maxFileMb),
          maxPages: Number(settings.maxPages),
          retentionHours: Number(settings.retentionHours),
        },
      });
      setSaved(true);
      changed();
    } catch (problem) {
      setError(problem.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card panel settings-form" onSubmit={save}>
      <label className="field">
        <span>School name</span>
        <input
          value={settings.schoolName}
          maxLength={120}
          required
          onChange={(event) => update('schoolName', event.target.value)}
        />
      </label>
      <div className="form-grid">
        {[
          ['pricePerPage', 'Price per page (NPR)', 0.01, 1000, 0.01],
          ['maxCopies', 'Maximum copies', 1, 100, 1],
          ['maxFileMb', 'Maximum upload (MB)', 1, 50, 1],
          ['maxPages', 'Maximum pages', 1, 500, 1],
          ['retentionHours', 'Document retention (hours)', 1, 8760, 1],
        ].map(([key, label, min, max, step]) => (
          <label className="field" key={key}>
            <span>{label}</span>
            <input
              type="number"
              min={min}
              max={max}
              step={step}
              required
              value={settings[key]}
              onChange={(event) => update(key, event.target.value)}
            />
          </label>
        ))}
      </div>
      <p className="muted">Price changes apply to new orders. Existing orders keep their original price.</p>
      <ErrorMessage message={error} />
      {saved && (
        <p className="notice notice-success" role="status">
          Settings saved.
        </p>
      )}
      <button type="submit" className="button primary" disabled={busy || !online}>
        {busy ? 'Saving…' : 'Save settings'}
      </button>
    </form>
  );
}

function SettingsPage({ online, changed }) {
  const query = useAdminQuery('/api/admin/settings', online);
  return (
    <>
      <AdminPageTitle title="Settings" text="Manage the price and document limits." />
      <AdminState query={query} />
      {query.data && (
        <SettingsForm
          config={query.data}
          online={online}
          changed={() => {
            query.refresh();
            changed();
          }}
        />
      )}
    </>
  );
}

function ReportTable({ title, rows }) {
  return (
    <section className="card table-card">
      <h2 className="table-title">{title}</h2>
      {!rows?.length ? (
        <p className="empty">No orders in this period.</p>
      ) : (
        <div className="table-scroll" tabIndex={0} aria-label={title}>
          <table>
            <thead>
              <tr>
                <th>Period</th>
                <th>Orders</th>
                <th>Pages</th>
                <th>Copies</th>
                <th>Print failures</th>
                <th>Test amount</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => (
                <tr key={row.period || row.date || row.month || row.day || index}>
                  <td>{row.period || row.date || row.month || row.day}</td>
                  <td>{row.orders ?? row.totalOrders}</td>
                  <td>{row.pages ?? row.totalPages}</td>
                  <td>{row.copies ?? row.totalCopies}</td>
                  <td>{row.failedJobs}</td>
                  <td>{money(row.testAmount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function Reports({ online }) {
  const [filters, setFilters] = useState({ from: '', to: '' });
  const [search, setSearch] = useState('');
  const query = useAdminQuery('/api/admin/reports?' + search, online);
  const report = query.data;
  return (
    <>
      <AdminPageTitle title="Reports" text="Daily and monthly activity in Nepal time.">
        <a className="button secondary" href={'/api/admin/reports.csv?' + search} download>
          <Download size={18} /> Export CSV
        </a>
      </AdminPageTitle>
      <div className="notice notice-warning">
        <strong>{TEST_LABEL}</strong>
      </div>
      <form
        className="card panel filters"
        onSubmit={(event) => {
          event.preventDefault();
          setSearch(new URLSearchParams(Object.entries(filters).filter(([, value]) => value)).toString());
          query.refresh();
        }}
      >
        <DateFilters {...filters} update={(key, value) => setFilters({ ...filters, [key]: value })} />
        <button className="button primary" type="submit" disabled={!online}>
          <CalendarDays size={18} /> Apply dates
        </button>
      </form>
      <AdminState query={query} />
      {report && (
        <>
          <StatGrid
            values={[
              ['Total pages', report.totalPages],
              ['Total copies', report.totalCopies],
              ['Failed jobs', report.failedJobs],
              ['Test transaction total', money(report.testAmount)],
            ]}
          />
          <ReportTable title="Daily activity" rows={report.daily} />
          <ReportTable title="Monthly activity" rows={report.monthly} />
        </>
      )}
    </>
  );
}

function Login({ online, onLogin }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function login(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api('/api/admin/login', { method: 'POST', body: { username: username.trim(), password } });
      onLogin();
    } catch (problem) {
      setError(problem.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main id="main" tabIndex={-1} className="shell focused">
      <form className="card panel login-card" onSubmit={login}>
        <span className="feature-icon">
          <ShieldCheck />
        </span>
        <p className="eyebrow">STAFF ACCESS</p>
        <h1>Administrator sign in</h1>
        <p className="muted">Use your school kiosk admin account.</p>
        <label className="field">
          <span>Username</span>
          <input
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            autoComplete="username"
            required
          />
        </label>
        <label className="field">
          <span>Password</span>
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
            required
          />
        </label>
        <ErrorMessage message={error} />
        <button className="button primary full" disabled={!online || busy} type="submit">
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
        <a className="text-button" href="/">
          <ArrowLeft size={18} /> Back to kiosk
        </a>
      </form>
    </main>
  );
}

export default function Admin({ online }) {
  const [session, setSession] = useState('loading');
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const [section, setSection] = useState('overview');
  const config = useAdminQuery('/api/config', online);

  useEffect(() => {
    if (!online) return;
    const controller = new AbortController();
    api('/api/admin/session', { signal: controller.signal })
      .then(() => {
        setSession('active');
        setError('');
      })
      .catch((problem) => {
        if (problem.name === 'AbortError') return;
        setSession(problem.status === 401 || problem.status === 403 ? 'signed-out' : 'error');
        if (problem.status !== 401 && problem.status !== 403) setError(problem.message);
      });
    return () => controller.abort();
  }, [online, revision]);

  async function logout() {
    setError('');
    try {
      await api('/api/admin/logout', { method: 'POST', body: {} });
      setSession('signed-out');
    } catch (problem) {
      if (problem.status === 401) setSession('signed-out');
      else setError(problem.message);
    }
  }

  return (
    <>
      <Header schoolName={config.data?.schoolName}>
        {session === 'active' && (
          <button className="button secondary" type="button" onClick={logout} disabled={!online}>
            <LogOut size={17} aria-hidden="true" /> Sign out
          </button>
        )}
      </Header>
      {session === 'loading' && (
        <main id="main" tabIndex={-1} className="shell focused">
          {online && <Loading>Checking admin session…</Loading>}
        </main>
      )}
      {session === 'error' && (
        <main id="main" tabIndex={-1} className="shell focused">
          <ErrorMessage message={error}>
            <button className="text-button" type="button" onClick={() => setRevision((value) => value + 1)}>
              Try again
            </button>
          </ErrorMessage>
        </main>
      )}
      {session === 'signed-out' && (
        <Login
          online={online}
          onLogin={() => {
            setSession('active');
            setSection('overview');
          }}
        />
      )}
      {session === 'active' && (
        <div className="shell admin-shell">
          <nav className="admin-nav" aria-label="Administrator sections">
            {tabs.map(([key, label, Icon]) => (
              <button
                type="button"
                aria-current={section === key ? 'page' : undefined}
                onClick={() => setSection(key)}
                key={key}
              >
                <Icon size={19} aria-hidden="true" />
                {label}
              </button>
            ))}
          </nav>
          <main id="main" tabIndex={-1} className="admin-main">
            <ErrorMessage message={error} />
            {section === 'overview' && <Overview online={online} />}
            {['orders', 'payments', 'jobs'].includes(section) && (
              <Orders key={section} mode={section} online={online} />
            )}
            {section === 'printer' && <PrinterPage online={online} />}
            {section === 'settings' && <SettingsPage online={online} changed={config.refresh} />}
            {section === 'reports' && <Reports online={online} />}
          </main>
        </div>
      )}
    </>
  );
}

