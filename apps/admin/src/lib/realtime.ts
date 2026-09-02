import {
  REALTIME_PATH,
  REALTIME_PING_INTERVAL_MS,
  type RealtimeEvent,
  type RealtimeServerMessage,
} from '@scansign/shared';
import { API_URL, loadSession } from './api';

/**
 * Live-update socket shared by both clients.
 *
 * Reconnects with exponential backoff, and re-authenticates on every connect —
 * an access token may well have been refreshed while the socket was down.
 * Callers get a plain unsubscribe function; nothing here throws, because losing
 * live updates must never break a page that also polls.
 */
export const connectRealtime = (
  onEvent: (event: RealtimeEvent) => void,
  onStatus?: (connected: boolean) => void,
): (() => void) => {
  let socket: WebSocket | null = null;
  let pingTimer: ReturnType<typeof setInterval> | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;
  let closed = false;

  const wsUrl = `${API_URL.replace(/^http/, 'ws')}${REALTIME_PATH}`;

  const clearTimers = () => {
    if (pingTimer) clearInterval(pingTimer);
    if (retryTimer) clearTimeout(retryTimer);
    pingTimer = null;
    retryTimer = null;
  };

  const scheduleReconnect = () => {
    if (closed) return;
    attempt += 1;
    // 1s, 2s, 4s… capped at 30s, so a server restart is picked up quickly
    // without hammering it when it stays down.
    const delay = Math.min(1000 * 2 ** (attempt - 1), 30_000);
    retryTimer = setTimeout(open, delay);
  };

  const open = () => {
    if (closed) return;
    const session = loadSession();
    if (!session) {
      scheduleReconnect();
      return;
    }

    try {
      socket = new WebSocket(wsUrl);
    } catch {
      scheduleReconnect();
      return;
    }

    socket.onopen = () => {
      // The token travels in a frame, never in the URL: URLs are logged.
      socket?.send(JSON.stringify({ type: 'auth', token: session.accessToken }));
      pingTimer = setInterval(() => {
        if (socket?.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: 'ping' }));
        }
      }, REALTIME_PING_INTERVAL_MS);
    };

    socket.onmessage = (raw) => {
      let message: RealtimeServerMessage;
      try {
        message = JSON.parse(String(raw.data)) as RealtimeServerMessage;
      } catch {
        return;
      }
      if (message.type === 'ready') {
        attempt = 0;
        onStatus?.(true);
      } else if (message.type === 'event') {
        onEvent(message.event);
      }
    };

    socket.onclose = () => {
      clearTimers();
      onStatus?.(false);
      scheduleReconnect();
    };
    socket.onerror = () => socket?.close();
  };

  open();

  return () => {
    closed = true;
    clearTimers();
    const current = socket;
    socket = null;
    if (!current) return;
    // Closing a socket that is still connecting makes the browser log an error
    // — which React's StrictMode provokes on every mount in development, since
    // it runs this cleanup before the handshake can finish. Let it open, then
    // close it silently.
    if (current.readyState === WebSocket.CONNECTING) {
      current.onmessage = null;
      current.onclose = null;
      current.onerror = null;
      current.onopen = () => current.close();
    } else {
      current.close();
    }
  };
};
