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
