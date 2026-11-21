import { execFile, spawn } from 'node:child_process';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { crc32 } from 'node:zlib';
import CFB from 'cfb';
import { PDFDocument, PDFName, PDFRawStream, PageSizes } from 'pdf-lib';
import { SaxesParser } from 'saxes';
import sharp from 'sharp';
import yauzl from 'yauzl';

const run = promisify(execFile);
const maxPdfBytes = 80 * 1024 * 1024;
const maxArchiveBytes = 96 * 1024 * 1024;
const oleSignature = Buffer.from('d0cf11e0a1b11ae1', 'hex');
const pngSignature = Buffer.from('89504e470d0a1a0a', 'hex');
const jpegSignature = Buffer.from('ffd8ff', 'hex');
const pageKeys = new Set([
  '/Type', '/Parent', '/Resources', '/MediaBox', '/CropBox', '/BleedBox', '/TrimBox',
  '/ArtBox', '/Contents', '/Rotate', '/Group', '/UserUnit',
]);

const officeFormats = {
  '.doc': { streams: ['worddocument'], export: 'writer' },
  '.docx': { part: 'word/document.xml', type: 'wordprocessingml.document', export: 'writer' },
  '.xls': { streams: ['workbook', 'book'], export: 'calc' },
  '.xlsx': { part: 'xl/workbook.xml', type: 'spreadsheetml.sheet', export: 'calc' },
  '.ppt': { streams: ['powerpoint document'], export: 'impress' },
  '.pptx': { part: 'ppt/presentation.xml', type: 'presentationml.presentation', export: 'impress' },
  '.txt': { export: 'writer', input: 'Text (encoded):UTF8,LF,Liberation Mono,en-US' },
};

function fail(status, message) {
  throw Object.assign(new Error(message), { status });
}

function corrupt() {
  fail(422, 'The file is corrupt, encrypted, or does not match its extension.');
}

function assertPageLimit(count, maxPages) {
  if (!Number.isInteger(count) || count < 1) corrupt();
  if (count > maxPages) fail(422, `Documents may contain at most ${maxPages} printable pages.`);
}

async function inspectPdf(path, maxPages) {
  try {
    const { stdout, stderr } = await run(process.env.PDFINFO_PATH || 'pdfinfo', [path], {
      timeout: 8_000,
      maxBuffer: 64 * 1024,
      windowsHide: true,
    });
    if (/syntax error/i.test(stderr) || /^Encrypted:\s*yes/im.test(stdout)) corrupt();
    const count = Number(/^Pages:\s*(\d+)\s*$/m.exec(stdout)?.[1]);
    assertPageLimit(count, maxPages);
    return count;
  } catch (error) {
    if (error.status) throw error;
    if (error.code === 'ENOENT') fail(503, 'The kiosk PDF converter is unavailable.');
    corrupt();
  }
}

async function normalizePdf(path, maxPages) {
  const { size } = await stat(path);
  if (size > maxPdfBytes) fail(422, 'The printable PDF exceeds the kiosk processing limit.');
  const buffer = await readFile(path);
  if (!/^%PDF-[12]\.\d/.test(buffer.subarray(0, 8).toString('latin1'))
      || !/%%EOF\s*$/.test(buffer.subarray(-1024).toString('latin1'))) corrupt();
  const count = await inspectPdf(path, maxPages);
  const source = await PDFDocument.load(buffer, { throwOnInvalidObject: true, updateMetadata: false });
  if (source.context.enumerateIndirectObjects().some(([, object]) => (
    object instanceof PDFRawStream && object.dict.has(PDFName.of('F'))
  ))) {
    fail(422, 'Export PDFs with externally linked content as a self-contained PDF before uploading.');
  }
  const sourcePages = source.getPages();
  if (sourcePages.length !== count) corrupt();

  // Preserve the visible values in ordinary filled forms before stripping active PDF features.
  if (source.catalog.has(PDFName.of('AcroForm'))) {
    const form = source.getForm();
    if (form.hasXFA()) fail(422, 'Export this interactive form as a flat PDF before uploading.');
    form.flatten({ updateFieldAppearances: false });
  }
  for (const page of sourcePages) {
    for (const key of page.node.keys()) {
      if (!pageKeys.has(key.toString())) page.node.delete(key);
    }
  }
  // Rebuild the catalog so file attachments, scripts, actions and interactive forms are dropped.
  const output = await PDFDocument.create({ updateMetadata: false });
  const pages = await output.copyPages(source, source.getPageIndices());
  for (const page of pages) output.addPage(page);
  return { pdf: await output.save(), pageCount: count };
}

