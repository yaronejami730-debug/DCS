import {
  combinedCutoutPath,
  HANDWRITTEN_MARKS,
  mentionCutoutPath,
  signatureCutoutPath,
  stampCutoutPath,
  processedPdfPath,
  type ErrorCode,
  type ZoneType,
} from '@scansign/shared';
import { generateSignedPdf, PdfPipelineError, type PlacementZone } from '@scansign/pdf';
import { env } from '../env.js';
import { db } from '../lib/supabase.js';
import { downloadObject, removeObjects, uploadObject } from '../lib/storage.js';
import { audit } from '../lib/audit.js';
import { HttpError } from '../lib/errors.js';
import { cropNormalizedRegion, imageSize, trimTransparentBorder } from './images.js';
import { createExtractionProvider } from './extraction/index.js';
import { loadTemplateZones, zoneRowToRect } from './templates.js';
import { fallbackVariantIndex, variantAt } from './variants.js';
import { notifyFolderCompleted, notifyFolderFailed } from './notify.js';
import { publish } from '../lib/realtime.js';

interface SessionRow {
  id: string;
  folder_id: string;
  owner_id: string;
  device_id: string | null;
  capture_mode: 'single' | 'per_mark';
  photo_path: string | null;
  photo_width: number | null;
  photo_height: number | null;
  signature_photo_path: string | null;
  stamp_photo_path: string | null;
  mention_photo_path: string | null;
  signature_stamp_photo_path: string | null;
}

interface DocumentRow {
  id: string;
  filename: string;
  storage_path: string;
  template_id: string | null;
  status: string;
}

type Rect = { x: number; y: number; width: number; height: number };

export interface RegionSelection {
  signature?: Rect | null;
  stamp?: Rect | null;
  mention?: Rect | null;
  /** Signature and stamp framed together as one mark. */
  signature_stamp?: Rect | null;
  /**
   * Which variant of each handwritten mark the signer chose for each document.
   * Absent when they did not assign any, in which case each document still
   * gets its own variant derived from its id.
   */
  assignments?: Partial<Record<ZoneType, Record<string, number>>>;
}

const failSession = async (
  sessionId: string,
  folderId: string,
  ownerId: string,
  code: ErrorCode,
  message: string,
): Promise<void> => {
  await db
    .from('signing_sessions')
    .update({ status: 'error', error_code: code, error_message: message })
    .eq('id', sessionId);
  await db
    .from('folders')
    .update({ status: 'error', error_code: code, error_message: message })
    .eq('id', folderId);
  publish(ownerId, { type: 'folder.updated', folderId, status: 'error' });
  // Tell the signer what went wrong AND what to do about it — a failure they
  // only discover by reopening the app is a failure they cannot act on.
  await notifyFolderFailed(ownerId, folderId, code);
};

const asErrorCode = (error: unknown): { code: ErrorCode; message: string } => {
  if (error instanceof PdfPipelineError) return { code: error.code, message: error.message };
  if (error instanceof HttpError) {
    return { code: error.code as ErrorCode, message: error.message };
  }
  return { code: 'INTERNAL_ERROR', message: String(error) };
};

/**
 * The whole signing pipeline for one folder.
 *
 *   photo -> crop signature -> extract -> trim -> store
 *         -> crop stamp     -> extract -> trim -> store   (when needed)
 *         -> for each document: original PDF + template zones -> pdf-lib -> processed PDF
 *
 * Documents are processed independently: one broken template does not stop the
 * others, it just marks that document `error` with a code the console shows.
 */
