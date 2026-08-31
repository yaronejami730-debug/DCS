import { Hono } from 'hono';
import { photoPath, submitRegionsSchema, type SigningSession } from '@scansign/shared';
import { env } from '../env.js';
import { db } from '../lib/supabase.js';
import { badRequest, notFound, payloadTooLarge, unsupportedMedia } from '../lib/errors.js';
import { requireAuth, type AppBindings } from '../lib/auth.js';
import { signedUrl, uploadObject } from '../lib/storage.js';
import { enqueue } from '../lib/queue.js';
import { audit } from '../lib/audit.js';
import { normalizeCapturePhoto } from '../services/images.js';
import { processSigningSession } from '../services/processing.js';

export const sessionRoutes = new Hono<AppBindings>();
sessionRoutes.use('*', requireAuth);

interface SessionRow {
  id: string;
  folder_id: string;
  owner_id: string;
  device_id: string | null;
  status: SigningSession['status'];
  photo_path: string | null;
  photo_width: number | null;
  photo_height: number | null;
  signature_image_path: string | null;
  stamp_image_path: string | null;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  completed_at: string | null;
}

const toModel = (row: SessionRow): SigningSession => ({
  id: row.id,
  folderId: row.folder_id,
  deviceId: row.device_id,
  status: row.status,
  photoPath: row.photo_path,
  photoWidth: row.photo_width,
  photoHeight: row.photo_height,
  signatureImagePath: row.signature_image_path,
  stampImagePath: row.stamp_image_path,
  errorCode: (row.error_code as SigningSession['errorCode']) ?? null,
  errorMessage: row.error_message,
  createdAt: row.created_at,
  completedAt: row.completed_at,
});

const ACCEPTED_IMAGE = ['image/jpeg', 'image/png', 'image/heic', 'image/heif', 'image/webp'];

/**
 * Step 1 of the capture flow: the phone uploads the photo of the sheet holding
 * the signature and the stamp.
 *
 * The photo is auto-oriented and re-encoded here so that the region rectangles
 * the user draws next refer to exactly the pixels they are looking at.
 */
sessionRoutes.post('/folders/:folderId/signing-sessions', async (c) => {
  const user = c.get('user');
  const folderId = c.req.param('folderId');

  const { data: folder } = await db
    .from('folders')
    .select('id, device_id, status')
    .eq('id', folderId)
    .eq('owner_id', user.id)
    .maybeSingle<{ id: string; device_id: string | null; status: string }>();
  if (!folder) throw notFound('Dossier introuvable.');

  const body = await c.req.parseBody();
  const file = body['photo'] ?? body['file'];
  if (!(typeof file === 'object' && file !== null && 'arrayBuffer' in file)) {
    throw badRequest('Photo manquante.', 'UPLOAD_FAILED');
  }
  const upload = file as File;
  if (upload.size > env.MAX_IMAGE_BYTES) {
    throw payloadTooLarge(
      `La photo dépasse ${Math.round(env.MAX_IMAGE_BYTES / 1024 / 1024)} Mo.`,
    );
  }
  if (upload.type && !ACCEPTED_IMAGE.includes(upload.type)) {
    throw unsupportedMedia(`Format d'image non supporté (${upload.type}).`);
  }

  const normalized = await normalizeCapturePhoto(new Uint8Array(await upload.arrayBuffer()));

  const { data: session, error } = await db
    .from('signing_sessions')
    .insert({
      folder_id: folder.id,
      owner_id: user.id,
      device_id: folder.device_id,
      status: 'awaiting_regions',
      photo_width: normalized.width,
      photo_height: normalized.height,
    })
    .select('*')
    .single<SessionRow>();
  if (error || !session) throw badRequest(error?.message ?? 'Session impossible.', 'UPLOAD_FAILED');

  const path = photoPath(user.id, session.id, 'jpg');
  await uploadObject(path, normalized.bytes, normalized.contentType);
  const { data: updated } = await db
    .from('signing_sessions')
    .update({ photo_path: path })
    .eq('id', session.id)
    .select('*')
    .single<SessionRow>();

  await db.from('folders').update({ status: 'in_progress' }).eq('id', folder.id);
  await audit({
    ownerId: user.id,
    folderId: folder.id,
    action: 'session.photo_uploaded',
    metadata: { sessionId: session.id, width: normalized.width, height: normalized.height },
  });

  return c.json(
    {
      session: toModel(updated!),
      photo: {
        url: await signedUrl(path),
        width: normalized.width,
        height: normalized.height,
      },
    },
    201,
  );
});

/**
 * Step 2: the user has drawn the signature (and optionally stamp) rectangles.
 * Processing runs off the request so the phone gets an immediate answer and
 * then polls GET /signing-sessions/:id.
 */
sessionRoutes.post('/signing-sessions/:id/regions', async (c) => {
  const user = c.get('user');
  const { data: session } = await db
    .from('signing_sessions')
    .select('*')
    .eq('id', c.req.param('id'))
    .eq('owner_id', user.id)
    .maybeSingle<SessionRow>();
  if (!session) throw notFound('Session introuvable.');
  if (session.status === 'processing') return c.json(toModel(session), 202);
  if (session.status === 'completed') return c.json(toModel(session));

  const parsed = submitRegionsSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    throw badRequest('Zones sélectionnées invalides.', 'BAD_REQUEST', parsed.error.issues);
  }

  const { data: updated } = await db
    .from('signing_sessions')
    .update({ status: 'processing', error_code: null, error_message: null })
    .eq('id', session.id)
    .select('*')
    .single<SessionRow>();

  enqueue(`session:${session.id}`, () =>
    processSigningSession(session.id, {
      signature: parsed.data.signature,
      stamp: parsed.data.stamp ?? null,
    }),
  );

  await audit({
    ownerId: user.id,
    folderId: session.folder_id,
    action: 'session.regions_submitted',
    metadata: { sessionId: session.id, hasStamp: Boolean(parsed.data.stamp) },
  });

  return c.json(toModel(updated!), 202);
});

sessionRoutes.get('/signing-sessions/:id', async (c) => {
  const user = c.get('user');
  const { data } = await db
    .from('signing_sessions')
    .select('*')
    .eq('id', c.req.param('id'))
    .eq('owner_id', user.id)
    .maybeSingle<SessionRow>();
  if (!data) throw notFound('Session introuvable.');
  return c.json(toModel(data));
});
