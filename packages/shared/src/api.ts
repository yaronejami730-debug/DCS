import { z } from 'zod';
import { CAPTURE_MODE, DEVICE_PLATFORM, ZONE_TYPE } from './status.js';
import type { ZoneType } from './status.js';

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

// --- devices --------------------------------------------------------------

export const registerDeviceSchema = z.object({
  name: z.string().min(1).max(80),
  platform: z.enum(DEVICE_PLATFORM).default('unknown'),
  pushToken: z.string().min(1).max(255).nullable().optional(),
  /** Stable per-install id so a reinstall-free relaunch reuses the same row. */
  installationId: z.string().min(8).max(128),
});
export type RegisterDeviceInput = z.infer<typeof registerDeviceSchema>;

export const updateDeviceSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  pushToken: z.string().min(1).max(255).nullable().optional(),
});
export type UpdateDeviceInput = z.infer<typeof updateDeviceSchema>;

// --- folders --------------------------------------------------------------

export const createFolderSchema = z.object({
  name: z.string().min(1).max(160),
  deviceId: z.string().uuid().nullable().optional(),
});
export type CreateFolderInput = z.infer<typeof createFolderSchema>;

export const sendFolderSchema = z.object({
  deviceId: z.string().uuid(),
});
export type SendFolderInput = z.infer<typeof sendFolderSchema>;

// --- templates ------------------------------------------------------------

export const templateZoneSchema = z.object({
  page: z.number().int().min(1),
  type: z.enum(ZONE_TYPE),
  rect: normalizedRectSchema,
  index: z.number().int().min(0).default(0),
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
  zones: z.array(templateZoneSchema).max(64),
});
export type SaveTemplateInput = z.infer<typeof saveTemplateSchema>;

/** Attach an existing template to a document and re-evaluate its status. */
export const assignTemplateSchema = z.object({
  templateId: z.string().uuid(),
});
export type AssignTemplateInput = z.infer<typeof assignTemplateSchema>;

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
export const previewCutoutSchema = z.object({
  mark: z.enum(ZONE_TYPE),
  region: normalizedRectSchema,
});
export type PreviewCutoutInput = z.infer<typeof previewCutoutSchema>;

export interface CutoutPreview {
  mark: ZoneType;
  width: number;
  height: number;
  /** Transparent PNG as a data URL — small, and belongs to nothing yet. */
  dataUrl: string;
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
