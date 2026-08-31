import { serve } from '@hono/node-server';
import type { Server } from 'node:http';
import { REALTIME_PATH } from '@scansign/shared';
import { env } from './env.js';
import { createApp } from './app.js';
import { createExtractionProvider } from './services/extraction/index.js';
import { attachRealtime } from './lib/realtime.js';

const app = createApp();

const server = serve({ fetch: app.fetch, port: env.API_PORT, hostname: env.API_HOST }, async (info) => {
  console.log(`[scan&sign] API listening on http://${env.API_HOST}:${info.port}`);
  console.log(`[scan&sign] Supabase: ${env.SUPABASE_URL}`);
  const provider = createExtractionProvider();
  const healthy = await provider.healthy();
  console.log(
    healthy
      ? `[scan&sign] extraction engine "${provider.name}" is up at ${env.SIGNATURE_SERVICE_URL}`
      : `[scan&sign] WARNING: extraction engine unreachable at ${env.SIGNATURE_SERVICE_URL} — run "pnpm extractor:up"`,
  );
  console.log(`[scan&sign] realtime on ws://${env.API_HOST}:${info.port}${REALTIME_PATH}`);
});

// Live updates share the HTTP server, so there is one port and one origin.
attachRealtime(server as unknown as Server);
