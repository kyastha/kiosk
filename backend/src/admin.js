import { audit, transact } from './db.js';
import { findOrder, orderSelect, orderView, settings } from './orders.js';
import { changeJob, printerView, queueTestPage, validQueue } from './printing.js';
import { HttpError } from './security.js';

const roles = req => `admin:${req.admin.id}`;
const pendingJobs = ['QUEUED', 'PROCESSING', 'SUBMITTED_TO_PRINTER', 'RETRY_PENDING'];
const paymentStatuses = ['PENDING', 'TEST_PAID', 'FAILED'];
const printStatuses = ['PENDING_PAYMENT', 'PAYMENT_FAILED', ...pendingJobs, 'COMPLETED', 'COMPLETION_UNCONFIRMED', 'FAILED', 'CANCELLED'];
const oneDay = 86_400_000;
const offset = 345 * 60_000;

function dayStart(date) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new HttpError(400, 'Use YYYY-MM-DD dates.');
  const midnight = Date.parse(`${date}T00:00:00.000Z`);
  if (!Number.isFinite(midnight) || new Date(midnight).toISOString().slice(0, 10) !== date) {
    throw new HttpError(400, 'Choose a valid date.');
  }
  return midnight - offset;
}

function filters(query) {
  const where = [];
  const params = [];
  if (query.from) { where.push('o.created_at >= ?'); params.push(dayStart(query.from)); }
  if (query.to) { where.push('o.created_at < ?'); params.push(dayStart(query.to) + oneDay); }
  if (query.from && query.to && query.from > query.to) throw new HttpError(400, 'The start date must come before the end date.');
  if (query.q) {
    if (typeof query.q !== 'string' || query.q.length > 100) throw new HttpError(400, 'Search terms must be 100 characters or fewer.');
    where.push('(instr(lower(o.id), lower(?)) > 0 OR instr(lower(o.customer_name), lower(?)) > 0)');
    params.push(query.q.trim(), query.q.trim());
  }
  if (query.paymentStatus) {
    if (!paymentStatuses.includes(query.paymentStatus)) throw new HttpError(400, 'Invalid payment filter.');
    where.push('o.payment_status = ?');
    params.push(query.paymentStatus);
  }
  if (query.printStatus) {
    if (!printStatuses.includes(query.printStatus)) throw new HttpError(400, 'Invalid print filter.');
    where.push('o.print_status = ?');
    params.push(query.printStatus);
  }
  return { clause: where.length ? ' WHERE ' + where.join(' AND ') : '', params };
}

function orders(db, query) {
  const { clause, params } = filters(query);
  const limit = Number(query.limit ?? 50);
  const offset = Number(query.offset ?? 0);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0) {
    throw new HttpError(400, 'Invalid page size or offset.');
  }
  const { total } = db.prepare('SELECT count(*) AS total FROM orders o' + clause).get(...params);
  const rows = db.prepare(orderSelect + clause + ' ORDER BY o.created_at DESC, o.id LIMIT ? OFFSET ?').all(...params, limit, offset);
  return { total, orders: rows.map(row => orderView(row)) };
}

function orderDetail(db, id) {
  const row = findOrder(db, id);
  if (!row) throw new HttpError(404, 'Order unavailable.');
  const attempts = db.prepare(`SELECT id, attempt_number AS attemptNumber, status, queue, cups_id AS cupsId,
      error, created_at AS createdAt, updated_at AS updatedAt FROM print_attempts WHERE job_id = ? ORDER BY attempt_number DESC`)
    .all(row.job_id).map(attempt => ({ ...attempt, createdAt: new Date(attempt.createdAt).toISOString(),
      updatedAt: new Date(attempt.updatedAt).toISOString() }));
  const events = db.prepare('SELECT action, actor, detail, created_at AS createdAt FROM audit_logs WHERE order_id = ? ORDER BY id DESC LIMIT 100')
    .all(id).map(event => ({ ...event, detail: JSON.parse(event.detail), createdAt: new Date(event.createdAt).toISOString() }));
  return { ...orderView(row), attempts, events };
}

const aggregates = `count(*) AS orders,
  coalesce(sum(CASE WHEN payment_status = 'TEST_PAID' THEN printable_pages * copies ELSE 0 END), 0) AS pages,
  coalesce(sum(CASE WHEN payment_status = 'TEST_PAID' THEN copies ELSE 0 END), 0) AS copies,
  coalesce(sum(CASE WHEN payment_status = 'TEST_PAID' THEN total ELSE 0 END), 0) AS testAmount,
  coalesce(sum(print_status IN ('FAILED', 'RETRY_PENDING')), 0) AS failedJobs`;

function reports(db, query) {
  const { clause, params } = filters(query);
  const source = ' FROM orders o' + clause;
  const totals = db.prepare('SELECT ' + aggregates + source).get(...params);
  const grouped = pattern => db.prepare(`SELECT strftime('${pattern}', o.created_at / 1000, 'unixepoch', '+345 minutes') AS period,
    ${aggregates}${source} GROUP BY period ORDER BY period DESC`).all(...params);
  return {
    daily: grouped('%Y-%m-%d'), monthly: grouped('%Y-%m'), totalPages: totals.pages, totalCopies: totals.copies,
    failedJobs: totals.failedJobs, testAmount: totals.testAmount, totalOrders: totals.orders,
  };
}

