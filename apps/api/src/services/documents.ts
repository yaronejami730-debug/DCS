import { originalPdfPath, type DocumentRole, type DocumentStatus } from '@scansign/shared';
import { inspectPdf, looksLikePdf, sha256 } from '@scansign/pdf';
import { env } from '../env.js';
import { db } from '../lib/supabase.js';
import { badRequest, payloadTooLarge, unsupportedMedia } from '../lib/errors.js';
import { uploadObject } from '../lib/storage.js';
import { audit } from '../lib/audit.js';
import { findTemplateForDocument } from './templates.js';

/**
 * Put PDFs into a folder.
 *
 * Two callers, one implementation: the operator importing from the console, and
 * a technician importing through a share link. They differ in what they are
 * allowed to see afterwards, not in what happens to the file — the same size
 * check, the same PDF sniff, the same template matching, the same audit trail.
 * Splitting it out is what keeps those from drifting apart, because the
 * link-side path is the one nobody watches.
 */

/** Pull the files out of a multipart body, under either field name. */
export const readPdfUploads = (body: Record<string, unknown>): File[] => {
  const raw = body['files'] ?? body['file'];
  const files = (Array.isArray(raw) ? raw : [raw]).filter(
    (f): f is File => typeof f === 'object' && f !== null && 'arrayBuffer' in f,
  );
  if (files.length === 0) throw badRequest('Aucun fichier reçu.', 'UPLOAD_FAILED');
  return files;
};

export interface ImportedDocument {
  id: string;
  filename: string;
  pageCount: number;
  status: DocumentStatus;
  role: DocumentRole;
}

export const importPdfsIntoFolder = async (params: {
  ownerId: string;
  folderId: string;
  files: File[];
  /** What these PDFs are for. See DOCUMENT_ROLE. */
  role?: DocumentRole;
}): Promise<ImportedDocument[]> => {
  const { ownerId, folderId, files, role = 'to_sign' } = params;

  const { count: existing } = await db
    .from('documents')
    .select('id', { count: 'exact', head: true })
    .eq('folder_id', folderId);

  const imported: ImportedDocument[] = [];

  for (const [i, file] of files.entries()) {
    if (file.size > env.MAX_PDF_BYTES) {
      throw payloadTooLarge(
        `${file.name} dépasse la limite de ${Math.round(env.MAX_PDF_BYTES / 1024 / 1024)} Mo.`,
      );
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    // Sniffed, not trusted from the extension or the declared MIME type: both
    // are attacker-controlled, and everything downstream assumes a real PDF.
    if (!looksLikePdf(bytes)) {
      throw unsupportedMedia(`${file.name} n'est pas un PDF.`);
    }

    const info = await inspectPdf(bytes);
    const hash = sha256(bytes);

    /**
     * A capture sheet is never stamped, so it has no zones to match and nothing
     * to wait for. Sending it through template matching would file it as
     * `awaiting_template` and hold the whole folder open on a configuration
     * that will never exist.
     */
    const match =
      role === 'for_signing'
        ? null
        : await findTemplateForDocument({
            ownerId,
            documentHash: hash,
            filename: file.name,
            pageCount: info.pageCount,
          });

    const status: DocumentStatus =
      role === 'for_signing' ? 'ready' : match ? 'ready' : 'awaiting_template';

    const { data: doc, error } = await db
      .from('documents')
      .insert({
        folder_id: folderId,
        owner_id: ownerId,
        filename: file.name,
        storage_path: 'pending',
        document_hash: hash,
        page_count: info.pageCount,
        byte_size: bytes.byteLength,
        template_id: match?.template.id ?? null,
        status,
        role,
        position: (existing ?? 0) + i,
      })
      .select('id')
      .single<{ id: string }>();

    if (error || !doc) throw badRequest(error?.message ?? 'Import impossible.', 'UPLOAD_FAILED');

    const path = originalPdfPath(ownerId, doc.id);
    await uploadObject(path, bytes, 'application/pdf');
    await db.from('documents').update({ storage_path: path }).eq('id', doc.id);

    await audit({
      ownerId,
      folderId,
      documentId: doc.id,
      action: 'document.imported',
      metadata: {
        filename: file.name,
        pages: info.pageCount,
        hash,
        role,
        template: match ? { id: match.template.id, matchedBy: match.matchedBy } : null,
      },
    });

    imported.push({ id: doc.id, filename: file.name, pageCount: info.pageCount, status, role });
  }

  return imported;
};

/**
 * Adding a document to a folder that was already finished makes it unfinished
 * again: the new document has not been signed, and leaving the badge on
 * "Terminé" would claim work that has not happened.
 */
export const reopenFolderIfFinished = async (
  folderId: string,
  status: string,
): Promise<void> => {
  if (status !== 'completed' && status !== 'error') return;
  await db
    .from('folders')
    .update({ status: 'pending', completed_at: null, error_code: null, error_message: null })
    .eq('id', folderId);
};
