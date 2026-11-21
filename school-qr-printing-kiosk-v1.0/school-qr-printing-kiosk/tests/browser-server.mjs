import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createApp } from '../backend/src/app.js';
import { loadConfig } from '../backend/src/config.js';
import { attachLive } from '../backend/src/live.js';

export default async function startBrowserServer() {
  if (!existsSync(resolve('frontend/dist/index.html'))) {
    throw new Error('Run npm run build before the browser tests.');
  }
  const storage = mkdtempSync(join(tmpdir(), 'kiosk-browser-'));
  process.env.KIOSK_BROWSER_AGENT_TOKEN ||= randomBytes(32).toString('hex');
  const config = loadConfig({
    // Browsers open 127.0.0.1, as they can when PUBLIC_ORIGIN uses localhost.
    PUBLIC_ORIGIN: 'http://localhost:3137',
    PORT: '3137',
    DATA_DIR: storage,
    SCHOOL_NAME: 'Test School',
    APP_SECRET: randomBytes(32).toString('hex'),
    AGENT_TOKEN: process.env.KIOSK_BROWSER_AGENT_TOKEN,
    ADMIN_USERNAME: 'browser-admin',
    ADMIN_PASSWORD: process.env.KIOSK_BROWSER_ADMIN_PASSWORD,
  });
  const { app, db } = createApp(config);
  const server = app.listen(config.port, config.host);
  const live = attachLive(server, { db, config });
  try {
    await new Promise((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
  } catch (error) {
    live.close();
    db.close();
    rmSync(storage, { recursive: true, force: true });
    throw error;
  }
  return async () => {
    live.close();
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections();
    });
    db.close();
    rmSync(storage, { recursive: true, force: true });
  };
}
