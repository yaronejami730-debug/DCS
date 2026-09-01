/**
 * Vercel serverless entry point for the API.
 *
 * The standalone server (src/index.ts) opens a port and attaches a WebSocket to
 * it. Neither is possible in a serverless function: there is no port to own and
 * no process to hold a socket open. So this entry deliberately imports only the
 * Hono app — none of the server bootstrap — and lets Vercel drive it one
 * request at a time through the Web Fetch handler.
 *
 * Consequences, both already handled elsewhere:
 *   - realtime (/ws) does not exist here; the clients poll, which the app was
 *     always built to fall back to.
 *   - signing work must finish before the response returns, or the frozen
 *     function abandons it — turned on with PROCESS_INLINE in the environment.
 */
import { handle } from 'hono/vercel';
import { createApp } from '../src/app.js';

export const config = {
  // The Node runtime, not Edge: sharp and pdf generation need real Node.
  runtime: 'nodejs',
};

export default handle(createApp());
