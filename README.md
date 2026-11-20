# School QR Printing Kiosk

A self-service A4 printing kiosk for a school LAN. Students and teachers scan the permanent QR, upload files to a cart, review the PDFs and consolidated price, and open the simulator to test payment. A successful simulation issues one downloadable receipt and releases one job to the local print agent. The administrator can manage rates, orders, printer settings and CSV reports.

**TEST PAYMENT — NO REAL MONEY TRANSFERRED**

## Run locally

Install Node.js 24 LTS, Poppler (with pdfinfo on PATH), and LibreOffice (with soffice on PATH). Set SOFFICE_PATH or PDFINFO_PATH in .env if needed. On Windows use the console executable soffice.com for the override. A PDF-only trial still needs Poppler.

```sh
npm ci
node scripts/setup-dev.mjs
npm run build
npm start
```

Open [the kiosk](http://localhost:3000/) or [the administration dashboard](http://localhost:3000/admin). Use the administrator credentials generated in .env. The kiosk can exercise upload, payment, and receipts without a printer. Paid jobs wait in the queue until a Linux agent connects. [Linux deployment](docs/deployment.md) covers phones, HTTPS, CUPS, and reboot recovery.

The local server also accepts [127.0.0.1 on port 3000](http://127.0.0.1:3000/). Use the address in PUBLIC_ORIGIN when accessing a deployed kiosk.

On the 14-inch laptop display, open [the kiosk display](http://localhost:3000/kiosk) and select **Fullscreen**. Its interactive journey map follows scanning, file preparation, settings, review and payment. The permanent access QR stays visible. At checkout a separate payment QR shows the exact order total. After payment confirmation the screen welcomes the next customer while retaining a compact live print status. Open [the printing display](http://localhost:3000/printer) for a dedicated status view.

The payment simulator loads the amount from the order automatically. Enter the six-digit demo PIN shown on that test payment page and select Pay. Five incorrect PIN attempts lock that payment. A successful test payment releases one print job and one receipt. To scan from a separate phone, configure PUBLIC_ORIGIN to the HTTPS address reachable from the school network.

## What the MVP supports

- PDF, JPG, JPEG, PNG, DOC, DOCX, XLS, XLSX, PPT, PPTX, and UTF-8 TXT. PDF preview shows the converted document before checkout. Password-protected or unsupported files and Office documents with active content or external resources can be rejected.
- A4, grayscale, portrait or landscape, selected page ranges, copies, fit, actual size, and 25–200% scaling. The agent prepares the selected pages on A4 before submission. Actual size and large custom scales can crop content outside the sheet or its printable area.
- A cart holds up to eight files. Choose page ranges per file and apply one set of print settings across the cart. The backend combines the selected pages in cart order, calculates one total, and issues one itemized receipt.
- WebSocket updates drive the monitor and the phone's print progress indicator. The phone falls back to status polling if its WebSocket drops.
- Prices are in NPR, stored as integer paisa. Defaults are NPR 5 per selected page, 10 copies, 20 MiB, 100 pages, and 24-hour file retention. The order snapshots the rate. Simulated payments expire after 30 minutes.
- Optional Google Picker for files authorized by the current Google account. Local upload needs only a name. [Google setup](docs/deployment.md#optional-google-drive-picker)
- Print history separates CUPS submission, CUPS-reported completion, and forwarding without output confirmation. Retry is available for attempts confirmed never to have reached CUPS. The operator resolves ambiguous cases at the printer before taking further action.
- A future Fonepay adapter boundary for official merchant creation, verification, callbacks and reconciliation. See [architecture](docs/architecture.md).

## Verify

```sh
npm run check
npm test
npm run build
npx playwright install chromium webkit
npm run test:browser
```

The Node suite covers conversion, access control, pricing, simulator verification and replay, receipts, reporting, retention, mock CUPS, and restart recovery. LibreOffice cases report skips if LibreOffice is missing. PDF cases require Poppler. Browser tests start a disposable API and database and cover desktop and mobile layouts. Set KIOSK_TEST_WEBKIT=1 to include iPhone emulation with WebKit, or set KIOSK_PLAYWRIGHT_CHANNEL=chrome to use installed Google Chrome for Chromium projects. See [verification and acceptance steps](docs/testing.md).

## Project layout

| Location | Purpose |
| --- | --- |
| frontend | React phone workflow and administration dashboard |
| backend/src | Express API, document conversion, simulator, reports and receipts |
| backend/migrations | Versioned SQLite schema |
| print-agent | Linux agent, CUPS IPP adapter, recovery journal and systemd unit |
| tests | API integration and Playwright browser tests |
| docs | [Architecture](docs/architecture.md), [API](docs/openapi.yaml), [deployment](docs/deployment.md) and [testing](docs/testing.md) |

Released under the [MIT license](LICENSE).
