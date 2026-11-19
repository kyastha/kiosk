import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { attachLive } from './live.js';

process.umask(0o077);
const config = loadConfig();
const { app, db, maintain } = createApp(config);
let cleanupTask;
const cleanup = () => {
  if (!cleanupTask) cleanupTask = maintain()
    .catch(error => console.error('Scheduled cleanup failed:', error.code || error.name))
    .finally(() => { cleanupTask = null; });
  return cleanupTask;
};
await cleanup();
const timer = setInterval(cleanup, 60_000);
const server = app.listen(config.port, config.host, () => console.log(`School kiosk listening on ${config.host}:${config.port}`));
const live = attachLive(server, { db, config });
server.requestTimeout = 90_000;
server.headersTimeout = 15_000;

function stop() {
  clearInterval(timer);
  live.close();
  server.close(async () => {
    await cleanupTask;
    db.close();
  });
}
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
