/**
 * Single private Supabase Storage bucket, four prefixes.
 * Originals are immutable: the signed output is always written to processed/.
 */
export const STORAGE_PREFIX = {
  originals: 'originals',
  processed: 'processed',
  signatures: 'signatures',
  stamps: 'stamps',
  photos: 'photos',
} as const;

export const originalPdfPath = (ownerId: string, documentId: string): string =>
  `${STORAGE_PREFIX.originals}/${ownerId}/${documentId}.pdf`;

export const processedPdfPath = (ownerId: string, documentId: string): string =>
  `${STORAGE_PREFIX.processed}/${ownerId}/${documentId}.pdf`;

export const photoPath = (ownerId: string, sessionId: string, ext: string): string =>
  `${STORAGE_PREFIX.photos}/${ownerId}/${sessionId}.${ext}`;

export const signatureCutoutPath = (ownerId: string, sessionId: string): string =>
  `${STORAGE_PREFIX.signatures}/${ownerId}/${sessionId}.png`;

export const stampCutoutPath = (ownerId: string, sessionId: string): string =>
  `${STORAGE_PREFIX.stamps}/${ownerId}/${sessionId}.png`;
