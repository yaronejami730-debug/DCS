import { z } from 'zod';
import { CAPTURE_MODE, DOCUMENT_ROLE, LINK_ACTIVITY_STEP, SHARE_SCOPE, ZONE_TYPE } from './status.js';
import type { ZoneType } from './status.js';
import type { NormalizedRect } from './geometry.js';

/**
 * Request contracts. The API validates every body against these; the clients
 * import the inferred types so a contract change breaks the build on both sides.
 */

export const normalizedRectSchema = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  width: z.number().gt(0).max(1),
  height: z.number().gt(0).max(1),
});

// --- auth -----------------------------------------------------------------

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const signupSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  displayName: z.string().min(1).max(120).optional(),
});
export type SignupInput = z.infer<typeof signupSchema>;

export const refreshSchema = z.object({ refreshToken: z.string().min(10) });
export type RefreshInput = z.infer<typeof refreshSchema>;

export interface AuthSession {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  user: { id: string; email: string; displayName: string | null };
}

// --- folders --------------------------------------------------------------

/**
 * Where an imported PDF goes.
 *
 * Asked on every import rather than inferred: the two look identical as files,
 * and guessing wrong either stamps a signature onto a blank capture sheet or
 * leaves a contract waiting for one.
 */
export const importDocumentsSchema = z.object({
  role: z.enum(DOCUMENT_ROLE).default('to_sign'),
});
export type ImportDocumentsInput = z.infer<typeof importDocumentsSchema>;

export const createFolderSchema = z.object({
  name: z.string().min(1).max(160),
});
export type CreateFolderInput = z.infer<typeof createFolderSchema>;

/**
 * Mint a share link for a folder.
 *
 * `expiresInDays: null` means no expiry, which the console has to ask for
 * explicitly — an unbounded capability URL is a decision, not a default.
 */
export const createShareLinkSchema = z.object({
  label: z.string().min(1).max(120).nullable().optional(),
  expiresInDays: z.number().int().min(1).max(365).nullable().optional(),
  scope: z.enum(SHARE_SCOPE).default('signer'),
  /** Empty or omitted covers the whole folder. See ShareLink.documentIds. */
  documentIds: z.array(z.string().uuid()).max(200).optional(),
  /** Ask the technician for their location on return. See ShareLink.requireLocation. */
  requireLocation: z.boolean().default(false),
});
export type CreateShareLinkInput = z.infer<typeof createShareLinkSchema>;

/**
 * A location a browser reported, with the person's consent.
 *
 * Bounded to real Earth coordinates so a malformed or spoofed payload is
 * rejected at the edge rather than stored as evidence. Accuracy is the browser's
 * own metres-of-uncertainty figure; it is advisory and may be absent.
 */
/** The signer's page reporting what it is doing. */
export const linkActivitySchema = z.object({
  step: z.enum(LINK_ACTIVITY_STEP),
});
export type LinkActivityInput = z.infer<typeof linkActivitySchema>;

/** Ask which type a framed region is. Single-photo (console crop) sessions only. */
export const classifyMarkSchema = z.object({
  region: normalizedRectSchema,
});
export type ClassifyMarkInput = z.infer<typeof classifyMarkSchema>;

export const geolocationSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  accuracy: z.number().min(0).max(100_000).nullable().optional(),
});
export type GeolocationInput = z.infer<typeof geolocationSchema>;

/** Change which documents an existing link covers, without reissuing it. */
export const updateShareLinkSchema = z.object({
  documentIds: z.array(z.string().uuid()).max(200),
});
export type UpdateShareLinkInput = z.infer<typeof updateShareLinkSchema>;

// --- templates ------------------------------------------------------------

export const templateZoneSchema = z.object({
  page: z.number().int().min(1),
  type: z.enum(ZONE_TYPE),
  rect: normalizedRectSchema,
  index: z.number().int().min(0).default(0),
  /** Which capture-sheet box fills this zone; see captureSheet.ts. */
  sheetField: z.string().max(64).nullable().optional(),
});
export type TemplateZoneInput = z.infer<typeof templateZoneSchema>;

