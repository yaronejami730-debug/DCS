import type { Document, Folder } from '@scansign/shared';

export interface FolderRow {
  id: string;
  owner_id: string;
  reference: number;
  name: string;
  device_id: string | null;
  status: Folder['status'];
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  delivered_at: string | null;
  completed_at: string | null;
  devices?: { id: string; name: string } | null;
  documents?: DocumentRow[];
}

export interface DocumentRow {
  id: string;
  folder_id: string;
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
  templates?: { id: string; name: string } | null;
}

export const toDocument = (row: DocumentRow): Document => ({
  id: row.id,
  folderId: row.folder_id,
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
  template: row.templates ?? null,
});

export const toFolder = (row: FolderRow): Folder => ({
  id: row.id,
  ownerId: row.owner_id,
  reference: Number(row.reference),
  name: row.name,
  deviceId: row.device_id,
  status: row.status,
  errorCode: (row.error_code as Folder['errorCode']) ?? null,
  errorMessage: row.error_message,
  createdAt: row.created_at,
  deliveredAt: row.delivered_at,
  completedAt: row.completed_at,
  device: row.devices ?? null,
  documents: (row.documents ?? []).map(toDocument),
});

export const FOLDER_SELECT =
  '*, devices:device_id (id, name), documents (*, templates:template_id (id, name))';
