import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import CFB from 'cfb';
import { PDFDocument, PDFName, PageSizes } from 'pdf-lib';
import PDFKit from 'pdfkit';
import sharp from 'sharp';
import { processDocument } from '../src/document-processing.js';

const run = promisify(execFile);
const fixtures = new URL('./fixtures/', import.meta.url);
const office = process.env.SOFFICE_PATH || (process.platform === 'win32' ? 'soffice.com' : 'soffice');
const hasOffice = Boolean(process.env.SOFFICE_PATH)
  || spawnSync(office, ['--headless', '--version'], { timeout: 10_000, windowsHide: true }).status === 0;

async function scratch(t) {
  const root = await realpath(tmpdir());
  const dir = await mkdtemp(join(root, 'kiosk-document-tests-'));
  t.after(async () => {
    if (dirname(dir) === root) await rm(dir, { recursive: true, force: true, maxRetries: 3 });
  });
  return dir;
}

async function processFixture(t, options) {
  const workRoot = await scratch(t);
  try {
    return await processDocument({ mimeType: 'application/octet-stream', maxPages: 10, ...options, workRoot });
  } finally {
    assert.deepEqual(await readdir(workRoot), [], 'conversion removes temporary originals and profiles');
  }
}

test('normalizes a PDF, counts actual pages and removes interactive document features', async (t) => {
  const original = await PDFDocument.create();
  const first = original.addPage(PageSizes.A4);
  original.addPage(PageSizes.A4);
  original.addJavaScript('test', 'app.alert("Removed from kiosk previews")');
  const text = original.getForm().createTextField('school');
  text.setText('School print test');
  text.addToPage(first, { x: 30, y: 50, width: 180, height: 20 });
  const result = await processFixture(t, { buffer: Buffer.from(await original.save()), fileName: 'School.PDF' });
  const normalized = await PDFDocument.load(result.pdf);
  assert.equal(result.pageCount, 2);
  assert.equal(normalized.getPageCount(), 2);
  assert.equal(normalized.catalog.has(PDFName.of('Names')), false);
  assert.equal(normalized.catalog.has(PDFName.of('AcroForm')), false);
  assert.equal(normalized.getPage(0).node.has(PDFName.of('Annots')), false);
});

test('rejects a PDF that exceeds the printable page limit', async (t) => {
  const document = await PDFDocument.create();
  document.addPage();
  document.addPage();
  await assert.rejects(
    processFixture(t, { buffer: Buffer.from(await document.save()), fileName: 'long.pdf', maxPages: 1 }),
    { status: 422, message: /at most 1 printable pages/ },
  );
});

test('rejects password-protected PDF files', async (t) => {
  const document = new PDFKit({ userPassword: 'test fixture password' });
  document.text('Protected PDF');
  document.end();
  const chunks = [];
  for await (const chunk of document) chunks.push(chunk);
  await assert.rejects(
    processFixture(t, { buffer: Buffer.concat(chunks), fileName: 'protected.pdf' }),
    { status: 422, message: /corrupt, encrypted/ },
  );
});

for (const [extension, imageFormat] of [['jpg', 'jpeg'], ['png', 'png']]) {
  test(`converts ${extension} into an A4 PDF page`, async (t) => {
    const image = await sharp({ create: {
      width: 100, height: 60, channels: 3, background: '#4287f5',
    } }).toFormat(imageFormat).toBuffer();
    const result = await processFixture(t, { buffer: image, fileName: `image.${extension}`, mimeType: `image/${imageFormat}` });
    const pdf = await PDFDocument.load(result.pdf);
    assert.equal(result.pageCount, 1);
    assert.deepEqual(pdf.getPage(0).getSize(), { width: PageSizes.A4[0], height: PageSizes.A4[1] });
    await assert.rejects(
      processFixture(t, { buffer: image.subarray(0, 12), fileName: `broken.${extension}` }),
      { status: 422 },
    );
  });
}

