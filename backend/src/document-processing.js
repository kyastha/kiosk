import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { HttpError } from './security.js';

const run = promisify(execFile);
const worker = fileURLToPath(new URL('./document-worker.js', import.meta.url));
const types = {
  '.pdf': ['application/pdf', 'application/x-pdf'],
  '.jpg': ['image/jpeg', 'image/pjpeg'],
  '.jpeg': ['image/jpeg', 'image/pjpeg'],
  '.png': ['image/png'],
  '.doc': ['application/msword', 'application/vnd.ms-word'],
  '.docx': ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/zip'],
  '.xls': ['application/vnd.ms-excel', 'application/x-msexcel'],
  '.xlsx': ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/zip'],
  '.ppt': ['application/vnd.ms-powerpoint', 'application/mspowerpoint'],
  '.pptx': ['application/vnd.openxmlformats-officedocument.presentationml.presentation', 'application/zip'],
  '.txt': ['text/plain'],
};
const genericMime = ['', 'application/octet-stream', 'binary/octet-stream'];
let activeConversions = 0;

export async function processDocument({ buffer, fileName, mimeType = '', maxPages, workRoot = tmpdir() }) {
  const extension = extname(fileName).toLowerCase();
  const mime = mimeType.split(';', 1)[0].trim().toLowerCase();
  if (!Object.hasOwn(types, extension)) {
    throw new HttpError(415, 'Choose a PDF, JPG, PNG, Word, Excel, PowerPoint, or text file.');
  }
  if (!genericMime.includes(mime) && !types[extension].includes(mime)) {
    throw new HttpError(415, 'The file type does not match its extension.');
  }
  if (!buffer.length) throw new HttpError(422, 'The file is empty.');
  if (activeConversions >= 2) {
    throw new HttpError(503, 'The kiosk is processing other files. Try again in a moment.');
  }

  activeConversions++;
  let temp;
  let root;
  try {
    await mkdir(workRoot, { recursive: true, mode: 0o700 });
    root = await realpath(workRoot);
    temp = await mkdtemp(join(root, 'conversion-'));
    await writeFile(join(temp, `input${extension}`), buffer, { mode: 0o600, flag: 'wx' });
    let result;
    try {
      // Give document parsers a separate heap, deadline and private working directory.
      const { stdout } = await run(
        process.execPath,
        ['--max-old-space-size=384', worker, temp, extension, String(maxPages)],
        { cwd: temp, timeout: 75_000, maxBuffer: 8192, windowsHide: true, env: workerEnv(temp) },
      );
      result = JSON.parse(stdout);
    } catch {
      throw new HttpError(422, 'The document could not be processed. Try exporting it to a new PDF.');
    }
    if (result.error) throw new HttpError(result.status, result.error);
    return { pdf: await readFile(join(temp, 'printable.pdf')), pageCount: result.pageCount };
  } finally {
    activeConversions--;
    if (temp && dirname(temp) === root) {
      await rm(temp, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 });
    }
  }
}

function workerEnv(temp) {
  const keys = ['PATH', 'SystemRoot', 'WINDIR', 'SystemDrive', 'SOFFICE_PATH', 'PDFINFO_PATH'];
  const environment = Object.fromEntries(
    keys.flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]]]),
  );
  return {
    ...environment,
    HOME: temp,
    USERPROFILE: temp,
    TMPDIR: temp,
    TEMP: temp,
    TMP: temp,
    XDG_CACHE_HOME: temp,
    XDG_CONFIG_HOME: temp,
    XDG_DATA_HOME: temp,
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    OMP_THREAD_LIMIT: '2',
    SAL_USE_VCLPLUGIN: 'svp',
  };
}
