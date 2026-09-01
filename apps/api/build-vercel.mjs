#!/usr/bin/env node
/**
 * Bundle the serverless entry point for Vercel.
 *
 * Same reasoning as build.mjs: the workspace packages are consumed as
 * TypeScript source, and Vercel's own function bundler leaves them as runtime
 * imports of .ts files Node cannot load. Bundling here inlines everything, so
 * the function Vercel deploys is a single self-contained JS file.
 *
 * `sharp` stays external — prebuilt native binaries, loaded from node_modules,
 * which Vercel's file tracing includes on its own.
 */
import { build } from 'esbuild';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));

await build({
  entryPoints: [resolve(root, 'api/index.ts')],
  outfile: resolve(root, 'api/index.js'),
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  sourcemap: false,
  minify: false,
  external: ['sharp'],
  banner: {
    js: [
      "import { createRequire as __createRequire } from 'node:module';",
      'const require = __createRequire(import.meta.url);',
    ].join('\n'),
  },
  logLevel: 'info',
});

/**
 * On Vercel only, remove the TypeScript entry after bundling.
 *
 * Both api/index.ts and the bundled api/index.js would otherwise be picked up
 * as two functions for the same route — and the .ts one is exactly the
 * unresolvable-workspace-imports version this bundle exists to replace.
 * Locally the source must stay, so the guard is the platform env var.
 */
if (process.env.VERCEL) {
  const { rm } = await import('node:fs/promises');
  await rm(resolve(root, 'api/index.ts'));
}
