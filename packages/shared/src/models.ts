import type {
  DevicePlatform,
  DocumentStatus,
  ErrorCode,
  FolderStatus,
  SessionStatus,
  ZoneType,
} from './status.js';
import type { CaptureMode } from './status.js';
import type { NormalizedRect } from './geometry.js';

/** An account. The same account signs in on the web console and on the iPhone. */
export interface User {
  id: string;
  email: string;
  displayName: string | null;
  createdAt: string;
}

export interface Device {
  id: string;
  ownerId: string;
  name: string;
  platform: DevicePlatform;
  /** Expo push token. Null until the user grants notification permission. */
  pushToken: string | null;
  lastSeenAt: string | null;
  createdAt: string;
  /** Derived: lastSeenAt within ONLINE_WINDOW_MS. */
  online: boolean;
}

export interface Folder {
  id: string;
  ownerId: string;
  /** Short human reference shown as DOSSIER #000123. */
  reference: number;
  name: string;
  deviceId: string | null;
  status: FolderStatus;
  errorCode: ErrorCode | null;
  errorMessage: string | null;
  createdAt: string;
  deliveredAt: string | null;
  completedAt: string | null;
  documents?: Document[];
  device?: Pick<Device, 'id' | 'name'> | null;
}

export interface Document {
  id: string;
  folderId: string;
  filename: string;
  storagePath: string;
  finalPdfPath: string | null;
  templateId: string | null;
  documentHash: string;
  pageCount: number;
  byteSize: number;
  status: DocumentStatus;
  errorCode: ErrorCode | null;
  errorMessage: string | null;
  createdAt: string;
  template?: Pick<Template, 'id' | 'name'> | null;
}

export interface TemplateZone {
  id: string;
  templateId: string;
  /** 1-based page number, matching what the user sees in the viewer. */
  page: number;
  type: ZoneType;
  /** Normalized 0..1, origin top-left. See geometry.ts. */
  rect: NormalizedRect;
  /** Draw order / label suffix, e.g. "Signature 2". */
  index: number;
}

export interface Template {
  id: string;
  ownerId: string;
  name: string;
  /** False = tied to one document; hidden from the library, never auto-matched. */
  reusable: boolean;
  /** SHA-256 of the source PDF bytes. Primary matching key. */
  documentHash: string | null;
  /** Fallback matcher, e.g. "contrat-vente-*.pdf". */
  filenamePattern: string | null;
  pageCount: number | null;
  /** Storage path of the PDF this template was configured against. */
  sourcePdfPath: string | null;
  sourceFilename: string | null;
  createdAt: string;
  updatedAt: string;
  zones?: TemplateZone[];
}

export interface SigningSession {
  id: string;
  folderId: string;
  deviceId: string | null;
  status: SessionStatus;
  captureMode: CaptureMode;
  photoPath: string | null;
  photoWidth: number | null;
  photoHeight: number | null;
  signatureImagePath: string | null;
  stampImagePath: string | null;
  mentionImagePath: string | null;
  signatureStampImagePath: string | null;
  errorCode: ErrorCode | null;
  errorMessage: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface AuditLog {
  id: string;
  ownerId: string;
  folderId: string | null;
  documentId: string | null;
  action: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface DashboardStats {
  pendingDocuments: number;
  completedDocuments: number;
  devicesOnline: number;
  devicesTotal: number;
  errors: number;
}

/** A device counts as online if it pinged within this window. */
export const ONLINE_WINDOW_MS = 2 * 60 * 1000;
