import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/**
 * Load the single .env at the repo root.
 *
 * The compiled bundle lives at a different depth than the source tree, so
 * rather than hard-coding "../../..", walk up from both the module and the
 * working directory until a .env turns up.
 */
const findEnvFile = (): string | null => {
  const starts = [dirname(fileURLToPath(import.meta.url)), process.cwd()];
  for (const start of starts) {
    let current = start;
    for (let depth = 0; depth < 6; depth++) {
      const candidate = resolve(current, '.env');
      if (existsSync(candidate)) return candidate;
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  return null;
};

const envFile = findEnvFile();
if (envFile) loadDotenv({ path: envFile, quiet: true });
loadDotenv({ quiet: true });

const bool = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? fallback : v === 'true' || v === '1'));

/** A float within [min, max], for the knobs that are ratios rather than counts. */
const num = (fallback: number, min: number, max: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? fallback : Number(v)))
    .pipe(z.number().min(min).max(max));

const int = (fallback: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? fallback : Number(v)))
    .pipe(z.number().int().positive());

const envSchema = z.object({
  SUPABASE_URL: z.string().url(),
  SUPABASE_ANON_KEY: z.string().min(20),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),
  SUPABASE_STORAGE_BUCKET: z.string().default('scansign'),

  API_PORT: int(8787),
  API_HOST: z.string().default('0.0.0.0'),
  API_PUBLIC_URL: z.string().default('http://localhost:8787'),
  /**
   * Where the signing app is served, used to assemble share links.
   *
   * Every link the console shows is built from this, so a wrong value here
   * produces links that look right and go nowhere. In production it is the
   * public HTTPS origin of the signer app — never localhost.
   */
  SIGNER_PUBLIC_URL: z.string().default('http://localhost:5174'),
  CORS_ORIGINS: z.string().default('http://localhost:5173,http://localhost:5174'),

  SIGNATURE_SERVICE_URL: z.string().url().default('http://localhost:8000'),
  SIGNATURE_EXTRACT_MODE: z.enum(['auto', 'dark', 'blue']).default('auto'),
  STAMP_EXTRACT_MODE: z.enum(['auto', 'dark', 'blue']).default('auto'),
  SIGNATURE_USE_ANALYZE: bool(true),
  SIGNATURE_SERVICE_TIMEOUT_MS: int(30_000),

  /**
   * remove.bg, offered beside the local engine so the two can be compared on
   * the same crop. Optional: without a key the second preview button reports
   * that it is not configured, and nothing else changes.
   *
   * Note what turning it on means — each call uploads the photographed mark to
   * a third party, where the local engine keeps it on this machine — so it is
   * opt-in per request and never used by the batch that signs documents.
   */
  REMOVEBG_API_KEY: z.string().optional(),
  REMOVEBG_SIZE: z.enum(['preview', 'small', 'regular', 'medium', 'hd', 'full', 'auto']).default('auto'),

  /**
   * Which engine cuts marks out, for previews and for the signing pipeline.
   *
   * `removebg` is the default: on the captures tested it removed desk shadow
   * and neighbouring handwriting that the local engine kept as solid black.
   * The price is real — every capture is uploaded to a third party, and every
   * extraction spends a credit — so this is a deliberate setting, not a
   * detail. `local` returns to the on-premises container, which is free and
   * keeps photographs on this machine.
   */
  /**
   * rembg — local, free and unmetered background removal (MIT).
   *
   * `birefnet-general` resolves thin strokes and faint ink far better than the
   * default `isnet-general-use`, which is what a signature is made of; it costs
   * a bigger one-time download and a slower call. Alpha matting re-estimates
   * the stroke boundary as real coverage instead of the near-binary mask
   * segmentation returns — a binary mask around a pen stroke is a staircase.
   */
  REMBG_SERVICE_URL: z.string().url().default('http://localhost:7001'),
  REMBG_MODEL: z.string().default('birefnet-general'),
  REMBG_ALPHA_MATTING: bool(true),
  REMBG_MATTING_FOREGROUND: int(240),
  REMBG_MATTING_BACKGROUND: int(15),
  REMBG_MATTING_ERODE: int(12),
  REMBG_TIMEOUT_MS: int(120_000),

  EXTRACTION_ENGINE: z.enum(['rembg', 'removebg', 'local']).default('rembg'),
  /**
   * Use the other engine when the chosen one cannot answer at all — no key, no
   * credits, service down. Without this a lapsed subscription stops signing
   * outright, mid-session, with no way forward for the signer.
   *
   * "No ink in this frame" is never a fallback: that is a verdict about the
   * photograph and it must reach the signer as-is.
   */
  EXTRACTION_FALLBACK: bool(true),

  /**
   * How a mark is scaled into the zone drawn for it.
   *
   * `FILL` is the fraction of the zone's WIDTH the mark takes. Width leads
   * because that is the dimension operators draw deliberately; strict
   * contain-fit was height-led and left marks filling as little as 23% of the
   * box, which is what "signature trop petite" meant.
   *
   * `MAX_OVERFLOW` caps how far the mark's height may exceed the zone's, so a
   * squarish mark in a flat box grows to a readable size without climbing into
   * the printed text. Set it to 1 for the old strict-contain behaviour.
   */
  MARK_FILL: num(1, 0.3, 1),
  MARK_MAX_OVERFLOW: num(1.5, 1, 3),

  MAX_PDF_BYTES: int(26_214_400),
  MAX_IMAGE_BYTES: int(20_971_520),

  RETENTION_DELETE_PHOTO_AFTER_SUCCESS: bool(true),
  RETENTION_KEEP_CUTOUTS: bool(true),
  RETENTION_PHOTO_MAX_AGE_DAYS: int(7),

  // Create accounts already confirmed, so the operator can sign in on the
  // console straight away. Turn OFF if you enable Supabase email confirmation
  // and want the mail round-trip enforced.
  AUTO_CONFIRM_SIGNUP: bool(true),
  // Vary each handwritten mark slightly per document and per zone, so a folder
  // does not carry one identical bitmap stamped repeatedly. Deterministic:
  // regenerating a document reproduces it exactly. Cosmetic only.
  SIGNATURE_VARIANTS: bool(true),
  /**
   * How variants are produced.
   *
   * `sigma_lognormal` traces the pen trajectory out of the cutout, decomposes
   * it with the Kinematic Theory's Sigma-Lognormal model and perturbs the motor
   * parameters — the signature is re-signed rather than re-filtered. It falls
   * back to `filter` on its own whenever a mark cannot be modelled, so this is
   * safe to leave on; set `filter` to force the old affine + drift + pen path.
   */
  SIGNATURE_VARIANT_ENGINE: z.enum(['sigma_lognormal', 'filter']).default('sigma_lognormal'),
  /**
   * How far apart the variants are, as a multiplier on the motor-parameter
   * ranges.
   *
   * 1 is the conservative default: the spread of one person signing twice in a
   * row, which is deliberately small — the marks must still read as the same
   * hand. Raise it towards 2 for the wider spread of the same person signing on
   * different days; past that the letterforms start to drift far enough that
   * two variants no longer look like the same signature.
   */
  SIGNATURE_VARIATION_STRENGTH: num(1, 0.25, 3),
  // Set false once your accounts exist to close public account creation.
  ALLOW_SELF_SIGNUP: bool(true),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
    .join('\n');
  throw new Error(
    `Invalid environment. Copy .env.example to .env and fill it in.\n${issues}`,
  );
}

export const env = {
  ...parsed.data,
  corsOrigins: parsed.data.CORS_ORIGINS.split(',')
    .map((o) => o.trim())
    .filter(Boolean),
};

export type Env = typeof env;
