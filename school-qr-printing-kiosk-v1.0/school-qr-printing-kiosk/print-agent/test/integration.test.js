import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { PDFDocument } from 'pdf-lib';
import { createApp } from '../../backend/src/app.js';
import { loadConfig } from '../../backend/src/config.js';
import { createAgent } from '../src/agent.js';
import { createBackend } from '../src/backend.js';
import { arrangePdf } from '../src/document.js';
import { openJournal } from '../src/journal.js';

test('the real API dispatches only paid documents and recovers a lost CUPS submission response', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'kiosk-agent-integration-'));
  const config = loadConfig({
    DATA_DIR: join(directory, 'data'),
    APP_SECRET: randomBytes(32).toString('hex'),
    AGENT_TOKEN: randomBytes(32).toString('hex'),
    ADMIN_PASSWORD: randomBytes(16).toString('hex')
  });
  const { app, db } = createApp(config);
  const server = app.listen(0, '127.0.0.1');
  t.after(async () => {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    db.close();
    await rm(directory, { recursive: true, force: true });
  });
  await once(server, 'listening');
  const url = 'http://127.0.0.1:' + server.address().port;
  config.publicOrigin = url;

  let cookie;
  async function json(path, { body, form, expected = 200 } = {}) {
    const headers = {};
    if (cookie) headers.cookie = cookie;
    if (body) headers['content-type'] = 'application/json';
    const response = await fetch(new URL(path, url), {
      method: body || form ? 'POST' : 'GET', headers, body: form ?? (body ? JSON.stringify(body) : undefined)
    });
    const result = await response.json();
    assert.equal(response.status, expected, JSON.stringify(result));
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    return result;
  }

  await json('/api/config');
  const source = await PDFDocument.create();
  source.addPage().drawText('School print agent integration');
  const form = new FormData();
  form.append('file', new Blob([await source.save()], { type: 'application/pdf' }), 'worksheet.pdf');
  const document = await json('/api/documents', { form, expected: 201 });
  const order = await json('/api/orders', { expected: 201, body: {
    documentId: document.id, customerName: 'Test student', copies: 2,
    orientation: 'landscape', pageRanges: '1', scaling: 'fit'
  } });

  let submits = 0;
  let acceptedJob;
  let printedPdf;
  const cups = {
    async printer() {
      return { status: 'READY', reasons: [], activeJobs: 0, scaling: ['none'], colorModes: ['monochrome'] };
    },
    async validate(queue, job) {
      assert.equal(queue, 'School');
      assert.equal(job.copies, 2);
      assert.equal(job.orientation, 'landscape');
    },
    async submit(queue, job, marker, printer, bytes) {
      submits++;
      printedPdf = bytes;
      acceptedJob = { id: '104', marker, state: 5, reasons: [] };
      throw new Error('CUPS response interrupted after acceptance');
    },
    async job(queue, id) {
      return acceptedJob?.id === String(id) ? acceptedJob : null;
    },
    async find(queue, marker) {
      return acceptedJob?.marker === marker ? [acceptedJob] : [];
    }
  };
  const agent = async () => createAgent({
    backend: createBackend(url, config.agentToken), cups, prepare: arrangePdf,
    journal: await openJournal(join(directory, 'agent-state')), defaultQueue: 'School', log: () => {}
  });

  await (await agent()).tick();
  assert.equal(submits, 0);
  const reference = new URL(order.paymentUrl).pathname.split('/').at(-1);
  const payment = await json('/api/payments/' + reference);
  await json('/api/payments/' + reference + '/simulate', {
    body: { outcome: 'success', pin: payment.demoPin, amount: payment.total }
  });
  const statusPath = new URL(order.statusUrl);
  const getOrder = () => json('/api' + statusPath.pathname + statusPath.search);
  assert.equal((await getOrder()).printStatus, 'QUEUED');

  await (await agent()).tick();
  assert.equal(submits, 1);
  assert.equal((await PDFDocument.load(printedPdf)).getPageCount(), 1);
  assert.equal((await getOrder()).printStatus, 'PROCESSING');
  const restarted = await agent();
  await restarted.tick();
  assert.equal((await getOrder()).printStatus, 'SUBMITTED_TO_PRINTER');
  acceptedJob.state = 9;
  acceptedJob.reasons = ['queued-in-device'];
  await restarted.tick();
  assert.equal((await getOrder()).printStatus, 'COMPLETION_UNCONFIRMED');
  await restarted.tick();
  assert.equal(submits, 1);
});
