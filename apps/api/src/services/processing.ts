import {
  combinedCutoutPath,
  HANDWRITTEN_MARKS,
  mentionCutoutPath,
  markCutoutPath,
  signatureCutoutPath,
  stampCutoutPath,
  processedPdfPath,
  type ErrorCode,
  type ZoneType,
  ZONE_TYPE,
  ZONE_TYPE_LABEL,
} from '@scansign/shared';
import { generateSignedPdf, PdfPipelineError, type PlacementZone } from '@scansign/pdf';
import { env } from '../env.js';
import { db } from '../lib/supabase.js';
import { downloadObject, removeObjects, uploadObject } from '../lib/storage.js';
import { audit } from '../lib/audit.js';
import { HttpError } from '../lib/errors.js';
import { cropNormalizedRegion, imageSize, trimTransparentBorder } from './images.js';
import { createExtractionProvider } from './extraction/index.js';
import { zonesForDocument } from './placement.js';
import { fallbackVariantIndex, variantAt, variantPlacement } from './variants.js';
import { notifyFolderCompleted, notifyFolderFailed } from './notify.js';
import { publish } from '../lib/realtime.js';

interface SessionRow {
  id: string;
  folder_id: string;
  owner_id: string;
  /** Null when the console started the session; set when a link did. */
  share_link_id: string | null;
  capture_mode: 'single' | 'per_mark';
  photo_path: string | null;
  photo_width: number | null;
  photo_height: number | null;
  signature_photo_path: string | null;
  stamp_photo_path: string | null;
  mention_photo_path: string | null;
  signature_stamp_photo_path: string | null;
  date_photo_path?: string | null;
  quote_date_photo_path?: string | null;
  free_text_photo_path?: string | null;
  checkbox_photo_path?: string | null;
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
  /** Extended handwritten marks — same pipeline as mention. */
  date?: Rect | null;
  quote_date?: Rect | null;
  free_text?: Rect | null;
  checkbox?: Rect | null;
  /**
   * Which variant of each handwritten mark the signer chose for each document.
   * Absent when they did not assign any, in which case each document still
   * gets its own variant derived from its id.
   */
  assignments?: Partial<Record<ZoneType, Record<string, number>>>;
  /**
   * Stamp only these documents. The console's crop-a-return flow aims each
   * submission at one contract; empty or absent keeps the historical
   * behaviour — every document the session can reach.
   */
  onlyDocumentIds?: string[];
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
      'id, folder_id, owner_id, share_link_id, capture_mode, photo_path, photo_width, photo_height, signature_photo_path, stamp_photo_path, mention_photo_path, signature_stamp_photo_path, date_photo_path, quote_date_photo_path, free_text_photo_path, checkbox_photo_path',
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
  /**
   * In per-mark capture, require that *some* mark was photographed.
   *
   * This used to demand `signature_photo_path` specifically, which failed a
   * folder that never asks for a bare signature. A template calling for a
   * signed stamp and a "Lu et approuvé" is captured as `signature_stamp` +
   * `mention`, and there is no separate signature photo to find — so the
   * signer did exactly what was asked and the pipeline rejected it with
   * "Photo de signature manquante", every time, on every retry.
   *
   * Which marks are actually required is known further down, once the
   * templates have been read; the check that each required mark has its photo
   * happens there, against the real requirement rather than a guess.
   */
  const capturedMarks = [
    session.signature_photo_path,
    session.stamp_photo_path,
    session.mention_photo_path,
    session.signature_stamp_photo_path,
    session.date_photo_path,
    session.quote_date_photo_path,
    session.free_text_photo_path,
    session.checkbox_photo_path,
  ].filter(Boolean);
  if (perMark && capturedMarks.length === 0) {
    await failSession(
      sessionId,
      folderId,
      ownerId,
      'IMAGE_PROCESSING_FAILED',
      'Aucune photo de marque n’a été reçue pour cette session.',
    );
    return;
  }

