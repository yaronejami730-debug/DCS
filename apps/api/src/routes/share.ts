import { Hono } from 'hono';
import {
  createShareLinkSchema,
  linkActivitySchema,
  marksToCapture,
  updateShareLinkSchema,
  type FolderStatus,
} from '@scansign/shared';
import { inspectPdf, looksLikePdf } from '@scansign/pdf';
import { geolocationSchema, returnPath, type ShareLinkReturn } from '@scansign/shared';
import { env } from '../env.js';
import { db } from '../lib/supabase.js';
import {
  badRequest,
  forbidden,
  notFound,
  payloadTooLarge,
  unsupportedMedia,
} from '../lib/errors.js';
import { removeObjects, signedUrl, uploadObject } from '../lib/storage.js';
import { normalizeCapturePhoto } from '../services/images.js';
import { requireAuth, type AppBindings } from '../lib/auth.js';
import { audit } from '../lib/audit.js';
import { publish } from '../lib/realtime.js';
import { requiredMarksForFolder } from '../services/templates.js';
import {
  importPdfsIntoFolder,
  readPdfUploads,
  reopenFolderIfFinished,
} from '../services/documents.js';
import {
  documentIdsForLink,
  linkDocumentIds,
  recordLinkActivity,
  requireAuthOrShare,
  setLinkDocuments,
  type ShareBindings,
  SHARE_LINK_SELECT,
  defaultExpiry,
  isActive,
  mintToken,
  resolveShareToken,
  toShareLink,
  touchShareLink,
  type ShareLinkRow,
} from '../lib/share.js';

/**
 * Share links, from the operator's side.
 *
 * Mounted under /folders, so the routes read as what they are: a property of a
 * folder rather than a resource of their own.
 */
export interface ReturnRow {
  id: string;
  link_id: string;
  folder_id: string;
  owner_id: string;
  document_id: string | null;
  filename: string;
  storage_path: string;
  content_type: string;
  byte_size: number;
  width: number | null;
  height: number | null;
  page_count: number | null;
  handled_at: string | null;
  latitude: number | null;
  longitude: number | null;
  location_accuracy: number | null;
  location_at: string | null;
  created_at: string;
}

export const toReturn = (row: ReturnRow, url?: string): ShareLinkReturn => ({
  id: row.id,
  linkId: row.link_id,
  folderId: row.folder_id,
  documentId: row.document_id,
  filename: row.filename,
  contentType: row.content_type,
  byteSize: Number(row.byte_size),
  width: row.width,
  height: row.height,
  pageCount: row.page_count,
  handledAt: row.handled_at,
  location:
    row.latitude !== null && row.longitude !== null
      ? {
          latitude: row.latitude,
          longitude: row.longitude,
          accuracy: row.location_accuracy,
          at: row.location_at ?? row.created_at,
        }
      : null,
  createdAt: row.created_at,
  ...(url ? { url } : {}),
});

export const shareRoutes = new Hono<AppBindings>();
shareRoutes.use('*', requireAuth);

const ownedFolder = async (folderId: string, ownerId: string) => {
  const { data } = await db
    .from('folders')
    .select('id, name, status')
    .eq('id', folderId)
    .eq('owner_id', ownerId)
    .maybeSingle<{ id: string; name: string; status: string }>();
  if (!data) throw notFound('Dossier introuvable.');
  return data;
};

/** Every link ever minted for this folder, newest first — including dead ones. */
shareRoutes.get('/:id/share-links', async (c) => {
  const user = c.get('user');
  const folder = await ownedFolder(c.req.param('id'), user.id);

  const { data, error } = await db
    .from('folder_share_links')
    .select(SHARE_LINK_SELECT)
    .eq('folder_id', folder.id)
    .order('created_at', { ascending: false });

  // Surfaced, not swallowed. `data ?? []` on its own turns "the table does not
  // exist because the migration has not been run" into a cheerful empty list,
  // and the operator concludes the feature is broken rather than unmigrated.
  if (error) throw badRequest(`Liens indisponibles : ${error.message}`);

  const items = await Promise.all(
    (data ?? []).map(async (row) => toShareLink(row, await linkDocumentIds(row.id))),
  );
  return c.json({ items });
});

/**
 * Mint a link.
 *
 * Minting does not revoke what came before: an operator may legitimately want
 * one link per signer on the same folder, labelled by name. Revoking is a
 * separate, deliberate act.
 */
