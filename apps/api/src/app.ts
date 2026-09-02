import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { HTTPException } from 'hono/http-exception';
import { PdfPipelineError } from '@scansign/pdf';
import { env } from './env.js';
import { HttpError } from './lib/errors.js';
import type { AppBindings } from './lib/auth.js';
import { authRoutes } from './routes/auth.js';
import { folderRoutes } from './routes/folders.js';
import { documentRoutes } from './routes/documents.js';
import { templateRoutes } from './routes/templates.js';
import { sessionRoutes } from './routes/sessions.js';
import { dashboardRoutes } from './routes/dashboard.js';
import { clientRoutes } from './routes/clients.js';
import { webhookRoutes } from './routes/webhooks.js';
import { publicShareRoutes, shareRoutes, shareUploadRoutes } from './routes/share.js';
import { createExtractionProvider } from './services/extraction/index.js';

export const createApp = () => {
  const app = new Hono<AppBindings>();

  app.use('*', logger());
  app.use(
    '*',
    cors({
      origin: (origin) => (env.corsOrigins.includes(origin) ? origin : env.corsOrigins[0] ?? ''),
      allowHeaders: ['Content-Type', 'Authorization'],
      allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      credentials: false,
    }),
  );

  app.get('/health', async (c) => {
    const provider = createExtractionProvider();
    const extractor = await provider.healthy();
    return c.json({
      status: 'ok',
      extractor: { name: provider.name, url: env.SIGNATURE_SERVICE_URL, healthy: extractor },
    });
  });

  app.route('/auth', authRoutes);
  app.route('/folders', folderRoutes);
  // Share-link management hangs off a folder: /folders/:id/share-links.
  app.route('/folders', shareRoutes);
  // The one unauthenticated surface. A signer opening a link has no credential
  // yet, so the token travels in the path here and in a header everywhere else.
  app.route('/s', publicShareRoutes);
  // What a link holder may write back: a PDF into the folder it points at.
  app.route('/link', shareUploadRoutes);
  app.route('/documents', documentRoutes);
  app.route('/templates', templateRoutes);
  app.route('/dashboard', dashboardRoutes);
  app.route('/clients', clientRoutes);
  app.route('/webhooks', webhookRoutes);
  // Session routes carry their own /folders/:id/... and /signing-sessions/... paths.
  app.route('/', sessionRoutes);

  app.notFound((c) => c.json({ error: 'Route inconnue.', code: 'NOT_FOUND' }, 404));

  app.onError((err, c) => {
    if (err instanceof HttpError) {
      return c.json({ error: err.message, code: err.code, details: err.details }, err.status);
    }
    if (err instanceof PdfPipelineError) {
      return c.json({ error: err.message, code: err.code }, 422);
    }
    if (err instanceof HTTPException) {
      return c.json({ error: err.message, code: 'HTTP_ERROR' }, err.status);
    }
    console.error('[api] unhandled error', err);
    return c.json({ error: 'Erreur interne du serveur.', code: 'INTERNAL_ERROR' }, 500);
  });

  return app;
};
