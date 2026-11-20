import { CheckCircle2, Maximize, Printer } from 'lucide-react';
import { useState } from 'react';
import { statusLabels } from './api.js';
import { useLiveSnapshot } from './live.js';
import { PrintProgress } from './print-progress.jsx';
import './printer-display.css';

const messages = {
  QUEUED: 'Your paid job is waiting in the print queue.',
  PROCESSING: 'Preparing the pages for printing.',
  SUBMITTED_TO_PRINTER: 'The printer has received the job. Waiting for its completion report.',
  COMPLETED: 'The printer reports completion. Collect your pages.',
  COMPLETION_UNCONFIRMED: 'The job was sent. Check the output tray for your pages.',
  RETRY_PENDING: 'A staff member can retry this job after checking the printer.',
  FAILED: 'The job needs a staff member’s attention. Check any partial output.',
  CANCELLED: 'The print job was cancelled.',
};
const printerTitles = {
  READY: 'Ready for printing',
  BUSY: 'Printer busy',
  ERROR: 'Printer needs attention',
  OFFLINE: 'Printer offline',
  UNCONFIGURED: 'Printer setup needed',
  UNKNOWN: 'Waiting for printer',
};

export default function PrinterDisplay({ online }) {
  const live = useLiveSnapshot('/ws/kiosk', online);
  const [fullscreenError, setFullscreenError] = useState(false);
  const printer = live.value?.printer;
  const order = live.value?.printingOrder;
  const connected = live.connected;
  const completed = order?.printStatus === 'COMPLETED';
  const printerTitle = printerTitles[printer?.status] || 'Waiting for printer';
  const jobTitle = order ? statusLabels[order.printStatus] : printerTitle;
  const status = connected ? jobTitle : 'Waiting for live status';

  async function fullscreen() {
    try {
      await document.documentElement.requestFullscreen();
      setFullscreenError(false);
    } catch {
      setFullscreenError(true);
    }
  }

  return (
    <main id="main" className="printer-display">
      <header>
        <strong>School printing</strong>
        <button className="button secondary" onClick={fullscreen}>
          <Maximize size={17} aria-hidden="true" /> Fullscreen
        </button>
      </header>
      {fullscreenError && <p role="status">Use your browser’s fullscreen command.</p>}
      <section aria-live="polite">
        <div className="printer-display-icon" data-working={connected && ['PROCESSING', 'SUBMITTED_TO_PRINTER'].includes(order?.printStatus)}>
          {completed ? <CheckCircle2 size={76} aria-hidden="true" /> : <Printer size={76} aria-hidden="true" />}
        </div>
        <p className="eyebrow">PRINTER STATUS</p>
        <h1>{status}</h1>
        <p>{connected ? (order ? messages[order.printStatus] : 'Scan the kiosk QR to add your files.') :
          'Reconnecting to the printing service. The last update may be out of date.'}</p>
        {connected && order && <PrintProgress status={order.printStatus} />}
        {connected && order && <small>Job {order.id.slice(0, 8)}</small>}
      </section>
      <footer>
        <p>{connected ? 'Live updates' : online ? 'Connecting' : 'Offline'}</p>
        {printer && <p>Printer {printer.status.toLowerCase().replaceAll('_', ' ')} · {printer.activeJobs} active jobs</p>}
        {connected && printer?.reasons?.length > 0 && <p>{printer.reasons.join(' · ')}</p>}
      </footer>
    </main>
  );
}
