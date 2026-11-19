import { setTimeout as delay } from 'node:timers/promises';
import { resolve } from 'node:path';
import { createAgent } from './agent.js';
import { createBackend } from './backend.js';
import { createCups, validQueue } from './cups.js';
import { preparePdf } from './document.js';
import { openJournal } from './journal.js';

const {
  KIOSK_API_URL = 'http://127.0.0.1:3000',
  AGENT_TOKEN,
  CUPS_QUEUE = '',
  CUPS_URL = 'ipp://127.0.0.1:631',
  AGENT_STATE_DIR = './agent-state',
  AGENT_POLL_MS = '3000',
  GHOSTSCRIPT_BIN = 'gs'
} = process.env;

const interval = Number(AGENT_POLL_MS);
if (!Number.isInteger(interval) || interval < 1_000 || interval > 60_000) {
  throw new Error('AGENT_POLL_MS must be between 1000 and 60000.');
}
if (CUPS_QUEUE && !validQueue(CUPS_QUEUE)) throw new Error('CUPS_QUEUE is invalid.');

const agent = createAgent({
  backend: createBackend(KIOSK_API_URL, AGENT_TOKEN),
  cups: createCups(CUPS_URL),
  journal: await openJournal(resolve(AGENT_STATE_DIR)),
  prepare: (bytes, job) => preparePdf(bytes, job, GHOSTSCRIPT_BIN),
  defaultQueue: CUPS_QUEUE
});
const stop = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => stop.abort());
}

console.log('Kiosk print agent started.');
while (!stop.signal.aborted) {
  try {
    await agent.tick();
  } catch (error) {
    console.error('Kiosk print agent: ' + error.message);
  }
  await delay(interval, undefined, { signal: stop.signal }).catch(error => {
    if (error.name !== 'AbortError') throw error;
  });
}
