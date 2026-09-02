import type { Document, Folder } from '@scansign/shared';

export interface FolderRow {
  id: string;
  owner_id: string;
  reference: number;
  name: string;
  crm_lead_id?: string | null;
  status: Folder['status'];
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  delivered_at: string | null;
  completed_at: string | null;
  documents?: DocumentRow[];
}

export interface DocumentRow {
  id: string;
  folder_id: string;
  role: Document['role'];
  filename: string;
  storage_path: string;
  final_pdf_path: string | null;
  template_id: string | null;
  document_hash: string;
  page_count: number;
  byte_size: number;
  status: Document['status'];
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  /** Which session's cutouts are on this document — needed to re-stamp it. */
  signing_session_id: string | null;
  /** Which variant of those cutouts, so a re-stamp reproduces the same mark. */
  variant_index: number | null;
  templates?: { id: string; name: string; sheet_field?: string | null } | null;
  signing_sessions?: { completed_at: string | null } | null;
}

export const toDocument = (row: DocumentRow): Document => ({
  id: row.id,
  folderId: row.folder_id,
  // Defaulted for rows read before the column existed in a given deploy.
  role: row.role ?? 'to_sign',
  filename: row.filename,
  storagePath: row.storage_path,
  finalPdfPath: row.final_pdf_path,
  templateId: row.template_id,
  documentHash: row.document_hash,
  pageCount: row.page_count,
  byteSize: Number(row.byte_size),
  status: row.status,
  errorCode: (row.error_code as Document['errorCode']) ?? null,
  errorMessage: row.error_message,
  createdAt: row.created_at,
  signingSessionId: row.signing_session_id ?? null,
  signedAt: row.signing_sessions?.completed_at ?? null,
  template: row.templates
    ? { id: row.templates.id, name: row.templates.name, sheetField: row.templates.sheet_field ?? null }
    : null,
});

export const toFolder = (row: FolderRow): Folder => ({
  id: row.id,
  ownerId: row.owner_id,
  reference: Number(row.reference),
  crmLeadId: row.crm_lead_id ?? null,
  name: row.name,
  status: row.status,
  errorCode: (row.error_code as Folder['errorCode']) ?? null,
  errorMessage: row.error_message,
  createdAt: row.created_at,
  deliveredAt: row.delivered_at,
  completedAt: row.completed_at,
  documents: (row.documents ?? []).map(toDocument),
});

export const FOLDER_SELECT =
  '*, documents (*, templates:template_id (id, name, sheet_field), signing_sessions:signing_session_id (completed_at))';
