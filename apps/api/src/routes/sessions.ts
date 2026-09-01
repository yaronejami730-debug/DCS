import { Hono, type Context } from 'hono';
import {
  markPhotoPath,
  photoPath,
  generateVariantsSchema,
  previewCutoutSchema,
  startSessionSchema,
  submitRegionsSchema,
  HANDWRITTEN_MARKS,
  ZONE_TYPE,
  ZONE_TYPE_LABEL,
  type CaptureMode,
  type RequiredMarks,
  type SigningSession,
  type ZoneType,
} from '@scansign/shared';
import { env } from '../env.js';
import { db } from '../lib/supabase.js';
import { badRequest, notFound, payloadTooLarge, unsupportedMedia } from '../lib/errors.js';
import { forbidden } from '../lib/errors.js';
import {
  assertShareScope,
  canReadDocuments,
  requireAuthOrShare,
  type ShareBindings,
} from '../lib/share.js';
import { downloadObject, signedUrl, uploadObject } from '../lib/storage.js';
import { enqueue } from '../lib/queue.js';
import { audit } from '../lib/audit.js';
import {
  cropNormalizedRegion,
  imageSize,
  normalizeCapturePhoto,
  trimTransparentBorder,
} from '../services/images.js';
import { createExtractionProvider } from '../services/extraction/index.js';
import { generateVariants } from '../services/variants.js';
import { detectInkRegionsSafely } from '../services/detect.js';
import { processSigningSession } from '../services/processing.js';
import { loadTemplateZones, requiredMarksForFolder } from '../services/templates.js';

export const sessionRoutes = new Hono<ShareBindings>();

/**
 * Two credentials, one surface.
 *
 * The operator arrives with an account token; the technician arrives with a
 * share token, which resolves to the same owner identity so that every
 * `owner_id` filter below keeps working untouched. What stops a link to folder
 * A from reaching folder B is `assertShareScope`, called after every lookup
 * with whatever folder the request actually resolved to. Miss one of those
 * calls and a link becomes a key to the whole account — which is why they are
 * not optional and not implicit.
 */
sessionRoutes.use('*', requireAuthOrShare);

interface SessionRow {
  id: string;
  folder_id: string;
  owner_id: string;
  status: SigningSession['status'];
  capture_mode: CaptureMode;
  photo_path: string | null;
  photo_width: number | null;
  photo_height: number | null;
  signature_image_path: string | null;
  stamp_image_path: string | null;
  mention_image_path: string | null;
  signature_stamp_image_path: string | null;
  signature_stamp_photo_path: string | null;
  signature_photo_path: string | null;
  stamp_photo_path: string | null;
  mention_photo_path: string | null;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  completed_at: string | null;
}

const toModel = (row: SessionRow): SigningSession => ({
  id: row.id,
  folderId: row.folder_id,
  status: row.status,
  captureMode: row.capture_mode,
  photoPath: row.photo_path,
  photoWidth: row.photo_width,
  photoHeight: row.photo_height,
  signatureImagePath: row.signature_image_path,
  stampImagePath: row.stamp_image_path,
  mentionImagePath: row.mention_image_path,
  signatureStampImagePath: row.signature_stamp_image_path,
  errorCode: (row.error_code as SigningSession['errorCode']) ?? null,
  errorMessage: row.error_message,
  createdAt: row.created_at,
  completedAt: row.completed_at,
});

const ACCEPTED_IMAGE = ['image/jpeg', 'image/png', 'image/heic', 'image/heif', 'image/webp'];

const loadFolder = async (folderId: string, ownerId: string) => {
  const { data } = await db
    .from('folders')
    .select('id, status')
    .eq('id', folderId)
    .eq('owner_id', ownerId)
    .maybeSingle<{ id: string; status: string }>();
  if (!data) throw notFound('Dossier introuvable.');
  return data;
};

sessionRoutes.get('/folders/:folderId/required-marks', async (c) => {
  const user = c.get('user');
  const folder = await loadFolder(c.req.param('folderId'), user.id);
  assertShareScope(c.get('share'), folder.id);
  return c.json(await requiredMarksForFolder(folder.id));
});

