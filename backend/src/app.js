import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import express from 'express';
import helmet from 'helmet';
import multer from 'multer';
import QRCode from 'qrcode';
import { registerAdmin } from './admin.js';
import { createCartOrder, maxCartFiles, quoteCart } from './cart.js';
import { openDatabase } from './db.js';
import { processDocument } from './document-processing.js';
import {
  applyPaymentEvent, authorizeOrder, createOrder, expirePayments, maintainStorage, orderView,
  ownedDocument, paymentLifetime, pdfPath, quote, settings,
} from './orders.js';
import { FakePaymentProvider, testNotice } from './payments.js';
import { registerAgent } from './printing.js';
import { makeReceipt } from './receipts.js';
import { cookieOptions, hash, HttpError, provisionAdmin, readCookie, registerAdminAuth, throttle, token, validateToken } from './security.js';

function browserOwner(req, res, config, issue = false) {
  const name = config.secure ? '__Host-kiosk_browser' : 'kiosk_browser';
  const current = readCookie(req, name);
  if (validateToken(current)) return hash(current);
  if (!issue) return null;
  const fresh = token();
  res.cookie(name, fresh, { ...cookieOptions(config), maxAge: 7 * 86_400_000 });
  return hash(fresh);
}

function safeFileName(originalName) {
  let decoded = originalName;
  // Browsers usually encode multipart filenames in UTF-8 while Busboy defaults to Latin-1.
  if (/^[\u0000-\u00ff]+$/u.test(originalName) && /[\u0080-\u00ff]/u.test(originalName)) {
    try { decoded = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(originalName, 'latin1')); }
    catch { /* Preserve filenames that actually arrived in Latin-1. */ }
  }
  const name = decoded.split(/[\\/]/).at(-1).replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/gu, '').trim();
  if (!name || name.length > 220) throw new HttpError(400, 'Choose a file with a shorter name.');
  return name;
}

function registerDocuments(app, db, config) {
  let uploadsInProgress = 0;
  app.post('/api/documents', throttle(12), async (req, res) => {
    if (uploadsInProgress >= 2) throw new HttpError(503, 'The kiosk is processing other documents. Try again shortly.');
    const owner = browserOwner(req, res, config, true);
    const limits = settings(db);
    const middleware = multer({ storage: multer.memoryStorage(),
      limits: { files: 1, fields: 0, parts: 2, fileSize: limits.maxFileMb * 1024 ** 2 } }).single('file');
    uploadsInProgress += 1;
    try {
      await new Promise((resolve, reject) => {
        const aborted = () => reject(new HttpError(400, 'The upload was interrupted.'));
        req.once('aborted', aborted);
        middleware(req, res, error => {
          req.off('aborted', aborted);
          if (error) reject(error);
          else resolve();
        });
      }).catch(error => {
        if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
          throw new HttpError(413, `Files may be at most ${limits.maxFileMb} MB.`);
        }
        throw new HttpError(400, 'Send one valid document in the file field.');
      });
      if (!req.file?.size) throw new HttpError(400, 'Choose a nonempty document.');
      const fileName = safeFileName(req.file.originalname);
      const { pdf, pageCount } = await processDocument({ buffer: req.file.buffer, fileName, mimeType: req.file.mimetype,
        maxPages: limits.maxPages, workRoot: config.workRoot });
      const id = randomUUID();
      const path = pdfPath(config, id);
      const temporary = path + '.partial';
      try {
        await writeFile(temporary, pdf, { mode: 0o600, flag: 'wx' });
        await rename(temporary, path);
        db.prepare('INSERT INTO documents (id, owner_hash, file_name, page_count, created_at) VALUES (?, ?, ?, ?, ?)')
          .run(id, owner, fileName, pageCount, Date.now());
      } catch (error) {
        await Promise.allSettled([unlink(temporary), unlink(path)]);
        throw error;
      }
      res.status(201).json({ id, fileName, pageCount, previewUrl: `/api/documents/${id}/preview` });
    } finally {
      uploadsInProgress -= 1;
    }
  });
  app.get('/api/documents/:id/preview', (req, res) => {
    const document = ownedDocument(db, req.params.id, browserOwner(req, res, config));
    res.type('pdf').set('Content-Disposition', 'inline; filename="preview.pdf"').sendFile(pdfPath(config, document.id));
  });
}

function paymentView(db, payment) {
  return {
    orderId: payment.order_id, total: payment.amount, schoolName: settings(db).schoolName,
    paymentStatus: payment.status, notice: testNotice,
  };
}

function findPayment(db, reference) {
  const payment = validateToken(reference) && db.prepare('SELECT * FROM payments WHERE reference = ?').get(reference);
  if (!payment) throw new HttpError(404, 'Payment unavailable.');
  return payment;
}

async function sendQr(res, url) {
  res.type('png').send(await QRCode.toBuffer(url, { width: 360, margin: 4, errorCorrectionLevel: 'M' }));
}

