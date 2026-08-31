import { SignatureRemoveBgProvider } from './signature-remove-bg.js';
import type { ImageExtractionProvider } from './provider.js';

export * from './provider.js';
export { SignatureRemoveBgProvider } from './signature-remove-bg.js';

let cached: ImageExtractionProvider | null = null;

/**
 * Single place to swap the extraction engine. To try a stamp-specialised
 * service, implement ImageExtractionProvider and return it from here — no
 * other file needs to know.
 */
export const createExtractionProvider = (): ImageExtractionProvider => {
  cached ??= new SignatureRemoveBgProvider();
  return cached;
};

/** Test seam. */
export const setExtractionProvider = (provider: ImageExtractionProvider | null): void => {
  cached = provider;
};