/** Pull the uploaded image out of a multipart body, with size and type checks. */
const readUpload = async (body: Record<string, unknown>): Promise<File> => {
  const file = body['photo'] ?? body['file'];
  if (!(typeof file === 'object' && file !== null && 'arrayBuffer' in file)) {
    throw badRequest('Photo manquante.', 'UPLOAD_FAILED');
  }
  const upload = file as File;
  if (upload.size > env.MAX_IMAGE_BYTES) {
    throw payloadTooLarge(`La photo dépasse ${Math.round(env.MAX_IMAGE_BYTES / 1024 / 1024)} Mo.`);
  }
  if (upload.type && !ACCEPTED_IMAGE.includes(upload.type)) {
    throw unsupportedMedia(`Format d'image non supporté (${upload.type}).`);
  }
  return upload;
};

/** The request as both entry points see it — one resolved by id, one by token. */
type SessionContext = Context<ShareBindings>;

/**
 * Start a signing session.
 *
 * `captureMode` decides the shape of the rest of the flow:
 *   single   — one sheet holding every mark, uploaded here, framed afterwards.
 *   per_mark — the session opens empty and each mark is uploaded separately to
 *              /signing-sessions/:id/photo/:mark.
 */
/**
 * The same thing, addressed by the link instead of by folder id.
 *
 * A share link holder must never need — or be handed — the id of the folder
 * they are signing into: it is the operator's filing reference, and passing it
 * around invites the client to start using it for other lookups. The folder
 * comes from the token, which is the only thing that ever authorised the
 * request in the first place.
 */
sessionRoutes.post('/signing-sessions', async (c) => {
  const share = c.get('share');
  if (!share) throw forbidden('Cette route est réservée aux liens de signature.');
  const user = c.get('user');
  const folder = await loadFolder(share.folderId, user.id);
  return startSession(c, folder.id);
});

const startSession = async (c: SessionContext, folderId: string) => {
  const user = c.get('user');

  const modeParam = c.req.query('captureMode') ?? 'single';
  const parsedMode = startSessionSchema.safeParse({ captureMode: modeParam });
  if (!parsedMode.success) throw badRequest('Mode de capture invalide.');
  const captureMode = parsedMode.data.captureMode;

  const marks = await requiredMarksForFolder(folderId);

  const { data: session, error } = await db
    .from('signing_sessions')
    .insert({
      folder_id: folderId,
      owner_id: user.id,
      capture_mode: captureMode,
      status: captureMode === 'single' ? 'awaiting_regions' : 'awaiting_photo',
      /**
       * Which link opened this, so processing can stamp only the documents
       * that link covers.
       *
       * It has to be stored now, not re-derived at submission: the subset is a
       * property of the credential the signer arrived with, and by the time
       * they submit, minutes later, nothing else ties the two together. Null
       * when the console started it, which covers the folder.
       */
      share_link_id: c.get('share')?.linkId ?? null,
      /**
       * Which returned scan this session's photo was cut from, when it was.
       *
       * The console starts a session by rasterising one page of a technician's
       * scan and uploading it as the photo; recording the origin is what lets
       * anyone later answer "where did this signature actually come from".
       */
      return_id: c.req.query('returnId') ?? null,
    })
    .select('*')
    .single<SessionRow>();
  if (error || !session) throw badRequest(error?.message ?? 'Session impossible.', 'UPLOAD_FAILED');

  await db.from('folders').update({ status: 'in_progress' }).eq('id', folderId);

  // Per-mark capture uploads each photo separately, so there is nothing to
  // store yet — the client drives the sequence from here.
  if (captureMode === 'per_mark') {
    await audit({
      ownerId: user.id,
      folderId: folderId,
      action: 'session.started',
      metadata: { sessionId: session.id, captureMode },
    });
    return c.json({ session: toModel(session), marks, photo: null, suggestions: null }, 201);
  }

  const upload = await readUpload(await c.req.parseBody());
  const normalized = await normalizeCapturePhoto(new Uint8Array(await upload.arrayBuffer()));

  const path = photoPath(user.id, session.id, 'jpg');
  await uploadObject(path, normalized.bytes, normalized.contentType);
  const { data: updated } = await db
    .from('signing_sessions')
    .update({
      photo_path: path,
      photo_width: normalized.width,
      photo_height: normalized.height,
    })
    .eq('id', session.id)
    .select('*')
    .single<SessionRow>();

  const suggestions = await detectInkRegionsSafely(normalized.bytes);

  await audit({
    ownerId: user.id,
    folderId: folderId,
    action: 'session.photo_uploaded',
    metadata: { sessionId: session.id, captureMode, width: normalized.width },
  });

  return c.json(
    {
      session: toModel(updated!),
      marks,
      photo: { url: await signedUrl(path), width: normalized.width, height: normalized.height },
      suggestions,
    },
    201,
  );
};

