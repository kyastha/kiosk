# School QR Printing Kiosk architecture

One Linux kiosk hosts the HTTPS reverse proxy, the React application and Express API, a private SQLite database with WAL, and a host-side Node.js CUPS agent. Phones connect to the school LAN. The permanent QR links to /?kiosk=1 on the configured public origin. Payment QR codes point to a separate simulator URL with an unguessable reference. Mobile access uses a private browser session for uploads and a separate capability for sharing status and receipts. Payment capabilities cannot download documents or receipts.

## Components

- frontend/src contains the customer and administrative applications.
- backend/src contains the API, SQLite migrations, document conversion, receipts and payment verification.
- print-agent/src contains the host CUPS adapter and recovery journal.
- tests contains API integration and browser tests. docs and scripts cover deployment.

## Persistence

SQLite tables cover admin_users, admin_sessions, documents, orders, payments, print_jobs, print_attempts, printers, settings, kiosk_sessions and audit_logs. Orders hold immutable price and print settings snapshots. Payments have a unique provider reference and a persisted PIN-attempt count. Each order can release at most one print job, and each attempt has a unique identifier. All state changes affecting multiple records are transactional. Document access uses private files and authenticated endpoints. Retention clears expired files while preserving historical records and protecting pending and active jobs.

Cart orders retain an item snapshot. A bounded worker combines the selected pages in cart order into one private PDF. The copy count, orientation, and scaling apply to the whole PDF. The existing single-job lifecycle then handles the merged document.

## HTTP contract

Requests and responses use JSON except uploads (multipart field file), PDFs, CSV and QR images. Errors use {error}. Sensitive routes use same-origin requests or the agent bearer token.

- GET /api/config returns {schoolName, pricePerPage, maxCopies, maxFileMb, maxPages, retentionHours, drive, maxCartFiles, onboardingUrl}. All monetary fields are integer paisa.
- GET /api/kiosk/qr returns PNG.
- POST /api/kiosk/session starts a browser-owned session or reuses an owned, unbound sessionId. It returns {sessionId,sequence}. POST /api/kiosk/activity accepts {sessionId,stage,fileCount,sequence}. Stage is SCANNED, SELECTING, UPLOADING, SETTINGS or REVIEW. Increasing sequence numbers allow editing earlier steps while ignoring stale retries. Unbound activity expires after ten minutes.
- POST /api/documents uploads a file and returns {id, fileName, pageCount, previewUrl}. GET /api/documents/:id/preview returns the private PDF.
- POST /api/quote and POST /api/orders accept {documentId, customerName, copies, orientation, pageRanges, scaling, scalePercent}. Orientation is portrait or landscape. Blank pageRanges means all pages. Scaling is fit, actual or custom. Quote returns {printablePages, copies, pricePerPage, total, paperSize, printingMode, orientation, pageRanges, scaling, scalePercent}. Creation returns the order shape plus {statusUrl, paymentUrl, paymentQrUrl}.
- A cart uses items [{documentId, pageRanges}] instead of documentId and pageRanges at the top level. The quote and order include itemized amounts and page counts. The cart limit is eight files and maxPages selected pages. A combined PDF has an 80 MiB processing limit. The kiosk flag associates a checkout with the public display.
- GET /api/orders/:id takes the order capability as query parameter key and returns {id, customerName, fileName, createdAt, printablePages, copies, pricePerPage, total, paperSize, printingMode, orientation, pageRanges, scaling, scalePercent, paymentStatus, printStatus, statusUrl, paymentUrl, paymentQrUrl, receiptUrl}.
- GET /api/payments/:reference returns {orderId,total,schoolName,paymentStatus,demoPin,pinAttemptsRemaining,expiresAt}. POST /api/payments/:reference/simulate accepts {outcome,pin,amount}. Success requires the current order's six-digit test PIN and an integer paisa amount matching its stored total. Wrong amounts are rejected and five wrong PINs lock the test payment. Failure requires only outcome. GET /api/payments/:reference/qr returns PNG.
- GET /api/orders/:id/receipt?key=... returns receipt PDF after payment.
- POST /api/admin/login accepts {username, password}. GET /api/admin/session and POST /api/admin/logout check or clear the admin cookie.
- GET /api/admin/overview returns {totalOrders, testPaid, failedPayments, testAmount, pendingJobs, completedJobs, unconfirmedJobs, failedJobs, printer}. GET /api/admin/orders accepts q, from, to, paymentStatus, printStatus, limit, offset and returns {orders, total}. Order rows omit capability URLs and add paymentReference, printError and retrySafe. GET /api/admin/orders/:id adds {attempts, events}. GET /api/admin/reports accepts from and to and returns {daily, monthly, totalPages, totalCopies, failedJobs, testAmount}. GET /api/admin/reports.csv exports matching order rows. Dates are YYYY-MM-DD in Asia/Kathmandu.
- PATCH /api/admin/settings accepts schoolName, pricePerPage, maxCopies, maxFileMb, maxPages and retentionHours. POST /api/admin/jobs/:id/retry and /cancel take order IDs. POST /api/admin/printer/test queues a marked test page. PATCH /api/admin/printer accepts {queue}. Printer objects expose {queue, status, reasons, lastSeen, activeJobs}.
- POST /api/agent/heartbeat accepts {queue, status, reasons, activeJobs} and returns {queue, activeJobs}. POST /api/agent/claim takes {recoveryOnly} and returns {job} or {job:null}. Recover an active attempt before claiming another job. Agent job shape is {id, attemptId, attemptNumber, documentUrl, copies, orientation, pageRanges, scaling, scalePercent, cupsId, status, queue, submissionAuthorized, submissionAuthorizedAt}. POST /api/agent/jobs/:id/authorize atomically grants one submission for {attemptId, queue}. GET /api/agent/jobs/:id/document returns printable PDF. POST /api/agent/jobs/:id/status accepts {attemptId, status, cupsId, error, retrySafe}. Statuses accepted are SUBMITTED_TO_PRINTER, COMPLETED, COMPLETION_UNCONFIRMED, FAILED, RETRY_PENDING. Only the owning authorized attempt can update a job.

