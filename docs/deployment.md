# Linux deployment and hardware setup

## Prepare the kiosk

Use a maintained Linux distribution, 8 GB RAM or more, SSD storage, stable power with a UPS, Ethernet if practical, and suitable cooling. Attach the A4 printer by USB. Confirm the exact printer model and obtain its official Linux driver if driverless IPP-over-USB is unavailable. Run the acceptance checks with the actual model before enabling student access.

Install a supported Node.js 24 LTS runtime, Docker Engine with Compose, and the host packages. Use the installation instructions for your distribution. [Node.js downloads](https://nodejs.org/en/download) · [Docker Engine installation](https://docs.docker.com/engine/install/) On Debian-family systems the printing and proxy packages are typically installed as follows.

```sh
sudo apt install cups cups-client cups-ipp-utils ghostscript nginx
sudo systemctl enable --now cups docker nginx
lpinfo -v
lpstat -p -d
```

Set the queue up using the CUPS administration interface on localhost or the distribution's printer tools. If the printer exposes driverless IPP, use the discovered URI with the everywhere driver. Driverless USB may require the distribution's ipp-usb package. For a vendor driver use its documented device URI and driver. Set the queue default to A4, monochrome, and a stop policy. For example, after creating the School_A4 queue, run the following.

```sh
sudo lpadmin -p School_A4 -o media=A4 -o print-color-mode=monochrome -o printer-error-policy=stop-printer
lpstat -p School_A4 -l
```

Check the queue's driver options for grayscale support. The agent applies the A4 layout and converts the result to a grayscale PDF. Require a working PDF filter chain and confirm simplex A4 and the requested copy count with a test page. Restrict CUPS to local access. Preserve marker metadata in cupsd.conf with PreserveJobHistory Yes and set PreserveJobFiles No to remove terminal spool documents. Restart CUPS after changing that configuration. Size CUPS history for the volume of jobs and keep it across restarts. Keep the original queue and its history while an authorized attempt is active. Treat spool files, SQLite, backups, and the agent journal as private. [CUPS IPP job attributes](https://openprinting.github.io/cups/doc/spec-ipp.html)

## Configure the API and QR

1. Copy the source to /opt/school-kiosk. From that directory run node scripts/setup-dev.mjs to create a private .env. Record the initial administrator credentials securely and set SCHOOL_NAME. Use different APP_SECRET and AGENT_TOKEN values. Keep APP_SECRET stable across restores so order link regeneration stays consistent.
2. Assign a stable kiosk IP and a hostname that resolves to it on the school LAN. Use a trusted TLS certificate for that hostname, including on student phones. A certificate issued through DNS validation can keep the application LAN-only. Copy docs/nginx-kiosk.conf into the active Nginx configuration and replace the hostname and certificate paths. Validate with nginx -t before reloading.
3. Set PUBLIC_ORIGIN to the HTTPS origin with no path and set TRUST_PROXY=1 when Nginx is the single proxy. The Compose service publishes port 3000 on loopback. Keep that port out of public ingress and allow HTTPS only from the intended LAN. Configure the host firewall to restrict outbound conversion-container traffic where practical. The Google Picker uses browser-side Google requests.
4. Run docker compose up -d --build and check docker compose ps and docker compose logs backend. The named kiosk-data volume stores the database and private documents. The service restarts after reboot. Keep the original .env and back it up separately from source archives.
5. Open the HTTPS kiosk URL from a phone on school Wi-Fi. On the monitor, open /kiosk and select Fullscreen. For a printed sign, download the PNG from /api/kiosk/qr. Recreate older signs that point directly to / to enroll scans in the monitor's live display. Recreate the sign when PUBLIC_ORIGIN changes. Payment QR codes are created separately for each order.

The Nginx example routes /ws/ WebSocket upgrades to the backend. Apply the corresponding upgrade headers if you use an existing reverse proxy, then reload it and verify that the monitor shows Live updates. [Nginx WebSocket proxying](https://nginx.org/en/docs/http/websocket.html)

For the 14-inch laptop screen, /kiosk combines the interactive journey map, the permanent access QR, the current payment QR and total, and the printing status. /printer provides a dedicated printing view. Test payment pages supply their own six-digit demo PIN and load the amount automatically. Rebuild the frontend and restart the backend together when updating this feature. Additive SQLite migrations run during startup against the configured DATA_DIR.

For native deployment install Node, Poppler, LibreOffice Writer/Calc/Impress and fonts. Use the README build and start commands with a dedicated non-root service account, a private persistent DATA_DIR, a loopback bind, and the same HTTPS proxy configuration. The HTTP LAN override is intended for an isolated test network.

## Install and test the agent

Run npm ci --workspace kiosk-print-agent --omit=dev in /opt/school-kiosk. Create an unprivileged kiosk-print system user and group. The source and node_modules must be readable by that user and owned by the deployer. Install print-agent/school-kiosk-agent.service under /etc/systemd/system and check its /usr/bin/node path. Use the same service account after reboot so that CUPS job ownership and recovery stay consistent.

Create /etc/school-kiosk/agent.env readable only by root. Set these values, replacing the token with the exact AGENT_TOKEN from the backend.

```dotenv
KIOSK_API_URL=http://127.0.0.1:3000
AGENT_TOKEN=
CUPS_URL=ipp://127.0.0.1:631
CUPS_QUEUE=School_A4
AGENT_POLL_MS=5000
```

Run sudo systemctl daemon-reload and sudo systemctl enable --now school-kiosk-agent. Check sudo journalctl -u school-kiosk-agent and the dashboard Printer view. Use its test-print action and verify the actual sheet. A dashboard queue override takes precedence over CUPS_QUEUE for new attempts. Active jobs stay bound to the queue where they were authorized. With the agent on another host, use HTTPS for KIOSK_API_URL and protect the agent token.

## Optional Google Drive Picker

In one Google Cloud project, enable the Drive API and Picker API, configure OAuth consent, and create a web OAuth client. Add the kiosk HTTPS origin as an authorized JavaScript origin. Restrict the browser API key to the kiosk hostname and https://docs.google.com/* in Website restrictions, and to the Picker and Drive APIs in API restrictions. Set GOOGLE_CLIENT_ID, GOOGLE_PICKER_API_KEY and GOOGLE_PROJECT_NUMBER from that same project and restart the backend. Testing mode requires adding permitted test Google accounts.

The Picker requests the drive.file scope. The token remains in browser memory and is used to download the selected file or export a supported Google Docs, Sheets, or Slides file as PDF. The file goes through the same kiosk upload validation. The backend stores no Google credentials or tokens. Google access requires internet connectivity. Verify the consent, picker and file download on a school phone before enabling it for students. [Google web Picker documentation](https://developers.google.com/workspace/drive/picker/guides/web-picker)

## Recovery and troubleshooting

| Symptom | Check |
| --- | --- |
| Backend exits with `APP_SECRET must contain at least 32 characters` or the same error for `AGENT_TOKEN` | In the project root, set both values in `.env` to different random secrets of at least 32 characters. Generate each with `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"`. Keep `APP_SECRET` unchanged after deployment. Start the PM2 process with `npm start` from the project root so Node loads `.env`; a process that runs `backend/src/server.js` directly does not load it automatically. Restart the process after updating its configuration. |
| Phone cannot open the QR URL | Check that school Wi-Fi allows access to the kiosk, DNS resolves to its LAN IP, and the certificate is trusted. Confirm the printed sign targets PUBLIC_ORIGIN. |
| Office conversion unavailable or times out | Check soffice, container memory, and available disk. Try a PDF exported by the user if the original document requires unsupported fonts or features. |
| Paid job stays queued | Check agent and API health, configured queue, service token, and printer status. A queued order survives backend and kiosk restarts. |
| Out of paper, disconnected or stopped | Check CUPS, supply paper, and inspect partial output before resuming the existing CUPS job. Only use dashboard Retry when the attempt is marked safe and no CUPS submission occurred. |
| CUPS response or history is missing | Keep the agent journal and CUPS history. Inspect the attempt marker and device output. The agent reconciles known IDs or matching markers. Ambiguous or unconfirmed jobs are terminal for automated dispatch and require manual investigation. |
| Printing shows submitted after the sheet prints | Check that the driver reports terminal IPP job state and preserves history. Forwarding-only completion appears as output unconfirmed. |
| Admin sign-in fails after restart | The password stored in SQLite takes precedence over ADMIN_PASSWORD. Use the recovery procedure below with the API stopped if the password is lost. |

For a lost password, stop the API, back up the volume, and use an offline maintenance shell with access to the same DATA_DIR. Remove the affected admin session and reset the hash with the exported passwordHash helper in backend/src/security.js, using a new value from a private environment variable. Preserve all order and payment tables. Deleting the admin user and restarting with a new strong ADMIN_PASSWORD also provisions a fresh admin on this single-admin MVP.

For a consistent backup, stop the agent and backend. Archive the full private backend data directory with SQLite, any WAL files and documents together. For Compose, from the deployment directory use the following example and restrict permissions on the resulting backup.

```sh
sudo systemctl stop school-kiosk-agent
docker compose stop backend
umask 077
docker compose run -T --rm --no-deps backend tar -C /var/lib/kiosk -czf - . > kiosk-data.tgz
```

Back up /var/lib/school-kiosk-agent separately, preserving permissions, and keep the deployment secrets in protected storage. Bring services back up after a normal backup. To restore, keep the original services stopped and extract into a fresh Compose project and kiosk-data volume. Restore the matching agent journal as the kiosk-print user. Before restarting the agent, reconcile all in-flight orders against retained CUPS history and any sheets printed after the backup timestamp. Rollback can restore a job to a prior state. Keep the agent stopped until an operator has resolved each ambiguous job.

For example, from the same source directory, restore the archive into the volume managed by a new Compose project.

~~~sh
docker compose -p kiosk-restore run -T --rm --no-deps backend tar -C /var/lib/kiosk -xzf - < kiosk-data.tgz
docker compose -p kiosk-restore up -d backend
~~~

Check the restored dashboard with the agent stopped. Use the same Compose project name for subsequent starts and backups of that restored instance.