sessionRoutes.post('/folders/:folderId/signing-sessions', async (c) => {
  const user = c.get('user');
  const folder = await loadFolder(c.req.param('folderId'), user.id);
  assertShareScope(c.get('share'), folder.id);
  return startSession(c, folder.id);
});

/**
 * Per-mark capture: upload the photo of one mark. The whole frame is used, so
 * the signer never has to draw a box — but a suggestion is still returned, so
 * they can tighten the crop if the sheet has stray marks on it.
 */
sessionRoutes.post('/signing-sessions/:id/photo/:mark', async (c) => {
  const user = c.get('user');
  const mark = c.req.param('mark') as ZoneType;
  if (!ZONE_TYPE.includes(mark)) throw badRequest('Type de marque inconnu.');

  const { data: session } = await db
    .from('signing_sessions')
    .select('*')
    .eq('id', c.req.param('id'))
    .eq('owner_id', user.id)
    .maybeSingle<SessionRow>();
  if (!session) throw notFound('Session introuvable.');
  assertShareScope(c.get('share'), session.folder_id);
  if (session.capture_mode !== 'per_mark') {
    throw badRequest('Cette session utilise une photo unique.', 'BAD_REQUEST');
  }

  const upload = await readUpload(await c.req.parseBody());
  const normalized = await normalizeCapturePhoto(new Uint8Array(await upload.arrayBuffer()));

  const path = markPhotoPath(user.id, session.id, mark, 'jpg');
  await uploadObject(path, normalized.bytes, normalized.contentType);

  const column = `${mark}_photo_path` as const;
  const { data: updated } = await db
    .from('signing_sessions')
    .update({ [column]: path, status: 'awaiting_regions' })
    .eq('id', session.id)
    .select('*')
    .single<SessionRow>();

  const suggestions = await detectInkRegionsSafely(normalized.bytes);
  // Only the region matching this mark is meaningful here.
  const suggested =
    mark === 'stamp' ? (suggestions.stamp ?? suggestions.signature) : suggestions.signature;

  await audit({
    ownerId: user.id,
    folderId: session.folder_id,
    action: 'session.mark_photo_uploaded',
    metadata: { sessionId: session.id, mark },
  });

  return c.json({
    session: toModel(updated!),
    mark,
    photo: { url: await signedUrl(path), width: normalized.width, height: normalized.height },
    suggestion: suggested,
  });
});

/**
 * Preview what the extraction engine will make of a framed region, before
 * committing to it.
 *
 * Background removal is the step most likely to disappoint — a faint stamp, a
 * shadow across the paper, ink too pale — and the signer has no way to judge it
 * from the photo alone. Returning the actual cutout lets them widen the box or
 * retake the photo now, rather than discovering the problem in the finished
 * contract.
 *
 * Runs the real pipeline, so what is shown is what will be stamped. Returned as
 * a data URL because it is a few kilobytes and belongs to nothing yet: storing
 * a preview would mean cleaning it up later for no gain.
 */
