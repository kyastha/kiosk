import { userInfo } from 'node:os';

const tag = { integer: 0x21, boolean: 0x22, enum: 0x23, name: 0x42, keyword: 0x44,
  uri: 0x45, charset: 0x47, language: 0x48, mime: 0x49 };
const operation = { print: 2, validate: 4, job: 9, jobs: 10, printer: 11 };
const jobAttributes = ['job-id', 'job-name', 'job-state', 'job-state-reasons', 'job-printer-state-reasons'];
const printerAttributes = ['printer-state', 'printer-state-reasons', 'printer-is-accepting-jobs',
  'queued-job-count', 'print-scaling-supported', 'print-color-mode-supported'];
const MAX_IPP_RESPONSE = 16 * 1024 * 1024;

function encodeAttribute(type, name, value) {
  let data;
  if (type === 'integer' || type === 'enum') {
    data = Buffer.alloc(4);
    data.writeInt32BE(value);
  } else {
    data = type === 'boolean' ? Buffer.from([Number(value)]) : Buffer.from(value);
  }
  const key = Buffer.from(name);
  const header = Buffer.from([tag[type], key.length >> 8, key.length & 255]);
  const length = Buffer.from([data.length >> 8, data.length & 255]);
  return Buffer.concat([header, key, length, data]);
}

function encodeGroup(delimiter, attributes) {
  return [Buffer.from([delimiter]), ...attributes.flatMap(([type, name, values]) =>
    [values].flat().map((value, index) => encodeAttribute(type, index ? '' : name, value)))];
}

export function encodeIpp(code, id, attributes, jobOptions = [], document = Buffer.alloc(0)) {
  const header = Buffer.from([1, 1, code >> 8, code & 255, 0, 0, 0, 0]);
  header.writeUInt32BE(id, 4);
  return Buffer.concat([header, ...encodeGroup(1, attributes),
    ...(jobOptions.length ? encodeGroup(2, jobOptions) : []), Buffer.from([3]), document]);
}

export function decodeIpp(buffer) {
  if (buffer.length < 9) throw new Error('Incomplete IPP response.');
  const status = buffer.readUInt16BE(2);
  const id = buffer.readUInt32BE(4);
  const groups = [];
  let group;
  let name;
  let offset = 8;
  function field() {
    const length = buffer.readUInt16BE(offset);
    offset += 2;
    if (offset + length > buffer.length) throw new Error('Incomplete IPP attribute.');
    const value = buffer.subarray(offset, offset + length);
    offset += length;
    return value;
  }
  while (offset < buffer.length) {
    const type = buffer[offset++];
    if (type === 3) return { id, status, groups, offset };
    if (type < 0x10) {
      group = { type, values: Object.create(null) };
      groups.push(group);
      name = undefined;
      continue;
    }
    const key = field().toString('utf8');
    name = key || name;
    const value = field();
    if (!group || !name) throw new Error('Invalid IPP attribute group.');
    let decoded = value.toString('utf8');
    if (type === tag.integer || type === tag.enum) decoded = value.readInt32BE(0);
    if (type === tag.boolean) decoded = value[0] === 1;
    (group.values[name] ??= []).push(decoded);
  }
  throw new Error('Missing IPP end marker.');
}

function first(group, key) {
  return group?.values[key]?.[0];
}

function reasons(group, ...keys) {
  return [...new Set(keys.flatMap(key => group?.values[key] ?? []))]
    .filter(value => typeof value === 'string' && value !== 'none').slice(0, 10);
}

function readJob(group) {
  const id = first(group, 'job-id');
  const state = first(group, 'job-state');
  if (!Number.isInteger(id) || id < 1 || !Number.isInteger(state)) return null;
  return { id: String(id), marker: first(group, 'job-name'), state,
    reasons: reasons(group, 'job-state-reasons', 'job-printer-state-reasons') };
}

export function validQueue(queue) {
  return typeof queue === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,126}$/.test(queue);
}

