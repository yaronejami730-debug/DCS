import { createHash } from 'node:crypto';

/**
 * SHA-256 of the raw PDF bytes, lowercase hex.
 * This is the primary key for matching an uploaded document to a template —
 * far more reliable than a filename, which users rename freely.
 */
export const sha256 = (bytes: Uint8Array | Buffer): string =>
  createHash('sha256').update(bytes).digest('hex');

/**
 * Glob-ish filename matcher used as the *fallback* template matcher.
 * Supports `*` (any run of characters) and `?` (one character), case-insensitive.
 */
export const matchesFilenamePattern = (filename: string, pattern: string): boolean => {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`^${escaped.replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i');
  return regex.test(filename);
};
