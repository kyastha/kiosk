import { STATUS_CODES } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { authorizeOrder, orderView, settings } from './orders.js';

const kiosk = '/ws/kiosk';
const orderPath = /^\/ws\/orders\/([a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12})$/i;
const maxConnections = 128;
const maxConnectionsPerFeed = 16;
const maxBufferedBytes = 64 * 1024;

function allowOrigin(request, config) {
  const origin = request.headers.origin;
  if (request.headers['sec-fetch-site'] === 'cross-site' ||
      (origin !== config.publicOrigin && !config.localOrigins?.includes(origin))) return false;
  return new URL(origin).host === request.headers.host?.toLowerCase();
}

function reject(socket, status) {
  socket.once('error', () => socket.destroy());
  socket.end(
    `HTTP/1.1 ${status} ${STATUS_CODES[status]}\r\nConnection: close\r\nCache-Control: no-store\r\nContent-Length: 0\r\n\r\n`,
    () => socket.destroy(),
  );
}

function publish(peer, client, payload) {
  if (peer.readyState !== WebSocket.OPEN || payload === client.lastPayload) return;
  if (peer.bufferedAmount > maxBufferedBytes) {
    peer.terminate();
    return;
  }
  peer.send(payload);
  client.lastPayload = payload;
}

export function attachLive(server, { db, config }) {
  const latestKioskOrder = db.prepare(`SELECT o.id, o.payment_status AS paymentStatus, o.print_status AS printStatus,
    p.updated_at AS updatedAt FROM orders o JOIN payments p ON p.order_id = o.id
    WHERE o.kiosk = 1 ORDER BY o.created_at DESC, o.id DESC LIMIT 1`);
  const websocket = new WebSocketServer({
    noServer: true, clientTracking: false, perMessageDeflate: false, maxPayload: 1024,
    maxFragments: 16, maxBufferedChunks: 32, closeTimeout: 1500,
  });
  const clients = new Map();
  let closed = false;

  function snapshot(client) {
    if (client.feed === kiosk) {
      const latest = latestKioskOrder.get();
      return JSON.stringify({ order: latest ? { ...latest, updatedAt: new Date(latest.updatedAt).toISOString() } : null });
    }
    const order = authorizeOrder(db, client.feed, client.key);
    return JSON.stringify({ ...orderView(order, config, client.key), schoolName: settings(db).schoolName });
  }

  function snapshotError(error) {
    if (error.status === 404) return 404;
    console.error('Live snapshot failed:', error.code || error.name);
    return 500;
  }

  function upgrade(request, socket, head) {
    if (!request.url?.startsWith('/ws/')) return reject(socket, 404);
    if (!allowOrigin(request, config)) return reject(socket, 403);
    const url = new URL(request.url, config.publicOrigin);
    const match = orderPath.exec(url.pathname);
    if (url.hash || (url.pathname !== kiosk && !match)) return reject(socket, 404);
    const client = { feed: match?.[1] || kiosk, key: match ? url.searchParams.get('key') : null, alive: true };
    if (match && url.searchParams.getAll('key').length !== 1) return reject(socket, 404);
    if (clients.size >= maxConnections) return reject(socket, 429);
    let initial;
    try {
      initial = snapshot(client);
    } catch (error) {
      return reject(socket, snapshotError(error));
    }
    const sameFeed = [...clients.values()].filter(existing => existing.feed === client.feed).length;
    if (sameFeed >= maxConnectionsPerFeed) return reject(socket, 429);
    websocket.handleUpgrade(request, socket, head, peer => {
      clients.set(peer, client);
      peer.on('error', () => peer.terminate());
      peer.on('pong', () => { client.alive = true; });
      peer.once('close', () => clients.delete(peer));
      publish(peer, client, initial);
    });
  }

  const poll = setInterval(() => {
    if (!clients.size) return;
    const snapshots = new Map();
    for (const [peer, client] of clients) {
      if (peer.readyState !== WebSocket.OPEN) continue;
      // A revoked key must never receive another key's snapshot for the same order.
      const cacheKey = client.key ? client.feed + ':' + client.key : client.feed;
      if (!snapshots.has(cacheKey)) {
        try {
          snapshots.set(cacheKey, { payload: snapshot(client) });
        } catch (error) {
          snapshots.set(cacheKey, { status: snapshotError(error) });
        }
      }
      const current = snapshots.get(cacheKey);
      if (current.status) peer.close(current.status === 404 ? 1008 : 1011);
      else publish(peer, client, current.payload);
    }
  }, 500);
  poll.unref();

  const heartbeat = setInterval(() => {
    for (const [peer, client] of clients) {
      if (peer.readyState !== WebSocket.OPEN) continue;
      if (!client.alive) {
        peer.terminate();
        continue;
      }
      client.alive = false;
      peer.ping();
    }
  }, 20_000);
  heartbeat.unref();

  function close() {
    if (closed) return;
    closed = true;
    clearInterval(poll);
    clearInterval(heartbeat);
    server.off('upgrade', upgrade);
    server.off('close', close);
    for (const peer of clients.keys()) peer.close(1001, 'Kiosk server shutting down.');
    clients.clear();
    websocket.close();
  }

  server.on('upgrade', upgrade);
  server.once('close', close);
  return { close };
}
