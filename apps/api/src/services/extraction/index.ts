import { env } from '../../env.js';
import { SignatureRemoveBgProvider } from './signature-remove-bg.js';
import { RemoveBgProvider } from './remove-bg.js';
import { RembgProvider } from './rembg.js';
import { FallbackExtractionProvider } from './fallback.js';
import type { ImageExtractionProvider } from './provider.js';

export * from './provider.js';
export { SignatureRemoveBgProvider } from './signature-remove-bg.js';
export { RemoveBgProvider } from './remove-bg.js';
export { RembgProvider } from './rembg.js';
export { FallbackExtractionProvider } from './fallback.js';

/**
 * Which engine to cut a mark out with.
 *
 *   removebg  the hosted remove.bg API. The default: on real captures it
 *             removed desk shadow and neighbouring handwriting that the local
 *             engine kept. Metered, and the photograph leaves this machine.
 *   local     signature-remove-bg, in a container on our own server. Free, and
 *             nothing is uploaded anywhere.
 *
 * Whichever is chosen, the other stands behind it: see FallbackExtractionProvider
 * for exactly which failures fall through and which do not.
 */
export const EXTRACTION_ENGINES = ['rembg', 'local', 'removebg'] as const;
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
  if (!env.EXTRACTION_FALLBACK) return bare(engine);

  let provider = composed.get(engine);
  if (!provider) {
    // Fall back to the on-premises engine that costs nothing: a metered API is
    // the wrong thing to reach for when the chosen engine is merely down.
    const other: ExtractionEngine = engine === 'local' ? 'rembg' : 'local';
    provider = new FallbackExtractionProvider(bare(engine), bare(other));
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
