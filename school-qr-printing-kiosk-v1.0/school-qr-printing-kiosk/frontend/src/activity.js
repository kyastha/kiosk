import { useEffect, useRef } from 'react';
import { api } from './api.js';

const storageKey = 'kiosk-checkout-session';

function storedSession() {
  try {
    const stored = JSON.parse(sessionStorage.getItem(storageKey));
    if (typeof stored?.sessionId === 'string' && Number.isSafeInteger(stored.sequence)) return stored;
  } catch {
    // Activity still works when browser storage is unavailable.
  }
  return null;
}

function persist(session) {
  try {
    if (session) sessionStorage.setItem(storageKey, JSON.stringify(session));
    else sessionStorage.removeItem(storageKey);
  } catch {
    // The in-memory session remains usable.
  }
}

function createActivity() {
  let session = storedSession();
  let sessionRequest;
  let sessionReady = false;
  let desired;
  let lastReported;
  let sending = false;
  let enabled = false;
  let stopped = false;
  let timer;
  let retry = 1000;
  const controllers = new Set();

  async function request(path, body) {
    const controller = new AbortController();
    controllers.add(controller);
    try {
      return await api(path, { method: 'POST', body, signal: controller.signal });
    } finally {
      controllers.delete(controller);
    }
  }

  async function ensureSession(validate = false) {
    if (sessionRequest) return sessionRequest;
    if (sessionReady && !validate) return session.sessionId;
    sessionRequest = (async () => {
      let result;
      try {
        result = await request('/api/kiosk/session', session ? { sessionId: session.sessionId } : {});
      } catch (error) {
        if (error.status !== 404 || !session) throw error;
        session = null;
        persist(null);
        result = await request('/api/kiosk/session', {});
      }
      const sameSession = session?.sessionId === result.sessionId;
      session = {
        sessionId: result.sessionId,
        sequence: sameSession ? Math.max(session.sequence, result.sequence) : result.sequence,
      };
      if (!sameSession && desired) delete desired.sequence;
      sessionReady = true;
      persist(session);
      return session.sessionId;
    })().finally(() => {
      sessionRequest = null;
    });
    return sessionRequest;
  }

  async function flush() {
    if (sending || !enabled || stopped || !desired) return;
    sending = true;
    clearTimeout(timer);
    try {
      await ensureSession();
      while (desired && enabled && !stopped) {
        const event = desired;
        if (!event.sequence) {
          session.sequence += 1;
          event.sequence = session.sequence;
          persist(session);
        }
        const result = await request('/api/kiosk/activity', { sessionId: session.sessionId, ...event });
        session.sequence = Math.max(session.sequence, result.sequence);
        persist(session);
        if (result.sequence > event.sequence) delete event.sequence;
        else if (desired === event) desired = null;
        retry = 1000;
      }
    } catch (error) {
      if (error.status === 404 || (error.status === 409 && error.message.includes('expired'))) {
        sessionReady = false;
        if (desired) delete desired.sequence;
      } else if (error.status === 409) {
        desired = null;
      }
      if (enabled && !stopped) {
        timer = setTimeout(flush, retry);
        retry = Math.min(retry * 2, 8000);
      }
    } finally {
      sending = false;
    }
  }

  return {
    connect(online) {
      enabled = online;
      if (online) flush();
      else clearTimeout(timer);
    },
    report(stage, fileCount = 0) {
      if (lastReported?.stage === stage && lastReported.fileCount === fileCount) return;
      lastReported = { stage, fileCount };
      desired = { stage, fileCount };
      flush();
    },
    session: () => ensureSession(true),
    complete() {
      persist(null);
      desired = null;
      stopped = true;
      clearTimeout(timer);
    },
    close() {
      stopped = true;
      clearTimeout(timer);
      for (const controller of controllers) controller.abort();
    },
  };
}

export function useKioskActivity(enabled, online) {
  const activity = useRef(null);
  if (!activity.current) activity.current = createActivity();

  useEffect(() => {
    if (!enabled) return;
    activity.current.connect(online);
    activity.current.report('SCANNED');
  }, [enabled]);

  useEffect(() => {
    activity.current.connect(enabled && online);
  }, [enabled, online]);

  useEffect(() => () => activity.current.close(), []);
  return enabled ? activity.current : null;
}
