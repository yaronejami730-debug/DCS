import { env } from '../../env.js';
import { HttpError } from '../../lib/errors.js';
import type {
  ExtractionInput,
  ExtractionResult,
  ImageExtractionProvider,
} from './provider.js';

/**
 * Client for fchaussin/signature-remove-bg (MIT, ~30 MB RAM, no ML/GPU).
 *
 * Verified API surface:
 *   POST /extract?mode=auto|dark|blue&steps=…&format=png|webp&output=binary|base64
 *        multipart/form-data, field name "file" -> image blob
 *   POST /analyze   multipart "file" -> { mode, steps: [{effect, value}, …] }
 *   GET  /health    -> { status: "ok" }
 */
export class SignatureRemoveBgProvider implements ImageExtractionProvider {
  readonly name = 'signature-remove-bg';

  constructor(
    private readonly baseUrl: string = env.SIGNATURE_SERVICE_URL,
    private readonly timeoutMs: number = env.SIGNATURE_SERVICE_TIMEOUT_MS,
  ) {}

  async healthy(): Promise<boolean> {
    try {
      const res = await this.fetchWithTimeout(`${this.baseUrl}/health`, { method: 'GET' }, 3000);
      if (!res.ok) return false;
      const body = (await res.json()) as { status?: string };
      return body.status === 'ok';
    } catch {
      return false;
    }
  }

  extractSignature(input: ExtractionInput): Promise<ExtractionResult> {
    return this.extract(input, env.SIGNATURE_EXTRACT_MODE, 'SIGNATURE_EXTRACTION_FAILED');
  }

  extractStamp(input: ExtractionInput): Promise<ExtractionResult> {
    return this.extract(input, env.STAMP_EXTRACT_MODE, 'STAMP_EXTRACTION_FAILED');
  }

  /**
   * Ask /analyze for per-image parameters, then run /extract with them.
   * A failing /analyze is not fatal: we fall back to the configured mode,
   * which is exactly what the upstream `auto` mode is for.
   */
  private async extract(
    input: ExtractionInput,
    mode: 'auto' | 'dark' | 'blue',
    failureCode: string,
  ): Promise<ExtractionResult> {
    const analysis = env.SIGNATURE_USE_ANALYZE ? await this.analyze(input) : null;

    const params = new URLSearchParams({
      mode: analysis?.mode ?? mode,
      format: 'png',
      output: 'binary',
    });
    if (analysis?.steps?.length) params.set('steps', analysis.steps);

    const res = await this.post(`/extract?${params.toString()}`, input, failureCode);

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new HttpError(
        502,
        `Détourage refusé par le moteur (${res.status}). ${detail.slice(0, 200)}`,
        failureCode,
      );
    }

    const png = new Uint8Array(await res.arrayBuffer());
    if (png.byteLength === 0) {
      throw new HttpError(502, 'Le moteur de détourage a renvoyé une image vide.', failureCode);
    }
    return {
      png,
      meta: {
        provider: this.name,
        mode: analysis?.mode ?? mode,
        steps: analysis?.steps ?? null,
        bytes: png.byteLength,
      },
    };
  }

  private async analyze(
    input: ExtractionInput,
  ): Promise<{ mode: string; steps: string } | null> {
    try {
      const res = await this.post('/analyze', input, 'IMAGE_PROCESSING_FAILED');
      if (!res.ok) return null;
      const body = (await res.json()) as {
        mode?: string;
        steps?: Array<{ effect: string; value: number | string }>;
      };
      if (!body.mode) return null;
      /**
       * Drop the engine's own smoothing, whatever /analyze asked for.
       *
       * The engine's `smoothing` does not soften the edge of the mask, it
       * blurs the whole mark: measured on a real capture it took mean opacity
       * from 246 to 96, which is precisely the washed-out cutout users
       * complain about — grey strokes over a faint haze instead of ink. It
       * also defeats the trim, because a frame that is 40% opaque everywhere
       * has no transparent border to cut away.
       *
       * The edge gradient a stamped signature needs is produced afterwards, by
       * `smoothEdges`, where it can be confined to the alpha channel and to the
       * boundary. So the engine is asked for a crisp mask and nothing else.
       * /analyze is still worth calling — its threshold and mode are per-image
       * and good — but this one step has to be overridden every time, since the
       * service keeps proposing it.
       */
      const steps = (body.steps ?? [])
        .filter((s) => s.effect !== 'smoothing')
        .map((s) => `${s.effect}:${s.value}`)
        .concat('smoothing:0')
        .join(',');
      return { mode: body.mode, steps };
    } catch {
      return null;
    }
  }

  private async post(
    path: string,
    input: ExtractionInput,
    failureCode: string,
  ): Promise<Response> {
    const form = new FormData();
    form.append(
      'file',
      new Blob([Buffer.from(input.image)], { type: input.contentType }),
      'capture.png',
    );
    try {
      return await this.fetchWithTimeout(
        `${this.baseUrl}${path}`,
        { method: 'POST', body: form },
        this.timeoutMs,
      );
    } catch (cause) {
      throw new HttpError(
        503,
        `Moteur de détourage injoignable sur ${this.baseUrl}. Lancez-le avec "pnpm extractor:up".`,
        failureCode,
        { cause: String(cause) },
      );
    }
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