export const processSigningSession = async (
  sessionId: string,
  regions: RegionSelection,
): Promise<void> => {
  const { data: session } = await db
    .from('signing_sessions')
    .select(
      'id, folder_id, owner_id, device_id, capture_mode, photo_path, photo_width, photo_height, signature_photo_path, stamp_photo_path, mention_photo_path, signature_stamp_photo_path',
    )
    .eq('id', sessionId)
    .maybeSingle<SessionRow>();

  if (!session) return;
  const { folder_id: folderId, owner_id: ownerId } = session;

  const perMark = session.capture_mode === 'per_mark';
  if (!perMark && (!session.photo_path || !session.photo_width || !session.photo_height)) {
    await failSession(sessionId, folderId, ownerId, 'IMAGE_PROCESSING_FAILED', 'Photo manquante.');
    return;
  }
  if (perMark && !session.signature_photo_path) {
    await failSession(sessionId, folderId, ownerId, 'IMAGE_PROCESSING_FAILED', 'Photo de signature manquante.');
    return;
  }

  await db.from('signing_sessions').update({ status: 'processing' }).eq('id', sessionId);
  await db
    .from('folders')
    .update({ status: 'processing', error_code: null, error_message: null })
    .eq('id', folderId);
  publish(ownerId, { type: 'folder.updated', folderId, status: 'processing' });

  const { data: documents } = await db
    .from('documents')
    .select('id, filename, storage_path, template_id, status')
    .eq('folder_id', folderId)
    .order('position', { ascending: true })
    .returns<DocumentRow[]>();

  const docs = documents ?? [];
  if (docs.length === 0) {
    await failSession(sessionId, folderId, ownerId, 'INTERNAL_ERROR', 'Ce dossier ne contient aucun document.');
    return;
  }

  // Work out what the templates actually require before touching the photo.
  const zonesByDocument = new Map<string, PlacementZone[]>();
  const needs: Record<ZoneType, boolean> = {
    signature: false,
    stamp: false,
    mention: false,
    signature_stamp: false,
  };
  for (const doc of docs) {
    if (!doc.template_id) continue;
    const rows = await loadTemplateZones(doc.template_id);
    const zones = rows.map<PlacementZone>((row) => ({
      page: row.page,
      type: row.type,
      rect: zoneRowToRect(row),
    }));
    zonesByDocument.set(doc.id, zones);
    for (const zone of zones) needs[zone.type] = true;
  }

  if (zonesByDocument.size === 0) {
    await failSession(
      sessionId,
      folderId,
      ownerId,
      'TEMPLATE_NOT_FOUND',
      'Aucun document de ce dossier ne possède de template configuré.',
    );
    return;
  }

  if (needs.signature && !regions.signature) {
    await failSession(
      sessionId,
      folderId,
      ownerId,
      'SIGNATURE_EXTRACTION_FAILED',
      'Ce dossier attend une signature mais aucune zone n’a été sélectionnée.',
    );
    return;
  }
  if (needs.signature_stamp && !regions.signature_stamp) {
    await failSession(
      sessionId,
      folderId,
      ownerId,
      'COMBINED_EXTRACTION_FAILED',
      'Ce dossier attend un tampon signé mais aucune zone n’a été sélectionnée.',
    );
    return;
  }
  if (needs.stamp && !regions.stamp) {
    await failSession(
      sessionId,
      folderId,
      ownerId,
      'STAMP_EXTRACTION_FAILED',
      'Ce dossier attend un tampon mais aucune zone de tampon n’a été sélectionnée.',
    );
    return;
  }
  if (needs.mention && !regions.mention) {
    await failSession(
      sessionId,
      folderId,
      ownerId,
      'MENTION_EXTRACTION_FAILED',
      'Ce dossier attend la mention « Lu et approuvé » mais aucune zone n’a été sélectionnée.',
    );
    return;
  }

  const provider = createExtractionProvider();
  const cutouts: Partial<Record<ZoneType, Uint8Array>> = {};

  /**
   * In single-photo mode every mark is framed on one sheet, so each region is
   * cropped from the shared photo. In per-mark mode the signer took a photo per
   * mark, and the region is relative to that mark's own photo.
   */
  const photoFor = async (
    mark: ZoneType,
  ): Promise<{ bytes: Uint8Array; width: number; height: number } | null> => {
    const path = perMark
      ? mark === 'signature'
        ? session.signature_photo_path
        : mark === 'stamp'
          ? session.stamp_photo_path
          : mark === 'mention'
            ? session.mention_photo_path
            : session.signature_stamp_photo_path
      : session.photo_path;
    if (!path) return null;
    const bytes = await downloadObject(path);
    if (!perMark) {
      return { bytes, width: session.photo_width!, height: session.photo_height! };
    }
    const size = await imageSize(bytes);
    return { bytes, ...size };
  };

  const FAILURE: Record<ZoneType, ErrorCode> = {
    signature: 'SIGNATURE_EXTRACTION_FAILED',
    stamp: 'STAMP_EXTRACTION_FAILED',
    mention: 'MENTION_EXTRACTION_FAILED',
    signature_stamp: 'COMBINED_EXTRACTION_FAILED',
  };

  try {
    const wanted: Array<[ZoneType, Rect | null | undefined]> = [
      ['signature', regions.signature],
      ['stamp', regions.stamp],
      ['mention', regions.mention],
      ['signature_stamp', regions.signature_stamp],
    ];

    for (const [mark, region] of wanted) {
      if (!region) continue;
      const photo = await photoFor(mark);
      if (!photo) {
        throw new HttpError(400, `Photo manquante pour ${mark}.`, FAILURE[mark]);
      }
      const crop = await cropNormalizedRegion(photo.bytes, region, photo.width, photo.height);
      // A combined mark is ink over a stamp; the stamp path handles coloured
      // ink better, which is what dominates that image.
      const extracted =
        mark === 'stamp' || mark === 'signature_stamp'
          ? await provider.extractStamp({ image: crop, contentType: 'image/png' })
          : await provider.extractSignature({ image: crop, contentType: 'image/png' });
      cutouts[mark] = (await trimTransparentBorder(extracted.png, FAILURE[mark])).bytes;
    }

    await audit({
      ownerId,
      folderId,
      action: 'extraction.completed',
      metadata: {
        provider: provider.name,
        captureMode: session.capture_mode,
        marks: Object.keys(cutouts),
      },
    });
  } catch (error) {
    const { code, message } = asErrorCode(error);
    await failSession(sessionId, folderId, ownerId, code, message);
    await audit({ ownerId, folderId, action: 'extraction.failed', metadata: { code, message } });
    return;
  }

  const signaturePng = cutouts.signature ?? null;
  const stampPng = cutouts.stamp ?? null;
  const mentionPng = cutouts.mention ?? null;
  const combinedPng = cutouts.signature_stamp ?? null;

  const signaturePath = signaturePng ? signatureCutoutPath(ownerId, sessionId) : null;
  const stampPath = stampPng ? stampCutoutPath(ownerId, sessionId) : null;
  const mentionPath = mentionPng ? mentionCutoutPath(ownerId, sessionId) : null;
  const combinedPath = combinedPng ? combinedCutoutPath(ownerId, sessionId) : null;

  if (signaturePng && signaturePath) await uploadObject(signaturePath, signaturePng, 'image/png');
  if (stampPng && stampPath) await uploadObject(stampPath, stampPng, 'image/png');
  if (mentionPng && mentionPath) await uploadObject(mentionPath, mentionPng, 'image/png');
  if (combinedPng && combinedPath) await uploadObject(combinedPath, combinedPng, 'image/png');

  await db
    .from('signing_sessions')
    .update({
      signature_image_path: signaturePath,
      stamp_image_path: stampPath,
      mention_image_path: mentionPath,
      signature_stamp_image_path: combinedPath,
    })
    .eq('id', sessionId);

  // --- per-document generation -------------------------------------------
  let succeeded = 0;
  let failed = 0;

  for (const doc of docs) {
    const zones = zonesByDocument.get(doc.id);
    if (!zones || zones.length === 0) {
      failed += 1;
      await db
        .from('documents')
        .update({
          status: 'awaiting_template',
          error_code: 'TEMPLATE_NOT_FOUND',
          error_message: 'Ce document nécessite une configuration de signature.',
        })
        .eq('id', doc.id);
      continue;
    }

    await db.from('documents').update({ status: 'processing' }).eq('id', doc.id);
    try {
      const original = await downloadObject(doc.storage_path);

      /**
       * Use the variant the signer picked for THIS document.
       *
       * The index is what was assigned on the phone, and a variant is derived
       * from its index alone — so the image stamped here is precisely the one
       * they looked at and approved. Where nothing was assigned, an index is
       * derived from the document id so documents in a folder still differ.
       *
       * A stamp is never varied: it is a physical die and reproduces
       * identically by design.
       */
      const varied = async (
        png: Uint8Array | null,
        mark: ZoneType,
      ): Promise<Uint8Array | null> => {
        if (!png) return null;
        if (!env.SIGNATURE_VARIANTS || !HANDWRITTEN_MARKS.includes(mark)) return png;
        const assigned = regions.assignments?.[mark]?.[doc.id];
        const index = assigned ?? fallbackVariantIndex(doc.id, Math.max(docs.length, 1));
        return variantAt(png, index);
      };

      const { bytes, placed } = await generateSignedPdf({
        pdfBytes: original,
        zones,
        signaturePng: await varied(signaturePng, 'signature'),
        stampPng,
        mentionPng: await varied(mentionPng, 'mention'),
        combinedPng: await varied(combinedPng, 'signature_stamp'),
      });

      const outPath = processedPdfPath(ownerId, doc.id);
      await uploadObject(outPath, bytes, 'application/pdf');

      await db
        .from('documents')
        .update({
          status: 'completed',
          final_pdf_path: outPath,
          error_code: null,
          error_message: null,
        })
        .eq('id', doc.id);

      succeeded += 1;
      publish(ownerId, {
        type: 'document.updated',
        documentId: doc.id,
        folderId,
        status: 'completed',
      });
      await audit({
        ownerId,
        folderId,
        documentId: doc.id,
        action: 'document.signed',
        metadata: { zones: placed, bytes: bytes.byteLength },
      });
    } catch (error) {
      failed += 1;
      const { code, message } = asErrorCode(error);
      await db
        .from('documents')
        .update({ status: 'error', error_code: code, error_message: message })
        .eq('id', doc.id);
      await audit({
        ownerId,
        folderId,
        documentId: doc.id,
        action: 'document.failed',
        metadata: { code, message },
      });
    }
  }

  const allGood = failed === 0 && succeeded > 0;
  const now = new Date().toISOString();

  await db
    .from('signing_sessions')
    .update({
      status: allGood ? 'completed' : 'error',
      completed_at: now,
      error_code: allGood ? null : 'PDF_GENERATION_FAILED',
      error_message: allGood ? null : `${failed} document(s) en échec.`,
    })
    .eq('id', sessionId);

  await db
    .from('folders')
    .update({
      status: allGood ? 'completed' : 'error',
      completed_at: allGood ? now : null,
      error_code: allGood ? null : 'PDF_GENERATION_FAILED',
      error_message: allGood ? null : `${failed} document(s) en échec.`,
    })
    .eq('id', folderId);

  // --- retention ----------------------------------------------------------
  if (allGood && env.RETENTION_DELETE_PHOTO_AFTER_SUCCESS) {
    const photos = [
      session.photo_path,
      session.signature_photo_path,
      session.stamp_photo_path,
      session.mention_photo_path,
      session.signature_stamp_photo_path,
    ].filter((p): p is string => Boolean(p));
    if (photos.length > 0) {
      await removeObjects(photos);
      await db
        .from('signing_sessions')
        .update({
          photo_path: null,
          signature_photo_path: null,
          stamp_photo_path: null,
          mention_photo_path: null,
          signature_stamp_photo_path: null,
        })
        .eq('id', sessionId);
    }
  }
  if (allGood && !env.RETENTION_KEEP_CUTOUTS) {
    await removeObjects(
      [signaturePath, stampPath, mentionPath, combinedPath].filter((p): p is string => Boolean(p)),
    );
    await db
      .from('signing_sessions')
      .update({
        signature_image_path: null,
        stamp_image_path: null,
        mention_image_path: null,
        signature_stamp_image_path: null,
      })
      .eq('id', sessionId);
  }

  const { data: folder } = await db
    .from('folders')
    .select('name, reference')
    .eq('id', folderId)
    .maybeSingle<{ name: string; reference: number }>();

  publish(ownerId, {
    type: 'folder.updated',
    folderId,
    status: allGood ? 'completed' : 'error',
  });
  publish(ownerId, {
    type: 'session.updated',
    sessionId,
    folderId,
    status: allGood ? 'completed' : 'error',
  });

  if (allGood) await notifyFolderCompleted(ownerId, folderId, succeeded);
  else await notifyFolderFailed(ownerId, folderId, 'PDF_GENERATION_FAILED');

  await audit({
    ownerId,
    folderId,
    action: allGood ? 'folder.completed' : 'folder.failed',
    metadata: { succeeded, failed },
  });
};
