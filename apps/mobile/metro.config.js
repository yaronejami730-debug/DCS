// Metro must be told about the monorepo: sources live in packages/*, and
// dependencies are hoisted to the repo root (see nodeLinker: hoisted in
// pnpm-workspace.yaml).
const { getDefaultConfig } = require('expo/metro-config');
const path = require('node:path');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');
const packagesRoot = path.resolve(workspaceRoot, 'packages');

const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];
// Hierarchical lookup is deliberately left ON. With nodeLinker: hoisted every
// dependency sits in the workspace root, which normal Node resolution finds on
// its own; disabling it made Metro rely solely on its own cached module map,
// so any install that replaced node_modules under a running server produced
// "could not be found within the project" for a package that was plainly there.

/**
 * `packages/*` are consumed as TypeScript source and are also compiled by tsc
 * for the Node backend, so their relative imports carry the `.js` extension
 * that Node's ESM resolver requires. Metro does not perform TypeScript's
 * `.js` -> `.ts` remap, so we do it here — scoped to packages/ only, to avoid
 * shadowing genuine `.js` files anywhere else.
 */
const defaultResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const resolve = defaultResolveRequest ?? context.resolveRequest;
  const from = context.originModulePath ?? '';

  if (from.startsWith(packagesRoot) && moduleName.startsWith('.') && moduleName.endsWith('.js')) {
    try {
      return resolve(context, moduleName.slice(0, -3), platform);
    } catch {
      // Fall through: it really was a .js file.
    }
  }
  return resolve(context, moduleName, platform);
};

module.exports = config;
