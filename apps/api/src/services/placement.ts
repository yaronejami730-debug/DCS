import {
  HANDWRITTEN_MARKS,
  processedPdfPath,
  type NormalizedRect,
  type ZoneType,
} from '@scansign/shared';
import { generateSignedPdf, type PlacementZone } from '@scansign/pdf';
import { env } from '../env.js';
import { db } from '../lib/supabase.js';
import { HttpError, notFound } from '../lib/errors.js';
import { downloadObject, uploadObject } from '../lib/storage.js';
import { audit } from '../lib/audit.js';
import { publish } from '../lib/realtime.js';
import { loadTemplateZones, zoneRowToRect } from './templates.js';
import { variantAt, variantPlacement } from './variants.js';

/**
 * Move or resize the marks on ONE already-signed document.
 *
 * A signature that lands on top of a printed line, or comes out smaller than
 * the box it was meant for, is not a reason to re-sign a folder — but until now
 * it was the only remedy, because placement lived solely on the template and
 * editing that moved the mark on every document the template describes.
 *
 * The rule this follows: **never rewrite a signed PDF in place.** Adjusting
 * regenerates it from the original document plus the stored cutouts, through
 * the same generator that produced it the first time. So the output is a
 * function of (original, zones, cutout, variant) and nothing else — it can be
 * reproduced, and an adjustment that goes wrong is undone by adjusting back
 * rather than by hoping the previous bytes survived somewhere.
 */

export interface DocumentZone {
  page: number;
  type: ZoneType;
  rect: NormalizedRect;
  index: number;
}

interface DocumentRow {
  id: string;
  owner_id: string;
  folder_id: string;
  filename: string;
  storage_path: string;
  final_pdf_path: string | null;
  template_id: string | null;
  signing_session_id: string | null;
  variant_index: number | null;
  status: string;
}

interface SessionCutouts {
  signature_image_path: string | null;
  stamp_image_path: string | null;
  mention_image_path: string | null;
  signature_stamp_image_path: string | null;
  date_image_path?: string | null;
  quote_date_image_path?: string | null;
  free_text_image_path?: string | null;
  checkbox_image_path?: string | null;
}

/**
 * The zones in force for a document: its own overrides if it has any, the
 * template's otherwise.
 *
 * All or nothing per document, deliberately. Merging per zone would mean an
 * operator who nudged the signature silently inherits later template edits to
 * the stamp beside it — placement that changes for reasons nobody asked for.
 */
export const zonesForDocument = async (doc: {
  id: string;
  template_id: string | null;
}): Promise<{ zones: DocumentZone[]; source: 'document' | 'template' }> => {
  const { data: overrides } = await db
    .from('document_zones')
    .select('page, type, x, y, width, height, zone_index')
    .eq('document_id', doc.id)
    .order('page', { ascending: true })
    .order('zone_index', { ascending: true })
    .returns<
      Array<{
        page: number;
        type: ZoneType;
        x: number;
        y: number;
        width: number;
        height: number;
        zone_index: number;
      }>
    >();

  if (overrides && overrides.length > 0) {
    return {
      source: 'document',
      zones: overrides.map((row) => ({
        page: row.page,
        type: row.type,
        rect: { x: row.x, y: row.y, width: row.width, height: row.height },
        index: row.zone_index,
      })),
    };
  }

  if (!doc.template_id) return { zones: [], source: 'template' };

  const rows = await loadTemplateZones(doc.template_id);
  return {
    source: 'template',
    zones: rows.map((row) => ({
      page: row.page,
      type: row.type,
      rect: zoneRowToRect(row),
      index: row.zone_index,
    })),
  };
};

/** Load a document the caller owns, or fail with a 404 rather than a leak. */
const loadDocument = async (documentId: string, ownerId: string): Promise<DocumentRow> => {
  const { data } = await db
    .from('documents')
    .select(
      'id, owner_id, folder_id, filename, storage_path, final_pdf_path, template_id, signing_session_id, variant_index, status',
    )
    .eq('id', documentId)
    .eq('owner_id', ownerId)
    .maybeSingle<DocumentRow>();
  if (!data) throw notFound('Document introuvable.');
  return data;
};