function registerCustomer(app, db, config) {
  const provider = new FakePaymentProvider(config.appSecret);
  const onboardingUrl = config.publicOrigin + '/?kiosk=1';
  app.get('/api/config', (req, res) => {
    browserOwner(req, res, config, true);
    res.json({ ...settings(db), drive: config.drive, maxCartFiles, onboardingUrl });
  });
  app.get('/api/kiosk/qr', (req, res) => sendQr(res, onboardingUrl));
  registerDocuments(app, db, config);
  app.post('/api/quote', (req, res) => {
    const input = req.body || {};
    const ownerHash = browserOwner(req, res, config);
    if (input.items !== undefined) return res.json(quoteCart(db, input, ownerHash));
    const document = ownedDocument(db, input.documentId, ownerHash);
    return res.json(quote(input, document, settings(db)));
  });
  app.post('/api/orders', throttle(24), async (req, res) => {
    const input = req.body || {};
    const request = { input, ownerHash: browserOwner(req, res, config), idempotencyKey: req.get('idempotency-key') };
    const order = input.items === undefined
      ? createOrder(db, config, provider, request)
      : await createCartOrder(db, config, provider, request);
    res.status(201).json({ ...order, schoolName: settings(db).schoolName });
  });
  app.get('/api/orders/:id', (req, res) => {
    const row = authorizeOrder(db, req.params.id, req.query.key);
    res.json({ ...orderView(row, config, req.query.key), schoolName: settings(db).schoolName });
  });
  app.get('/api/orders/:id/receipt', async (req, res) => {
    const order = authorizeOrder(db, req.params.id, req.query.key);
    if (order.payment_status !== 'TEST_PAID' || !order.receipt_number) throw new HttpError(409, 'A receipt is available after payment.');
    const pdf = await makeReceipt({ ...config, schoolName: settings(db).schoolName }, order);
    res.attachment(`${order.receipt_number}.pdf`).type('pdf').send(pdf);
  });
  app.get('/api/payments/:reference', (req, res) => {
    let payment = findPayment(db, req.params.reference);
    if (payment.status === 'PENDING' && payment.created_at + paymentLifetime <= Date.now()) {
      expirePayments(db);
      payment = findPayment(db, req.params.reference);
    }
    res.json(paymentView(db, payment));
  });
  app.get('/api/payments/:reference/qr', (req, res) => {
    const payment = findPayment(db, req.params.reference);
    return sendQr(res, `${config.publicOrigin}/pay/${payment.reference}`);
  });
  app.post('/api/payments/:reference/simulate', throttle(30), (req, res) => {
    const payment = findPayment(db, req.params.reference);
    const { outcome } = req.body || {};
    if (!['success', 'failure'].includes(outcome)) throw new HttpError(400, 'Choose success or failure.');
    const status = applyPaymentEvent(db, provider, payment, provider.simulate(payment, outcome));
    if (!status) throw new HttpError(400, 'Could not verify this payment.');
    res.json(paymentView(db, { ...payment, status }));
  });
}

function headers(config) {
  const google = config.drive;
  const liveOrigins = new Set([config.publicOrigin, ...config.localOrigins].map(origin => origin.replace(/^http/, 'ws')));
  return helmet({
    crossOriginOpenerPolicy: { policy: google ? 'same-origin-allow-popups' : 'same-origin' },
    referrerPolicy: { policy: google ? 'strict-origin' : 'no-referrer' },
    strictTransportSecurity: config.secure ? undefined : false,
    contentSecurityPolicy: {
      directives: {
        'default-src': ["'self'"], 'object-src': ["'none'"], 'base-uri': ["'self'"], 'worker-src': ["'self'"],
        'script-src': ["'self'", ...(google ? ['https://apis.google.com', 'https://accounts.google.com/gsi/client'] : [])],
        'frame-src': google ? ["'self'", 'https://accounts.google.com', 'https://docs.google.com', 'https://drive.google.com'] : ["'self'"],
        'connect-src': ["'self'", ...liveOrigins, ...(google ? ['https://accounts.google.com', 'https://www.googleapis.com', 'https://apis.google.com'] : [])],
        'style-src': ["'self'", ...(google ? ['https://accounts.google.com/gsi/style'] : [])],
        'img-src': ["'self'", 'data:', ...(google ? ['https://*.googleusercontent.com', 'https://*.gstatic.com'] : [])],
        'upgrade-insecure-requests': config.secure ? [] : null,
      },
    },
  });
}

export function createApp(config, { database } = {}) {
  const db = database || openDatabase(join(config.storage, 'kiosk.sqlite'));
  db.prepare(`INSERT INTO settings VALUES (1, ?, 500, 10, 20, 100, 24)
    ON CONFLICT(id) DO NOTHING`).run(config.schoolName);
  provisionAdmin(db, config);
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.proxy);
  app.use(headers(config));
  app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const origin = req.get('origin');
      const localAlias = config.localOrigins.includes(origin) && origin === `${req.protocol}://${req.get('host')}`;
      if ((origin && origin !== config.publicOrigin && !localAlias) || req.get('sec-fetch-site') === 'cross-site') {
        throw new HttpError(403, 'Requests must come from the kiosk website.');
      }
    }
    next();
  });
  app.get('/api/health', (req, res) => res.json({ ok: true }));
  app.use('/api', express.json({ limit: '24kb' }));
  registerAgent(app, db, config);
  app.use('/api', throttle(240));
  registerCustomer(app, db, config);
  registerAdminAuth(app, db, config);
  registerAdmin(app, db);
  app.use('/api', (req, res) => res.status(404).json({ error: 'Endpoint unavailable.' }));
  if (existsSync(join(config.frontendDist, 'index.html'))) {
    app.use(express.static(config.frontendDist, { index: false, dotfiles: 'deny' }));
    app.get('/{*path}', (req, res) => {
      res.set('Cache-Control', 'no-store').sendFile(join(config.frontendDist, 'index.html'));
    });
  }
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const requestedStatus = error.status || error.statusCode;
    const status = Number.isInteger(requestedStatus) && requestedStatus >= 400 && requestedStatus < 600 ? requestedStatus : 500;
    if (status >= 500 && !(error instanceof HttpError)) console.error('Request failed:', error.code || error.name);
    const message = error instanceof HttpError || status < 500 ? error.message : 'The kiosk could not complete this request.';
    res.status(status).json({ error: message });
  });
  return { app, db, maintain: () => maintainStorage(db, config) };
}