function overview(db) {
  const order = db.prepare(`SELECT count(*) AS totalOrders, coalesce(sum(payment_status = 'TEST_PAID'), 0) AS testPaid,
    coalesce(sum(payment_status = 'FAILED'), 0) AS failedPayments,
    coalesce(sum(CASE WHEN payment_status = 'TEST_PAID' THEN total ELSE 0 END), 0) AS testAmount,
    coalesce(sum(print_status IN (${pendingJobs.map(status => `'${status}'`).join(',')})), 0) AS pendingJobs,
    coalesce(sum(print_status = 'COMPLETED'), 0) AS completedJobs,
    coalesce(sum(print_status = 'COMPLETION_UNCONFIRMED'), 0) AS unconfirmedJobs,
    coalesce(sum(print_status IN ('FAILED', 'RETRY_PENDING')), 0) AS failedJobs FROM orders`).get();
  return { ...order, printer: printerView(db) };
}

function csv(value) {
  let text = String(value ?? '');
  if (/^[\s\uFEFF]*[=+\-@]/u.test(text) || /^[\t\r\n]/u.test(text)) text = "'" + text;
  return '"' + text.replaceAll('"', '""') + '"';
}

function exportReports(db, query) {
  const { clause, params } = filters(query);
  const fields = {
    id: 'Order ID', createdAt: 'Created UTC', customerName: 'Customer', fileName: 'File',
    printablePages: 'Selected pages', copies: 'Copies', pricePerPage: 'Rate (paisa)', total: 'Total (paisa)',
    paymentReference: 'Test payment reference', paymentStatus: 'Payment status', printStatus: 'Print status', printError: 'Print error',
  };
  const lines = [Object.values(fields).map(csv).join(',')];
  for (const row of db.prepare(orderSelect + clause + ' ORDER BY o.created_at DESC').iterate(...params)) {
    const view = orderView(row);
    lines.push(Object.keys(fields).map(key => csv(view[key])).join(','));
  }
  return '\uFEFF' + lines.join('\r\n') + '\r\n';
}

const limits = { pricePerPage: [1, 100_000], maxCopies: [1, 100], maxFileMb: [1, 50],
  maxPages: [1, 500], retentionHours: [1, 8760] };

function saveSettings(db, input, actor) {
  return transact(db, () => {
    const next = { ...settings(db) };
    for (const [key, [min, max]] of Object.entries(limits)) {
      if (input[key] === undefined) continue;
      if (!Number.isInteger(input[key]) || input[key] < min || input[key] > max) {
        throw new HttpError(400, `${key} must be between ${min} and ${max}.`);
      }
      next[key] = input[key];
    }
    if (input.schoolName !== undefined) {
      if (typeof input.schoolName !== 'string' || !input.schoolName.trim() || input.schoolName.length > 120 ||
          /[\u0000-\u001f\u007f]/u.test(input.schoolName)) {
        throw new HttpError(400, 'Enter a school name between 1 and 120 characters.');
      }
      next.schoolName = input.schoolName.trim();
    }
    db.prepare(`UPDATE settings SET school_name = ?, price_per_page = ?, max_copies = ?, max_file_mb = ?,
      max_pages = ?, retention_hours = ? WHERE id = 1`)
      .run(next.schoolName, next.pricePerPage, next.maxCopies, next.maxFileMb, next.maxPages, next.retentionHours);
    audit(db, actor, 'SETTINGS_UPDATED', null, next);
    return next;
  });
}

export function registerAdmin(app, db) {
  app.get('/api/admin/overview', (req, res) => res.json(overview(db)));
  app.get('/api/admin/orders', (req, res) => res.json(orders(db, req.query)));
  app.get('/api/admin/orders/:id', (req, res) => res.json(orderDetail(db, req.params.id)));
  app.get('/api/admin/reports', (req, res) => res.json(reports(db, req.query)));
  app.get('/api/admin/reports.csv', (req, res) => {
    const data = exportReports(db, req.query);
    res.attachment('kiosk-test-transactions.csv').type('text/csv').send(data);
  });
  app.get('/api/admin/settings', (req, res) => res.json(settings(db)));
  app.patch('/api/admin/settings', (req, res) => res.json(saveSettings(db, req.body || {}, roles(req))));
  for (const action of ['retry', 'cancel']) {
    app.post(`/api/admin/jobs/:id/${action}`, (req, res) => {
      changeJob(db, req.params.id, action, roles(req));
      res.json(orderView(findOrder(db, req.params.id)));
    });
  }
  app.get('/api/admin/printer', (req, res) => res.json(printerView(db)));
  app.patch('/api/admin/printer', (req, res) => {
    const queue = req.body?.queue;
    if (queue !== '' && queue !== null && !validQueue(queue)) throw new HttpError(400, 'Enter a valid CUPS queue name.');
    transact(db, () => {
      db.prepare('UPDATE printers SET queue = ? WHERE id = 1').run(queue || null);
      audit(db, roles(req), 'PRINTER_CONFIGURED', null, { queue: queue || null });
    });
    res.json(printerView(db));
  });
  app.post('/api/admin/printer/test', (req, res) => res.status(201).json({ jobId: queueTestPage(db, roles(req)) }));
}