test('rejects unsupported formats, contradictory MIME, corrupt documents and binary text', async (t) => {
  const bytes = Buffer.from('Not a printable source');
  await assert.rejects(processFixture(t, { buffer: bytes, fileName: 'recording.mp4' }), { status: 415 });
  await assert.rejects(processFixture(t, { buffer: bytes, fileName: 'notes.pdf', mimeType: 'text/plain' }), { status: 415 });
  await assert.rejects(processFixture(t, { buffer: bytes, fileName: 'broken.pdf' }), { status: 422 });
  await assert.rejects(processFixture(t, { buffer: bytes, fileName: 'broken.doc' }), { status: 422 });
  await assert.rejects(processFixture(t, { buffer: Buffer.from([0x00, 0xff]), fileName: 'broken.txt' }), { status: 422 });
});

test('rejects wrong Office formats and externally linked Office templates before conversion', async (t) => {
  const word = await readFile(new URL('sample.docx', fixtures));
  await assert.rejects(processFixture(t, { buffer: word, fileName: 'spoof.xlsx' }), { status: 422 });
  const remote = await readFile(new URL('remote-template.docx', fixtures));
  await assert.rejects(
    processFixture(t, { buffer: remote, fileName: 'external.docx' }),
    { status: 422, message: /externally linked data or templates/ },
  );
});

test('rejects legacy Office files containing VBA storage before conversion', async (t) => {
  const archive = CFB.utils.cfb_new();
  CFB.utils.cfb_add(archive, 'WordDocument', Buffer.from('test stream'));
  CFB.utils.cfb_add(archive, 'Macros/VBA', Buffer.from('test macro stream'));
  const buffer = CFB.write(archive, { type: 'buffer' });
  await assert.rejects(
    processFixture(t, { buffer, fileName: 'macros.doc' }),
    { status: 422, message: /Remove macros/ },
  );
});

const officeCases = [
  { extension: 'docx', legacy: 'doc', filter: 'MS Word 97' },
  { extension: 'xlsx', legacy: 'xls', filter: 'MS Excel 97' },
  { extension: 'pptx', legacy: 'ppt', filter: 'MS PowerPoint 97' },
];
const officeOptions = { skip: hasOffice ? false : 'LibreOffice unavailable. Install it or set SOFFICE_PATH.' };
for (const { extension, legacy, filter } of officeCases) {
  test(`converts .${extension} and legacy .${legacy} using LibreOffice`, officeOptions, async (t) => {
    const fileName = `sample.${extension}`;
    const buffer = await readFile(new URL(fileName, fixtures));
    const modern = await processFixture(t, { buffer, fileName });
    assert.equal(modern.pageCount, 1);
    assert.equal((await PDFDocument.load(modern.pdf)).getPageCount(), 1);

    const legacyDir = await scratch(t);
    await writeFile(join(legacyDir, fileName), buffer);
    await run(office, [
      `-env:UserInstallation=${pathToFileURL(join(legacyDir, 'profile')).href}`,
      '--headless', '--convert-to', `${legacy}:${filter}`, '--outdir', legacyDir, join(legacyDir, fileName),
    ], { timeout: 55_000, windowsHide: true });
    const legacyName = `sample.${legacy}`;
    const legacyResult = await processFixture(t, { buffer: await readFile(join(legacyDir, legacyName)), fileName: legacyName });
    assert.equal(legacyResult.pageCount, 1);
  });
}

test('converts UTF-8 text to a printable PDF and enforces its rendered page limit', officeOptions, async (t) => {
  const buffer = Buffer.from('School printing\nविद्यालय प्रिन्टिङ\n');
  const single = await processFixture(t, { buffer, fileName: 'notes.txt' });
  assert.equal(single.pageCount, 1);
  const long = Buffer.from('School printing\n'.repeat(300));
  await assert.rejects(processFixture(t, { buffer: long, fileName: 'long.txt', maxPages: 1 }), { status: 422, message: /at most 1/ });
});
