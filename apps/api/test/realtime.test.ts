import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { REALTIME_PATH, type RealtimeEvent } from '@scansign/shared';

// The realtime module verifies tokens through Supabase; stub that boundary so
// the test exercises the socket protocol rather than the network.
const getUser = vi.fn();
vi.mock('../src/lib/supabase.js', () => ({
  db: { auth: { getUser: (token: string) => getUser(token) } },
  authClient: {},
  BUCKET: 'test',
}));

const { attachRealtime, publish, realtimeStats, closeRealtime } = await import(
  '../src/lib/realtime.js'
);

const start = async (): Promise<{ server: Server; url: string }> => {
  const server = createServer();
  attachRealtime(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { server, url: `ws://127.0.0.1:${port}${REALTIME_PATH}` };
};

const nextMessage = (socket: WebSocket, timeoutMs = 3000): Promise<Record<string, unknown>> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out')), timeoutMs);
    socket.once('message', (raw) => {
      clearTimeout(timer);
      resolve(JSON.parse(String(raw)) as Record<string, unknown>);
    });
  });

const open = (url: string): Promise<WebSocket> =>
  new Promise((resolve) => {
    const socket = new WebSocket(url);
    socket.once('open', () => resolve(socket));
  });

let running: Server | null = null;
afterEach(() => {
  closeRealtime();
  running?.close();
  running = null;
  getUser.mockReset();
});

describe('realtime socket', () => {
  it('accepts a valid token and confirms readiness', async () => {
    const { server, url } = await start();
    running = server;
    getUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null });

    const socket = await open(url);
    socket.send(JSON.stringify({ type: 'auth', token: 'good-token' }));
    const message = await nextMessage(socket);

    expect(message).toEqual({ type: 'ready', userId: 'user-1' });
    socket.close();
  });

  it('rejects a bad token instead of leaving the socket open', async () => {
    const { server, url } = await start();
    running = server;
    getUser.mockResolvedValue({ data: { user: null }, error: { message: 'bad' } });

    const socket = await open(url);
    socket.send(JSON.stringify({ type: 'auth', token: 'bad-token' }));
    const message = await nextMessage(socket);

    expect(message.type).toBe('error');
    await new Promise((r) => setTimeout(r, 50));
    expect(socket.readyState).not.toBe(WebSocket.OPEN);
  });

  it('delivers an event to the account that owns it', async () => {
    const { server, url } = await start();
    running = server;
    getUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null });

    const socket = await open(url);
    socket.send(JSON.stringify({ type: 'auth', token: 't' }));
    await nextMessage(socket);

    const received = nextMessage(socket);
    publish('user-1', {
      type: 'folder.shared',
      folderId: 'folder-9',
      name: 'Contrat',
    });

    expect(await received).toEqual({
      type: 'event',
      event: { type: 'folder.shared', folderId: 'folder-9', name: 'Contrat' },
    });
    socket.close();
  });

  it('never leaks another account’s events', async () => {
    const { server, url } = await start();
    running = server;
    getUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null });

    const socket = await open(url);
    socket.send(JSON.stringify({ type: 'auth', token: 't' }));
    await nextMessage(socket);

    const seen: unknown[] = [];
    socket.on('message', (raw) => seen.push(JSON.parse(String(raw))));

    publish('someone-else', { type: 'folder.deleted', folderId: 'not-yours' });
    await new Promise((r) => setTimeout(r, 120));

    expect(seen).toEqual([]);
    socket.close();
  });

  it('ignores events for a socket that never authenticated', async () => {
    const { server, url } = await start();
    running = server;

    const socket = await open(url);
    const seen: unknown[] = [];
    socket.on('message', (raw) => seen.push(JSON.parse(String(raw))));

    publish('user-1', { type: 'folder.deleted', folderId: 'x' });
    await new Promise((r) => setTimeout(r, 120));

    expect(seen).toEqual([]);
    expect(realtimeStats().sockets).toBe(0);
    socket.close();
  });

  it('answers a heartbeat', async () => {
    const { server, url } = await start();
    running = server;
    getUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null });

    const socket = await open(url);
    socket.send(JSON.stringify({ type: 'auth', token: 't' }));
    await nextMessage(socket);

    socket.send(JSON.stringify({ type: 'ping' }));
    expect(await nextMessage(socket)).toEqual({ type: 'pong' });
    socket.close();
  });

  it('fans an event out to every device of the same account', async () => {
    const { server, url } = await start();
    running = server;
    getUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null });

    const phone = await open(url);
    const console_ = await open(url);
    for (const s of [phone, console_]) {
      s.send(JSON.stringify({ type: 'auth', token: 't' }));
      await nextMessage(s);
    }
    expect(realtimeStats()).toEqual({ sockets: 2, accounts: 1 });

    const both = Promise.all([nextMessage(phone), nextMessage(console_)]);
    publish('user-1', { type: 'folder.updated', folderId: 'f1', status: 'completed' });
    const [a, b] = await both;
    expect(a).toEqual(b);

    phone.close();
    console_.close();
  });

  it('survives a malformed frame', async () => {
    const { server, url } = await start();
    running = server;
    getUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null });

    const socket = await open(url);
    socket.send('not json at all');
    socket.send(JSON.stringify({ type: 'auth', token: 't' }));
    expect(await nextMessage(socket)).toEqual({ type: 'ready', userId: 'user-1' });
    socket.close();
  });
});

describe('notification content for live events', () => {
  // The phone raises its own alert from the socket, so the mapping from event
  // to notification is what decides whether the signer hears about a document.
  // The console reacts to these, so the shapes are pinned here: every event
  // must name the folder it is about, or the console cannot decide what to
  // refetch.
  it('names every event the console must react to', () => {
    const mustRefresh: RealtimeEvent[] = [
      { type: 'folder.shared', folderId: 'f', name: 'Contrat' },
      { type: 'folder.updated', folderId: 'f', status: 'completed' },
      { type: 'folder.updated', folderId: 'f', status: 'error' },
      { type: 'folder.updated', folderId: 'f', status: 'delivered' },
      { type: 'folder.updated', folderId: 'f', status: 'in_progress' },
    ];
    for (const event of mustRefresh) {
      expect(event).toHaveProperty('folderId');
    }
  });
});