export const saveTemplateSchema = z.object({
  name: z.string().min(1).max(160),
  /**
   * False = configured for this document only. Such a template is hidden from
   * the library and skipped when matching a future import, so ad-hoc zone
   * configuration does not fill the list with single-use entries.
   */
  reusable: z.boolean().default(true),
  documentHash: z.string().length(64).nullable().optional(),
  filenamePattern: z.string().max(160).nullable().optional(),
  pageCount: z.number().int().min(1).nullable().optional(),
  /** Which capture-sheet box signs this template; see captureSheet.ts. */
  sheetField: z.string().max(64).nullable().optional(),
  zones: z.array(templateZoneSchema).max(64),
});
export type SaveTemplateInput = z.infer<typeof saveTemplateSchema>;

/** Attach an existing template to a document and re-evaluate its status. */
export const assignTemplateSchema = z.object({
  templateId: z.string().uuid(),
});
export type AssignTemplateInput = z.infer<typeof assignTemplateSchema>;

/**
 * Move or resize the marks on ONE already-signed document.
 *
 * Same geometry as a template zone, but scoped to a single document, so a
 * signature that landed on a printed line can be nudged without moving it on
 * every other document the template describes. The signature itself never
 * changes: regeneration reuses the stored cutout at its recorded variant.
 */
export const adjustPlacementSchema = z.object({
  zones: z.array(templateZoneSchema).min(1).max(64),
});
export type AdjustPlacementInput = z.infer<typeof adjustPlacementSchema>;

/** One document on the folder comparison screen. */
export interface ComparisonItem {
  documentId: string;
  filename: string;
  /** False for a document the folder holds but nobody has signed yet. */
  signed: boolean;
  pageCount: number;
  /** Which variant of the marks this document carries. */
  variantIndex: number;
  /** False when it was inferred from the document's rank rather than recorded. */
  variantRecorded: boolean;
  /** Short-lived link: the signed PDF when there is one, the original otherwise. */
  url: string;
  /** The same document before signing — subtracted to isolate the mark. */
  originalUrl: string;
  /** Where the marks were stamped. Empty on an unsigned document. */
  zones: Array<{ page: number; type: ZoneType; rect: NormalizedRect; index: number }>;
}

export interface FolderComparison {
  folderId: string;
  items: ComparisonItem[];
  total: number;
}

/** Where a document's marks currently sit, and whether that is its own doing. */
export interface DocumentPlacement {
  documentId: string;
  /** `document` once an operator has adjusted it; `template` until then. */
  source: 'document' | 'template';
  zones: Array<{
    page: number;
    type: ZoneType;
    rect: NormalizedRect;
    index: number;
    sheetField?: string | null;
  }>;
  /** Null when the document can be adjusted; otherwise why it cannot. */
  blockedReason: string | null;
}

// --- signing sessions -----------------------------------------------------

/**
 * Which variant of a handwritten mark goes on which document.
 *
 * A folder holds several documents, and a person signing them by hand signs
 * each one separately. So the signer generates one variant per document and
 * decides where each goes, rather than the backend picking silently. Only the
 * index is stored: variants are derived from a seed, so an index reproduces the
 * exact image the signer approved.
 */
export const variantAssignmentSchema = z.record(
  z.string().uuid(),
  z.number().int().min(0).max(63),
);
export type VariantAssignment = z.infer<typeof variantAssignmentSchema>;

export const markAssignmentsSchema = z.object({
  signature: variantAssignmentSchema.optional(),
  mention: variantAssignmentSchema.optional(),
  signature_stamp: variantAssignmentSchema.optional(),
});
export type MarkAssignments = z.infer<typeof markAssignmentsSchema>;

export const generateVariantsSchema = z.object({
  mark: z.enum(ZONE_TYPE),
  region: normalizedRectSchema,
  /** One per document to sign. Capped so a huge folder cannot stall a phone. */
  count: z.number().int().min(1).max(24).default(4),
});
export type GenerateVariantsInput = z.infer<typeof generateVariantsSchema>;

export interface GeneratedVariant {
  index: number;
  dataUrl: string;
}

