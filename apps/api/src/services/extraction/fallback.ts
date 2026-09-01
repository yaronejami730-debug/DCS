import { HttpError } from '../../lib/errors.js';
import type {
  ExtractionInput,
  ExtractionResult,
  ImageExtractionProvider,
} from './provider.js';

/**
 * Run one engine, and if it cannot answer, run the other.
 *
 * The reason this exists: the primary engine is now a metered third-party API,
 * and the signing pipeline depends on it. Without a fallback, an expired card
 * or an outage does not degrade the product — it stops it, mid-signature, with
 * the signer holding a phone and no way forward. That is the same dead end a
 * folder stuck in `error` produced, and it is worth avoiding twice.
 *
 * The distinction that makes this safe is *which* failures fall through.
 *
 *   Fall back — the engine could not be reached, is not configured, is out of
 *   credits, refused the key, or broke internally. Nothing was learned about
 *   the image; another engine may well succeed.
 *
 *   Do not fall back — the engine ran and found no ink in the frame. That is an
 *   answer about the photograph, not a fault of the service, and the signer
 *   needs to hear it so they can widen the box or retake the photo. Retrying on
 *   a second engine would bury a real problem under a worse cutout.
 */
export class FallbackExtractionProvider implements ImageExtractionProvider {
  readonly name: string;

  constructor(
    private readonly primary: ImageExtractionProvider,
    private readonly secondary: ImageExtractionProvider,
  ) {
    this.name = `${primary.name}+${secondary.name}`;
  }

  /** Healthy if either engine can answer. */
  async healthy(): Promise<boolean> {
    return (await this.primary.healthy()) || (await this.secondary.healthy());
  }

  extractSignature(input: ExtractionInput): Promise<ExtractionResult> {
    return this.run(input, (p) => p.extractSignature(input));
  }

  extractStamp(input: ExtractionInput): Promise<ExtractionResult> {
    return this.run(input, (p) => p.extractStamp(input));
  }

  private async run(
    _input: ExtractionInput,
    call: (provider: ImageExtractionProvider) => Promise<ExtractionResult>,
  ): Promise<ExtractionResult> {
    try {
      const result = await call(this.primary);
      return { ...result, meta: { ...result.meta, engine: this.primary.name, fellBack: false } };
    } catch (error) {
      if (!isServiceFailure(error)) throw error;

      // Worth a line in the log: a run that quietly used the other engine has a
      // different cost and a different cutout quality, and nothing else records
      // which one produced the signature on the document.
      console.warn(
        '[extraction] %s unavailable (%s) — falling back to %s',
        this.primary.name,
        error instanceof Error ? error.message : String(error),
        this.secondary.name,
      );

      const result = await call(this.secondary);
      return {
        ...result,
        meta: {
          ...result.meta,
          engine: this.secondary.name,
          fellBack: true,
          fellBackFrom: this.primary.name,
          reason: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }
}

/**
 * Is this "the engine could not answer", rather than "the engine answered, and
 * the answer is that there is no ink here"?
 */
const isServiceFailure = (error: unknown): boolean => {
  if (!(error instanceof HttpError)) return true;
  // 422 is the engine's verdict on the image itself — an empty cutout, an
  // unreadable result — and must reach the signer unchanged.
  return error.status !== 422;
};