  await db.from('signing_sessions').update({ status: 'processing' }).eq('id', sessionId);
  await db
    .from('folders')
    .update({ status: 'processing', error_code: null, error_message: null })
    .eq('id', folderId);
  publish(ownerId, { type: 'folder.updated', folderId, status: 'processing' });

  /**
   * The documents this signature is for.
   *
   * A session opened through a share link is bound to whatever subset that link
   * covers, so a technician signing the delivery notes cannot have their
   * signature land on the contract next to them. An empty subset — or no link
   * at all, meaning the console — is the whole folder.
   *
   * Filtered here rather than in the query so that "the link named documents
   * that have since been deleted" is caught below as an empty selection, with a
   * message, instead of silently signing everything.
   */
  const scopedIds = session.share_link_id
    ? new Set(
        (
          (
            await db
              .from('folder_share_link_documents')
              .select('document_id')
              .eq('link_id', session.share_link_id)
              .returns<Array<{ document_id: string }>>()
          ).data ?? []
        ).map((r) => r.document_id),
      )
    : null;

  /**
   * Contracts only.
   *
   * `for_signing` rows are the sheet the technician printed and signed — the
   * source of the ink. Stamping a signature back onto the page it was cut out
   * of is not a coherent operation, and it would also count that sheet towards
   * the folder being finished.
   */
  const { data: documents } = await db
    .from('documents')
    .select('id, filename, storage_path, template_id, status')
    .eq('folder_id', folderId)
    .eq('role', 'to_sign')
    .order('position', { ascending: true })
    .returns<DocumentRow[]>();

  const all = documents ?? [];
  let docs = scopedIds && scopedIds.size > 0 ? all.filter((d) => scopedIds.has(d.id)) : all;
  if (regions.onlyDocumentIds && regions.onlyDocumentIds.length > 0) {
    const chosen = new Set(regions.onlyDocumentIds);
    docs = docs.filter((d) => chosen.has(d.id));
  }

  if (docs.length === 0) {
    await failSession(
      sessionId,
      folderId,
      ownerId,
      'INTERNAL_ERROR',
      all.length === 0
        ? 'Ce dossier ne contient aucun document.'
        : 'Les documents de ce lien de signature n’existent plus.',
    );
    return;
  }

