import { WebSocketServer, type WebSocket } from 'ws';
import type { Server } from 'node:http';
import {
  REALTIME_AUTH_TIMEOUT_MS,
  REALTIME_PATH,
  type RealtimeClientMessage,
  type RealtimeEvent,
  type RealtimeServerMessage,
} from '@scansign/shared';
import { db } from './supabase.js';

/**
 * Live updates over a WebSocket.
 *
 * Why not Supabase Realtime: no client holds a Supabase key at all — that
 * is the whole reason it talks only to this API — and handing one out to enable
 * live updates would undo the security model. A socket on our own server keeps
 * the boundary intact and serves the console and the signing app identically.
 *
 * Auth is the first frame, not a query parameter: URLs end up in access logs,
 * proxies and crash reports, and an access token has no business there.
 */

interface Client {
  socket: WebSocket;
  userId: string;
  alive: boolean;
}

const clients = new Set<Client>();
let wss: WebSocketServer | null = null;

const send = (socket: WebSocket, message: RealtimeServerMessage): void => {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
};

/** Push an event to every socket this account has open. */
export const publish = (userId: string, event: RealtimeEvent): void => {
  for (const client of clients) {
    if (client.userId === userId) send(client.socket, { type: 'event', event });
  }
};

export const realtimeStats = (): { sockets: number; accounts: number } => ({
  sockets: clients.size,
  accounts: new Set([...clients].map((c) => c.userId)).size,
});

export const attachRealtime = (server: Server): void => {
  wss = new WebSocketServer({ server, path: REALTIME_PATH });

  wss.on('connection', (socket) => {
    let client: Client | null = null;

    // Drop anything that has not identified itself promptly, so an unauthorised
    // socket cannot sit and hold a connection.
    const authTimer = setTimeout(() => {
      if (!client) {
        send(socket, { type: 'error', message: 'Authentification requise.' });
        socket.close(4401, 'unauthenticated');
      }
    }, REALTIME_AUTH_TIMEOUT_MS);

    socket.on('message', async (raw) => {
      let message: RealtimeClientMessage;
      try {
        message = JSON.parse(String(raw)) as RealtimeClientMessage;
      } catch {
        return;
      }

      if (message.type === 'ping') {
        if (client) client.alive = true;
        send(socket, { type: 'pong' });
        return;
      }

      if (message.type !== 'auth' || client) return;

      const { data, error } = await db.auth.getUser(message.token);
      if (error || !data.user) {
        send(socket, { type: 'error', message: 'Session invalide.' });
        socket.close(4401, 'unauthenticated');
        return;
      }

      clearTimeout(authTimer);
      client = { socket, userId: data.user.id, alive: true };
      clients.add(client);
      send(socket, { type: 'ready', userId: data.user.id });
    });

    const cleanup = () => {
      clearTimeout(authTimer);
      if (client) clients.delete(client);
      client = null;
    };
    socket.on('close', cleanup);
    socket.on('error', cleanup);
  });

  // Reap sockets whose peer vanished without a close frame — a laptop that went
  // through a tunnel, a laptop that slept.
  const sweeper = setInterval(() => {
    for (const client of clients) {
      if (!client.alive) {
        client.socket.terminate();
        clients.delete(client);
        continue;
      }
      client.alive = false;
      if (client.socket.readyState === client.socket.OPEN) client.socket.ping();
    }
  }, 30_000);
  sweeper.unref();

  wss.on('connection', (socket) => {
    socket.on('pong', () => {
      for (const client of clients) if (client.socket === socket) client.alive = true;
    });
  });
};

export const closeRealtime = (): void => {
  for (const client of clients) client.socket.close();
  clients.clear();
  wss?.close();
  wss = null;
};
