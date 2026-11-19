import { MAX_PDF_BYTES } from './document.js';

export class BackendError extends Error {
  constructor(status) {
    super('Kiosk API returned HTTP ' + status + '.');
    this.status = status;
  }
}

export function createBackend(baseUrl, token, request = fetch) {
  const origin = new URL(baseUrl);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname);
  if ((origin.protocol !== 'https:' && !(origin.protocol === 'http:' && local)) ||
      origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) {
    throw new Error('KIOSK_API_URL must be an HTTPS origin or a loopback HTTP origin.');
  }
  if (!token) throw new Error('AGENT_TOKEN is required.');

  async function send(path, body) {
    const url = new URL(path, origin);
    if (url.origin !== origin.origin || !url.pathname.startsWith('/api/agent/')) {
      throw new Error('Unexpected kiosk API URL.');
    }
    const headers = { authorization: 'Bearer ' + token };
    if (body) headers['content-type'] = 'application/json';
    const response = await request(url, {
      method: body ? 'POST' : 'GET', headers, body: body ? JSON.stringify(body) : undefined,
      redirect: 'error', signal: AbortSignal.timeout(30_000)
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new BackendError(response.status);
    }
    return response;
  }

  const jobRoute = id => '/api/agent/jobs/' + encodeURIComponent(id);
  return {
    async heartbeat(snapshot) {
      return (await send('/api/agent/heartbeat', snapshot)).json();
    },
    async claim(recoveryOnly) {
      return (await (await send('/api/agent/claim', { recoveryOnly })).json()).job;
    },
    async authorize(job, queue) {
      const response = await send(jobRoute(job.id) + '/authorize', { attemptId: job.attemptId, queue });
      return (await response.json()).authorized === true;
    },
    async status(job, status) {
      const response = await send(jobRoute(job.id) + '/status', { attemptId: job.attemptId, ...status });
      await response.body?.cancel();
    },
    async document(job) {
      const response = await send(job.documentUrl);
      if (Number(response.headers.get('content-length')) > MAX_PDF_BYTES ||
          !response.headers.get('content-type')?.startsWith('application/pdf')) {
        await response.body?.cancel();
        throw new Error('Invalid printable PDF response.');
      }
      const chunks = [];
      let length = 0;
      const reader = response.body.getReader();
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          length += value.byteLength;
          if (length > MAX_PDF_BYTES) throw new Error('Printable PDF exceeds the kiosk limit.');
          chunks.push(value);
        }
      } finally {
        await reader.cancel();
      }
      return Buffer.concat(chunks, length);
    }
  };
}