/**
 * Fetch the cutouts that were stamped on this document.
 *
 * Returns null when they are gone — RETENTION_KEEP_CUTOUTS=false wipes them
 * after a successful run, and a document signed under that setting simply
 * cannot be regenerated. Saying so plainly is the point: silently re-extracting
 * from the photo, or substituting another session's signature, would put a mark
 * on a contract that the signer never approved.
 */
const loadCutouts = async (
  sessionId: string,
): Promise<Partial<Record<ZoneType, Uint8Array>> | null> => {
  const { data: session } = await db
    .from('signing_sessions')
    .select(
      'signature_image_path, stamp_image_path, mention_image_path, signature_stamp_image_path, date_image_path, quote_date_image_path, free_text_image_path, checkbox_image_path',
    )
    .eq('id', sessionId)
    .maybeSingle<SessionCutouts>();
  if (!session) return null;

  const paths: Array<[ZoneType, string | null]> = [
    ['signature', session.signature_image_path],
    ['stamp', session.stamp_image_path],
    ['mention', session.mention_image_path],
    ['signature_stamp', session.signature_stamp_image_path],
    ['date', session.date_image_path ?? null],
    ['quote_date', session.quote_date_image_path ?? null],
    ['free_text', session.free_text_image_path ?? null],
    ['checkbox', session.checkbox_image_path ?? null],
  ];

  const cutouts: Partial<Record<ZoneType, Uint8Array>> = {};
  for (const [mark, path] of paths) {
    if (!path) continue;
    try {
      cutouts[mark] = await downloadObject(path);
    } catch {
      // A path recorded but no object behind it: treat as gone rather than
      // generating a document with a mark missing from it.
      return null;
    }
  }

  return Object.keys(cutouts).length > 0 ? cutouts : null;
};

/** Why a document cannot be adjusted, in words the console can show as-is. */
export const adjustmentBlocker = (doc: {
  status: string;
  final_pdf_path: string | null;
  signing_session_id: string | null;
}): string | null => {
  if (doc.status !== 'completed' || !doc.final_pdf_path) {
    return 'Ce document n’est pas encore signé.';
  }
  if (!doc.signing_session_id) {
    return 'La signature de ce document est antérieure au suivi des sessions : elle ne peut pas être repositionnée.';
  }
  return null;
};

export interface AdjustResult {
  documentId: string;
  finalPdfPath: string;
  placed: number;
  bytes: number;
}

/**
 * Re-stamp a signed document with new zone geometry.
 *
 * The signature itself is untouched: the same cutout, at the same variant
 * index, from the same session. Only where it sits and how big it is change —
 * which is exactly what "modifier" should mean to an operator looking at a
 * signature that landed badly.
 */
