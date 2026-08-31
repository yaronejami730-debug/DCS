import { serve } from '@hono/node-server';
import { env } from './env.js';
import { createApp } from './app.js';
import { createExtractionProvider } from './services/extraction/index.js';

const app = createApp();

serve({ fetch: app.fetch, port: env.API_PORT, hostname: env.API_HOST }, async (info) => {
  console.log(`[scan&sign] API listening on http://${env.API_HOST}:${info.port}`);
  console.log(`[scan&sign] Supabase: ${env.SUPABASE_URL}`);
  const provider = createExtractionProvider();
  const healthy = await provider.healthy();
  console.log(
    healthy
      ? `[scan&sign] extraction engine "${provider.name}" is up at ${env.SIGNATURE_SERVICE_URL}`
      : `[scan&sign] WARNING: extraction engine unreachable at ${env.SIGNATURE_SERVICE_URL} — run "pnpm extractor:up"`,
  );
});
