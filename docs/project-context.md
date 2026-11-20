# Kiosk project context

Updated November 20, 2026, using the Asia/Katmandu date. This record preserves the deployment troubleshooting conversation and its unfinished work. Remote results were supplied by the user; server commands were not executed directly by the assistant.

## Project and working environment

- Repository supplied by the user: https://github.com/kyastha/kiosk.git.
- Product: School QR Printing Kiosk, a school printing application with a React frontend, Node/Express backend, administrator dashboard, document uploads, QR onboarding, and a separate print agent. The repository describes payments as simulated, with no real money transferred.
- Local checkout: `C:\Users\kaysh\Music\Kiosh`, saved in Codex as `kios machine`. A nested `kiosk` source copy also exists locally; the inspected application files were in the checkout root.
- Server: Ubuntu, accessed as `vps@my-vps`, project directory `/home/vps/kiosk`. SSH used the private address `192.168.141.129`. The local Windows computer has a VMware NAT adapter on this private network; this address is not a public VPS address.
- Reported server runtime: Node.js `24.22.3`; PM2 process name `server`.
- The user prefers Nepali conversation and short instructions, with exact commands displayed for copying. Distinguish the Ubuntu VPS terminal from Windows PowerShell. Give one small step at a time when a result is needed.

## Confirmed application startup fixes

The original PM2 error was `APP_SECRET must contain at least 32 characters.` The user generated separate `APP_SECRET` and `AGENT_TOKEN` values, put them in the server's root `.env`, and confirmed both effective lengths were 64. Neither value is saved here.

PM2 originally ran `/home/vps/kiosk/backend/src/server.js` directly, without interpreter arguments, with working directory `/home/vps/kiosk/backend/src`. The repository's normal `npm start` loads the root `.env` explicitly; direct execution of the server file does not automatically load it.

The user restarted the existing process with an explicit environment file:

```bash
pm2 restart server --node-args="--env-file=/home/vps/kiosk/.env" --update-env
```

Startup then advanced to `Set an initial ADMIN_PASSWORD of 14–256 characters.` The user configured an initial administrator password and restarted again. The subsequent health request returned `HTTP/1.1 200 OK` with `{"ok":true}`, and the output log showed `Server is running`:

```bash
curl --max-time 10 -i http://127.0.0.1:3000/api/health
```

The correct backend port is **3000**. A voice response mistakenly suggested 4000 during Cloudflare setup; that was corrected before the user reported the route was added.

The old secret and password failures remained in PM2's accumulated error log after successful startup. Their presence alone does not establish a current failure.

The user successfully ran `pm2 save` after the startup fix. Later frontend and public-origin environment changes still need to be saved after verification. Boot integration via `pm2 startup` or an existing systemd unit was not checked: `pm2 save` alone does not establish that PM2 starts at boot.

## Frontend fix and storage caveat

The backend health check worked while `/` returned `Cannot GET /`. The code resolves `FRONTEND_DIST` relative to the process working directory unless an absolute path is supplied, and registers frontend routes only if `index.html` exists when the application starts.

The user ran `npm run build` in `/home/vps/kiosk` and reported a file listing for `/home/vps/kiosk/frontend/dist/index.html`. They then applied:

```bash
FRONTEND_DIST=/home/vps/kiosk/frontend/dist pm2 restart server --update-env
```

The user subsequently confirmed that the main website opened.

The inspected backend also resolves `DATA_DIR` relative to the working directory, defaulting to `./data`. Its actual remote value and database location were not established. Changing PM2's working directory could select another SQLite database or document directory. The fixes above preserved the working directory. Preserve the existing data location when continuing; changing directories is not needed just to fix frontend serving.

## Network and Cloudflare decisions

Initial browser testing used a Windows SSH tunnel forwarding local port 3000 to `127.0.0.1:3000` on the Ubuntu server. A silent terminal after entering the SSH password was expected with `ssh -N`; the Windows browser health check succeeded. The desktop's `localhost` is not reachable by using `localhost` on a phone.

The user initially requested same-WiFi access, then explicitly chose **Cloudflare Tunnel using an owned domain**. The latest direction is the domain/tunnel deployment. This makes the published application reachable over the Internet, rather than restricting it to the same WiFi.

Cloudflare state reported by the user:

