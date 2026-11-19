import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { renameSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { transact } from './db.js';
import {
  checkExpectedTotal, findOrder, insertOrder, normalizePrintSettings, orderKey, orderView, parsePageRanges,
  pdfPath, settings, validateOrderIdentifier,
} from './orders.js';
import { equal, hash, HttpError } from './security.js';

const run = promisify(execFile);
const worker = fileURLToPath(new URL('./cart-worker.js', import.meta.url));
export const maxCartFiles = 8;
let activeMerges = 0;

function selectItems(db, input, ownerHash) {
  if (!Array.isArray(input.items) || input.items.length < 1 || input.items.length > maxCartFiles) {
    throw new HttpError(400, `Add between 1 and ${maxCartFiles} files.`);
  }
  if (!ownerHash) throw new HttpError(404, 'Document unavailable.');
  const lookup = db.prepare('SELECT * FROM documents WHERE id = ? AND owner_hash = ?');
  const seen = new Set();
  return input.items.map(item => {
    if (!item || typeof item.documentId !== 'string') throw new HttpError(400, 'Choose a file for each cart item.');
    if (seen.has(item.documentId)) throw new HttpError(400, 'Add each uploaded file once.');
    seen.add(item.documentId);
    // Deleted rows keep the immutable page metadata needed to replay a completed request.
    const document = lookup.get(item.documentId, ownerHash);
    if (!document) throw new HttpError(404, 'Document unavailable.');
    const { pageRanges = '' } = item;
    return { document, ...parsePageRanges(pageRanges, document.page_count) };
  });
}

function priceCart(input, selection, limits) {
  const normalized = normalizePrintSettings(input, limits);
  let printablePages = 0;
  const items = selection.map(item => {
    if (item.document.deleted_at !== null) throw new HttpError(404, 'Document unavailable.');
    if (item.document.page_count > limits.maxPages) {
      throw new HttpError(400, `A file exceeds the current ${limits.maxPages}-page limit.`);
    }
    printablePages += item.printablePages;
    return { fileName: item.document.file_name, pageRanges: item.pageRanges, printablePages: item.printablePages,
      total: item.printablePages * normalized.copies * limits.pricePerPage };
  });
  if (printablePages > limits.maxPages) {
    throw new HttpError(400, `Select at most ${limits.maxPages} pages across all files.`);
  }
  return { ...normalized, printablePages, pageRanges: '', pricePerPage: limits.pricePerPage,
    total: printablePages * normalized.copies * limits.pricePerPage, items };
}

export function quoteCart(db, input, ownerHash) {
  return priceCart(input, selectItems(db, input, ownerHash), settings(db));
}

function previousOrder(db, config, ownerHash, idempotencyKey, requestHash) {
  if (!idempotencyKey) return null;
  const existing = db.prepare('SELECT id, request_hash FROM orders WHERE cart_owner_hash = ? AND idempotency_key = ?')
    .get(ownerHash, idempotencyKey);
  if (!existing) return null;
  if (!equal(existing.request_hash, requestHash)) throw new HttpError(409, 'This request identifier has already been used.');
  return orderView(findOrder(db, existing.id), config, orderKey(config, existing.id, ownerHash));
}

async function mergeCart(config, selection, output) {
  const manifest = selection.map(({ document, pageRanges }) => ({
    path: pdfPath(config, document.id), pageCount: document.page_count, pageRanges,
  }));
  const env = process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot } : {};
  let result;
  try {
    const { stdout } = await run(process.execPath, [
      '--max-old-space-size=384', worker, output, JSON.stringify(manifest),
    ], { env, timeout: 30_000, maxBuffer: 8192, windowsHide: true });
    result = JSON.parse(stdout);
  } catch {
    throw new HttpError(422, 'The files could not be combined. Try a smaller cart.');
  }
  if (result.error === 'size') throw new HttpError(413, 'The combined PDF exceeds the 80 MiB processing limit.');
  if (result.error === 'missing') throw new HttpError(409, 'An uploaded file is unavailable. Upload it again.');
  if (result.error) throw new HttpError(422, 'The files could not be combined. Try uploading them again.');
}

export async function createCartOrder(db, config, provider, { input, ownerHash, idempotencyKey }) {
  validateOrderIdentifier(idempotencyKey);
  const selection = selectItems(db, input, ownerHash);
  const kiosk = input.kiosk === true;
  const requestHash = hash(JSON.stringify({
    ...normalizePrintSettings(input, { maxCopies: 100 }), kiosk,
    items: selection.map(({ document, pageRanges }) => [document.id, pageRanges]),
  }));
  const replay = () => previousOrder(db, config, ownerHash, idempotencyKey, requestHash);
  const existing = replay();
  if (existing) return existing;
  checkExpectedTotal(input, priceCart(input, selection, settings(db)));
  if (activeMerges >= 2) throw new HttpError(503, 'The kiosk is combining other files. Try again shortly.');

  const id = randomUUID();
  const path = pdfPath(config, id);
  const temporary = path + '.partial';
  let saved = false;
  activeMerges++;
  try {
    await mergeCart(config, selection, temporary);
    const result = transact(db, () => {
      const previous = replay();
      if (previous) return { order: previous, inserted: false };
      // Upload retention and pricing can change while the worker runs.
      const values = priceCart(input, selectItems(db, input, ownerHash), settings(db));
      checkExpectedTotal(input, values);
      const fileName = values.items.length === 1 ? values.items[0].fileName : `${values.items.length} documents`;
      renameSync(temporary, path);
      db.prepare('INSERT INTO documents (id, owner_hash, file_name, page_count, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(id, 'cart', fileName, values.printablePages, Date.now());
      const order = insertOrder(db, config, provider, {
        document: { id, file_name: fileName }, values, ownerHash, idempotencyKey, requestHash, kiosk, items: values.items,
      });
      return { order, inserted: true };
    });
    saved = result.inserted;
    return result.order;
  } finally {
    activeMerges--;
    if (!saved) await Promise.allSettled([unlink(temporary), unlink(path)]);
  }
}
