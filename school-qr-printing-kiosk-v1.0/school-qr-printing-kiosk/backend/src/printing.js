import { randomUUID } from 'node:crypto';
import { audit, transact } from './db.js';
import { equal, HttpError, throttle } from './security.js';
import { pdfPath } from './orders.js';
import { makePdf } from './receipts.js';

const activeStatuses = ['PROCESSING', 'SUBMITTED_TO_PRINTER'];
const terminalStatuses = ['COMPLETED', 'COMPLETION_UNCONFIRMED', 'FAILED', 'RETRY_PENDING'];
const queueName = /^[a-z0-9_.-]{1,127}$/i;
const printerStaleMs = 120_000;

export function validQueue(queue) {
  return typeof queue === 'string' && queueName.test(queue);
}

export function printerView(db) {
  const printer = db.prepare('SELECT * FROM printers WHERE id = 1').get();
  const stale = printer.last_seen && Date.now() - printer.last_seen > printerStaleMs;
  return {
    queue: printer.queue || printer.reported_queue, configuredQueue: printer.queue,
    status: stale ? 'OFFLINE' : printer.status,
    reasons: stale ? ['The kiosk agent has stopped reporting.'] : JSON.parse(printer.reasons),
    activeJobs: printer.active_jobs, lastSeen: printer.last_seen ? new Date(printer.last_seen).toISOString() : null,
  };
}

function setJob(db, job, status, error = null, retrySafe = false) {
  const now = Date.now();
  db.prepare('UPDATE print_jobs SET status = ?, error = ?, retry_safe = ?, updated_at = ? WHERE id = ?')
    .run(status, error, Number(retrySafe), now, job.id);
  if (job.order_id) db.prepare('UPDATE orders SET print_status = ?, updated_at = ? WHERE id = ?').run(status, now, job.order_id);
}

export function queueTestPage(db, actor) {
  return transact(db, () => {
    if (db.prepare(`SELECT id FROM print_jobs WHERE order_id IS NULL
      AND status IN ('QUEUED','PROCESSING','SUBMITTED_TO_PRINTER')`).get()) {
      throw new HttpError(409, 'A test page is already queued or processing.');
    }
    const id = randomUUID();
    const now = Date.now();
    db.prepare("INSERT INTO print_jobs (id, status, created_at, updated_at) VALUES (?, 'QUEUED', ?, ?)").run(id, now, now);
    audit(db, actor, 'PRINTER_TEST_QUEUED', null, { jobId: id });
    return id;
  });
}

export function changeJob(db, orderId, action, actor) {
  transact(db, () => {
    const job = db.prepare('SELECT * FROM print_jobs WHERE order_id = ?').get(orderId);
    if (!job) throw new HttpError(404, 'Print job unavailable.');
    if (action === 'retry') {
      if (!['RETRY_PENDING', 'FAILED'].includes(job.status) || !job.retry_safe) {
        throw new HttpError(409, 'Only a job confirmed to have never reached CUPS can be retried here.');
      }
      const document = db.prepare(`SELECT d.deleted_at FROM orders o JOIN documents d ON d.id = o.document_id
        WHERE o.id = ? AND o.payment_status = 'TEST_PAID'`).get(orderId);
      if (!document || document.deleted_at !== null) throw new HttpError(409, 'The print document is unavailable.');
      setJob(db, job, 'QUEUED');
    } else {
      const attempt = lastAttempt(db, job.id);
      if (!['QUEUED', 'RETRY_PENDING'].includes(job.status) && !(job.status === 'PROCESSING' && !attempt?.authorized_at)) {
        throw new HttpError(409, 'Only a job confirmed to have never reached CUPS can be cancelled here.');
      }
      if (job.status === 'PROCESSING') db.prepare("UPDATE print_attempts SET status = 'CANCELLED', updated_at = ? WHERE id = ?")
        .run(Date.now(), attempt.id);
      setJob(db, job, 'CANCELLED');
    }
    audit(db, actor, action === 'retry' ? 'PRINT_REQUEUED' : 'PRINT_CANCELLED', orderId, { jobId: job.id });
  });
}

function lastAttempt(db, jobId) {
  return db.prepare('SELECT * FROM print_attempts WHERE job_id = ? ORDER BY attempt_number DESC LIMIT 1').get(jobId);
}

