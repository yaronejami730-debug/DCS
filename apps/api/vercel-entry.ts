/**
 * Vercel serverless entry point for the API.
 *
 * Lives OUTSIDE api/ on purpose. Vercel scans api/ for function sources before
 * the build and compiles them after it — so a TypeScript file there is always
 * compiled with its unresolvable workspace imports, and deleting it mid-build
 * breaks the post-build compile. This file is only ever the INPUT to
 * build-vercel.mjs, which bundles it into the committed api/index.js that
 * Vercel actually deploys.
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
import { createApp } from './src/app.js';

export const config = {
  // The Node runtime, not Edge: sharp and pdf generation need real Node.
  runtime: 'nodejs',
  // Declared here rather than in vercel.json's `functions` block: that block
  // is validated before the build runs, and this function only exists after
  // the build has bundled it. Inline signing work needs the headroom.
  maxDuration: 300,
  memory: 1024,
};

export default handle(createApp());