async function convertImage(buffer, extension) {
  const isPng = extension === '.png';
  const signature = isPng ? pngSignature : jpegSignature;
  if (!buffer.subarray(0, signature.length).equals(signature)) corrupt();
  const image = sharp(buffer, { failOn: 'warning', limitInputPixels: 25_000_000 });
  const metadata = await image.metadata();
  if (metadata.format !== (isPng ? 'png' : 'jpeg') || (metadata.pages ?? 1) !== 1) corrupt();
  const { data, info } = await image.autoOrient().flatten({ background: '#ffffff' })
    .resize({ width: 2480, height: 3508, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 92 }).toBuffer({ resolveWithObject: true });
  const output = await PDFDocument.create({ updateMetadata: false });
  const page = output.addPage(PageSizes.A4);
  const margin = 28;
  const scale = Math.min((page.getWidth() - 2 * margin) / info.width, (page.getHeight() - 2 * margin) / info.height);
  const width = info.width * scale;
  const height = info.height * scale;
  page.drawImage(await output.embedJpg(data), {
    x: (page.getWidth() - width) / 2,
    y: (page.getHeight() - height) / 2,
    width,
    height,
  });
  return { pdf: await output.save(), pageCount: 1 };
}

function inspectLegacyOffice(buffer, streams) {
  if (!buffer.subarray(0, oleSignature.length).equals(oleSignature)) corrupt();
  const file = CFB.read(buffer, { type: 'buffer' });
  const names = file.FullPaths.map((path) => path.split('/').slice(1).join('/').replace(/\/$/, '').toLowerCase());
  if (names.some((name) => /(^|\/)(vba|_vba_project_cur|_vba_project|macros|objectpool|\u0001ole10native|encryptedpackage|encryptioninfo)(\/|$)/i.test(name))) {
    fail(422, 'Remove macros, embedded files, or password protection before uploading.');
  }
  if (!streams.some((stream) => names.includes(stream))) corrupt();
}

async function readZipPart(zip, entry, readXml) {
  if (readXml && entry.uncompressedSize > 2 * 1024 * 1024) corrupt();
  const stream = await new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, data) => error ? reject(error) : resolve(data));
  });
  const chunks = [];
  let checksum = 0;
  for await (const chunk of stream) {
    checksum = crc32(chunk, checksum);
    if (readXml) chunks.push(chunk);
  }
  if (checksum !== entry.crc32) corrupt();
  if (!readXml) return;
  const buffer = Buffer.concat(chunks);
  const encoding = buffer[0] === 0xff && buffer[1] === 0xfe ? 'utf-16le'
    : buffer[0] === 0xfe && buffer[1] === 0xff ? 'utf-16be'
      : 'utf-8';
  return new TextDecoder(encoding, { fatal: true }).decode(buffer);
}

function inspectPackageXml(xml, relationships, format) {
  const parser = new SaxesParser();
  let mainPartMatches = false;
  parser.on('doctype', corrupt);
  parser.on('opentag', ({ name, attributes }) => {
    const tag = name.split(':').at(-1);
    if (relationships && tag === 'Relationship'
        && attributes.TargetMode?.toLowerCase() === 'external'
        && !attributes.Type?.endsWith('/hyperlink')) {
      fail(422, 'Remove externally linked data or templates before uploading.');
    }
    if (!relationships && /macroenabled|vbaproject|activex/i.test(attributes.ContentType ?? '')) {
      fail(422, 'Remove macros and active content before uploading.');
    }
    if (!relationships && tag === 'Override'
        && attributes.PartName?.toLowerCase() === `/${format.part}`
        && attributes.ContentType === `application/vnd.openxmlformats-officedocument.${format.type}.main+xml`) {
      mainPartMatches = true;
    }
  });
  parser.write(xml).close();
  if (!relationships && !mainPartMatches) corrupt();
}

async function inspectOpenXml(buffer, format) {
  if (!buffer.subarray(0, 4).equals(Buffer.from('504b0304', 'hex'))) corrupt();
  const zip = await new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true, strictFileNames: true }, (error, file) => {
      if (error) reject(error);
      else resolve(file);
    });
  });
  try {
    if (zip.entryCount > 2500) fail(422, 'The Office file contains too many internal parts.');
    const names = new Set();
    let expandedBytes = 0;
    await new Promise((resolve, reject) => {
      zip.on('error', reject);
      zip.once('end', resolve);
      zip.on('entry', async (entry) => {
        try {
          const name = entry.fileName.toLowerCase();
          if (names.has(name) || (entry.generalPurposeBitFlag & 1)) corrupt();
          names.add(name);
          expandedBytes += entry.uncompressedSize;
          if (expandedBytes > maxArchiveBytes) fail(422, 'The Office file expands beyond the kiosk processing limit.');
          if (/(^|\/)(vbaproject[^/]*|activex|embeddings|externallinks|macrosheets)(\/|$)/i.test(name)) {
            fail(422, 'Remove macros, embedded files, or externally linked data before uploading.');
          }
          if (!name.endsWith('/')) {
            const relationships = name.endsWith('.rels');
            const isXml = relationships || name === '[content_types].xml';
            const xml = await readZipPart(zip, entry, isXml);
            if (isXml) inspectPackageXml(xml, relationships, format);
          }
          zip.readEntry();
        } catch (error) {
          reject(error);
        }
      });
      zip.readEntry();
    });
    if (!names.has('[content_types].xml') || !names.has('_rels/.rels') || !names.has(format.part)) corrupt();
  } finally {
    zip.close();
  }
}

