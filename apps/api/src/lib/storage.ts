import { BUCKET, db } from './supabase.js';
import { HttpError } from './errors.js';

export const uploadObject = async (
  path: string,
  bytes: Uint8Array | Buffer,
  contentType: string,
): Promise<void> => {
  const { error } = await db.storage
    .from(BUCKET)
    .upload(path, Buffer.from(bytes), { contentType, upsert: true });
  if (error) throw new HttpError(500, `Stockage: ${error.message}`, 'STORAGE_FAILED');
};

export const downloadObject = async (path: string): Promise<Uint8Array> => {
  const { data, error } = await db.storage.from(BUCKET).download(path);
  if (error || !data) {
    throw new HttpError(500, `Stockage: ${error?.message ?? 'fichier introuvable'}`, 'STORAGE_FAILED');
  }
  return new Uint8Array(await data.arrayBuffer());
};

/** Short-lived signed URL. The bucket is private; this is the only way out. */
export const signedUrl = async (path: string, expiresInSeconds = 900): Promise<string> => {
  const { data, error } = await db.storage.from(BUCKET).createSignedUrl(path, expiresInSeconds);
  if (error || !data) {
    throw new HttpError(500, `Stockage: ${error?.message ?? 'URL indisponible'}`, 'STORAGE_FAILED');
  }
  return data.signedUrl;
};

/** Best-effort delete used by the retention policy. Never throws. */
export const removeObjects = async (paths: string[]): Promise<void> => {
  const clean = paths.filter(Boolean);
  if (clean.length === 0) return;
  const { error } = await db.storage.from(BUCKET).remove(clean);
  if (error) console.warn('[storage] cleanup failed: %s', error.message);
};
