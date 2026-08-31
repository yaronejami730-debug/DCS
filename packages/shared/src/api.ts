import { z } from 'zod';
import { DEVICE_PLATFORM, ZONE_TYPE } from './status.js';

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

export const submitRegionsSchema = z.object({
  /** Region of the uploaded photo containing the handwritten signature. */
  signature: normalizedRectSchema,
  /** Optional — a folder may need no stamp at all. */
  stamp: normalizedRectSchema.nullable().optional(),
});
export type SubmitRegionsInput = z.infer<typeof submitRegionsSchema>;

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
