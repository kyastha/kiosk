import { resolve } from 'node:path';
import { mkdirSync } from 'node:fs';

const loopbackHosts = ['localhost', '127.0.0.1', '[::1]'];

export function loadConfig(env = process.env) {
  const publicUrl = new URL(env.PUBLIC_ORIGIN || 'http://localhost:3000');
  if (publicUrl.href !== publicUrl.origin + '/' || publicUrl.username || publicUrl.password ||
      !['http:', 'https:'].includes(publicUrl.protocol)) {
    throw new Error('PUBLIC_ORIGIN must be an HTTP(S) origin without a path.');
  }
  const secure = publicUrl.protocol === 'https:';
  const loopback = loopbackHosts.includes(publicUrl.hostname);
  if (!secure && !loopback && env.ALLOW_INSECURE_HTTP !== 'true') {
    throw new Error('A network-facing kiosk needs HTTPS. Use ALLOW_INSECURE_HTTP only on an isolated test network.');
  }
  for (const name of ['APP_SECRET', 'AGENT_TOKEN']) {
    if (!env[name] || env[name].length < 32) throw new Error(`${name} must contain at least 32 characters.`);
  }
  if (env.APP_SECRET === env.AGENT_TOKEN) throw new Error('Use separate app and agent secrets.');
  if (env.TRUST_PROXY && !['0', '1'].includes(env.TRUST_PROXY)) throw new Error('TRUST_PROXY must be 0 or 1.');
  const proxy = env.TRUST_PROXY === '1' ? 1 : false;
  const localOrigins = !secure && loopback && !proxy
    ? loopbackHosts.map(host => 'http://' + host + (publicUrl.port ? ':' + publicUrl.port : ''))
    : [];
  const driveValues = [env.GOOGLE_CLIENT_ID, env.GOOGLE_PICKER_API_KEY, env.GOOGLE_PROJECT_NUMBER];
  if (driveValues.some(Boolean) && !driveValues.every(Boolean)) throw new Error('Set all three Google Picker variables.');
  const storage = resolve(env.DATA_DIR || './data');
  const documents = resolve(storage, 'documents');
  const workRoot = resolve(storage, 'conversion');
  for (const directory of [storage, documents, workRoot]) mkdirSync(directory, { recursive: true, mode: 0o700 });
  return {
    publicOrigin: publicUrl.origin, localOrigins, secure, appSecret: env.APP_SECRET, agentToken: env.AGENT_TOKEN,
    storage, documents, workRoot, host: env.HOST || '127.0.0.1', port: Number(env.PORT || 3000),
    proxy, frontendDist: resolve(env.FRONTEND_DIST || './frontend/dist'),
    schoolName: env.SCHOOL_NAME?.trim().slice(0, 120) || 'School Printing Service',
    adminUsername: env.ADMIN_USERNAME || 'admin', adminPassword: env.ADMIN_PASSWORD, receiptFont: env.RECEIPT_FONT,
    drive: driveValues.every(Boolean) ? { clientId: driveValues[0], apiKey: driveValues[1], appId: driveValues[2] } : null,
  };
}
