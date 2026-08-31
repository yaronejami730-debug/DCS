/**
 * The seam that keeps Scan&Sign from being welded to one image engine.
 *
 * V1 ships SignatureRemoveBgProvider (fchaussin/signature-remove-bg), which is
 * tuned for dark/blue handwritten ink. Stamps are a different problem — often
 * coloured, often ringed — and the upstream project does not claim to handle
 * them. If the stamp results are not good enough, implement this interface
 * against another engine and swap it in `createExtractionProvider()`; nothing
 * else in the codebase changes.
 */

export interface ExtractionInput {
  /** Cropped region: just the signature, or just the stamp. */
  image: Uint8Array;
  /** MIME of `image`, e.g. image/png. */
  contentType: string;
}

export interface ExtractionResult {
  /** Transparent PNG. */
  png: Uint8Array;
  /** Free-form provider diagnostics, stored in the audit log. */
  meta?: Record<string, unknown>;
}

export interface ImageExtractionProvider {
  readonly name: string;
  /** True when the backing engine answers. Used by /health. */
  healthy(): Promise<boolean>;
  extractSignature(input: ExtractionInput): Promise<ExtractionResult>;
  extractStamp(input: ExtractionInput): Promise<ExtractionResult>;
}