const officeProfile = `<?xml version="1.0" encoding="UTF-8"?>
<oor:items xmlns:oor="http://openoffice.org/2001/registry">
  <item oor:path="/org.openoffice.Office.Common/Security/Scripting">
    <prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop>
    <prop oor:name="DisableMacrosExecution" oor:op="fuse"><value>true</value></prop>
  </item>
  <item oor:path="/org.openoffice.Office.Writer/Content/Update">
    <prop oor:name="Link" oor:op="fuse"><value>2</value></prop>
    <prop oor:name="Field" oor:op="fuse"><value>false</value></prop>
  </item>
  <item oor:path="/org.openoffice.Office.Calc/Content/Update">
    <prop oor:name="Link" oor:op="fuse"><value>1</value></prop>
  </item>
</oor:items>`;

function runOffice(executable, args, cwd) {
  return new Promise((resolve, reject) => {
    const windows = process.platform === 'win32';
    // LibreOffice's launcher starts another process. Stop the whole tree on timeout.
    const child = spawn(executable, args, { cwd, detached: !windows, stdio: 'ignore', windowsHide: true });
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      if (windows) {
        const stop = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
          stdio: 'ignore', windowsHide: true,
        });
        stop.once('error', () => child.kill());
        stop.once('exit', (code) => { if (code !== 0) child.kill(); });
      } else {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch (error) {
          if (error.code !== 'ESRCH') child.kill('SIGKILL');
        }
      }
    }, 55_000);
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timeout);
      if (timedOut) reject(new Error('Office conversion timed out.'));
      else if (code === 0) resolve();
      else reject(new Error('Office conversion failed.'));
    });
  });
}

async function convertOffice({ dir, input, buffer, extension, maxPages }) {
  const format = officeFormats[extension];
  if (format.part) await inspectOpenXml(buffer, format);
  else if (format.streams) inspectLegacyOffice(buffer, format.streams);
  else {
    const encoding = buffer[0] === 0xff && buffer[1] === 0xfe ? 'utf-16le'
      : buffer[0] === 0xfe && buffer[1] === 0xff ? 'utf-16be'
        : 'utf-8';
    const text = new TextDecoder(encoding, { fatal: true }).decode(buffer);
    if (!text.trim() || /[\u0000-\u0008\u000b\u000e-\u001f\u007f]/u.test(text)) corrupt();
    await writeFile(input, text.replace(/\r\n?/g, '\n'), { mode: 0o600 });
  }

  const profile = join(dir, 'office-profile');
  const userProfile = join(profile, 'user');
  await mkdir(userProfile, { recursive: true, mode: 0o700 });
  await writeFile(join(userProfile, 'registrymodifications.xcu'), officeProfile, { mode: 0o600 });
  const filterOptions = {
    PageRange: { type: 'string', value: `1-${maxPages + 1}` },
    ExportFormFields: { type: 'boolean', value: 'false' },
    ExportBookmarks: { type: 'boolean', value: 'false' },
    ReduceImageResolution: { type: 'boolean', value: 'true' },
    MaxImageResolution: { type: 'long', value: '300' },
  };
  try {
    await runOffice(process.env.SOFFICE_PATH || (process.platform === 'win32' ? 'soffice.com' : 'soffice'), [
      `-env:UserInstallation=${pathToFileURL(profile).href}`,
      '--headless', '--nologo', '--nodefault', '--nofirststartwizard', '--norestore',
      ...(format.input ? [`--infilter=${format.input}`] : []),
      '--convert-to', `pdf:${format.export}_pdf_Export:${JSON.stringify(filterOptions)}`,
      '--outdir', dir, input,
    ], dir);
  } catch (error) {
    if (error.code === 'ENOENT') fail(503, 'The kiosk Office converter is unavailable. Upload a PDF or image instead.');
    fail(422, 'This document could not be converted. Try exporting it to PDF.');
  }
  return normalizePdf(join(dir, 'input.pdf'), maxPages);
}

async function main() {
  const [dir, extension, maxPagesArgument] = process.argv.slice(2);
  const maxPages = Number(maxPagesArgument);
  const input = join(dir, `input${extension}`);
  const buffer = extension === '.pdf' ? null : await readFile(input);
  let result;
  if (extension === '.pdf') result = await normalizePdf(input, maxPages);
  else if (['.jpg', '.jpeg', '.png'].includes(extension)) result = await convertImage(buffer, extension);
  else result = await convertOffice({ dir, input, buffer, extension, maxPages });
  assertPageLimit(result.pageCount, maxPages);
  if (result.pdf.length > maxPdfBytes) fail(422, 'The printable PDF exceeds the kiosk processing limit.');
  await writeFile(join(dir, 'printable.pdf'), result.pdf, { mode: 0o600, flag: 'wx' });
  process.stdout.write(JSON.stringify({ pageCount: result.pageCount }));
}

main().catch((error) => {
  process.stdout.write(JSON.stringify({
    status: error.status || 422,
    error: error.status ? error.message : 'The file is corrupt or could not be converted. Try exporting it to PDF.',
  }));
});