function claimJob(db, recoveryOnly) {
  return transact(db, () => {
    const active = db.prepare("SELECT * FROM print_jobs WHERE status IN ('PROCESSING','SUBMITTED_TO_PRINTER') LIMIT 1").get();
    if (active) return active;
    if (recoveryOnly) return null;
    const job = db.prepare(`SELECT j.* FROM print_jobs j LEFT JOIN orders o ON o.id = j.order_id
      WHERE j.status = 'QUEUED' AND (j.order_id IS NULL OR o.payment_status = 'TEST_PAID')
      ORDER BY j.created_at, j.id LIMIT 1`).get();
    if (!job) return null;
    const previous = lastAttempt(db, job.id);
    const attempt = randomUUID();
    const now = Date.now();
    db.prepare(`INSERT INTO print_attempts (id, job_id, attempt_number, status, created_at, updated_at)
      VALUES (?, ?, ?, 'PROCESSING', ?, ?)`).run(attempt, job.id, (previous?.attempt_number || 0) + 1, now, now);
    setJob(db, job, 'PROCESSING');
    audit(db, 'agent', 'PRINT_CLAIMED', job.order_id, { jobId: job.id, attemptId: attempt });
    return { ...job, status: 'PROCESSING' };
  });
}

function jobView(db, job) {
  const attempt = lastAttempt(db, job.id);
  const order = job.order_id && db.prepare('SELECT * FROM orders WHERE id = ?').get(job.order_id);
  return {
    id: job.id, attemptId: attempt.id, attemptNumber: attempt.attempt_number,
    status: job.status, documentUrl: `/api/agent/jobs/${job.id}/document`,
    copies: order?.copies ?? 1, orientation: order?.orientation ?? 'portrait',
    pageRanges: order?.page_ranges ?? '', scaling: order?.scaling ?? 'fit', scalePercent: order?.scale_percent ?? null,
    cupsId: attempt.cups_id === null ? null : Number(attempt.cups_id),
    queue: attempt.queue, submissionAuthorized: Boolean(attempt.authorized_at),
    submissionAuthorizedAt: attempt.authorized_at ? new Date(attempt.authorized_at).toISOString() : null,
  };
}

function attemptForUpdate(db, jobId, attemptId) {
  const job = db.prepare('SELECT * FROM print_jobs WHERE id = ?').get(jobId);
  const attempt = job && lastAttempt(db, job.id);
  if (!attempt || attempt.id !== attemptId) throw new HttpError(409, 'This print attempt is no longer current.');
  return { job, attempt };
}

function authorizeSubmission(db, jobId, { attemptId, queue }) {
  if (!validQueue(queue)) throw new HttpError(400, 'Invalid CUPS queue.');
  return transact(db, () => {
    const { job, attempt } = attemptForUpdate(db, jobId, attemptId);
    if (job.status !== 'PROCESSING' || attempt.authorized_at) return false;
    const now = Date.now();
    db.prepare('UPDATE print_attempts SET authorized_at = ?, queue = ?, updated_at = ? WHERE id = ?')
      .run(now, queue, now, attempt.id);
    audit(db, 'agent', 'PRINT_SUBMISSION_AUTHORIZED', job.order_id, { jobId, attemptId, queue });
    return true;
  });
}