- An existing tunnel named `my VPS tunnel` was reported **Healthy** in the dashboard.
- The existing Ubuntu `cloudflared` systemd service returned `active` from `systemctl is-active cloudflared`.
- A second tunnel was created during setup, but its connector screen kept showing `Waiting for your tunnel to connect`.
- Installing that second tunnel as the default service failed because `/etc/systemd/system/cloudflared.service` already existed. The existing service was not reported uninstalled. The selected approach was to reuse the healthy existing tunnel and append a route, preserving its other applications.
- `sudo cloudflared tunnel list` failed for lack of `cert.pem`. This management-command failure did not prove that the token-managed service was broken. An account certificate was not required for the next service-state check.
- A published application route and its CNAME DNS record were successfully created. The intended origin is HTTP on loopback port **3000 on the VPS**, where the connector runs.
- The hostname was spelled by the user as **`kiosk.murari-me.com.np`**. The user reported that the website opened through the domain. An independent web-tool health request could not access the URL, so external availability was not independently verified.

The current Cloudflare dashboard guide uses `Networking → Tunnels`, then the existing tunnel's `Routes → Add route → Published application`. The service URL is `http://127.0.0.1:3000`; if the form separates protocol and address, select HTTP and enter `127.0.0.1:3000`.

## Unfinished QR and public-origin fix

**Latest confirmed problem:** the QR still contained `localhost:3000`, and scanning it on the phone produced `This site can't be reached`.

The local source establishes that `/api/config` returns `onboardingUrl`, generated from `PUBLIC_ORIGIN + '/?kiosk=1'`, and `/api/kiosk/qr` encodes that same URL. `PUBLIC_ORIGIN` also affects browser origin checks, WebSocket origin checks, and secure cookies. Merely publishing a Cloudflare route does not change these application settings.

The user was first advised to put these non-secret settings in `/home/vps/kiosk/.env`, then restart:

```dotenv
PUBLIC_ORIGIN=https://kiosk.murari-me.com.np
TRUST_PROXY=1
FRONTEND_DIST=/home/vps/kiosk/frontend/dist
```

Those file edits were **not confirmed**. When the user still reported a localhost QR, the latest proposed commands were:

```bash
PUBLIC_ORIGIN=https://kiosk.murari-me.com.np TRUST_PROXY=1 pm2 restart server --update-env
```

After allowing the server to start, the proposed check was:

```bash
curl -fsS http://127.0.0.1:3000/api/config | node -p 'JSON.parse(require("node:fs").readFileSync(0,"utf8")).onboardingUrl'
```

Expected output:

```text
https://kiosk.murari-me.com.np/?kiosk=1
```

**Neither that latest restart nor its check has a reported result yet.** Environment variables retained by PM2 can override values in Node's `--env-file`, which is why the last command sets the intended public origin explicitly for PM2.

Next work is to obtain the actual `onboardingUrl`, ensure the root `.env` and effective PM2 environment agree, refresh `https://kiosk.murari-me.com.np/kiosk` to get a new QR, and verify the phone opens the HTTPS domain when scanning it. Persist the verified process configuration with `pm2 save`. Keep secrets stable. Phone upload, administrator login through the domain, WebSocket updates, and physical printing have not been verified in this session.

## Credential follow-up

A Cloudflare tunnel installation token was pasted into the conversation. Its raw value is intentionally omitted from this file. Rotation of the token for the tunnel to which that installation command belonged was advised, but completion was **not confirmed**. The newly created tunnel and the healthy existing tunnel must not be confused when rotating or replacing credentials. Do not uninstall the working service merely to clear the duplicate-service error; any necessary credential replacement must preserve the existing routes and account for connector restart requirements.

No application secrets, agent tokens, administrator passwords, Cloudflare tokens, or account certificates should be copied into project notes. Keep the configured `APP_SECRET` stable; regenerating it unnecessarily can affect existing order links. The print agent must use the backend's matching `AGENT_TOKEN`.

## Useful references

- Local project documentation: [README](../README.md), [Linux deployment](deployment.md), [testing](testing.md).
- [Cloudflare Tunnel setup](https://developers.cloudflare.com/tunnel/get-started/).
- [Cloudflare tunnel token rotation](https://developers.cloudflare.com/tunnel/reference/tunnel-tokens/).
- [Node.js environment-file behavior](https://nodejs.org/download/release/v24.22.2/docs/api/cli.html).
- [PM2 CLI](https://pm2.keymetrics.io/docs/usage/commands/).