sessionRoutes.post('/signing-sessions/:id/preview-cutout', async (c) => {
  const user = c.get('user');
  const { data: session } = await db
    .from('signing_sessions')
    .select('*')
    .eq('id', c.req.param('id'))
    .eq('owner_id', user.id)
    .maybeSingle<SessionRow>();
  if (!session) throw notFound('Session introuvable.');
  assertShareScope(c.get('share'), session.folder_id);

  const parsed = previewCutoutSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw badRequest('Zone invalide.', 'BAD_REQUEST', parsed.error.issues);
  const { mark, region, engine } = parsed.data;

  const path =
    session.capture_mode === 'per_mark'
      ? mark === 'signature'
        ? session.signature_photo_path
        : mark === 'stamp'
          ? session.stamp_photo_path
          : mark === 'mention'
            ? session.mention_photo_path
            : session.signature_stamp_photo_path
      : session.photo_path;
  if (!path) throw badRequest('Aucune photo pour cette marque.', 'IMAGE_PROCESSING_FAILED');

  const photo = await downloadObject(path);
  const size =
    session.capture_mode === 'per_mark' || !session.photo_width || !session.photo_height
      ? await imageSize(photo)
      : { width: session.photo_width, height: session.photo_height };

  const crop = await cropNormalizedRegion(photo, region, size.width, size.height);
  // The preview is the one place a different engine may be asked for, so the
  // operator can put the two results side by side on the same crop. Omitted,
  // it uses whichever engine this server actually signs with.
  const chosen = engine ?? env.EXTRACTION_ENGINE;
  const provider = createExtractionProvider(chosen);
  const failure =
    mark === 'stamp'
      ? 'STAMP_EXTRACTION_FAILED'
      : mark === 'mention'
        ? 'MENTION_EXTRACTION_FAILED'
        : mark === 'signature_stamp'
          ? 'COMBINED_EXTRACTION_FAILED'
          : 'SIGNATURE_EXTRACTION_FAILED';

  // A combined mark is ink over a stamp: the stamp path copes better with the
  // coloured ink that dominates it.
  const extracted =
    mark === 'stamp' || mark === 'signature_stamp'
      ? await provider.extractStamp({ image: crop, contentType: 'image/png' })
      : await provider.extractSignature({ image: crop, contentType: 'image/png' });

  const trimmed = await trimTransparentBorder(extracted.png, failure);

  return c.json({
    mark,
    engine: chosen,
    fellBack: extracted.meta?.fellBack === true,
    width: trimmed.width,
    height: trimmed.height,
    dataUrl: `data:image/png;base64,${Buffer.from(trimmed.bytes).toString('base64')}`,
  });
});

/**
 * Show the natural variation that will be applied between documents.
 *
 * Signing five documents by hand produces five slightly different signatures;
 * stamping one identical bitmap reads as mechanical. This returns a few
 * variants of the framed mark so the signer can see the spread before
 * committing. Purely cosmetic — it changes how the marks sit on the page, not
 * what the document is.
 */
/**
 * The documents in this session's folder — one variant will go to each.
 *
 * Closed to a *signer* link. It returns filenames, and an outside technician is
 * not entitled to them: they supply a signature, and which contracts it lands
 * on is the operator's business. Refused rather than filtered, because there is
 * no filtered version of this answer that is still useful — even the row count
 * would say how many documents exist. An operator link passes, because that is
 * the account holder on their own phone.
 */
sessionRoutes.get('/signing-sessions/:id/documents', async (c) => {
  const user = c.get('user');
  if (!canReadDocuments(c.get('share')))
    throw forbidden('Ce lien ne donne pas accès aux documents.');
  const { data: session } = await db
    .from('signing_sessions')
    .select('folder_id')
    .eq('id', c.req.param('id'))
    .eq('owner_id', user.id)
    .maybeSingle<{ folder_id: string }>();
  if (!session) throw notFound('Session introuvable.');

  const { data } = await db
    .from('documents')
    .select('id, filename, page_count, status')
    .eq('folder_id', session.folder_id)
    .order('position', { ascending: true })
    .returns<Array<{ id: string; filename: string; page_count: number; status: string }>>();

  const items = (data ?? []).map((d) => ({
    id: d.id,
    filename: d.filename,
    pageCount: d.page_count,
    status: d.status,
  }));
  return c.json({ items, total: items.length });
});

/**
 * Closed to a signer link, for the same reason as /documents.
 *
 * The caller passes a `count`, and the only sensible count is "one per
 * document" — so answering this for a technician would hand them the size of a
 * folder they are not allowed to see. For them the variants are produced
 * server-side at processing time instead, one per document, which is what they
 * would have chosen anyway.
 */
