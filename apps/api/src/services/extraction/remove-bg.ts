import { env } from '../../env.js';
import { HttpError } from '../../lib/errors.js';
import type {
  ExtractionInput,
  ExtractionResult,
  ImageExtractionProvider,
} from './provider.js';

/**
 * Client for remove.bg's hosted API.
 *
 * Offered beside the local engine so the two can be compared on the same crop,
 * which is the only way to settle which one actually cuts a signature better.
 *
 * Two things to know before making it the default:
 *
 *  - **It is off-premises.** Every call uploads the photographed mark to a
 *    third party. The local engine runs in a container on this machine and the
 *    image never leaves it. For a signing product that difference is not a
 *    detail, so this provider is opt-in per request rather than a global
 *    default, and it refuses to run at all without a key.
 *  - **It is metered.** Each call spends a credit, so it belongs on a button
 *    the operator presses, not in the batch that signs a folder of documents.
 *
 * API surface used:
 *   POST https://api.remove.bg/v1.0/removebg
 *        header  X-Api-Key
 *        form    image_file, size, format, channels
 *        -> PNG bytes, or JSON { errors: [{ title, detail }] }
 */
export class RemoveBgProvider implements ImageExtractionProvider {
  readonly name = 'remove.bg';

  constructor(
    private readonly apiKey: string | undefined = env.REMOVEBG_API_KEY,
    private readonly size: string = env.REMOVEBG_SIZE,
    private readonly timeoutMs: number = env.SIGNATURE_SERVICE_TIMEOUT_MS,
    /** Injectable so the client can be exercised without spending credits. */
    private readonly endpoint: string = 'https://api.remove.bg/v1.0/removebg',
  ) {}

  /** Configured at all? The key is the only precondition worth checking. */
  async healthy(): Promise<boolean> {
    return Boolean(this.apiKey);
  }

  extractSignature(input: ExtractionInput): Promise<ExtractionResult> {
    return this.extract(input, 'SIGNATURE_EXTRACTION_FAILED');
  }

  extractStamp(input: ExtractionInput): Promise<ExtractionResult> {
    return this.extract(input, 'STAMP_EXTRACTION_FAILED');
  }

  private async extract(input: ExtractionInput, failureCode: string): Promise<ExtractionResult> {
    if (!this.apiKey) {
      throw new HttpError(
        503,
        'remove.bg n’est pas configuré : ajoutez REMOVEBG_API_KEY au fichier .env.',
        failureCode,
      );
    }

    const form = new FormData();
    form.append(
      'image_file',
      new Blob([Buffer.from(input.image)], { type: input.contentType }),
      'capture.png',
    );
    form.append('size', this.size);
    form.append('format', 'png');
    // Ask for the full RGBA cutout rather than a bare mask: the pen's own
    // colour is what the rest of the pipeline re-inks and preserves.
    form.append('channels', 'rgba');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await fetch(this.endpoint, {
        method: 'POST',
        headers: { 'X-Api-Key': this.apiKey },
        body: form,
        signal: controller.signal,
      });
    } catch (cause) {
      throw new HttpError(503, 'remove.bg injoignable.', failureCode, { cause: String(cause) });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      // Errors come back as JSON; surface the reason rather than a bare status,
      // since "out of credits" and "bad key" need very different reactions.
      const detail = await this.readError(response);
      const message =
        response.status === 402
          ? `remove.bg : crédits épuisés. ${detail}`
          : response.status === 403
            ? `remove.bg : clé API refusée. ${detail}`
            : `remove.bg a refusé la requête (${response.status}). ${detail}`;
      throw new HttpError(502, message.trim(), failureCode);
    }

    const png = new Uint8Array(await response.arrayBuffer());
    if (png.byteLength === 0) {
      throw new HttpError(502, 'remove.bg a renvoyé une image vide.', failureCode);
    }

    return {
      png,
      meta: {
        provider: this.name,
        size: this.size,
        bytes: png.byteLength,
        // Remaining balance, so the operator is not surprised by a 402.
        creditsCharged: response.headers.get('X-Credits-Charged'),
      },
    };
  }

  private async readError(response: Response): Promise<string> {
    try {
      const body = (await response.json()) as {
        errors?: Array<{ title?: string; detail?: string }>;
      };
      return (body.errors ?? [])
        .map((e) => [e.title, e.detail].filter(Boolean).join(' — '))
        .join('; ')
        .slice(0, 200);
    } catch {
      return '';
    }
  }
}