export const submitRegionsSchema = z
  .object({
    /** Region of the uploaded photo containing the handwritten signature. */
    signature: normalizedRectSchema.nullable().optional(),
    /** Optional — a folder may need no stamp at all. */
    stamp: normalizedRectSchema.nullable().optional(),
    /** Optional — the "Lu et approuvé" mention, when a template asks for one. */
    mention: normalizedRectSchema.nullable().optional(),
    /** Optional — signature and stamp together, framed as a single mark. */
    signature_stamp: normalizedRectSchema.nullable().optional(),
    /** Handwritten extras: each cropped and matched to zones of its own type. */
    date: normalizedRectSchema.nullable().optional(),
    quote_date: normalizedRectSchema.nullable().optional(),
    free_text: normalizedRectSchema.nullable().optional(),
    checkbox: normalizedRectSchema.nullable().optional(),
    /**
     * Restrict this submission to these documents of the folder.
     *
     * The console crops a returned scan one document at a time — this
     * signature goes on that contract, that one on the next — and without a
     * target the pipeline stamps every document in the folder. Omitted or
     * empty means all of them, which is what the phone-style flow wants.
     */
    documentIds: z.array(z.string().uuid()).max(50).optional(),
    /**
     * Which variant the signer chose for each document, per mark. Omitted
     * entirely when the signer did not assign any, in which case each document
     * still gets its own variant, derived from its id.
     */
    assignments: markAssignmentsSchema.optional(),
  })
  // A document signed with the combined mark needs no separate signature, but
  // something has to carry the signer's hand.
  .refine((r) => Boolean(r.signature ?? r.signature_stamp), {
    message: 'Sélectionnez au moins une signature (seule ou avec le tampon).',
    path: ['signature'],
  });
export type SubmitRegionsInput = z.infer<typeof submitRegionsSchema>;

export const startSessionSchema = z.object({
  captureMode: z.enum(CAPTURE_MODE).default('single'),
});
export type StartSessionInput = z.infer<typeof startSessionSchema>;

/**
 * Ask what the extraction engine makes of a framed region, before committing.
 * Lets the signer judge a faint stamp or a shadowed photo while they can still
 * widen the box or retake it.
 */
/**
 * Which engine cuts the mark out.
 *
 *   local     the container on our own server. Free, fast, and the photograph
 *             never leaves the machine — so it is the default and the only one
 *             the signing pipeline itself ever uses.
 *   removebg  the hosted remove.bg API. Metered, and it uploads the mark to a
 *             third party, so it exists only as a preview an operator asks for
 *             deliberately, to compare the two on the same crop.
 */
export const EXTRACTION_ENGINE = ['rembg', 'local', 'removebg', 'builtin'] as const;
export type ExtractionEngine = (typeof EXTRACTION_ENGINE)[number];

export const EXTRACTION_ENGINE_LABEL: Record<ExtractionEngine, string> = {
  rembg: 'rembg (local)',
  local: 'Moteur simple',
  removebg: 'remove.bg',
  builtin: 'Intégré (encre sur papier)',
};

export const previewCutoutSchema = z.object({
  mark: z.enum(ZONE_TYPE),
  region: normalizedRectSchema,
  /** Omit to use whichever engine the server is configured to sign with. */
  engine: z.enum(EXTRACTION_ENGINE).optional(),
});
export type PreviewCutoutInput = z.infer<typeof previewCutoutSchema>;

export interface CutoutPreview {
  mark: ZoneType;
  width: number;
  height: number;
  /** Transparent PNG as a data URL — small, and belongs to nothing yet. */
  dataUrl: string;
  /** Which engine produced it, so the two can be told apart on screen. */
  engine: ExtractionEngine;
  /**
   * True when the chosen engine could not answer and the other one stepped in.
   * Worth showing: the cutout on screen is not from the engine that was asked
   * for, and the reason is usually actionable — no credits, service down.
   */
  fellBack?: boolean;
}

/** Which marks a folder's templates actually call for, and how many of each. */
export type RequiredMarks = Record<ZoneType, number>;

// --- generic API envelope -------------------------------------------------

export interface ApiError {
  error: string;
  code?: string;
  details?: unknown;
}

export interface Paginated<T> {
  items: T[];
  total: number;
}