export const adjustDocumentPlacement = async (params: {
  documentId: string;
  ownerId: string;
  zones: DocumentZone[];
  /**
   * Store these zones as the document's own. False when regenerating from the
   * template — see resetDocumentPlacement, where writing them back would leave
   * the document pinned to today's template forever.
   */
  persist?: boolean;
}): Promise<AdjustResult> => {
  const { documentId, ownerId, zones, persist = true } = params;
  const doc = await loadDocument(documentId, ownerId);

  const blocker = adjustmentBlocker(doc);
  if (blocker) throw new HttpError(409, blocker, 'BAD_REQUEST');

  if (zones.length === 0) {
    throw new HttpError(400, 'Au moins une zone est nécessaire.', 'BAD_REQUEST');
  }

  const cutouts = await loadCutouts(doc.signing_session_id!);
  if (!cutouts) {
    throw new HttpError(
      409,
      'Les images de signature de cette session ont été supprimées (rétention). Ce document ne peut plus être repositionné.',
      'BAD_REQUEST',
    );
  }

  // Every zone asked for must have ink to put in it, or the "adjusted"
  // document would come back with a mark quietly missing.
  const missing = [...new Set(zones.map((z) => z.type))].filter((type) => !cutouts[type]);
  if (missing.length > 0) {
    throw new HttpError(
      409,
      `Aucune image disponible pour : ${missing.join(', ')}. Cette session n’a pas capturé cette marque.`,
      'BAD_REQUEST',
    );
  }

  const original = await downloadObject(doc.storage_path);

  /**
   * Reproduce the variant that was stamped, rather than deriving a new one.
   *
   * `variant_index` is what the signer's own choice resolved to at signing
   * time. Recomputing it here would depend on how many documents the folder
   * holds *now*, so adding a document to a folder would change the signature on
   * a document already signed — moving a mark must never redraw it.
   */
  const varied = async (mark: ZoneType): Promise<Uint8Array | null> => {
    const png = cutouts[mark];
    if (!png) return null;
    if (
      !env.SIGNATURE_VARIANTS ||
      !HANDWRITTEN_MARKS.includes(mark) ||
      doc.variant_index === null
    ) {
      return png;
    }
    return variantAt(png, doc.variant_index);
  };

  const { bytes, placed } = await generateSignedPdf({
    pdfBytes: original,
    zones: zones.map<PlacementZone>((zone) => ({
      page: zone.page,
      type: zone.type,
      rect: zone.rect,
    })),
    signaturePng: await varied('signature'),
    stampPng: cutouts.stamp ?? null,
    mentionPng: await varied('mention'),
    combinedPng: await varied('signature_stamp'),
      fit: { fill: env.MARK_FILL, maxHeightOverflow: env.MARK_MAX_OVERFLOW },
    // Reproduce the same placement variation the original signing used, so
    // repositioning a mark moves it without also resizing or straightening it.
    variation:
      env.SIGNATURE_VARIANTS && doc.variant_index !== null
        ? variantPlacement(doc.variant_index, env.SIGNATURE_VARIATION_STRENGTH)
        : undefined,
  });

  // Same path as the original run: the console links to it, and a signed
  // document that changed URL every time it was nudged would strand anyone
  // holding the old link.
  const outPath = processedPdfPath(doc.owner_id, doc.id);
  await uploadObject(outPath, bytes, 'application/pdf');

  // Persist the geometry as this document's own, so a later template edit does
  // not undo the adjustment.
  if (persist) {
    await db.from('document_zones').delete().eq('document_id', doc.id);
    await db.from('document_zones').insert(
      zones.map((zone) => ({
        document_id: doc.id,
        page: zone.page,
        type: zone.type,
        x: zone.rect.x,
        y: zone.rect.y,
        width: zone.rect.width,
        height: zone.rect.height,
        zone_index: zone.index,
      })),
    );
  }

  await db
    .from('documents')
    .update({ final_pdf_path: outPath, error_code: null, error_message: null })
    .eq('id', doc.id);

  publish(ownerId, {
    type: 'document.updated',
    documentId: doc.id,
    folderId: doc.folder_id,
    status: 'completed',
  });

  await audit({
    ownerId,
    folderId: doc.folder_id,
    documentId: doc.id,
    action: persist ? 'document.placement_adjusted' : 'document.placement_reset',
    metadata: { zones: placed, bytes: bytes.byteLength, variantIndex: doc.variant_index },
  });

  return { documentId: doc.id, finalPdfPath: outPath, placed, bytes: bytes.byteLength };
};

/**
 * Drop a document's overrides and put it back on its template's placement.
 *
 * The way out of an adjustment that made things worse, without asking the
 * operator to remember where the zones originally were.
 */
export const resetDocumentPlacement = async (params: {
  documentId: string;
  ownerId: string;
}): Promise<AdjustResult> => {
  const doc = await loadDocument(params.documentId, params.ownerId);
  await db.from('document_zones').delete().eq('document_id', doc.id);

  // Read the template's zones with the overrides already gone.
  const { zones } = await zonesForDocument(doc);
  if (zones.length === 0) {
    throw new HttpError(
      409,
      'Ce document n’a pas de template : il n’y a pas de placement d’origine à restaurer.',
      'TEMPLATE_NOT_FOUND',
    );
  }

  // `persist: false` matters. Writing the template's own geometry back as
  // overrides would look identical today and diverge tomorrow: the document
  // would be pinned to this version of the template and stop following later
  // edits, which is the opposite of what "restaurer le placement du template"
  // promises.
  return adjustDocumentPlacement({ ...params, zones, persist: false });
};
