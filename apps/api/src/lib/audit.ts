import { db } from './supabase.js';

/**
 * Append-only trail. Deliberately fire-and-forget: an audit write must never
 * be the reason a document fails to be signed.
 */
export const audit = async (entry: {
  ownerId: string;
  action: string;
  folderId?: string | null;
  documentId?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<void> => {
  const { error } = await db.from('audit_logs').insert({
    owner_id: entry.ownerId,
    folder_id: entry.folderId ?? null,
    document_id: entry.documentId ?? null,
    action: entry.action,
    metadata: entry.metadata ?? {},
  });
  if (error) console.warn('[audit] failed to record %s: %s', entry.action, error.message);
};