shareRoutes.post('/:id/share-links', async (c) => {
  const user = c.get('user');
  const folder = await ownedFolder(c.req.param('id'), user.id);

  const body = await c.req.json().catch(() => ({}));
  const parsed = createShareLinkSchema.safeParse(body ?? {});
  if (!parsed.success) throw badRequest('Paramètres de lien invalides.');

  /**
   * A link with no capture sheet sends the technician to a page with nothing to
   * print. Counted on `for_signing` specifically: a folder full of contracts
   * and no signature sheet is exactly the case this catches, and counting all
   * documents would let it through.
   */
  const { count } = await db
    .from('documents')
    .select('id', { count: 'exact', head: true })
    .eq('folder_id', folder.id)
    .eq('role', 'for_signing');
  if (!count) {
    throw badRequest(
      'Importez d’abord la feuille que le signataire devra signer.',
      'UPLOAD_FAILED',
    );
  }

  const { data, error } = await db
    .from('folder_share_links')
    .insert({
      folder_id: folder.id,
      owner_id: user.id,
      token: mintToken(),
      label: parsed.data.label ?? null,
      scope: parsed.data.scope,
      require_location: parsed.data.requireLocation,
      expires_at: defaultExpiry(parsed.data.expiresInDays),
    })
    .select(SHARE_LINK_SELECT)
    .single<ShareLinkRow>();
  if (error || !data) throw badRequest(error?.message ?? 'Création du lien impossible.');

  const documentIds = await setLinkDocuments(
    data.id,
    folder.id,
    parsed.data.documentIds ?? [],
  );

  await audit({
    ownerId: user.id,
    folderId: folder.id,
    action: 'folder.shared',
    metadata: {
      linkId: data.id,
      label: data.label,
      scope: data.scope,
      expiresAt: data.expires_at,
      // 'all' rather than 0, so the log distinguishes "the whole folder" from
      // "a subset that happens to be empty" — which cannot be created.
      documents: documentIds.length === 0 ? 'all' : documentIds.length,
    },
  });
  publish(user.id, { type: 'folder.shared', folderId: folder.id, name: folder.name });

  return c.json(toShareLink(data, documentIds), 201);
});

/**
 * Revoke.
 *
 * Kept as a row rather than deleted: the console shows that a link existed, was
 * opened N times, and was cut off — which is the record you want when someone
 * asks why a signer can no longer reach a contract.
 */
shareRoutes.delete('/:id/share-links/:linkId', async (c) => {
  const user = c.get('user');
  const folder = await ownedFolder(c.req.param('id'), user.id);

  const { data } = await db
    .from('folder_share_links')
    .update({ revoked_at: new Date().toISOString() })
    .eq('id', c.req.param('linkId'))
    .eq('folder_id', folder.id)
    .eq('owner_id', user.id)
    .select(SHARE_LINK_SELECT)
    .maybeSingle<ShareLinkRow>();
  if (!data) throw notFound('Lien introuvable.');

  await audit({
    ownerId: user.id,
    folderId: folder.id,
    action: 'folder.share_revoked',
    metadata: { linkId: data.id },
  });

  return c.json(toShareLink(data, await linkDocumentIds(data.id)));
});

/**
 * Change which documents a link covers, without reissuing it.
 *
 * Separate from revoking: adding a document to a technician's link is an
 * ordinary correction, and forcing a new URL for it would mean chasing the
 * person who already has the old one.
 *
 * A signature already applied is not undone by narrowing the subset — it is on
 * the document. This only governs what future submissions reach.
 */
shareRoutes.put('/:id/share-links/:linkId/documents', async (c) => {
  const user = c.get('user');
  const folder = await ownedFolder(c.req.param('id'), user.id);

  const parsed = updateShareLinkSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw badRequest('Sélection de documents invalide.');

  const { data: link } = await db
    .from('folder_share_links')
    .select(SHARE_LINK_SELECT)
    .eq('id', c.req.param('linkId'))
    .eq('folder_id', folder.id)
    .eq('owner_id', user.id)
    .maybeSingle<ShareLinkRow>();
  if (!link) throw notFound('Lien introuvable.');

  const documentIds = await setLinkDocuments(link.id, folder.id, parsed.data.documentIds);

  await audit({
    ownerId: user.id,
    folderId: folder.id,
    action: 'folder.share_documents_changed',
    metadata: { linkId: link.id, documents: documentIds.length === 0 ? 'all' : documentIds.length },
  });

  return c.json(toShareLink(link, documentIds));
});

