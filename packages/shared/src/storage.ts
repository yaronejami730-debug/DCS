/**
 * Single private Supabase Storage bucket, four prefixes.
 * Originals are immutable: the signed output is always written to processed/.
 */
import type { ZoneType } from './status.js';

export const STORAGE_PREFIX = {
  originals: 'originals',
  processed: 'processed',
  signatures: 'signatures',
  stamps: 'stamps',
  mentions: 'mentions',
  photos: 'photos',
  previews: 'previews',
  templates: 'templates',
  /** Signed pages sent back by a technician through a share link. */
  returns: 'returns',
} as const;

export const originalPdfPath = (ownerId: string, documentId: string): string =>
  `${STORAGE_PREFIX.originals}/${ownerId}/${documentId}.pdf`;

/** The PDF a template was configured against, so it stands on its own. */
export const templateSourcePdfPath = (ownerId: string, templateId: string): string =>
  `${STORAGE_PREFIX.templates}/${ownerId}/${templateId}.pdf`;

export const processedPdfPath = (ownerId: string, documentId: string): string =>
  `${STORAGE_PREFIX.processed}/${ownerId}/${documentId}.pdf`;

export const photoPath = (ownerId: string, sessionId: string, ext: string): string =>
  `${STORAGE_PREFIX.photos}/${ownerId}/${sessionId}.${ext}`;

/**
 * A signed page the technician sent back.
 *
 * Kept under its own prefix rather than with `originals`: an original is
 * something the operator put in to be signed, a return is evidence coming back
 * the other way, and the retention rules for the two are not the same.
 */
export const returnPath = (ownerId: string, returnId: string, ext: string): string =>
  `${STORAGE_PREFIX.returns}/${ownerId}/${returnId}.${ext}`;

/** Annotated copy of a document showing where its zones fall. Regenerated on demand. */
export const previewPdfPath = (ownerId: string, documentId: string): string =>
  `${STORAGE_PREFIX.previews}/${ownerId}/${documentId}.pdf`;

export const signatureCutoutPath = (ownerId: string, sessionId: string): string =>
  `${STORAGE_PREFIX.signatures}/${ownerId}/${sessionId}.png`;

export const stampCutoutPath = (ownerId: string, sessionId: string): string =>
  `${STORAGE_PREFIX.stamps}/${ownerId}/${sessionId}.png`;

export const mentionCutoutPath = (ownerId: string, sessionId: string): string =>
  `${STORAGE_PREFIX.mentions}/${ownerId}/${sessionId}.png`;

export const combinedCutoutPath = (ownerId: string, sessionId: string): string =>
  `${STORAGE_PREFIX.signatures}/${ownerId}/${sessionId}-combined.png`;

/**
 * Cutout of one of the extended handwritten marks (date, quote date, free
 * text, checkbox). The legacy marks keep their historical prefixes; giving
 * each new type its own bucket prefix would multiply retention rules for no
 * benefit.
 */
export const markCutoutPath = (ownerId: string, sessionId: string, mark: ZoneType): string =>
  `${STORAGE_PREFIX.signatures}/${ownerId}/${sessionId}-${mark}.png`;

/** Per-mark capture stores one photo per mark instead of a single shared sheet. */
export const markPhotoPath = (
  ownerId: string,
  sessionId: string,
  mark: ZoneType,
  ext: string,
): string => `${STORAGE_PREFIX.photos}/${ownerId}/${sessionId}-${mark}.${ext}`;
