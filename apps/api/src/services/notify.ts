import { ERROR_CODE_LABEL, type ErrorCode } from '@scansign/shared';
import { db } from '../lib/supabase.js';
import { sendPush } from './push.js';
import { publish } from '../lib/realtime.js';

/**
 * Every notification the product sends, in one place.
 *
 * Two rules shape the wording:
 *
 *  1. Say what happened AND what to do about it. "Échec du détourage" tells the
 *     signer nothing they can act on; "la signature n'a pas pu être détourée —
 *     reprenez la photo sur une feuille bien éclairée" does.
 *  2. Never send a notification the recipient cannot act on or does not care
 *     about. A device does not need telling that its own upload succeeded.
 *
 * Delivery is best-effort by design: a failed push must never fail the work it
 * was reporting on. Everything is recorded in `notifications` either way, so
 * the console can show what was sent and what could not be.
 */

interface FolderRef {
  id: string;
  name: string;
  deviceId: string | null;
}

const loadFolder = async (folderId: string): Promise<FolderRef | null> => {
  const { data } = await db
    .from('folders')
    .select('id, name, device_id')
    .eq('id', folderId)
    .maybeSingle<{ id: string; name: string; device_id: string | null }>();
  return data ? { id: data.id, name: data.name, deviceId: data.device_id } : null;
};

/** A document is waiting on the device. Sent when the console presses Envoyer. */
export const notifyFolderSent = async (
  ownerId: string,
  folderId: string,
  documentCount: number,
): Promise<void> => {
  const folder = await loadFolder(folderId);
  if (!folder) return;

  await sendPush({
    ownerId,
    deviceId: folder.deviceId,
    folderId,
    title: 'Nouveau document à signer',
    body:
      documentCount > 1
        ? `${folder.name} — ${documentCount} documents vous attendent. Ouvrez pour signer.`
        : `${folder.name} vous attend. Ouvrez pour signer.`,
    data: { kind: 'folder.sent' },
  });
};

/** Everything in the folder is signed. */
export const notifyFolderCompleted = async (
  ownerId: string,
  folderId: string,
  documentCount: number,
): Promise<void> => {
  const folder = await loadFolder(folderId);
  if (!folder) return;

  await sendPush({
    ownerId,
    deviceId: folder.deviceId,
    folderId,
    title: 'Document signé',
    body:
      documentCount > 1
        ? `${folder.name} — ${documentCount} documents signés. Ils sont disponibles dans votre espace web.`
        : `${folder.name} est signé. Il est disponible dans votre espace web.`,
    data: { kind: 'folder.completed' },
  });
};

/**
 * Something went wrong. The body has to say what the person can do next,
 * because a code on its own leaves them stuck.
 */
const RECOVERY: Partial<Record<ErrorCode, string>> = {
  SIGNATURE_EXTRACTION_FAILED:
    'Reprenez la photo sur une feuille blanche, bien à plat et bien éclairée, puis recadrez la signature.',
  STAMP_EXTRACTION_FAILED:
    'Le tampon n’a pas été détecté. Reprenez la photo avec un tampon bien encré et un cadrage plus large.',
  MENTION_EXTRACTION_FAILED:
    'La mention n’a pas été détectée. Réécrivez « Lu et approuvé » plus lisiblement et reprenez la photo.',
  IMAGE_PROCESSING_FAILED: 'La photo est illisible. Reprenez-la avec plus de lumière.',
  TEMPLATE_NOT_FOUND:
    'Ce document n’a pas de zones de signature. Configurez-les dans la console avant de l’envoyer.',
  TEMPLATE_ZONE_OUT_OF_RANGE:
    'Une zone du template sort du document. Corrigez-la dans l’éditeur de template.',
  PDF_GENERATION_FAILED: 'Le PDF signé n’a pas pu être écrit. Réessayez la signature.',
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

  await sendPush({
    ownerId,
    deviceId: folder.deviceId,
    folderId,
    title: `${folder.name} — action requise`,
    body: `${what}. ${next}`,
    data: { kind: 'folder.failed', code },
  });
};

/** The device opened the folder. Useful to the console, not to the phone. */
export const notifyFolderDelivered = async (
  ownerId: string,
  folderId: string,
): Promise<void> => {
  const folder = await loadFolder(folderId);
  if (!folder) return;

  // Recorded for the console's activity feed; deliberately not pushed to the
  // device, which is the one that just did it.
  await db.from('notifications').insert({
    owner_id: ownerId,
    device_id: folder.deviceId,
    folder_id: folderId,
    title: 'Dossier reçu',
    body: `${folder.name} a été ouvert sur l’appareil.`,
    status: 'recorded',
  });
  publish(ownerId, { type: 'folder.updated', folderId, status: 'delivered' });
};

/** The console's notification list. */
export const listNotifications = async (ownerId: string, limit = 50) => {
  const { data } = await db
    .from('notifications')
    .select('id, title, body, status, error, created_at, folder_id, device_id')
    .eq('owner_id', ownerId)
    .order('created_at', { ascending: false })
    .limit(limit);
  return data ?? [];
};
