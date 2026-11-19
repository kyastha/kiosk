import { execFile } from 'node:child_process';
import { degrees, PDFDocument, PDFName, PDFNumber } from 'pdf-lib';

const A4 = [595.2756, 841.8898];
const FIT_MARGIN = 18;
export const MAX_PDF_BYTES = 128 * 1024 * 1024;

function selectedPages(ranges, count) {
  if (!ranges) return Array.from({ length: count }, (_, index) => index);
  const selected = new Set();
  for (const range of ranges.split(',')) {
    const match = /^\s*(\d+)(?:\s*-\s*(\d+))?\s*$/.exec(range);
    if (!match) throw new Error('Invalid print page range.');
    const first = Number(match[1]);
    const last = Number(match[2] ?? match[1]);
    if (first < 1 || last < first || last > count) throw new Error('Print page range exceeds the PDF.');
    for (let page = first; page <= last; page++) selected.add(page - 1);
  }
  return [...selected].sort((a, b) => a - b);
}

function position(page, settings) {
  const { x, y, width, height } = page.getCropBox();
  const unit = page.node.lookupMaybe(PDFName.of('UserUnit'), PDFNumber)?.asNumber() ?? 1;
  const angle = (settings.orientation === 'landscape' ? 90 : 0) - page.getRotation().angle;
  const radians = angle * Math.PI / 180;
  const cosine = Math.round(Math.cos(radians));
  const sine = Math.round(Math.sin(radians));
  if (Math.abs(cosine) + Math.abs(sine) !== 1 || !Number.isInteger(angle / 90) ||
      width <= 0 || height <= 0 || unit <= 0) throw new Error('Invalid PDF page geometry.');
  const rotatedWidth = Math.abs(width * cosine) + Math.abs(height * sine);
  const rotatedHeight = Math.abs(width * sine) + Math.abs(height * cosine);
  const scale = settings.scaling === 'fit'
    ? Math.min((A4[0] - 2 * FIT_MARGIN) / rotatedWidth, (A4[1] - 2 * FIT_MARGIN) / rotatedHeight)
    : unit * (settings.scaling === 'custom' ? settings.scalePercent / 100 : 1);
  if (!Number.isFinite(scale) || scale <= 0) throw new Error('Invalid print scale.');
  return {
    box: { left: x, bottom: y, right: x + width, top: y + height },
    draw: {
      x: (A4[0] - scale * (width * cosine - height * sine)) / 2,
      y: (A4[1] - scale * (width * sine + height * cosine)) / 2,
      xScale: scale,
      yScale: scale,
      rotate: degrees(angle)
    }
  };
}

export async function arrangePdf(bytes, settings) {
  if (!['portrait', 'landscape'].includes(settings.orientation) ||
      !['actual', 'fit', 'custom'].includes(settings.scaling)) throw new Error('Invalid print settings.');
  const source = await PDFDocument.load(bytes, { updateMetadata: false });
  const output = await PDFDocument.create();
  const pages = selectedPages(settings.pageRanges, source.getPageCount());
  if (!pages.length) throw new Error('The print document has no pages.');
  for (const index of pages) {
    const page = source.getPage(index);
    const sheet = output.addPage(A4);
    if (!page.node.Contents()) continue;
    const { box, draw } = position(page, settings);
    const embedded = await output.embedPage(page, box);
    sheet.drawPage(embedded, draw);
  }
  const printable = await output.save();
  if (printable.byteLength > MAX_PDF_BYTES) throw new Error('Printable PDF exceeds the kiosk limit.');
  return printable;
}

export function grayscalePdf(bytes, executable) {
  return new Promise((resolve, reject) => {
    const child = execFile(executable, [
      '-q', '-dSAFER', '-dBATCH', '-dNOPAUSE', '-dPDFSTOPONERROR', '-dUseCropBox', '-dPrinted',
      '-d.IgnoreNumCopies=true',
      '-sDEVICE=pdfwrite', '-sColorConversionStrategy=Gray', '-dProcessColorModel=/DeviceGray',
      '-dPreserveSeparation=false',
      '-dPreserveAnnots=false', '-dShowAnnots=true', '-dAutoRotatePages=/None',
      '-sstdout=%stderr', '-sOutputFile=%stdout', '-'
    ], { encoding: 'buffer', timeout: 90_000, killSignal: 'SIGKILL', maxBuffer: MAX_PDF_BYTES },
    (error, output) => {
      if (error || !output?.subarray(0, 5).equals(Buffer.from('%PDF-'))) {
        reject(new Error(error?.code === 'ENOENT'
          ? 'Ghostscript is not installed on the kiosk.'
          : 'The kiosk could not prepare a monochrome PDF.'));
      } else {
        resolve(output);
      }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(bytes);
  });
}

export async function preparePdf(bytes, settings, executable) {
  return arrangePdf(await grayscalePdf(bytes, executable), settings);
}
