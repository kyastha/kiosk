import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { createCups, decodeIpp, encodeIpp } from '../src/cups.js';

function reply(id, group, attributes) {
  const encoded = encodeIpp(0, id, [], attributes);
  encoded[9] = group;
  return encoded;
}

test('CUPS adapter requests real IPP job state and sends an A4 Print-Job', async t => {
  const received = [];
  const printer = [
    ['enum', 'printer-state', 3], ['boolean', 'printer-is-accepting-jobs', true],
    ['keyword', 'printer-state-reasons', 'none'], ['integer', 'queued-job-count', 0],
    ['keyword', 'print-scaling-supported', ['fit', 'none']], ['keyword', 'print-color-mode-supported', 'monochrome']
  ];
  const job = [
    ['integer', 'job-id', 42], ['name', 'job-name', 'kiosk-attempt'],
    ['enum', 'job-state', 9], ['keyword', 'job-state-reasons', 'job-completed-successfully']
  ];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const decoded = decodeIpp(body);
    received.push({ ...decoded, path: req.url, document: body.subarray(decoded.offset) });
    res.setHeader('Content-Type', 'application/ipp');
    if (decoded.status === 11) res.end(reply(decoded.id, 4, printer));
    else if (decoded.status === 4) res.end(encodeIpp(0, decoded.id, []));
    else res.end(reply(decoded.id, 2, job));
  });
  server.listen(0, '127.0.0.1');
  t.after(() => server.close());
  await once(server, 'listening');
  const cups = createCups('ipp://127.0.0.1:' + server.address().port, { username: 'kiosk-print' });
  const snapshot = await cups.printer('School');
  assert.equal(snapshot.status, 'READY');
  await cups.validate('School', { copies: 2 }, 'kiosk-attempt', snapshot);
  const bytes = Buffer.from('%PDF-1.7 print content');
  assert.equal(await cups.submit('School', { copies: 2 }, 'kiosk-attempt', snapshot, bytes), '42');
  assert.deepEqual(await cups.job('School', 42), {
    id: '42', marker: 'kiosk-attempt', state: 9, reasons: ['job-completed-successfully']
  });
  assert.equal((await cups.find('School', 'kiosk-attempt')).length, 1);
  assert.deepEqual(received.map(request => request.status), [11, 4, 2, 9, 10]);
  const submit = received[2];
  assert.equal(submit.path, '/printers/School');
  assert.deepEqual(submit.document, bytes);
  const [operation, settings] = submit.groups;
  assert.deepEqual(operation.values['job-name'], ['kiosk-attempt']);
  assert.deepEqual(operation.values['ipp-attribute-fidelity'], [true]);
  assert.deepEqual(settings.values.media, ['iso_a4_210x297mm']);
  assert.deepEqual(settings.values.copies, [2]);
  assert.deepEqual(settings.values['print-scaling'], ['none']);
  assert.deepEqual(settings.values['print-color-mode'], ['monochrome']);
  assert.deepEqual(settings.values.sides, ['one-sided']);
  assert.deepEqual(settings.values['number-up'], [1]);
  assert.deepEqual(settings.values['orientation-requested'], [3]);
  assert.deepEqual(received.at(-1).groups[0].values['which-jobs'], ['all']);
});
