#!/usr/bin/env node
/**
 * Bundle the API into a single ESM file.
 *
 * The workspace packages are consumed as TypeScript source, so plain `tsc`
 * would emit an unresolvable import at runtime. Bundling inlines them and
 * makes `node dist/index.js` genuinely runnable.
 *
 * `sharp` stays external: it ships prebuilt native binaries that must be
 * loaded from node_modules, not inlined.
 */
import { build } from 'esbuild';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));

await build({
  entryPoints: [resolve(root, 'src/index.ts')],
  outfile: resolve(root, 'dist/index.js'),
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  sourcemap: true,
  minify: false,
  external: ['sharp'],
  banner: {
    // Some transitive CJS dependencies expect `require` to exist in scope.
    js: [
      "import { createRequire as __createRequire } from 'node:module';",
      'const require = __createRequire(import.meta.url);',
    ].join('\n'),
  },
  logLevel: 'info',
});
