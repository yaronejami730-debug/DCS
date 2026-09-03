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

/**
 * A one-shot URL the browser can PUT a file to, straight into the bucket.
 *
 * Vercel caps a function's request body at 4.5 MB; a 30-page study is more.
 * So large files never travel through the API: the API signs a destination,
 * the browser uploads there, then tells the API where the file landed.
 */
export const createSignedUploadUrl = async (
  path: string,
): Promise<{ signedUrl: string; token: string; path: string }> => {
  const { data, error } = await db.storage.from(BUCKET).createSignedUploadUrl(path);
  if (error || !data) throw new HttpError(500, `Stockage: ${error?.message ?? 'signature impossible'}`, 'STORAGE_FAILED');
  return { signedUrl: data.signedUrl, token: data.token, path: data.path };
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