/**
 * What the signer sees when the link opens — before any credential exists.
 *
 * Capture only. This route deliberately returns NOTHING about the folder's
 * contents: no filenames, no document count, no page counts, no previews, not
 * even the folder's name. The technician holding this link supplies one thing —
 * a photograph of their own signature — and the contracts it will be stamped
 * onto are none of their business. They are usually a third party, and a link
 * forwarded by mistake must not become a leak of somebody's contract.
 *
 * What it does return is the minimum needed to act: who is asking, and which
 * marks to photograph. The marks are reported as a plain list of types, never
 * as counts — a count of signature zones is a count of documents by another
 * name.
 *
 * It is also the only route that carries the token in the path rather than a
 * header, because the browser has nothing else to send yet.
 */
export const publicShareRoutes = new Hono();

publicShareRoutes.get('/:token', async (c) => {
  const link = await resolveShareToken(c.req.param('token'));
  void touchShareLink(link.id);
  void recordLinkActivity(link.id, 'opened');

  const { data: folder } = await db
    .from('folders')
    .select('id, name, reference, status')
    .eq('id', link.folder_id)
    .maybeSingle<{ id: string; name: string; reference: number; status: string }>();
  if (!folder) throw notFound('Demande introuvable.');

  const { data: profile } = await db
    .from('profiles')
    .select('display_name')
    .eq('id', link.owner_id)
    .maybeSingle<{ display_name: string | null }>();

  const marks = await requiredMarksForFolder(link.folder_id);

  // Opening the link is what tells the console the request was received — the
  // signal the old "the phone acknowledged" step used to produce.
  if (folder.status === 'pending') {
    await db
      .from('folders')
      .update({ status: 'delivered', delivered_at: new Date().toISOString() })
      .eq('id', folder.id);
    publish(link.owner_id, { type: 'folder.updated', folderId: folder.id, status: 'delivered' });
  }

  /**
   * The documents this link covers.
   *
   * The technician needs them: the flow is download, print, sign by hand, scan
   * back. Narrowed to the link's own subset, so a link sent for the delivery
   * notes does not also hand over the contract filed beside them.
   */
  const allowedIds = await documentIdsForLink(link.id, folder.id);
  const { data: documents } = allowedIds.length
    ? await db
        .from('documents')
        .select('id, filename, page_count, status')
        .eq('folder_id', folder.id)
        .in('id', allowedIds)
        .order('position', { ascending: true })
        .returns<Array<{ id: string; filename: string; page_count: number; status: string }>>()
    : { data: [] };

  return c.json({
    /** Who is asking, so the page is not a request from nobody. */
    sender: profile?.display_name ?? null,
    /** Which marks the paperwork calls for, in capture order. */
    marks: marksToCapture(marks),
    /** Terminal states let the page say "déjà fait" instead of restarting. */
    done: folder.status === 'completed',
    scope: link.scope,
    requireLocation: link.require_location ?? false,
    folder: {
      name: folder.name,
      reference: Number(folder.reference),
      documents: (documents ?? []).map((d) => ({
        id: d.id,
        filename: d.filename,
        pageCount: d.page_count,
        status: d.status,
      })),
    },
    expiresAt: link.expires_at,
    active: isActive(link),
  });
});

/**
 * What a link holder may WRITE into the folder.
 *
 * The technician is often the person actually holding the paperwork — a
 * delivery note, a signed annex, a form filled in on site — so the link lets
 * them add a PDF to the folder it points at. That is the other half of the
 * exchange: the console sends a request, the technician sends back both their
 * signature and, when they have it, the document itself.
 *
 * Write-only, and deliberately asymmetric. Uploading returns nothing but a
 * receipt for the files this very request carried: no folder, no list, no count
 * of what was already there. Being able to contribute a document is not the
 * same as being allowed to read the folder, and this is the route where those
 * two would be easiest to conflate.
 */
export const shareUploadRoutes = new Hono<ShareBindings>();
shareUploadRoutes.use('*', requireAuthOrShare);

shareUploadRoutes.post('/documents', async (c) => {
  const share = c.get('share');
  if (!share) throw forbidden('Cette route est réservée aux liens de signature.');
  const user = c.get('user');

  const { data: folder } = await db
    .from('folders')
    .select('id, status')
    .eq('id', share.folderId)
    .eq('owner_id', user.id)
    .maybeSingle<{ id: string; status: FolderStatus }>();
  if (!folder) throw notFound('Demande introuvable.');

  const files = readPdfUploads(await c.req.parseBody({ all: true }));
  const imported = await importPdfsIntoFolder({
    ownerId: user.id,
    folderId: folder.id,
    files,
  });
  await reopenFolderIfFinished(folder.id, folder.status);

  await audit({
    ownerId: user.id,
    folderId: folder.id,
    // Its own action, distinct from 'document.imported', so the console's
    // activity feed shows at a glance which documents the operator added and
    // which arrived through a link.
    action: 'document.imported_via_link',
    metadata: { linkId: share.linkId, count: imported.length },
  });

  publish(user.id, { type: 'folder.updated', folderId: folder.id, status: folder.status });

  // Only what this request just uploaded. The signer knows these filenames —
  // they chose them a second ago — and learns nothing else.
  return c.json(
    { imported: imported.map((d) => ({ filename: d.filename, pageCount: d.pageCount })) },
    201,
  );
});

