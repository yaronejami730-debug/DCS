import type { DocumentStatus, FolderStatus, SessionStatus } from './status.js';

/**
 * Live updates pushed from the backend to whichever clients an account has
 * open — the console in one tab, the signer following a share link in
 * another.
 *
 * Deliberately thin: an event says *what changed*, never carries the changed
 * row. Clients refetch through their normal authenticated endpoints, so a
 * socket can never become a way to read data the HTTP API would refuse, and
 * the payload cannot drift out of step with the real record.
 */
export type RealtimeEvent =
  | { type: 'folder.shared'; folderId: string; name: string }
  | { type: 'folder.updated'; folderId: string; status: FolderStatus }
  | { type: 'folder.deleted'; folderId: string }
  | { type: 'document.updated'; documentId: string; folderId: string; status: DocumentStatus }
  | { type: 'session.updated'; sessionId: string; folderId: string; status: SessionStatus };

/** Client -> server. The token is sent in a frame, never in the URL. */
export type RealtimeClientMessage = { type: 'auth'; token: string } | { type: 'ping' };

/** Server -> client. */
export type RealtimeServerMessage =
  | { type: 'ready'; userId: string }
  | { type: 'error'; message: string }
  | { type: 'pong' }
  | ({ type: 'event' } & { event: RealtimeEvent });

export const REALTIME_PATH = '/ws';
/** A socket that has not authenticated within this window is dropped. */
export const REALTIME_AUTH_TIMEOUT_MS = 8_000;
/** Client heartbeat interval; the server drops sockets that go quiet. */
export const REALTIME_PING_INTERVAL_MS = 25_000;
