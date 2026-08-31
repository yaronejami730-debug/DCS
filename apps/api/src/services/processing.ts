import {
  signatureCutoutPath,
  stampCutoutPath,
  processedPdfPath,
  type ErrorCode,
} from '@scansign/shared';
import { generateSignedPdf, PdfPipelineError, type PlacementZone } from '@scansign/pdf';
import { env } from '../env.js';
import { db } from '../lib/supabase.js';
import { downloadObject, removeObjects, uploadObject } from '../lib/storage.js';
import { audit } from '../lib/audit.js';
import { HttpError } from '../lib/errors.js';
import { cropNormalizedRegion, trimTransparentBorder } from './images.js';
import { createExtractionProvider } from './extraction/index.js';
import { loadTemplateZones, zoneRowToRect } from './templates.js';
import { sendPush } from './push.js';

interface SessionRow {
  id: string;
  folder_id: string;
  owner_id: string;
  device_id: string | null;
  photo_path: string | null;
  photo_width: number | null;
  photo_height: number | null;
}

interface DocumentRow {
  id: string;
  filename: string;
  storage_path: string;
  template_id: string | null;
  status: string;
}

export interface RegionSelection {
  signature: { x: number; y: number; width: number; height: number };
  stamp?: { x: number; y: number; width: number; height: number } | null;
}

const failSession = async (
  sessionId: string,
  folderId: string,
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
    .select('id, folder_id, owner_id, device_id, photo_path, photo_width, photo_height')
    .eq('id', sessionId)
    .maybeSingle<SessionRow>();

  if (!session) return;
  const { folder_id: folderId, owner_id: ownerId } = session;

  if (!session.photo_path || !session.photo_width || !session.photo_height) {
    await failSession(sessionId, folderId, 'IMAGE_PROCESSING_FAILED', 'Photo manquante.');
    return;
  }

  await db.from('signing_sessions').update({ status: 'processing' }).eq('id', sessionId);
  await db
    .from('folders')
    .update({ status: 'processing', error_code: null, error_message: null })
    .eq('id', folderId);

  const { data: documents } = await db
    .from('documents')
    .select('id, filename, storage_path, template_id, status')
    .eq('folder_id', folderId)
    .order('position', { ascending: true })
    .returns<DocumentRow[]>();

  const docs = documents ?? [];
  if (docs.length === 0) {
    await failSession(sessionId, folderId, 'INTERNAL_ERROR', 'Ce dossier ne contient aucun document.');
    return;
  }

  // Work out what the templates actually require before touching the photo.
  const zonesByDocument = new Map<string, PlacementZone[]>();
  let needsStamp = false;
  for (const doc of docs) {
    if (!doc.template_id) continue;
    const rows = await loadTemplateZones(doc.template_id);
    const zones = rows.map<PlacementZone>((row) => ({
      page: row.page,
      type: row.type,
      rect: zoneRowToRect(row),
    }));
    zonesByDocument.set(doc.id, zones);
    if (zones.some((z) => z.type === 'stamp')) needsStamp = true;
  }

  if (zonesByDocument.size === 0) {
    await failSession(
      sessionId,
      folderId,
      'TEMPLATE_NOT_FOUND',
      'Aucun document de ce dossier ne possède de template configuré.',
    );
    return;
  }

  if (needsStamp && !regions.stamp) {
    await failSession(
      sessionId,
      folderId,
      'STAMP_EXTRACTION_FAILED',
      'Ce dossier attend un tampon mais aucune zone de tampon n’a été sélectionnée.',
    );
    return;
  }

  const provider = createExtractionProvider();
  let signaturePng: Uint8Array;
  let stampPng: Uint8Array | null = null;

  try {
    const photo = await downloadObject(session.photo_path);

    const signatureCrop = await cropNormalizedRegion(
      photo,
      regions.signature,
      session.photo_width,
      session.photo_height,
    );
    const signatureResult = await provider.extractSignature({
      image: signatureCrop,
      contentType: 'image/png',
    });
    signaturePng = (
      await trimTransparentBorder(signatureResult.png, 'SIGNATURE_EXTRACTION_FAILED')
    ).bytes;

    if (regions.stamp) {
      const stampCrop = await cropNormalizedRegion(
        photo,
        regions.stamp,
        session.photo_width,
        session.photo_height,
      );
      const stampResult = await provider.extractStamp({
        image: stampCrop,
        contentType: 'image/png',
      });
      stampPng = (await trimTransparentBorder(stampResult.png, 'STAMP_EXTRACTION_FAILED')).bytes;
    }

    await audit({
      ownerId,
      folderId,
      action: 'extraction.completed',
      metadata: {
        provider: provider.name,
        signature: signatureResult.meta ?? {},
        stamp: regions.stamp ? 'extracted' : 'not requested',
      },
    });
  } catch (error) {
    const { code, message } = asErrorCode(error);
    await failSession(sessionId, folderId, code, message);
    await audit({ ownerId, folderId, action: 'extraction.failed', metadata: { code, message } });
    return;
  }

  const signaturePath = signatureCutoutPath(ownerId, sessionId);
  const stampPath = stampPng ? stampCutoutPath(ownerId, sessionId) : null;
  await uploadObject(signaturePath, signaturePng, 'image/png');
  if (stampPng && stampPath) await uploadObject(stampPath, stampPng, 'image/png');

  await db
    .from('signing_sessions')
    .update({ signature_image_path: signaturePath, stamp_image_path: stampPath })
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
      const { bytes, placed } = await generateSignedPdf({
        pdfBytes: original,
        zones,
        signaturePng,
        stampPng,
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
  if (allGood && env.RETENTION_DELETE_PHOTO_AFTER_SUCCESS && session.photo_path) {
    await removeObjects([session.photo_path]);
    await db.from('signing_sessions').update({ photo_path: null }).eq('id', sessionId);
  }
  if (allGood && !env.RETENTION_KEEP_CUTOUTS) {
    await removeObjects([signaturePath, stampPath].filter((p): p is string => Boolean(p)));
    await db
      .from('signing_sessions')
      .update({ signature_image_path: null, stamp_image_path: null })
      .eq('id', sessionId);
  }

  const { data: folder } = await db
    .from('folders')
    .select('name, reference')
    .eq('id', folderId)
    .maybeSingle<{ name: string; reference: number }>();

  await sendPush({
    ownerId,
    deviceId: session.device_id,
    folderId,
    title: allGood ? 'Document terminé' : 'Erreur de traitement',
    body: allGood
      ? `${folder?.name ?? 'Le dossier'} est signé.`
      : `${folder?.name ?? 'Le dossier'} n’a pas pu être traité.`,
    data: { kind: 'folder.processed' },
  });

  await audit({
    ownerId,
    folderId,
    action: allGood ? 'folder.completed' : 'folder.failed',
    metadata: { succeeded, failed },
  });
};
