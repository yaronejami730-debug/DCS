import { useEffect, useState } from 'react';
import { AppState } from 'react-native';
import { useQueryClient } from '@tanstack/react-query';
import {
  REALTIME_PATH,
  REALTIME_PING_INTERVAL_MS,
  type RealtimeEvent,
  type RealtimeServerMessage,
} from '@scansign/shared';
import { API_URL, loadSession } from './api';
import { notificationForEvent, notifyLocally } from './notifications';

/**
 * Live updates on the phone.
 *
 * React Native ships a WebSocket implementation, so this is the same protocol
 * the console uses — and, crucially, it needs no Supabase key on the device.
 * Keeping the phone talking only to our API is the reason the bundle carries no
 * database credentials at all, and Supabase Realtime would have required one.
 *
 * The socket is closed when the app goes to the background: iOS suspends the
 * process anyway, and a half-dead socket that looks connected is worse than an
 * honest reconnect on resume.
 */
const connect = (
  onEvent: (event: RealtimeEvent) => void,
  onStatus: (connected: boolean) => void,
): (() => void) => {
  let socket: WebSocket | null = null;
  let pingTimer: ReturnType<typeof setInterval> | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;
  let closed = false;

  const url = `${API_URL.replace(/^http/, 'ws')}${REALTIME_PATH}`;

  const clearTimers = () => {
    if (pingTimer) clearInterval(pingTimer);
    if (retryTimer) clearTimeout(retryTimer);
    pingTimer = null;
    retryTimer = null;
  };

  const scheduleReconnect = () => {
    if (closed) return;
    attempt += 1;
    retryTimer = setTimeout(open, Math.min(1000 * 2 ** (attempt - 1), 30_000));
  };

  const open = async () => {
    if (closed) return;
    const session = await loadSession();
    if (!session) {
      scheduleReconnect();
      return;
    }

    try {
      socket = new WebSocket(url);
    } catch {
      scheduleReconnect();
      return;
    }

    socket.onopen = () => {
      socket?.send(JSON.stringify({ type: 'auth', token: session.accessToken }));
      pingTimer = setInterval(() => {
        if (socket?.readyState === 1) socket.send(JSON.stringify({ type: 'ping' }));
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
        onStatus(true);
      } else if (message.type === 'event') {
        onEvent(message.event);
      }
    };

    socket.onclose = () => {
      clearTimers();
      onStatus(false);
      scheduleReconnect();
    };
    socket.onerror = () => socket?.close();
  };

  void open();

  return () => {
    closed = true;
    clearTimers();
    socket?.close();
    socket = null;
  };
};

/**
 * A document sent from the web console appears on the phone immediately,
 * without a pull-to-refresh and without waiting for the 15s poll.
 */
export const useRealtime = (enabled: boolean): { connected: boolean } => {
  const queryClient = useQueryClient();
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (!enabled) {
      setConnected(false);
      return;
    }

    let disconnect: (() => void) | null = null;

    const start = () => {
      disconnect?.();
      disconnect = connect((event) => {
        /**
         * Raise the alert from the device itself.
         *
         * The socket already told us, so we do not need the push service to
         * repeat it — and this works in Expo Go, where remote push does not.
         * `notifyWhileForeground` is false only for events the signer is
         * plainly already watching.
         */
        const alert = notificationForEvent(event);
        if (alert) void notifyLocally(alert.title, alert.body, alert.data);

        switch (event.type) {
          case 'folder.sent':
          case 'folder.updated':
          case 'folder.deleted':
          case 'document.updated':
            void queryClient.invalidateQueries({ queryKey: ['folders'] });
            void queryClient.invalidateQueries({ queryKey: ['folder'] });
            break;
          case 'session.updated':
            void queryClient.invalidateQueries({ queryKey: ['session'] });
            void queryClient.invalidateQueries({ queryKey: ['folders'] });
            break;
          case 'device.updated':
            break;
        }
      }, setConnected);
    };

    start();

    // Resuming from the background: refetch at once, and rebuild the socket
    // rather than trusting one that survived a suspend.
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        void queryClient.invalidateQueries({ queryKey: ['folders'] });
        start();
      } else {
        disconnect?.();
        disconnect = null;
        setConnected(false);
      }
    });

    return () => {
      subscription.remove();
      disconnect?.();
    };
  }, [enabled, queryClient]);

  return { connected };
};