export function createCups(baseUrl, { request = fetch, username = userInfo().username } = {}) {
  const url = new URL(baseUrl);
  if (!['ipp:', 'ipps:', 'http:', 'https:'].includes(url.protocol) || !url.hostname ||
      url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) {
    throw new Error('CUPS_URL must be a CUPS origin, for example ipp://127.0.0.1:631.');
  }
  const secure = ['ipps:', 'https:'].includes(url.protocol);
  const host = url.hostname + ':' + (url.port || 631);
  let requestId = 0;

  async function send(queue, code, attrs, options, document) {
    if (!validQueue(queue)) throw new Error('Invalid CUPS queue name.');
    const path = '/printers/' + encodeURIComponent(queue);
    const id = ++requestId;
    const body = encodeIpp(code, id, [
      ['charset', 'attributes-charset', 'utf-8'],
      ['language', 'attributes-natural-language', 'en'],
      ['uri', 'printer-uri', (secure ? 'ipps://' : 'ipp://') + host + path],
      ['name', 'requesting-user-name', username],
      ...attrs
    ], options, document);
    const response = await request((secure ? 'https://' : 'http://') + host + path, {
      method: 'POST', headers: { 'content-type': 'application/ipp' }, body,
      redirect: 'error', signal: AbortSignal.timeout(30_000)
    });
    if (!response.ok) {
      await response.body?.cancel();
      const error = new Error('CUPS returned HTTP ' + response.status + '.');
      error.httpStatus = response.status;
      throw error;
    }
    const chunks = [];
    let size = 0;
    const reader = response.body.getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_IPP_RESPONSE) throw new Error('CUPS response exceeds the size limit.');
        chunks.push(value);
      }
    } finally {
      await reader.cancel();
    }
    const reply = decodeIpp(Buffer.concat(chunks, size));
    if (reply.id !== id) throw new Error('CUPS response request ID did not match.');
    if (reply.status >= 0x100) {
      const error = new Error('CUPS returned IPP status 0x' + reply.status.toString(16) + '.');
      error.ippStatus = reply.status;
      throw error;
    }
    return reply;
  }

  function printParameters(job, marker, printer) {
    const attrs = [['name', 'job-name', marker], ['mime', 'document-format', 'application/pdf'],
      ['boolean', 'ipp-attribute-fidelity', true]];
    const options = [['keyword', 'media', 'iso_a4_210x297mm'], ['integer', 'copies', job.copies],
      ['keyword', 'sides', 'one-sided'], ['keyword', 'job-sheets', 'none'],
      ['integer', 'number-up', 1], ['enum', 'orientation-requested', 3]];
    if (printer.scaling.includes('none')) options.push(['keyword', 'print-scaling', 'none']);
    if (printer.colorModes.includes('monochrome')) options.push(['keyword', 'print-color-mode', 'monochrome']);
    return { attrs, options };
  }

  return {
    async printer(queue) {
      const { groups } = await send(queue, operation.printer, [['keyword', 'requested-attributes', printerAttributes]]);
      const printer = groups.find(group => group.type === 4);
      const state = first(printer, 'printer-state');
      if (!printer || ![3, 4, 5].includes(state)) throw new Error('CUPS did not report a printer state.');
      const issues = reasons(printer, 'printer-state-reasons');
      const blocked = issues.some(reason =>
        /^(paused|shutdown|offline|media-empty|media-needed|media-jam|toner-empty|marker-supply-empty|cover-open|door-open|connecting-to-device)(?:-|$)|-error$/.test(reason));
      const accepting = first(printer, 'printer-is-accepting-jobs') === true;
      const status = blocked || state === 5 || !accepting ? 'ERROR' : state === 4 ? 'BUSY' : 'READY';
      if (!accepting) issues.push('not-accepting-jobs');
      if (state === 5 && !issues.length) issues.push('printer-stopped');
      return { status, reasons: issues.slice(0, 10), activeJobs: Math.max(0, first(printer, 'queued-job-count') ?? 0),
        scaling: printer.values['print-scaling-supported'] ?? [],
        colorModes: printer.values['print-color-mode-supported'] ?? [] };
    },
    async validate(queue, job, marker, printer) {
      const { attrs, options } = printParameters(job, marker, printer);
      const { status } = await send(queue, operation.validate, attrs, options);
      if (status !== 0) throw new Error('CUPS did not accept all requested print options.');
    },
    async submit(queue, job, marker, printer, document) {
      const { attrs, options } = printParameters(job, marker, printer);
      const { groups } = await send(queue, operation.print, attrs, options, document);
      const id = first(groups.find(group => group.type === 2), 'job-id');
      if (!Number.isInteger(id) || id < 1) throw new Error('CUPS did not return a job ID.');
      return String(id);
    },
    async job(queue, id) {
      try {
        const { groups } = await send(queue, operation.job, [
          ['integer', 'job-id', Number(id)], ['keyword', 'requested-attributes', jobAttributes]
        ]);
        return readJob(groups.find(group => group.type === 2));
      } catch (error) {
        if (error.httpStatus === 404 || error.ippStatus === 0x406 || error.ippStatus === 0x407) return null;
        throw error;
      }
    },
    async find(queue, marker) {
      try {
        const { groups } = await send(queue, operation.jobs, [
          ['keyword', 'which-jobs', 'all'], ['boolean', 'my-jobs', true],
          ['keyword', 'requested-attributes', jobAttributes]
        ]);
        return groups.filter(group => group.type === 2).map(readJob).filter(job => job?.marker === marker);
      } catch (error) {
        if (error.httpStatus === 404 || error.ippStatus === 0x406 || error.ippStatus === 0x407) return [];
        throw error;
      }
    }
  };
}
