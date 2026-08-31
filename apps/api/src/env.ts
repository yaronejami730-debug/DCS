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
  CORS_ORIGINS: z.string().default('http://localhost:5173'),

  SIGNATURE_SERVICE_URL: z.string().url().default('http://localhost:8000'),
  SIGNATURE_EXTRACT_MODE: z.enum(['auto', 'dark', 'blue']).default('auto'),
  STAMP_EXTRACT_MODE: z.enum(['auto', 'dark', 'blue']).default('auto'),
  SIGNATURE_USE_ANALYZE: bool(true),
  SIGNATURE_SERVICE_TIMEOUT_MS: int(30_000),

  MAX_PDF_BYTES: int(26_214_400),
  MAX_IMAGE_BYTES: int(20_971_520),

  RETENTION_DELETE_PHOTO_AFTER_SUCCESS: bool(true),
  RETENTION_KEEP_CUTOUTS: bool(true),
  RETENTION_PHOTO_MAX_AGE_DAYS: int(7),

  EXPO_ACCESS_TOKEN: z.string().optional(),

  // Create accounts already confirmed, so the operator can sign in on the
  // console and on the phone straight away. Turn OFF if you enable Supabase
  // email confirmation and want the mail round-trip enforced.
  AUTO_CONFIRM_SIGNUP: bool(true),
  // Vary each handwritten mark slightly per document and per zone, so a folder
  // does not carry one identical bitmap stamped repeatedly. Deterministic:
  // regenerating a document reproduces it exactly. Cosmetic only.
  SIGNATURE_VARIANTS: bool(true),
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
