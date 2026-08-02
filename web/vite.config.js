import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { staticPageAssets } from './scripts/staticPageAssets.js';
import { DEFAULT_KINDS, GENESIS_STAMP } from './src/products/roadmap/model/Legend.js';
import { GENESIS_GOLDEN } from '../packages/api-contract/genesis.js';

// anon-first-tree: a local-born tree's claim converges with the server's empty tree
// ONLY while the frontend's genesis seed is byte-equal to the backend's
// (Legend::seededDefaults + Hlc{1,0,"genesis"} — pinned there by TreeRegistryTest).
// The golden now lives once in packages/api-contract/genesis.js (shared with the backend);
// this build re-asserts the roadmap model still consumes exactly it, so a drift refuses.
if (JSON.stringify({ stamp: GENESIS_STAMP, kinds: DEFAULT_KINDS }) !== GENESIS_GOLDEN) {
  throw new Error(
    'DEFAULT_KINDS/GENESIS_STAMP drifted from the backend genesis legend (Legend::seededDefaults, Hlc{1,0,"genesis"}) — change both repos together or local-born trees silently diverge.',
  );
}

// https://vite.dev/config/
export default defineConfig({
  // staticPageAssets serves/emits /fonts.css and /chrome.css for the plain-HTML pages in public/,
  // which never enter the module graph the SPA entry gets its faces and its chrome from.
  plugins: [react(), staticPageAssets()],
  server: {
    port: 5173,
    open: false,
    // The web app now imports the shared genesis legend from ../packages/api-contract, which
    // lives outside this Vite root. Allow the dev server to serve web/ and the packages/ dir
    // it reads from (the production build resolves these through Rollup regardless).
    fs: { allow: ['.', '../packages'] },
  },
  build: {
    // scripts/build-landing-shells.mjs reads the manifest to find each landing's own hashed chunk,
    // so a shell can preload it instead of leaving the visitor to watch it be discovered.
    manifest: true,
    rollupOptions: {
      output: {
        // Keep React in its own long-lived chunk so app-code changes don't bust
        // its cache. dagre lands in the layout worker's own chunk automatically.
        manualChunks(id) {
          if (!id.includes('node_modules')) return;
          if (id.includes('node_modules/react')) return 'react';
        },
      },
    },
  },
});
