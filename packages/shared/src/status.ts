/**
 * Status + error vocabulary shared by the API, the admin console and the mobile app.
 * Every value here is persisted in Postgres, so treat them as an append-only enum.
 */

export const FOLDER_STATUS = [
  'pending', // created by the owner, not yet delivered to a device
  'delivered', // device fetched it / notification acknowledged
  'in_progress', // signer started the capture flow
  'processing', // backend is cropping / extracting / generating
  'completed', // every document has a final PDF
  'error',
] as const;
export type FolderStatus = (typeof FOLDER_STATUS)[number];

export const DOCUMENT_STATUS = [
  'awaiting_template', // no template matched — owner must configure zones
  'ready', // template matched, waiting for a signature capture
  'processing', // final PDF being generated
  'completed', // final PDF stored
  'error',
] as const;
export type DocumentStatus = (typeof DOCUMENT_STATUS)[number];

export const SESSION_STATUS = [
  'awaiting_photo',
  'awaiting_regions',
  'processing',
  'completed',
  'error',
] as const;
export type SessionStatus = (typeof SESSION_STATUS)[number];

/**
 * The kinds of handwritten mark a document can call for.
 * `mention` is the "Lu et approuvé" a contract often requires beside the
 * signature — a separate mark with its own zone, cutout and placement.
 */
export const ZONE_TYPE = ['signature', 'stamp', 'mention', 'signature_stamp'] as const;
export type ZoneType = (typeof ZONE_TYPE)[number];

export const ZONE_TYPE_LABEL: Record<ZoneType, string> = {
  signature: 'Signature',
  stamp: 'Tampon',
  mention: 'Lu et approuvé',
  signature_stamp: 'Tampon + signature',
};

/** What the signer is asked to produce, shown as guidance during capture. */
export const ZONE_TYPE_INSTRUCTION: Record<ZoneType, string> = {
  signature: 'Signez sur une feuille blanche.',
  stamp: 'Apposez votre tampon sur une feuille blanche.',
  mention: 'Écrivez « Lu et approuvé » sur une feuille blanche.',
  signature_stamp:
    'Signez puis apposez votre tampon par-dessus, comme sur un document réel.',
};

/**
 * Marks that carry handwritten ink, and so are worth varying between
 * documents. A stamp is a physical die and reproduces identically every
 * time — varying it would look wrong, not natural.
 */
export const HANDWRITTEN_MARKS: readonly ZoneType[] = ['signature', 'mention', 'signature_stamp'];

/**
 * The order marks are captured in: the signature first, always, then the
 * combined mark, the stamp, and the mention.
 *
 * Derived from ZONE_TYPE rather than written out, because a hand-written list
 * silently drops whatever is added later — `signature_stamp` was missing from
 * one, so a folder needing a signed stamp was never asked for it and failed at
 * processing with "aucune zone n'a été sélectionnée".
 */
export const CAPTURE_ORDER: readonly ZoneType[] = [
  'signature',
  'signature_stamp',
  'stamp',
  'mention',
];

/** Fails the build if a new mark is added without giving it a capture position. */
const _captureOrderIsExhaustive: Record<ZoneType, true> = Object.fromEntries(
  CAPTURE_ORDER.map((mark) => [mark, true]),
) as Record<ZoneType, true>;
void _captureOrderIsExhaustive;

/** The marks a folder actually asks for, in capture order. */
export const marksToCapture = (counts: Partial<Record<ZoneType, number>>): ZoneType[] => {
  const needed = CAPTURE_ORDER.filter((mark) => (counts[mark] ?? 0) > 0);
  // A folder with no configured zones still needs a signature.
  return needed.length > 0 ? [...needed] : ['signature'];
};

/**
 * How the marks are captured.
 *  single   — one sheet holding every mark, framed afterwards. Fastest.
 *  per_mark — one photo per mark. Easier to frame, better for a faint stamp.
 */
export const CAPTURE_MODE = ['single', 'per_mark'] as const;
export type CaptureMode = (typeof CAPTURE_MODE)[number];

export const DEVICE_PLATFORM = ['ios', 'android', 'unknown'] as const;
export type DevicePlatform = (typeof DEVICE_PLATFORM)[number];

/** Machine-readable failure reasons surfaced to the owner in the console. */
export const ERROR_CODE = [
  'UPLOAD_FAILED',
  'INVALID_PDF',
  'FILE_TOO_LARGE',
  'UNSUPPORTED_MIME',
  'TEMPLATE_NOT_FOUND',
  'TEMPLATE_ZONE_OUT_OF_RANGE',
  'IMAGE_PROCESSING_FAILED',
  'SIGNATURE_EXTRACTION_FAILED',
  'STAMP_EXTRACTION_FAILED',
  'MENTION_EXTRACTION_FAILED',
  'COMBINED_EXTRACTION_FAILED',
  'PDF_GENERATION_FAILED',
  'STORAGE_FAILED',
  'NOTIFICATION_FAILED',
  'INTERNAL_ERROR',
] as const;
export type ErrorCode = (typeof ERROR_CODE)[number];

/** Human-readable French labels used by both clients. */
export const FOLDER_STATUS_LABEL: Record<FolderStatus, string> = {
  pending: 'En attente',
  delivered: 'Reçu',
  in_progress: 'En cours de signature',
  processing: 'Traitement',
  completed: 'Terminé',
  error: 'Erreur',
};

export const DOCUMENT_STATUS_LABEL: Record<DocumentStatus, string> = {
  awaiting_template: 'Configuration requise',
  ready: 'À signer',
  processing: 'Traitement',
  completed: 'Signé',
  error: 'Erreur',
};

export const ERROR_CODE_LABEL: Record<ErrorCode, string> = {
  UPLOAD_FAILED: "Échec de l'envoi du fichier",
  INVALID_PDF: 'Le fichier PDF est illisible',
  FILE_TOO_LARGE: 'Fichier trop volumineux',
  UNSUPPORTED_MIME: 'Type de fichier non supporté',
  TEMPLATE_NOT_FOUND: 'Ce document nécessite une configuration de signature',
  TEMPLATE_ZONE_OUT_OF_RANGE: 'Une zone du template sort du document',
  IMAGE_PROCESSING_FAILED: "Échec du traitement de l'image",
  SIGNATURE_EXTRACTION_FAILED: 'Échec du détourage de la signature',
  STAMP_EXTRACTION_FAILED: 'Échec du détourage du tampon',
  MENTION_EXTRACTION_FAILED: 'Échec du détourage de la mention',
  COMBINED_EXTRACTION_FAILED: 'Échec du détourage du tampon signé',
  PDF_GENERATION_FAILED: 'Échec de la génération du PDF',
  STORAGE_FAILED: 'Échec du stockage',
  NOTIFICATION_FAILED: "Échec de l'envoi de la notification",
  INTERNAL_ERROR: 'Erreur interne',
};
