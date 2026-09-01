import { env } from '../../env.js';
import { HttpError } from '../../lib/errors.js';
import type {
  ExtractionInput,
  ExtractionResult,
  ImageExtractionProvider,
} from './provider.js';

/**
 * Client for a local rembg server (MIT).
 *
 * The point of it: unmetered and on-premises. The hosted alternative bills per
 * image and uploads the photographed mark to a third party — for a product
 * whose whole job is handling signatures, both of those are real costs, and
 * neither is necessary when the same work runs on this machine's CPU.
 *
 * Two settings carry the quality:
 *
 *  - **The model.** `birefnet-general` resolves thin strokes and faint ink far
 *    better than the default `isnet-general-use`, which is precisely what a
 *    signature is made of. It is slower and downloads more weights once.
 *  - **Alpha matting.** rembg's segmentation returns a near-binary mask, and a
 *    binary mask around a pen stroke is a staircase. Matting re-estimates the
 *    boundary as real coverage, which is what keeps a stamped signature from
 *    looking cut out with scissors. It costs time, so it is a setting rather
 *    than a default nobody asked for.
 *
 * API surface used:
 *   POST /api/remove   multipart "file" -> PNG bytes
 *        query: model, a (alpha matting on), af/ab/ae (matting thresholds)
 */
export class RembgProvider implements ImageExtractionProvider {
  readonly name = 'rembg';

  constructor(
    private readonly baseUrl: string = env.REMBG_SERVICE_URL,
    private readonly model: string = env.REMBG_MODEL,
    private readonly alphaMatting: boolean = env.REMBG_ALPHA_MATTING,
    private readonly timeoutMs: number = env.REMBG_TIMEOUT_MS,
  ) {}

  async healthy(): Promise<boolean> {
    try {
      // No dedicated health route. `/api` is the docs page the server prints on
      // startup, and answering it proves the process is up without spending a
      // segmentation. (Not `/docs`: that 404s — the server mounts its docs at
      // /api.)
      const res = await this.fetchWithTimeout(`${this.baseUrl}/api`, { method: 'GET' }, 3000);
      return res.ok;
    } catch {
      return false;
    }
  }

  extractSignature(input: ExtractionInput): Promise<ExtractionResult> {
    return this.extract(input, 'SIGNATURE_EXTRACTION_FAILED');
  }

  extractStamp(input: ExtractionInput): Promise<ExtractionResult> {
    return this.extract(input, 'STAMP_EXTRACTION_FAILED');
  }

  private async extract(input: ExtractionInput, failureCode: string): Promise<ExtractionResult> {
    const params = new URLSearchParams({ model: this.model });
    if (this.alphaMatting) {
      params.set('a', 'true');
      // Foreground/background confidence thresholds, and the band between them
      // that matting is allowed to re-estimate. The defaults are tuned for
      // photographs of objects; ink needs a wider uncertain band, because a
      // pen stroke is mostly edge.
      params.set('af', String(env.REMBG_MATTING_FOREGROUND));
      params.set('ab', String(env.REMBG_MATTING_BACKGROUND));
      params.set('ae', String(env.REMBG_MATTING_ERODE));
    }

    const form = new FormData();
    form.append(
      'file',
      new Blob([Buffer.from(input.image)], { type: input.contentType }),
      'capture.png',
    );

    let response: Response;
    try {
      response = await this.fetchWithTimeout(
        `${this.baseUrl}/api/remove?${params.toString()}`,
        { method: 'POST', body: form },
        this.timeoutMs,
      );
    } catch (cause) {
      throw new HttpError(
        503,
        `rembg injoignable sur ${this.baseUrl}. Lancez-le avec "pnpm rembg:up".`,
        failureCode,
        { cause: String(cause) },
      );
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new HttpError(
        502,
        `rembg a refusé la requête (${response.status}). ${detail.slice(0, 200)}`.trim(),
        failureCode,
      );
    }

    const png = new Uint8Array(await response.arrayBuffer());
    if (png.byteLength === 0) {
      throw new HttpError(502, 'rembg a renvoyé une image vide.', failureCode);
    }

    return {
      png,
      meta: {
        provider: this.name,
        model: this.model,
        alphaMatting: this.alphaMatting,
        bytes: png.byteLength,
      },
    };
  }

  private async fetchWithTimeout(
    url: string,
    init: RequestInit,
    timeoutMs: number,
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }
}
