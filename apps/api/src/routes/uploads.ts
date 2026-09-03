import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { requireAuth, type AppBindings } from '../lib/auth.js';
import { createSignedUploadUrl, downloadObject, removeObjects } from '../lib/storage.js';
import { badRequest } from '../lib/errors.js';
import { env } from '../env.js';

export const uploadRoutes = new Hono<AppBindings>();
uploadRoutes.use('*', requireAuth);

/** Where direct uploads land before the API files them. Owner-scoped. */
export const stagingPath = (ownerId: string, ext: string): string =>
  `uploads/${ownerId}/${randomUUID()}.${ext}`;

/**
 * Sign a destination for a direct browser → storage upload.
 *
 * The browser PUTs the file to `signedUrl`, then hands `path` to the route
 * that consumes it (documents import, template creation). The path carries
 * the owner id, and the consuming routes check it starts with theirs, so a
 * path cannot be pointed at someone else's staging area.
 */
uploadRoutes.post('/sign', async (c) => {
  const user = c.get('user');
  const body = (await c.req.json().catch(() => ({}))) as { filename?: string; size?: number };
  const size = Number(body.size ?? 0);
  if (size > env.MAX_PDF_BYTES) {
    throw badRequest(`Fichier trop volumineux (max ${Math.round(env.MAX_PDF_BYTES / 1024 / 1024)} Mo).`, 'FILE_TOO_LARGE');
  }
  const path = stagingPath(user.id, 'pdf');
  const signed = await createSignedUploadUrl(path);
  return c.json({ path: signed.path, signedUrl: signed.signedUrl, token: signed.token });
});

/** Read a staged upload back as a File the import pipeline understands, then drop it. */
export const takeStagedFile = async (
  ownerId: string,
  path: string,
  filename: string,
): Promise<File> => {
  if (!path.startsWith(`uploads/${ownerId}/`)) throw badRequest('Fichier téléversé invalide.', 'UPLOAD_FAILED');
  const bytes = await downloadObject(path);
  void removeObjects([path]).catch(() => {
    /* a leftover in staging is harmless */
  });
  return new File([Buffer.from(bytes)], filename || 'document.pdf', { type: 'application/pdf' });
};