  // Work out what the templates actually require before touching the photo.
  const zonesByDocument = new Map<string, PlacementZone[]>();
  // Seeded from the list itself, so a type added later cannot be missed here.
  const needs: Record<ZoneType, boolean> = Object.fromEntries(
    ZONE_TYPE.map((t) => [t, false]),
  ) as Record<ZoneType, boolean>;
  for (const doc of docs) {
    // A document an operator has repositioned keeps its own geometry when the
    // folder is signed again. Falling back to the template here would silently
    // undo that adjustment on the next signature, which is the behaviour the
    // per-document override exists to prevent.
    const { zones: placement } = await zonesForDocument(doc);
    if (placement.length === 0) continue;

    const zones = placement.map<PlacementZone>((zone) => ({
      page: zone.page,
      type: zone.type,
      rect: zone.rect,
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
  for (const extra of ['date', 'quote_date', 'free_text', 'checkbox'] as const) {
    if (needs[extra] && !regions[extra]) {
      await failSession(
        sessionId,
        folderId,
        ownerId,
        'MARK_EXTRACTION_FAILED',
        `Ce dossier attend « ${ZONE_TYPE_LABEL[extra]} » mais aucune zone n’a été sélectionnée.`,
      );
      return;
    }
  }

  const provider = createExtractionProvider();
  const cutouts: Partial<Record<ZoneType, Uint8Array>> = {};
  const enginesUsed = new Set<string>();
  let fellBack = false;
  let credits = 0;

  /**
   * In single-photo mode every mark is framed on one sheet, so each region is
   * cropped from the shared photo. In per-mark mode the signer took a photo per
   * mark, and the region is relative to that mark's own photo.
   */
  const photoFor = async (
    mark: ZoneType,
  ): Promise<{ bytes: Uint8Array; width: number; height: number } | null> => {
    const perMarkPath: Record<ZoneType, string | null | undefined> = {
      signature: session.signature_photo_path,
      stamp: session.stamp_photo_path,
      mention: session.mention_photo_path,
      signature_stamp: session.signature_stamp_photo_path,
      date: session.date_photo_path,
      quote_date: session.quote_date_photo_path,
      free_text: session.free_text_photo_path,
      checkbox: session.checkbox_photo_path,
    };
    const path = perMark ? perMarkPath[mark] : session.photo_path;
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
    date: 'MARK_EXTRACTION_FAILED',
    quote_date: 'MARK_EXTRACTION_FAILED',
    free_text: 'MARK_EXTRACTION_FAILED',
    checkbox: 'MARK_EXTRACTION_FAILED',
  };

  try {
    const wanted: Array<[ZoneType, Rect | null | undefined]> = [
      ['signature', regions.signature],
      ['stamp', regions.stamp],
      ['mention', regions.mention],
      ['signature_stamp', regions.signature_stamp],
      ['date', regions.date],
      ['quote_date', regions.quote_date],
      ['free_text', regions.free_text],
      ['checkbox', regions.checkbox],
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

      // Which engine actually produced each mark, and what it cost. With a
      // metered API in the pipeline this is the only record of the spend, and
      // of the runs that quietly used the other engine instead.
      enginesUsed.add(String(extracted.meta?.engine ?? provider.name));
      if (extracted.meta?.fellBack === true) fellBack = true;
      const charged = Number(extracted.meta?.creditsCharged ?? 0);
      if (Number.isFinite(charged)) credits += charged;
    }

    await audit({
      ownerId,
      folderId,
      action: 'extraction.completed',
      metadata: {
        provider: provider.name,
        engines: [...enginesUsed],
        fellBack,
        credits,
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
  const datePng = cutouts.date ?? null;
  const quoteDatePng = cutouts.quote_date ?? null;
  const freeTextPng = cutouts.free_text ?? null;
  const checkboxPng = cutouts.checkbox ?? null;

  const signaturePath = signaturePng ? signatureCutoutPath(ownerId, sessionId) : null;
  const stampPath = stampPng ? stampCutoutPath(ownerId, sessionId) : null;
  const mentionPath = mentionPng ? mentionCutoutPath(ownerId, sessionId) : null;
  const combinedPath = combinedPng ? combinedCutoutPath(ownerId, sessionId) : null;
  const datePath = datePng ? markCutoutPath(ownerId, sessionId, 'date') : null;
  const quoteDatePath = quoteDatePng ? markCutoutPath(ownerId, sessionId, 'quote_date') : null;
  const freeTextPath = freeTextPng ? markCutoutPath(ownerId, sessionId, 'free_text') : null;
  const checkboxPath = checkboxPng ? markCutoutPath(ownerId, sessionId, 'checkbox') : null;

  if (signaturePng && signaturePath) await uploadObject(signaturePath, signaturePng, 'image/png');
  if (stampPng && stampPath) await uploadObject(stampPath, stampPng, 'image/png');
  if (mentionPng && mentionPath) await uploadObject(mentionPath, mentionPng, 'image/png');
  if (combinedPng && combinedPath) await uploadObject(combinedPath, combinedPng, 'image/png');
  if (datePng && datePath) await uploadObject(datePath, datePng, 'image/png');
  if (quoteDatePng && quoteDatePath) await uploadObject(quoteDatePath, quoteDatePng, 'image/png');
  if (freeTextPng && freeTextPath) await uploadObject(freeTextPath, freeTextPng, 'image/png');
  if (checkboxPng && checkboxPath) await uploadObject(checkboxPath, checkboxPng, 'image/png');

  await db
    .from('signing_sessions')
    .update({
      signature_image_path: signaturePath,
      stamp_image_path: stampPath,
      mention_image_path: mentionPath,
      signature_stamp_image_path: combinedPath,
      date_image_path: datePath,
      quote_date_image_path: quoteDatePath,
      free_text_image_path: freeTextPath,
      checkbox_image_path: checkboxPath,
    })
    .eq('id', sessionId);

  // --- per-document generation -------------------------------------------
  let succeeded = 0;
  let failed = 0;
  /**
   * Documents this folder holds that no template describes yet.
   *
   * Not a failure of this signing run: nothing was attempted for them and
   * nothing went wrong. Counting them as failures marked the whole folder
   * `error` even when every configured document was signed, and since an
   * unconfigured document never configures itself, every retry reproduced the
   * same error — leaving the folder permanently stuck.
   */
  let skipped = 0;

  for (const [ordinal, doc] of docs.entries()) {
    const zones = zonesByDocument.get(doc.id);
    if (!zones || zones.length === 0) {
      skipped += 1;
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
       * The index is what the console assigned, and a variant is derived
       * from its index alone — so the image stamped here is precisely the one
       * they looked at and approved. Where nothing was assigned, an index is
       * derived from the document id so documents in a folder still differ.
       *
       * A stamp is never varied: it is a physical die and reproduces
       * identically by design.
       */
      /**
       * Remember which variant was used, not just apply it.
       *
       * The index is recorded on the document so the mark can be regenerated
       * later — moved or resized from the console — and come back as the same
       * signature. Deriving it again at that point would work only until the
       * folder's document count changed, and would silently redraw the mark
       * rather than move it.
       */
      let variantIndex: number | null = null;
      const varied = async (
        png: Uint8Array | null,
        mark: ZoneType,
      ): Promise<Uint8Array | null> => {
        if (!png) return null;
        if (!env.SIGNATURE_VARIANTS || !HANDWRITTEN_MARKS.includes(mark)) return png;
        const assigned = regions.assignments?.[mark]?.[doc.id];
        // The document's own place in the folder, so no two documents in one
        // signing can land on the same variant.
        const index = assigned ?? fallbackVariantIndex(ordinal);
        variantIndex = index;
        return variantAt(png, index);
      };

      const { bytes, placed } = await generateSignedPdf({
        pdfBytes: original,
        zones,
        signaturePng: await varied(signaturePng, 'signature'),
        stampPng,
        mentionPng: await varied(mentionPng, 'mention'),
        combinedPng: await varied(combinedPng, 'signature_stamp'),
        datePng: await varied(datePng, 'date'),
        quoteDatePng: await varied(quoteDatePng, 'quote_date'),
        freeTextPng: await varied(freeTextPng, 'free_text'),
        checkboxPng: await varied(checkboxPng, 'checkbox'),
              fit: { fill: env.MARK_FILL, maxHeightOverflow: env.MARK_MAX_OVERFLOW },
        // Size, position and tilt for THIS signing. Applied at placement, where
        // nothing normalises it away — see variantPlacement.
        variation:
          env.SIGNATURE_VARIANTS && variantIndex !== null
            ? variantPlacement(variantIndex, env.SIGNATURE_VARIATION_STRENGTH)
            : undefined,
      });

      const outPath = processedPdfPath(ownerId, doc.id);
      await uploadObject(outPath, bytes, 'application/pdf');

      /**
       * Mark the document signed. This update is the one that must not fail:
       * the PDF is already in storage, and a document left at `processing`
       * with no final_pdf_path is invisible in the console —
       * signed, but with no way to reach it.
       *
       * supabase-js reports failures in the result rather than throwing, so an
       * ignored `error` here is silent. It happened: adding two columns to
       * this update before their migration had run made every document in a
       * folder stall exactly that way, while the folder reported success.
       */
      const { error: completionError } = await db
        .from('documents')
        .update({
          status: 'completed',
          final_pdf_path: outPath,
          error_code: null,
          error_message: null,
        })
        .eq('id', doc.id);
      if (completionError) {
        throw new HttpError(
          500,
          `Le PDF signé a été produit mais le document n'a pas pu être mis à jour : ${completionError.message}`,
          'INTERNAL_ERROR',
        );
      }

      /**
       * Then the provenance a later repositioning needs: whose cutouts, and
       * which variant. Deliberately a second statement, and deliberately
       * tolerant — this is a nicety, and it must never be able to strand a
       * document that is otherwise correctly signed. Missing columns simply
       * mean the console will not offer to reposition this document yet.
       */
      const { error: provenanceError } = await db
        .from('documents')
        .update({ signing_session_id: sessionId, variant_index: variantIndex })
        .eq('id', doc.id);
      if (provenanceError) {
        console.warn(
          '[processing] document %s signed, but provenance not recorded: %s',
          doc.id,
          provenanceError.message,
        );
      }

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

  /** Nothing broke: every document that had a template was signed. */
  const cleanRun = failed === 0 && succeeded > 0;
  /** …and there is nothing left for the operator to configure either. */
  const allGood = cleanRun && skipped === 0;
  const now = new Date().toISOString();

  const pending =
    skipped === 1
      ? '1 document reste à configurer.'
      : `${skipped} documents restent à configurer.`;

  // The session is the signer's run. It succeeded whenever nothing broke —
  // documents awaiting configuration are the operator's job, not theirs, and
  // reporting a failure they cannot act on is what stranded them.
  await db
    .from('signing_sessions')
    .update({
      status: cleanRun ? 'completed' : 'error',
      completed_at: now,
      error_code: cleanRun ? null : 'PDF_GENERATION_FAILED',
      error_message: cleanRun ? null : `${failed} document(s) en échec.`,
    })
    .eq('id', sessionId);

  // The folder is only `completed` once every document has a final PDF. With
  // documents still to configure it goes back to `in_progress` — work left to
  // do, but no error, so the folder can be signed again once they are set up.
  await db
    .from('folders')
    .update({
      status: allGood ? 'completed' : cleanRun ? 'in_progress' : 'error',
      completed_at: allGood ? now : null,
      error_code: cleanRun ? null : 'PDF_GENERATION_FAILED',
      error_message: allGood ? null : cleanRun ? pending : `${failed} document(s) en échec.`,
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
      session.date_photo_path,
      session.quote_date_photo_path,
      session.free_text_photo_path,
      session.checkbox_photo_path,
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
          date_photo_path: null,
          quote_date_photo_path: null,
          free_text_photo_path: null,
          checkbox_photo_path: null,
        })
        .eq('id', sessionId);
    }
  }
  if (allGood && !env.RETENTION_KEEP_CUTOUTS) {
    await removeObjects(
      [
        signaturePath,
        stampPath,
        mentionPath,
        combinedPath,
        datePath,
        quoteDatePath,
        freeTextPath,
        checkboxPath,
      ].filter((p): p is string => Boolean(p)),
    );
    await db
      .from('signing_sessions')
      .update({
        signature_image_path: null,
        stamp_image_path: null,
        mention_image_path: null,
        signature_stamp_image_path: null,
        date_image_path: null,
        quote_date_image_path: null,
        free_text_image_path: null,
        checkbox_image_path: null,
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
    status: allGood ? 'completed' : cleanRun ? 'in_progress' : 'error',
  });
  publish(ownerId, {
    type: 'session.updated',
    sessionId,
    folderId,
    status: cleanRun ? 'completed' : 'error',
  });

  if (cleanRun) await notifyFolderCompleted(ownerId, folderId, succeeded);
  else await notifyFolderFailed(ownerId, folderId, 'PDF_GENERATION_FAILED');

  await audit({
    ownerId,
    folderId,
    action: cleanRun ? 'folder.completed' : 'folder.failed',
    metadata: { succeeded, failed, skipped },
  });
};