/**
 * The signed page comes back.
 *
 * This is step 3 of the loop: the technician has printed the document, signed
 * it by hand and photographed or scanned the result. What arrives here is raw
 * evidence — nobody has yet decided which mark is where in it. The operator
 * does that on the console afterwards.
 *
 * Images and PDFs both, because a technician on site sends whatever their phone
 * produced: a photo of the page, or a multi-page scan from the office copier.
 */
const ACCEPTED_RETURN = [
  'image/jpeg',
  'image/png',
  'image/heic',
  'image/heif',
  'image/webp',
  'application/pdf',
];

shareUploadRoutes.post('/returns', async (c) => {
  const share = c.get('share');
  if (!share) throw forbidden('Cette route est réservée aux liens de signature.');
  const user = c.get('user');

  const body = await c.req.parseBody({ all: true });
  const raw = body['file'] ?? body['files'];
  const files = (Array.isArray(raw) ? raw : [raw]).filter(
    (f): f is File => typeof f === 'object' && f !== null && 'arrayBuffer' in f,
  );
  if (files.length === 0) throw badRequest('Aucun fichier reçu.', 'UPLOAD_FAILED');

  // Which document this is a signed copy of, when the technician said so. It is
  // re-checked against the link's own subset rather than trusted: the field
  // comes from a form anyone holding the link can edit.
  const claimed = typeof body['documentId'] === 'string' ? body['documentId'] : null;
  const allowed = await documentIdsForLink(share.linkId, share.folderId);
  const documentId = claimed && allowed.includes(claimed) ? claimed : null;

  /**
   * The location, if the technician allowed it.
   *
   * Validated against real Earth coordinates rather than trusted: it arrives in
   * a form field, so a malformed or invented payload must be rejected at the
   * edge, not filed as evidence. Absent is fine — the link may not have asked,
   * or the technician may have refused, and neither blocks the signature.
   */
  let location: { latitude: number; longitude: number; accuracy: number | null } | null = null;
  const rawLocation = body['location'];
  if (typeof rawLocation === 'string' && rawLocation.length > 0) {
    const parsed = geolocationSchema.safeParse(JSON.parse(rawLocation));
    if (parsed.success) {
      location = {
        latitude: parsed.data.latitude,
        longitude: parsed.data.longitude,
        accuracy: parsed.data.accuracy ?? null,
      };
    }
  }

  const saved: ShareLinkReturn[] = [];

  for (const file of files) {
    if (file.size > env.MAX_IMAGE_BYTES && file.type !== 'application/pdf') {
      throw payloadTooLarge(
        `${file.name} dépasse ${Math.round(env.MAX_IMAGE_BYTES / 1024 / 1024)} Mo.`,
      );
    }
    if (file.size > env.MAX_PDF_BYTES) {
      throw payloadTooLarge(
        `${file.name} dépasse ${Math.round(env.MAX_PDF_BYTES / 1024 / 1024)} Mo.`,
      );
    }
    if (file.type && !ACCEPTED_RETURN.includes(file.type)) {
      throw unsupportedMedia(`Format non supporté (${file.type}).`);
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    const isPdf = file.type === 'application/pdf' || looksLikePdf(bytes);

    /**
     * Images are normalised the way capture photos are — EXIF orientation baked
     * in, size capped — because the console will crop against the pixels it is
     * shown, and a photo whose stored dimensions disagree with its displayed
     * ones puts every crop 90° out. PDFs are stored as sent; their pages are
     * rasterised in the console at the moment of cropping.
     */
    let stored: Uint8Array = bytes;
    let contentType = isPdf ? 'application/pdf' : 'image/jpeg';
    let width: number | null = null;
    let height: number | null = null;
    let pageCount: number | null = null;

    if (isPdf) {
      const info = await inspectPdf(bytes);
      pageCount = info.pageCount;
    } else {
      const normalized = await normalizeCapturePhoto(bytes);
      stored = normalized.bytes;
      contentType = normalized.contentType;
      width = normalized.width;
      height = normalized.height;
    }

    const { data: row, error } = await db
      .from('share_link_returns')
      .insert({
        link_id: share.linkId,
        folder_id: share.folderId,
        owner_id: user.id,
        document_id: documentId,
        filename: file.name || (isPdf ? 'scan.pdf' : 'scan.jpg'),
        storage_path: 'pending',
        content_type: contentType,
        byte_size: stored.byteLength,
        width,
        height,
        page_count: pageCount,
        latitude: location?.latitude ?? null,
        longitude: location?.longitude ?? null,
        location_accuracy: location?.accuracy ?? null,
        location_at: location ? new Date().toISOString() : null,
      })
      .select('*')
      .single<ReturnRow>();
    if (error || !row) throw badRequest(error?.message ?? 'Envoi impossible.', 'UPLOAD_FAILED');

    const path = returnPath(user.id, row.id, isPdf ? 'pdf' : 'jpg');
    await uploadObject(path, stored, contentType);
    await db.from('share_link_returns').update({ storage_path: path }).eq('id', row.id);

    saved.push(toReturn({ ...row, storage_path: path }));
  }

  await audit({
    ownerId: user.id,
    folderId: share.folderId,
    action: 'return.received',
    metadata: {
      linkId: share.linkId,
      count: saved.length,
      documentId,
      located: location !== null,
    },
  });

  // The console is usually not looking at this folder when it lands, so the
  // socket is what puts it in front of the operator.
  publish(user.id, { type: 'folder.updated', folderId: share.folderId, status: 'in_progress' });

  return c.json(
    { returned: saved.map((r) => ({ id: r.id, filename: r.filename })) },
    201,
  );
});

/**
 * The returns, from the operator's side.
 *
 * Listed with a short-lived signed URL so the console can render the scan
 * straight away — this is the thing the operator is about to crop marks out of,
 * and a second round trip per row to fetch each URL would show them a list of
 * grey rectangles.
 */
shareRoutes.get('/:id/returns', async (c) => {
  const user = c.get('user');
  const folder = await ownedFolder(c.req.param('id'), user.id);

  const { data, error } = await db
    .from('share_link_returns')
    .select('*')
    .eq('folder_id', folder.id)
    .order('created_at', { ascending: false })
    .returns<ReturnRow[]>();
  if (error) throw badRequest(`Documents reçus indisponibles : ${error.message}`);

  const items = await Promise.all(
    (data ?? []).map(async (row) => toReturn(row, await signedUrl(row.storage_path))),
  );
  return c.json({ items });
});

/**
 * Mark a return as dealt with.
 *
 * Separate from cropping so the operator can also dismiss one they are never
 * going to use — a duplicate, a blurred page the technician re-sent. Left
 * implicit, the list would grow forever and stop meaning "still to do".
 */
shareRoutes.post('/:id/returns/:returnId/handled', async (c) => {
  const user = c.get('user');
  const folder = await ownedFolder(c.req.param('id'), user.id);

  const { data } = await db
    .from('share_link_returns')
    .update({ handled_at: new Date().toISOString() })
    .eq('id', c.req.param('returnId'))
    .eq('folder_id', folder.id)
    .eq('owner_id', user.id)
    .select('*')
    .maybeSingle<ReturnRow>();
  if (!data) throw notFound('Document reçu introuvable.');

  return c.json(toReturn(data));
});

shareRoutes.delete('/:id/returns/:returnId', async (c) => {
  const user = c.get('user');
  const folder = await ownedFolder(c.req.param('id'), user.id);

  const { data } = await db
    .from('share_link_returns')
    .select('storage_path')
    .eq('id', c.req.param('returnId'))
    .eq('folder_id', folder.id)
    .eq('owner_id', user.id)
    .maybeSingle<{ storage_path: string }>();
  if (!data) throw notFound('Document reçu introuvable.');

  await db.from('share_link_returns').delete().eq('id', c.req.param('returnId'));
  // The object goes too: a scan of a signed page is the most sensitive thing
  // this system stores, and keeping orphans of it is not a neutral default.
  await removeObjects([data.storage_path]);

  await audit({
    ownerId: user.id,
    folderId: folder.id,
    action: 'return.deleted',
    metadata: { returnId: c.req.param('returnId') },
  });

  return c.json({ ok: true });
});

/**
 * The signer's page reporting its step — powers the console's presence dot.
 *
 * Fire-and-forget from the client and cheap here: one UPDATE of two columns on
 * the link row. No response body worth having, no failure worth surfacing.
 */
shareUploadRoutes.post('/activity', async (c) => {
  const share = c.get('share');
  if (!share) throw forbidden('Cette route est réservée aux liens de signature.');
  const parsed = linkActivitySchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw badRequest('Étape inconnue.');
  await recordLinkActivity(share.linkId, parsed.data.step);
  return c.json({ ok: true });
});