function updateJob(db, jobId, { attemptId, status, cupsId: rawCupsId, error: message, retrySafe }) {
  if (![...terminalStatuses, 'SUBMITTED_TO_PRINTER'].includes(status)) throw new HttpError(400, 'Invalid print status.');
  const cupsId = rawCupsId == null ? null : String(rawCupsId);
  if (cupsId !== null && !/^[1-9]\d{0,9}$/.test(cupsId)) throw new HttpError(400, 'Invalid CUPS job identifier.');
  const error = typeof message === 'string' ? message.slice(0, 500) : null;
  transact(db, () => {
    const { job, attempt } = attemptForUpdate(db, jobId, attemptId);
    if (attempt.cups_id && cupsId && attempt.cups_id !== cupsId) throw new HttpError(409, 'CUPS job identifier changed.');
    if (job.status === status && attempt.status === status && status !== 'SUBMITTED_TO_PRINTER') return;
    if (!activeStatuses.includes(job.status)) throw new HttpError(409, 'The print job is no longer active.');
    if (status === 'RETRY_PENDING' && (attempt.authorized_at || retrySafe !== true)) {
      throw new HttpError(409, 'A retry needs evidence that submission was never authorized.');
    }
    const completion = ['COMPLETED', 'COMPLETION_UNCONFIRMED'].includes(status);
    if ((status === 'SUBMITTED_TO_PRINTER' || completion || cupsId) &&
        (!attempt.authorized_at || !(attempt.cups_id || cupsId))) {
      throw new HttpError(409, 'Printer status requires an authorized submission and CUPS job ID.');
    }
    if (completion && job.status !== 'SUBMITTED_TO_PRINTER') {
      throw new HttpError(409, 'Record the CUPS submission before recording completion.');
    }
    if (retrySafe === true && attempt.authorized_at) throw new HttpError(409, 'An authorized job is ineligible for retry.');
    if (job.status === status && attempt.cups_id === cupsId && attempt.error === error) return;
    db.prepare('UPDATE print_attempts SET status = ?, cups_id = ?, error = ?, updated_at = ? WHERE id = ?')
      .run(status, attempt.cups_id || cupsId, error, Date.now(), attempt.id);
    setJob(db, job, status, error, retrySafe === true);
    audit(db, 'agent', `PRINT_${status}`, job.order_id, { jobId, attemptId, cupsId: attempt.cups_id || cupsId, error });
  });
}

export function registerAgent(app, db, config) {
  app.use('/api/agent', (req, res, next) => {
    const supplied = req.get('authorization') || '';
    if (!equal(supplied, `Bearer ${config.agentToken}`)) throw new HttpError(401, 'Agent authorization required.');
    next();
  }, throttle(240));
  app.post('/api/agent/heartbeat', (req, res) => {
    const { queue, status, reasons, activeJobs } = req.body || {};
    if (queue != null && !validQueue(queue)) throw new HttpError(400, 'Invalid CUPS queue.');
    if (typeof status !== 'string' || !/^[a-z_-]{2,50}$/i.test(status)) throw new HttpError(400, 'Invalid printer status.');
    const messages = Array.isArray(reasons) ? reasons.filter(reason => typeof reason === 'string').slice(0, 20)
      .map(reason => reason.slice(0, 200)) : [];
    const count = Number.isSafeInteger(activeJobs) && activeJobs >= 0 ? activeJobs : 0;
    db.prepare('UPDATE printers SET reported_queue = ?, status = ?, reasons = ?, active_jobs = ?, last_seen = ? WHERE id = 1')
      .run(queue ?? null, status, JSON.stringify(messages), count, Date.now());
    res.json({ queue: printerView(db).configuredQueue, activeJobs: count });
  });
  app.post('/api/agent/claim', (req, res) => {
    const job = claimJob(db, req.body?.recoveryOnly === true);
    res.json({ job: job ? jobView(db, job) : null });
  });
  app.get('/api/agent/jobs/:id/document', async (req, res) => {
    const job = db.prepare(`SELECT j.*, o.document_id, o.payment_status, d.deleted_at FROM print_jobs j
      LEFT JOIN orders o ON o.id = j.order_id LEFT JOIN documents d ON d.id = o.document_id WHERE j.id = ?`).get(req.params.id);
    if (!job || !activeStatuses.includes(job.status) || (job.order_id && (job.payment_status !== 'TEST_PAID' || job.deleted_at !== null))) {
      throw new HttpError(404, 'Print document unavailable.');
    }
    if (!job.order_id) {
      res.type('pdf').send(await makePdf(config, 'Kiosk printer test', [
        ['Job ID', job.id], ['Paper', 'A4'], ['Mode', 'Black & White'], ['Requested', new Date(job.created_at).toISOString()],
      ], 'PRINTER TEST PAGE'));
      return;
    }
    res.type('pdf').sendFile(pdfPath(config, job.document_id));
  });
  app.post('/api/agent/jobs/:id/authorize', (req, res) => res.json({
    authorized: authorizeSubmission(db, req.params.id, req.body || {}),
  }));
  app.post('/api/agent/jobs/:id/status', (req, res) => {
    updateJob(db, req.params.id, req.body || {});
    res.json({ ok: true });
  });
}
