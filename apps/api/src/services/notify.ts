import { ERROR_CODE_LABEL, type ErrorCode } from '@scansign/shared';
import { db } from '../lib/supabase.js';
import { publish } from '../lib/realtime.js';

/**
 * Everything the system tells the operator, in one place.
 *
 * These used to be Expo push notifications aimed at a registered phone. There
 * is no phone any more: the signer follows a link in a browser, and the only
 * party who needs telling after the fact is the operator — who is looking at
 * the console, where the live socket already delivers the news instantly.
 *
 * So a notification is now a *record*, not a delivery. It lands in
 * `notifications` for the console's activity feed and its history, and the
 * socket does the waking-up. That removes the whole class of failure where a
 * finished signature was reported as failed because a push token had gone
 * stale.
 *
 * Two rules still shape the wording:
 *
 *  1. Say what happened AND what to do about it. "Échec du détourage" tells the
 *     operator nothing they can act on; "la signature n'a pas pu être détourée —
 *     demandez une nouvelle photo sur une feuille bien éclairée" does.
 *  2. Never record a notification nobody will read. Noise in the feed is what
 *     makes the one that matters invisible.
 */

interface FolderRef {
  id: string;
  name: string;
}

const loadFolder = async (folderId: string): Promise<FolderRef | null> => {
  const { data } = await db
    .from('folders')
    .select('id, name')
    .eq('id', folderId)
    .maybeSingle<FolderRef>();
  return data ?? null;
};

/** Write to the feed. Never throws: reporting must not fail the work reported. */
const record = async (entry: {
  ownerId: string;
  folderId: string | null;
  title: string;
  body: string;
}): Promise<void> => {
  try {
    await db.from('notifications').insert({
      owner_id: entry.ownerId,
      folder_id: entry.folderId,
      title: entry.title,
      body: entry.body,
      status: 'recorded',
    });
  } catch {
    /* the feed loses a line; the signature is unaffected */
  }
};

/** Everything in the folder is signed. */
export const notifyFolderCompleted = async (
  ownerId: string,
  folderId: string,
  documentCount: number,
): Promise<void> => {
  const folder = await loadFolder(folderId);
  if (!folder) return;

  await record({
    ownerId,
    folderId,
    title: 'Documents signés',
    body:
      documentCount > 1
        ? `${folder.name} — ${documentCount} documents signés, prêts à télécharger.`
        : `${folder.name} est signé, prêt à télécharger.`,
  });
};

/**
 * Something went wrong. The body has to say what the person can do next,
 * because a code on its own leaves them stuck.
 *
 * The advice is addressed to the operator now, not the signer: the operator is
 * the one reading this, and what they can do is ask for another photo.
 */
const RECOVERY: Partial<Record<ErrorCode, string>> = {
  SIGNATURE_EXTRACTION_FAILED:
    'Demandez une nouvelle photo sur une feuille blanche, bien à plat et bien éclairée.',
  STAMP_EXTRACTION_FAILED:
    'Le tampon n’a pas été détecté. Demandez une photo avec un tampon bien encré et un cadrage plus large.',
  MENTION_EXTRACTION_FAILED:
    'La mention n’a pas été détectée. Demandez une écriture plus lisible de « Lu et approuvé ».',
  IMAGE_PROCESSING_FAILED: 'La photo est illisible. Demandez-en une avec plus de lumière.',
  TEMPLATE_NOT_FOUND:
    'Ce document n’a pas de zones de signature. Configurez-les avant de partager le lien.',
  TEMPLATE_ZONE_OUT_OF_RANGE:
    'Une zone du template sort du document. Corrigez-la dans l’éditeur de template.',
  PDF_GENERATION_FAILED: 'Le PDF signé n’a pas pu être écrit. Relancez la signature.',
  STORAGE_FAILED: 'Le stockage est indisponible. Réessayez dans un instant.',
  FILE_TOO_LARGE: 'Le fichier est trop volumineux.',
  INVALID_PDF: 'Ce PDF est illisible. Réexportez-le puis réimportez-le.',
};

export const notifyFolderFailed = async (
  ownerId: string,
  folderId: string,
  code: ErrorCode,
): Promise<void> => {
  const folder = await loadFolder(folderId);
  if (!folder) return;

  const what = ERROR_CODE_LABEL[code] ?? 'Une erreur est survenue';
  const next = RECOVERY[code] ?? 'Ouvrez le dossier pour réessayer.';

  await record({
    ownerId,
    folderId,
    title: `${folder.name} — action requise`,
    body: `${what}. ${next}`,
  });
  publish(ownerId, { type: 'folder.updated', folderId, status: 'error' });
};

/** The console's notification list. */
export const listNotifications = async (ownerId: string, limit = 50) => {
  const { data } = await db
    .from('notifications')
    .select('id, title, body, status, error, created_at, folder_id')
    .eq('owner_id', ownerId)
    .order('created_at', { ascending: false })
    .limit(limit);
  return data ?? [];
};
