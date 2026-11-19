import { validQueue } from './cups.js';
import { BackendError } from './backend.js';
import { attemptMarker } from './journal.js';

const READY = new Set(['READY', 'BUSY']);
const MISSING_JOB_GRACE_MS = 120_000;
const blockedReason = /media-(empty|needed|jam)|paper|offline|connecting-to-device|paused|stopped|cover-open|door-open|toner-empty|marker-supply-empty|-error(s)?$/;

export function createAgent({ backend, cups, journal, prepare, defaultQueue, now = Date.now,
  graceMs = MISSING_JOB_GRACE_MS, log = console.error }) {
  let queue = defaultQueue;

  async function printerSnapshot(name) {
    if (!validQueue(name)) {
      return { status: 'UNCONFIGURED', reasons: ['Set the CUPS queue.'], activeJobs: 0 };
    }
    try {
      return await cups.printer(name);
    } catch (error) {
      return { status: 'OFFLINE', reasons: [error.message], activeJobs: 0 };
    }
  }

  async function reportPrinter(name, snapshot) {
    return backend.heartbeat({ queue: name || null, status: snapshot.status,
      reasons: snapshot.reasons, activeJobs: snapshot.activeJobs });
  }

  async function finish(job, record, status) {
    await journal.write(job.attemptId, { ...record, final: status });
    await backend.status(job, status);
    await journal.remove(job.attemptId);
  }

  async function reportSubmitted(job, record, error) {
    if (job.status === 'SUBMITTED_TO_PRINTER' && String(job.cupsId) === record.cupsId &&
        (record.reportedError ?? null) === error) return record;
    await backend.status(job, { status: 'SUBMITTED_TO_PRINTER', cupsId: record.cupsId, error });
    const updated = { ...record, reportedError: error };
    await journal.write(job.attemptId, updated);
    return updated;
  }

  async function missing(job, record, queueName, multiple) {
    const status = {
      status: 'FAILED', retrySafe: false,
      error: multiple
        ? 'More than one CUPS job has this attempt marker. Check output and CUPS history.'
        : 'CUPS could not confirm this submission. Check output and CUPS history before reprinting.'
    };
    if (record.cupsId) status.cupsId = record.cupsId;
    if (multiple || (record.missingSince !== undefined && now() - record.missingSince >= graceMs)) {
      await finish(job, record, status);
    } else if (record.missingSince === undefined) {
      await journal.write(job.attemptId, { ...record, queue: queueName, missingSince: now() });
    }
  }

  async function reconcile(job, record, marker) {
    const queueName = job.queue || record.queue || queue;
    const id = record.cupsId ?? job.cupsId;
    let match = id ? await cups.job(queueName, id) : null;
    if (match?.marker !== marker) {
      const found = await cups.find(queueName, marker);
      if (found.length !== 1) {
        await missing(job, record, queueName, found.length > 1);
        return;
      }
      [match] = found;
    }
    let resolved = { ...record, queue: queueName, cupsId: match.id };
    delete resolved.missingSince;
    if (record.cupsId !== resolved.cupsId || record.missingSince !== undefined) {
      await journal.write(job.attemptId, resolved);
    }
    const issues = match.reasons.filter(reason => blockedReason.test(reason));
    const error = issues.length ? 'CUPS: ' + issues.join(', ')
      : match.state === 6 ? 'CUPS reports that printing has stopped.' : null;
    resolved = await reportSubmitted(job, resolved, error);

    const unsuccessful = match.reasons.some(reason => reason.includes('completed-with-errors'));
    if (match.state === 9 && !unsuccessful) {
      if (match.reasons.includes('queued-in-device')) {
        await finish(job, resolved, {
          status: 'COMPLETION_UNCONFIRMED', cupsId: match.id,
          error: 'CUPS forwarded the job to a printer that cannot report completion.'
        });
      } else {
        await finish(job, resolved, { status: 'COMPLETED', cupsId: match.id });
      }
    } else if ([7, 8, 9].includes(match.state)) {
      await finish(job, resolved, {
        status: 'FAILED', cupsId: match.id, retrySafe: false,
        error: 'CUPS reported an unsuccessful job. Check output before reprinting.' +
          (match.reasons.length ? ' ' + match.reasons.join(', ') : '')
      });
    }
  }

  async function preflight(job, record, marker, printer) {
    let document;
    try {
      document = await backend.document(job);
    } catch (error) {
      if (!(error instanceof BackendError) || ![404, 410, 422].includes(error.status)) throw error;
      await finish(job, record, {
        status: 'RETRY_PENDING', retrySafe: true, error: 'The printable PDF is unavailable.'
      });
      return;
    }
    try {
      document = await prepare(document, job);
      await cups.validate(queue, job, marker, printer);
      return document;
    } catch (error) {
      await finish(job, record, {
        status: 'RETRY_PENDING', retrySafe: true,
        error: ('The kiosk stopped before submission. ' + error.message).slice(0, 300)
      });
    }
  }

  return {
    async tick() {
      let printer = await printerSnapshot(queue);
      const configuration = await reportPrinter(queue, printer);
      const desired = configuration.queue || defaultQueue;
      if (queue !== desired) {
        queue = desired;
        printer = await printerSnapshot(queue);
        await reportPrinter(queue, printer);
      }
      const ready = READY.has(printer.status);
      const job = await backend.claim(!ready);
      if (!job) return;
      const marker = attemptMarker(job.attemptId);
      let record = await journal.read(job.attemptId);
      if (record.final && (record.final.status !== 'RETRY_PENDING' || !job.submissionAuthorized)) {
        await backend.status(job, record.final);
        await journal.remove(job.attemptId);
        return;
      }
      if (job.submissionAuthorized || job.cupsId || record.authorized) {
        await reconcile(job, record, marker);
        return;
      }
      if (!ready) return;

      const document = await preflight(job, record, marker, printer);
      if (!document) return;
      record = { queue };
      await journal.write(job.attemptId, record);
      // Only a fresh backend grant can reach Print-Job. A lost grant response is reconciled.
      if (!await backend.authorize(job, queue)) return;
      record.authorized = true;
      await journal.write(job.attemptId, record);
      try {
        record.cupsId = await cups.submit(queue, job, marker, printer, document);
      } catch (error) {
        log('CUPS submission needs reconciliation: ' + error.message);
        return;
      }
      await journal.write(job.attemptId, record);
      await reportSubmitted(job, record, null);
    }
  };
}
