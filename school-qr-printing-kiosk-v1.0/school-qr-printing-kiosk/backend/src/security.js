import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { rateLimit } from 'express-rate-limit';
import { audit, transact } from './db.js';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const token = () => randomBytes(32).toString('base64url');
export const hash = value => createHash('sha256').update(value).digest('hex');
export const equal = (left, right) => timingSafeEqual(Buffer.from(hash(left), 'hex'), Buffer.from(hash(right), 'hex'));
export const validateToken = value => typeof value === 'string' && /^[\w-]{43}$/.test(value);

export function readCookie(req, name) {
  const prefix = `${name}=`;
  return (req.get('cookie') || '').split(';').map(part => part.trim()).find(part => part.startsWith(prefix))?.slice(prefix.length);
}

export function cookieOptions(config) {
  return { httpOnly: true, sameSite: 'strict', secure: config.secure, path: '/' };
}

export function throttle(limit, windowMs = 60_000) {
  return rateLimit({ limit, windowMs, standardHeaders: 'draft-8', legacyHeaders: false,
    message: { error: 'Too many requests. Try again shortly.' } });
}

const sessionLifetime = 8 * 60 * 60 * 1000;
const dummyPasswordHash = passwordHash(token());

export function passwordHash(password) {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [salt, digest] = stored.split(':');
  return equal(scryptSync(password, salt, 64).toString('hex'), digest);
}

export function provisionAdmin(db, config) {
  if (db.prepare('SELECT id FROM admin_users LIMIT 1').get()) return;
  if (!config.adminPassword || config.adminPassword.length < 14 || config.adminPassword.length > 256) {
    throw new Error('Set an initial ADMIN_PASSWORD of 14–256 characters.');
  }
  if (!/^[a-z0-9_.-]{3,64}$/i.test(config.adminUsername)) throw new Error('Invalid ADMIN_USERNAME.');
  db.prepare("INSERT INTO admin_users (username, password_hash, role) VALUES (?, ?, 'ADMIN')")
    .run(config.adminUsername, passwordHash(config.adminPassword));
}

export function registerAdminAuth(app, db, config) {
  const cookie = config.secure ? '__Host-kiosk_admin' : 'kiosk_admin';
  const options = cookieOptions(config);
  app.post('/api/admin/login', throttle(8, 10 * 60_000), (req, res) => {
    const { username, password } = req.body || {};
    if (typeof username !== 'string' || typeof password !== 'string' || username.length > 64 || password.length > 256) {
      throw new HttpError(400, 'Enter a valid username and password.');
    }
    const user = db.prepare('SELECT * FROM admin_users WHERE username = ?').get(username);
    if (!verifyPassword(password, user?.password_hash || dummyPasswordHash) || !user) {
      audit(db, 'public', 'ADMIN_LOGIN_REJECTED');
      throw new HttpError(401, 'Incorrect username or password.');
    }
    const session = token();
    transact(db, () => {
      const previous = readCookie(req, cookie);
      if (validateToken(previous)) db.prepare('DELETE FROM admin_sessions WHERE token_hash = ?').run(hash(previous));
      db.prepare('INSERT INTO admin_sessions VALUES (?, ?, ?)').run(hash(session), user.id, Date.now() + sessionLifetime);
      audit(db, `admin:${user.id}`, 'ADMIN_LOGIN');
    });
    res.cookie(cookie, session, { ...options, maxAge: sessionLifetime }).json({ username: user.username, role: user.role });
  });
  app.use('/api/admin', (req, res, next) => {
    const session = readCookie(req, cookie);
    if (!validateToken(session)) throw new HttpError(401, 'Sign in to continue.');
    req.admin = db.prepare(`SELECT a.id, a.username, a.role FROM admin_sessions s JOIN admin_users a ON a.id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > ? AND a.role = 'ADMIN'`).get(hash(session), Date.now());
    if (!req.admin) throw new HttpError(401, 'Sign in to continue.');
    req.sessionHash = hash(session);
    next();
  });
  app.get('/api/admin/session', (req, res) => res.json({ username: req.admin.username, role: req.admin.role }));
  app.post('/api/admin/logout', (req, res) => {
    transact(db, () => {
      db.prepare('DELETE FROM admin_sessions WHERE token_hash = ?').run(req.sessionHash);
      audit(db, `admin:${req.admin.id}`, 'ADMIN_LOGOUT');
    });
    res.clearCookie(cookie, options).json({ ok: true });
  });
}
