import { env } from '../../env.js';
import { SignatureRemoveBgProvider } from './signature-remove-bg.js';
import { RemoveBgProvider } from './remove-bg.js';
import { RembgProvider } from './rembg.js';
import { FallbackExtractionProvider } from './fallback.js';
import { BuiltinInkProvider } from './builtin.js';
import type { ImageExtractionProvider } from './provider.js';

export * from './provider.js';
export { SignatureRemoveBgProvider } from './signature-remove-bg.js';
export { RemoveBgProvider } from './remove-bg.js';
export { RembgProvider } from './rembg.js';
export { FallbackExtractionProvider } from './fallback.js';
export { BuiltinInkProvider } from './builtin.js';

/**
 * Which engine to cut a mark out with.
 *
 *   removebg  the hosted remove.bg API. The default: on real captures it
 *             removed desk shadow and neighbouring handwriting that the local
 *             engine kept. Metered, and the photograph leaves this machine.
 *   local     signature-remove-bg, in a container on our own server. Free, and
 *             nothing is uploaded anywhere.
 *   builtin   ink thresholding inside this process. No service, no model; made
 *             for paper and ink, which is what the capture sheet delivers.
 *
 * Whichever is chosen, `builtin` stands behind it — it is the one engine that
 * cannot be down, and it needs neither Docker nor a subscription. See
 * FallbackExtractionProvider for exactly which failures fall through.
 */
export const EXTRACTION_ENGINES = ['rembg', 'local', 'removebg', 'builtin'] as const;
export type ExtractionEngine = (typeof EXTRACTION_ENGINES)[number];

const singletons = new Map<ExtractionEngine, ImageExtractionProvider>();
const composed = new Map<ExtractionEngine, ImageExtractionProvider>();
let override: ImageExtractionProvider | null = null;

const bare = (engine: ExtractionEngine): ImageExtractionProvider => {
  let provider = singletons.get(engine);
  if (!provider) {
    provider =
      engine === 'removebg'
        ? new RemoveBgProvider()
        : engine === 'rembg'
          ? new RembgProvider()
          : engine === 'builtin'
            ? new BuiltinInkProvider()
            : new SignatureRemoveBgProvider();
    singletons.set(engine, provider);
  }
  return provider;
};

/**
 * The engine to use. Defaults to whatever EXTRACTION_ENGINE says, so the
 * signing pipeline and the preview agree unless a caller asks for one by name —
 * which the preview does, to put the two side by side on the same crop.
 */
export const createExtractionProvider = (
  engine: ExtractionEngine = env.EXTRACTION_ENGINE,
): ImageExtractionProvider => {
  if (override) return override;
  if (!env.EXTRACTION_FALLBACK || engine === 'builtin') return bare(engine);

  let provider = composed.get(engine);
  if (!provider) {
    // Fall back to the engine that is always there and costs nothing. The
    // containers used to be the fallback, but a fallback that needs Docker is
    // no fallback on a machine without it — which is how a clean scan refused
    // by remove.bg ended as "moteur de détourage injoignable".
    provider = new FallbackExtractionProvider(bare(engine), bare('builtin'));
    composed.set(engine, provider);
  }
  return provider;
};

/** Test seam: force every engine to resolve to this provider. */
export const setExtractionProvider = (provider: ImageExtractionProvider | null): void => {
  override = provider;
  if (!provider) {
    singletons.clear();
    composed.clear();
  }
};
