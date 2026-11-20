# Verification and acceptance

## Automated checks

| Command | Expected result |
| --- | --- |
| npm run check | JavaScript syntax checks pass |
| npm test | API, conversion and agent tests pass. Office and native grayscale cases run when their host tools are present |
| npm run build | Vite emits frontend/dist |
| npm run test:browser | Desktop Chrome and Android/iPhone layout emulation pass |
| KIOSK_TEST_WEBKIT=1 npm run test:browser | Adds the iPhone WebKit project when its browser has been installed |
| docker compose --env-file .env.example config --no-env-resolution --quiet | Compose configuration parses |

On Windows PowerShell, set browser options with $env:KIOSK_TEST_WEBKIT = '1' or $env:KIOSK_PLAYWRIGHT_CHANNEL = 'chrome' before running the command. Playwright starts a disposable test backend. It expects port 3137 to be free and requires the frontend build and Poppler.

## Build verification

The production frontend build, JavaScript syntax checks and Compose configuration validation passed. The Node tests exercised the real SQLite API, mock CUPS with IPP, and native Ghostscript grayscale output. Separate LibreOffice 26.2.6 runs passed both modern and legacy Word, Excel and PowerPoint formats and UTF-8 text. Playwright passed desktop Chrome, Android and iPhone layout emulation in Chrome, and iPhone emulation in WebKit.

Container startup, the school's physical printer and phones, and live Google authorization are deployment acceptance checks.

## On the actual kiosk

1. Open /kiosk on the laptop display, select Fullscreen, and confirm it shows Live updates. Scan the permanent QR from a phone and watch the map highlight the scan and files steps. Add two documents, open their previews, adjust settings, then review. Click the map nodes to read their details.
2. Continue to payment. Check that the separate payment QR on the laptop shows the same consolidated total as the phone. Select Continue to pay on the phone, allow camera access, and scan the kiosk payment QR. Verify the access QR is hidden and the amount appears automatically. Try an incorrect demo PIN and confirm no job is released.
3. Enter the displayed demo PIN to complete the test payment. Confirm the laptop returns to Ready to scan while retaining the print status. Watch the queued, preparing, submitted and completion states on /kiosk or /printer. Download the itemized receipt, then replay the payment request and confirm one payment and one print job.
4. Print the dashboard test page. Confirm A4, grayscale, and single-sided output. Print the paid job and compare paper count, range, order, copies and scale with the checkout summary. Compare the dashboard's terminal status with the actual printer's IPP reporting.
5. Remove paper or power before another job, then restore it. Inspect the error reason and any partial output. Resume the existing CUPS job or retry an eligible unsubmitted attempt. Confirm that the order and original payment survive.
6. Restart the agent after a submission. Confirm it finds the existing CUPS job and leaves the copy count unchanged. Restart the backend and confirm the order and receipt are still accessible.
7. Verify that a second browser cannot open another user's preview or receipt without its capability. Confirm that a new student does not need admin or Google credentials for local upload.
8. If Google Picker is enabled, select a file with an allowed Google test account and verify the resulting preview. Check permission denial and disconnected internet paths.
9. Export the administrator report. Confirm it labels transactions as tests. Perform a test backup and restore before opening the kiosk to regular use.
