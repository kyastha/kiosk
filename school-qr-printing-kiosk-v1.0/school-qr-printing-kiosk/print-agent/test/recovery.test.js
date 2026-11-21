import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createAgent } from '../src/agent.js';
import { openJournal } from '../src/journal.js';

async function setup(t) {
  const path = await mkdtemp(join(tmpdir(), 'kiosk-agent-test-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  const h = {
    calls: 0, submits: 0, transitions: [], snapshot: null, queue: null, now: 1_000,
    job: { id: 'print-123', attemptId: 'attempt-123', status: 'PROCESSING' },
    printer: { status: 'READY', reasons: [], activeJobs: 0, scaling: [], colorModes: [] },
    cupsJob: null
  };
  h.backend = {
    async heartbeat(snapshot) {
      h.snapshot = snapshot;
      return { queue: h.queue };
    },
    async claim(recoveryOnly) {
      h.calls++;
      if (h.job?.status === 'QUEUED' && recoveryOnly) return null;
      return h.job && { ...h.job };
    },
    async authorize(job, queue) {
      if (h.job.submissionAuthorized || job.attemptId !== h.job.attemptId) return false;
      h.job.submissionAuthorized = true;
      h.job.queue = queue;
      if (h.loseGrant) throw new Error('Backend connection dropped during authorization');
      return true;
    },
    async status(job, status) {
      if (h.disconnectStatus) throw new Error('Backend connection dropped after submission');
      h.transitions.push(status);
      h.job = ['SUBMITTED_TO_PRINTER'].includes(status.status) ? { ...h.job, ...status } : null;
    },
    async document() {
      return Buffer.from('%PDF-1.7');
    }
  };
  h.cups = {
    async printer() {
      if (h.disconnectPrinter) throw new Error('Printer unavailable');
      return h.printer;
    },
    async validate() {
      if (h.validationError) throw new Error(h.validationError);
    },
    async submit(queue, job, marker) {
      h.submits++;
      h.cupsJob = { id: '15', marker, state: 5, reasons: [], queue };
      if (h.loseSubmission) throw new Error('CUPS connection dropped after acceptance');
      return h.cupsJob.id;
    },
    async find(queue, marker) {
      return h.cupsJob?.queue === queue && h.cupsJob?.marker === marker ? [h.cupsJob] : [];
    },
    async job(queue, id) {
      return h.cupsJob?.queue === queue && h.cupsJob?.id === String(id) ? h.cupsJob : null;
    }
  };
  h.agent = async (dir = path) => createAgent({
    backend: h.backend, cups: h.cups, journal: await openJournal(dir),
    prepare: async bytes => bytes, defaultQueue: 'School', log: () => {},
    now: () => h.now, graceMs: 2_000
  });
  return h;
}

test('a paid job is submitted once and stays submitted until CUPS completes', async t => {
  const h = await setup(t);
  const agent = await h.agent();
  await agent.tick();
  assert.equal(h.submits, 1);
  assert.deepEqual(h.transitions.map(status => status.status), ['SUBMITTED_TO_PRINTER']);
  await agent.tick();
  assert.equal(h.transitions.length, 1);
  h.cupsJob.state = 9;
  await agent.tick();
  assert.equal(h.submits, 1);
  assert.equal(h.transitions.at(-1).status, 'COMPLETED');
});

test('an offline or paper-out printer holds new work at the backend', async t => {
  const h = await setup(t);
  h.job.status = 'QUEUED';
  h.disconnectPrinter = true;
  const agent = await h.agent();
  await agent.tick();
  assert.equal(h.snapshot.status, 'OFFLINE');
  assert.equal(h.job.status, 'QUEUED');
  h.disconnectPrinter = false;
  h.printer = { status: 'ERROR', reasons: ['media-empty-error'], activeJobs: 0 };
  await agent.tick();
  assert.equal(h.snapshot.status, 'ERROR');
  assert.deepEqual(h.snapshot.reasons, ['media-empty-error']);
  assert.equal(h.submits, 0);
});

test('paper-out after submission is reported without a second print or payment', async t => {
  const h = await setup(t);
  const agent = await h.agent();
  await agent.tick();
  h.cupsJob.state = 6;
  h.cupsJob.reasons = ['media-empty-error'];
  h.printer = { status: 'ERROR', reasons: ['media-empty-error'], activeJobs: 1 };
  await agent.tick();
  assert.equal(h.transitions.at(-1).status, 'SUBMITTED_TO_PRINTER');
  assert.match(h.transitions.at(-1).error, /media-empty-error/);
  h.cupsJob.reasons = [];
  h.cupsJob.state = 9;
  await agent.tick();
  assert.equal(h.transitions.at(-1).status, 'COMPLETED');
  assert.equal(h.submits, 1);
});

test('a connection drop after CUPS acceptance recovers on restart and keeps the original queue', async t => {
  const h = await setup(t);
  h.loseSubmission = true;
  await (await h.agent()).tick();
  assert.equal(h.submits, 1);
  assert.equal(h.transitions.length, 0);
  h.queue = 'Replacement';
  const restarted = await h.agent();
  await restarted.tick();
  assert.equal(h.snapshot.queue, 'Replacement');
  assert.equal(h.job.status, 'SUBMITTED_TO_PRINTER');
  h.cupsJob.state = 9;
  await restarted.tick();
  assert.equal(h.transitions.at(-1).status, 'COMPLETED');
  assert.equal(h.submits, 1);
});

test('a backend disconnection after submission replays status instead of the document', async t => {
  const h = await setup(t);
  h.disconnectStatus = true;
  await assert.rejects((await h.agent()).tick(), /connection dropped/);
  h.disconnectStatus = false;
  h.cupsJob.state = 9;
  await (await h.agent()).tick();
  assert.equal(h.submits, 1);
  assert.deepEqual(h.transitions.map(status => status.status), ['SUBMITTED_TO_PRINTER', 'COMPLETED']);
});

test('a lost authorization response never causes submission or enables unsafe retry', async t => {
  const h = await setup(t);
  h.loseGrant = true;
  await assert.rejects((await h.agent()).tick(), /connection dropped/);
  const restarted = await h.agent();
  await restarted.tick();
  h.now += 3_000;
  await restarted.tick();
  assert.equal(h.submits, 0);
  assert.equal(h.transitions.at(-1).status, 'FAILED');
  assert.equal(h.transitions.at(-1).retrySafe, false);
});

test('a known pre-submission rejection is eligible for controlled retry', async t => {
  const h = await setup(t);
  h.validationError = 'The printer rejected A4.';
  const agent = await h.agent();
  await agent.tick();
  assert.equal(h.submits, 0);
  assert.equal(h.transitions.at(-1).status, 'RETRY_PENDING');
  assert.equal(h.transitions.at(-1).retrySafe, true);
  h.validationError = null;
  h.job = { id: 'print-123', attemptId: 'retry-123', status: 'PROCESSING' };
  await agent.tick();
  assert.equal(h.submits, 1);
});

test('competing workers cannot both submit the same backend attempt', async t => {
  const h = await setup(t);
  const anotherDirectory = await mkdtemp(join(tmpdir(), 'kiosk-competing-agent-'));
  t.after(() => rm(anotherDirectory, { recursive: true, force: true }));
  const agents = await Promise.all([h.agent(), h.agent(anotherDirectory)]);
  await Promise.all(agents.map(agent => agent.tick()));
  assert.equal(h.submits, 1);
});

test('an unsuccessful CUPS terminal state is recorded without an automatic retry', async t => {
  const h = await setup(t);
  const agent = await h.agent();
  await agent.tick();
  h.cupsJob.state = 9;
  h.cupsJob.reasons = ['job-completed-with-errors'];
  await agent.tick();
  assert.equal(h.transitions.at(-1).status, 'FAILED');
  assert.equal(h.transitions.at(-1).retrySafe, false);
  assert.equal(h.submits, 1);
});

test('CUPS forwarding without device feedback does not confirm printing', async t => {
  const h = await setup(t);
  const agent = await h.agent();
  await agent.tick();
  h.cupsJob.state = 9;
  h.cupsJob.reasons = ['queued-in-device'];
  await agent.tick();
  assert.equal(h.transitions.at(-1).status, 'COMPLETION_UNCONFIRMED');
  assert.equal(h.submits, 1);
});
