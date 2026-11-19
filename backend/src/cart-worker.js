import { open, writeFile } from 'node:fs/promises';
import { PDFDocument } from 'pdf-lib';

const maxBytes = 80 * 1024 ** 2;

function pageIndices(pageRanges, pageCount) {
  if (!pageRanges) return Array.from({ length: pageCount }, (_, index) => index);
  const indices = [];
  for (const range of pageRanges.split(',')) {
    const [first, last = first] = range.split('-').map(Number);
    for (let page = first; page <= last; page++) indices.push(page - 1);
  }
  return indices;
}

async function merge(output, manifest) {
  const merged = await PDFDocument.create({ updateMetadata: false });
  let bytes = 0;
  for (const { path, pageCount, pageRanges } of manifest) {
    const input = await open(path, 'r');
    try {
      const info = await input.stat();
      if (!info.isFile()) return { error: 'missing' };
      bytes += info.size;
      if (bytes > maxBytes) return { error: 'size' };
      const source = await PDFDocument.load(await input.readFile(), { throwOnInvalidObject: true, updateMetadata: false });
      if (source.getPageCount() !== pageCount) return { error: 'invalid' };
      const pages = await merged.copyPages(source, pageIndices(pageRanges, pageCount));
      for (const page of pages) merged.addPage(page);
    } finally {
      await input.close();
    }
  }
  const pdf = await merged.save();
  if (pdf.length > maxBytes) return { error: 'size' };
  await writeFile(output, pdf, { flag: 'wx', mode: 0o600, flush: true });
  return { ok: true };
}

try {
  const [output, manifest] = process.argv.slice(2);
  process.stdout.write(JSON.stringify(await merge(output, JSON.parse(manifest))));
} catch (error) {
  process.stdout.write(JSON.stringify({ error: error.code === 'ENOENT' ? 'missing' : 'invalid' }));
}
