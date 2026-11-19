import { useEffect, useState } from 'react';

export function useLiveSnapshot(path, online) {
  const [state, setState] = useState(null);

  useEffect(() => {
    if (!path || !online) return;
    setState((current) => current?.path === path && current.connected ? { ...current, connected: false } : current);
    const url = new URL(path, window.location.origin);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    let socket;
    let timer;
    let stopped = false;
    let retry = 500;

    function reconnect() {
      if (stopped) return;
      setState((current) => current?.path === path ? { ...current, connected: false } : current);
      timer = setTimeout(connect, retry);
      retry = Math.min(retry * 2, 8000);
    }

    function connect() {
      try {
        socket = new WebSocket(url);
      } catch {
        reconnect();
        return;
      }
      socket.onmessage = (event) => {
        if (stopped) return;
        try {
          const value = JSON.parse(event.data);
          retry = 500;
          setState({ path, value, connected: true });
        } catch {
          socket.close();
        }
      };
      socket.onclose = reconnect;
    }

    connect();
    return () => {
      stopped = true;
      clearTimeout(timer);
      if (socket) {
        socket.onclose = null;
        socket.onmessage = null;
        socket.close();
      }
    };
  }, [path, online]);

  const current = state?.path === path ? state : null;
  return { value: current?.value ?? null, connected: Boolean(online && current?.connected) };
}