sessionRoutes.post('/signing-sessions/:id/preview-variants', async (c) => {
  const user = c.get('user');
  if (!canReadDocuments(c.get('share')))
    throw forbidden('Ce lien ne donne pas accès aux documents.');
  const { data: session } = await db
    .from('signing_sessions')
    .select('*')
    .eq('id', c.req.param('id'))
    .eq('owner_id', user.id)
    .maybeSingle<SessionRow>();
  if (!session) throw notFound('Session introuvable.');
  assertShareScope(c.get('share'), session.folder_id);

  const parsed = generateVariantsSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw badRequest('Zone invalide.', 'BAD_REQUEST', parsed.error.issues);
  const { mark, region, count } = parsed.data;

  if (!HANDWRITTEN_MARKS.includes(mark)) {
    throw badRequest(
      'Un tampon est un objet physique : il se reproduit à l’identique et n’est pas varié.',
      'BAD_REQUEST',
    );
  }

  const path =
    session.capture_mode === 'per_mark'
      ? mark === 'signature'
        ? session.signature_photo_path
        : mark === 'mention'
          ? session.mention_photo_path
          : session.signature_stamp_photo_path
      : session.photo_path;
  if (!path) throw badRequest('Aucune photo pour cette marque.', 'IMAGE_PROCESSING_FAILED');

  const photo = await downloadObject(path);
  const size =
    session.capture_mode === 'per_mark' || !session.photo_width || !session.photo_height
      ? await imageSize(photo)
      : { width: session.photo_width, height: session.photo_height };

  const crop = await cropNormalizedRegion(photo, region, size.width, size.height);
  const provider = createExtractionProvider();
  const extracted =
    mark === 'signature_stamp'
      ? await provider.extractStamp({ image: crop, contentType: 'image/png' })
      : await provider.extractSignature({ image: crop, contentType: 'image/png' });
  const trimmed = await trimTransparentBorder(
    extracted.png,
    mark === 'signature_stamp' ? 'COMBINED_EXTRACTION_FAILED' : 'SIGNATURE_EXTRACTION_FAILED',
  );

  return c.json({ mark, variants: await generateVariants(trimmed.bytes, count) });
});

/**
 * The signer has framed every mark. Processing runs off the request so the
 * client gets an immediate answer and then polls GET /signing-sessions/:id.
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
  assertShareScope(c.get('share'), session.folder_id);
  if (session.status === 'processing') return c.json(toModel(session), 202);
  if (session.status === 'completed') return c.json(toModel(session));

  const parsed = submitRegionsSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    throw badRequest('Zones sélectionnées invalides.', 'BAD_REQUEST', parsed.error.issues);
  }

  /**
   * In per-mark capture, refuse a region whose photo never arrived.
   *
   * This caught a real failure: each mark used to open its own session, so the
   * signature landed in one and the mention in another, and the session that
   * was finally submitted held no signature. The pipeline only noticed after
   * queueing, and reported "Photo de signature manquante" long after the
   * signer had moved on. Checking here fails immediately and names the mark.
   */
  if (session.capture_mode === 'per_mark') {
    const photoFor: Record<ZoneType, string | null> = {
      signature: session.signature_photo_path,
      stamp: session.stamp_photo_path,
      mention: session.mention_photo_path,
      signature_stamp: session.signature_stamp_photo_path,
    };
    const missing = ZONE_TYPE.filter(
      (mark) => parsed.data[mark as keyof typeof parsed.data] && !photoFor[mark],
    );
    if (missing.length > 0) {
      throw badRequest(
        `Photo manquante pour : ${missing.map((m) => ZONE_TYPE_LABEL[m].toLowerCase()).join(', ')}. Reprenez la capture depuis le début.`,
        'IMAGE_PROCESSING_FAILED',
        { missing },
      );
    }
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
      mention: parsed.data.mention ?? null,
      signature_stamp: parsed.data.signature_stamp ?? null,
      assignments: parsed.data.assignments,
    }),
  );

  await audit({
    ownerId: user.id,
    folderId: session.folder_id,
    action: 'session.regions_submitted',
    metadata: {
      sessionId: session.id,
      captureMode: session.capture_mode,
      hasStamp: Boolean(parsed.data.stamp),
      hasMention: Boolean(parsed.data.mention),
      assigned: Object.keys(parsed.data.assignments ?? {}),
    },
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
  assertShareScope(c.get('share'), data.folder_id);
  return c.json(toModel(data));
});
