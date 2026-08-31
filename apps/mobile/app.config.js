const path = require('node:path');
const { config: loadEnv } = require('dotenv');

/**
 * Expo only auto-loads a .env sitting next to app.json. Scan&Sign keeps a
 * single .env at the monorepo root, so load it here and pass the one value the
 * app needs through `extra` — which works in Expo Go and in EAS builds alike.
 */
loadEnv({ path: path.resolve(__dirname, '../../.env'), quiet: true });

module.exports = ({ config }) => ({
  ...config,
  extra: {
    ...config.extra,
    // On a physical iPhone this MUST be the Mac's LAN IP: the phone has no
    // route to the Mac's localhost.
    apiUrl: process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:8787',
  },
});
