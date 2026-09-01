import type {
  DocumentRole,
  DocumentStatus,
  ShareScope,
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

/**
 * A capability URL onto exactly one folder.
 *
 * The token IS the authorisation: whoever holds the link can photograph their
 * signature into this folder and nothing else — no account, no password, no
 * visibility onto any other folder or document. That is the whole point. An
 * external signer receives a link by email or SMS and signs; asking them to
 * open an account first is the friction the link exists to remove.
 *
 * It is therefore treated like any other bearer secret: long random token,
 * revocable at any moment, and expiring on its own so a link forwarded once
 * does not stay live forever.
 */
export interface ShareLink {
  id: string;
  folderId: string;
  /** The secret. Only ever travels inside the link itself. */
  token: string;
  /** Ready-to-send address, assembled by the API from SIGNER_PUBLIC_URL. */
  url: string;
  label: string | null;
  scope: ShareScope;
  /**
   * The documents this link covers.
   *
   * Empty means the whole folder, including documents added later — which is
   * what "sign this folder" means and what every link did before subsets
   * existed. A non-empty list is exact: those documents and no others.
   */
  documentIds: string[];
  /**
   * The link asks the technician for their location when they return the
   * signed pages. Consented proof of presence — the browser prompts, they
   * grant or refuse. Off by default.
   */
  requireLocation: boolean;
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  lastOpenedAt: string | null;
  openedCount: number;
  /** Derived: not revoked and not past its expiry. */
  active: boolean;
}

/**
 * A signed page a technician sent back through a link.
 *
 * The raw thing they returned, before anyone has decided what is in it — the
 * operator crops the marks out of it afterwards, on the console.
 */
export interface ShareLinkReturn {
  id: string;
  linkId: string;
  folderId: string;
  /** Which document this is a signed copy of, when the technician said so. */
  documentId: string | null;
  filename: string;
  contentType: string;
  byteSize: number;
  /** Pixel size for an image; null for a PDF, rasterised at crop time. */
  width: number | null;
  height: number | null;
  pageCount: number | null;
  /** Set once the operator has cropped marks out of it. */
  handledAt: string | null;
  /**
   * Where the technician was when they sent this, if the link asked and they
   * allowed it. Null throughout when it did not ask, or they declined — a
   * refusal is a valid outcome, not a failure.
   */
  location: { latitude: number; longitude: number; accuracy: number | null; at: string } | null;
  createdAt: string;
  /** Short-lived signed URL, present when the API was asked for one. */
  url?: string;
}

export interface Folder {
  id: string;
  ownerId: string;
  /** Short human reference shown as DOSSIER #000123. */
  reference: number;
  name: string;
  status: FolderStatus;
  errorCode: ErrorCode | null;
  errorMessage: string | null;
  createdAt: string;
  deliveredAt: string | null;
  completedAt: string | null;
  documents?: Document[];
  /** The active link, when the console asked for it. */
  share?: ShareLink | null;
}

export interface Document {
  id: string;
  folderId: string;
  /** What this PDF is for. See DOCUMENT_ROLE. */
  role: DocumentRole;
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
  /**
   * The session whose cutouts were stamped here. Null on documents signed
   * before this was tracked, which is exactly when the console must not offer
   * to reposition the mark: there is no way to know which signature to reuse.
   */
  signingSessionId?: string | null;
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
  activeLinks: number;
  errors: number;
}

/** How long a share link stays usable unless the operator says otherwise. */
export const SHARE_LINK_TTL_DAYS = 30;
