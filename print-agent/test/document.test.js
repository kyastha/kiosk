import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { degrees, PDFDocument, rgb } from 'pdf-lib';
import { arrangePdf, preparePdf } from '../src/document.js';

async function source() {
  const input = await PDFDocument.create();
  input.addPage([612, 792]);
  const page = input.addPage([400, 500]);
  page.drawRectangle({ x: 50, y: 60, width: 80, height: 90, color: rgb(0, 0, 0) });
  page.setCropBox(10, 20, 360, 420);
  page.setRotation(degrees(90));
  input.addPage();
  return input.save();
}

test('kiosk layout selects distinct pages and embeds an A4 monochrome document', async () => {
  const bytes = await arrangePdf(await source(), {
    orientation: 'landscape', pageRanges: '2-3,2', scaling: 'custom', scalePercent: 80
  });
  const pdf = await PDFDocument.load(bytes);
  assert.equal(pdf.getPageCount(), 2);
  assert.equal(Math.round(pdf.getPage(0).getWidth()), 595);
  assert.equal(Math.round(pdf.getPage(0).getHeight()), 842);
  assert.ok(pdf.getPage(0).node.Contents());
  assert.equal(pdf.getPage(1).node.Contents(), undefined);
});

test('kiosk layout rejects invalid ranges, scale or orientation before submission', async () => {
  const bytes = await source();
  const settings = { orientation: 'portrait', pageRanges: '2', scaling: 'fit' };
  await assert.rejects(arrangePdf(bytes, { ...settings, pageRanges: '1-10' }), /range exceeds/);
  await assert.rejects(arrangePdf(bytes, { ...settings, scaling: 'custom', scalePercent: 0 }), /print scale/);
  await assert.rejects(arrangePdf(bytes, { ...settings, orientation: 'sideways' }), /print settings/);
});

const gs = process.env.GHOSTSCRIPT_BIN || 'gs';
const hasGhostscript = spawnSync(gs, ['--version'], { timeout: 5_000 }).status === 0;

test('Ghostscript prepares a grayscale page from colored input', {
  skip: hasGhostscript ? false : 'Ghostscript executable unavailable'
}, async () => {
  const input = await PDFDocument.create();
  input.addPage().drawRectangle({ x: 30, y: 40, width: 200, height: 300, color: rgb(1, 0, 0) });
  const bytes = await preparePdf(await input.save(), { orientation: 'portrait', scaling: 'fit' }, gs);
  const result = spawnSync(gs, ['-q', '-dSAFER', '-dBATCH', '-dNOPAUSE', '-sDEVICE=inkcov',
    '-sOutputFile=%stdout', '-'], { input: bytes, encoding: 'utf8', timeout: 30_000 });
  assert.equal(result.status, 0, result.stderr);
  const match = /^\s*([.\d]+)\s+([.\d]+)\s+([.\d]+)\s+([.\d]+)\s+CMYK/m.exec(result.stdout);
  assert.ok(match, result.stdout);
  assert.deepEqual(match.slice(1, 4).map(Number), [0, 0, 0]);
  assert.ok(Number(match[4]) > 0, result.stdout);
});