## Live status

Both WebSocket routes require the kiosk origin and send an initial JSON snapshot followed by changes. /ws/kiosk sends {activity,order,printingOrder,printer}. Activity identifies the most recent scanned session and its current step. A sessionId is included in order creation and atomically bound to that browser's order. The selected pending order includes total and paymentQrUrl. The oldest pending payment keeps the kiosk display until it is confirmed, cancelled or expired; newer scans cannot replace its QR. Names, files, status keys and receipt links stay private. The public printingOrder and printer data separately track the current queue and printer state. /ws/orders/:id?key=... requires the order capability and sends the same data as the private status endpoint.

The /kiosk display shows an interactive journey map, the permanent access QR and a pending payment QR with its total. After a short payment confirmation it returns to onboarding while retaining the printing status. /printer provides a full-screen printing view for the laptop display. Print states come from the agent and preserve the distinction between submission and completion.

## State transitions

Payment starts PENDING and becomes TEST_PAID or FAILED after a backend-verified simulator event. A signed internal event binds the provider reference, amount, and outcome. The first terminal result wins. A transaction records the outcome, audit event and unique job. Pending payments expire after 30 minutes. Failed or pending payments cannot enter the queue.

Print starts PENDING_PAYMENT and becomes PAYMENT_FAILED or QUEUED. The agent claims an order atomically and creates a PROCESSING attempt. It writes a durable local journal before submission. A CUPS job identifier gives SUBMITTED_TO_PRINTER. Explicit IPP completion gives COMPLETED. A job marked queued-in-device ends as COMPLETION_UNCONFIRMED because the device does not report output. Unavailable printers preserve paid orders and surface errors. Known failures before submission can be retried. Uncertain outcomes are reconciled by attempt marker against the local CUPS queue and require operator intervention before a duplicate could be released. Eligible unsubmitted jobs can be cancelled. Retention, authorizations and restart recovery are enforced server-side and in the agent.

## Trust boundaries

Use HTTPS and a dedicated origin for phones, httpOnly admin and upload cookies, strict same-origin mutation checks, hashed passwords, private storage, finite rate and conversion limits, and a kiosk-specific agent token. Google Picker uses a browser OAuth access token scoped to drive.file, downloads only the selected file directly from Google, and uploads it through the normal validation path. Keep Fonepay disabled until official onboarding.

## Review-triggered QR and phone scanner

Review order creates the pending order immediately using the existing idempotency key and browser-owned session. The kiosk receives its payment QR and immutable total through the live feed. Editing first calls POST /api/orders/:id/cancel-review with the private order key. The backend cancels the unpaid reference and detaches its session atomically; paid orders cannot be edited.

The phone's /scan?session=... view validates scanned same-origin payment URLs, then POSTs {sessionId,reference} to /api/kiosk/scan-payment. This route verifies browser ownership, the bound order, the reference and expiry before returning the canonical payment URL and stored total. The existing PIN gateway performs the final amount and PIN verification and transactional single-job release.

Continue to pay opens /scan?session=... and starts an in-page live camera preview with getUserMedia, preferring the rear camera. A supported BarcodeDetector reads QR frames, with a portable decoder handling browsers where that detector is absent or fails. Frames are decoded on the device, and only the payment reference is submitted for backend validation. The kiosk shows only the pending payment QR and restores the access QR after backend-confirmed payment. The scanner also accepts a pasted QR link and performs the same backend validation. Camera and verification requests are cancelled on backgrounding, disconnection and navigation.
