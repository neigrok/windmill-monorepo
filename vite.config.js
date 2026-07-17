import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { DEFAULT_KINDS, GENESIS_STAMP } from './src/skilltree/model/Legend.js';

// anon-first-tree: a local-born tree's claim converges with the server's empty tree
// ONLY while the frontend's genesis seed is byte-equal to the backend's
// (Legend::seededDefaults + Hlc{1,0,"genesis"} — pinned there by TreeRegistryTest).
// Drift would silently split legends on every local-born tree, so the build refuses.
const GENESIS_GOLDEN = JSON.stringify({
  stamp: '1:0:genesis',
  kinds: [
    { id: 'build', hue: 'terracotta', label: 'Build', description: 'Things you make' },
    { id: 'learn', hue: 'olive', label: 'Learn', description: 'Things you figure out' },
    { id: 'milestone', hue: 'gold', label: 'Milestone', description: 'Moments that matter' },
  ],
});
if (JSON.stringify({ stamp: GENESIS_STAMP, kinds: DEFAULT_KINDS }) !== GENESIS_GOLDEN) {
  throw new Error(
    'DEFAULT_KINDS/GENESIS_STAMP drifted from the backend genesis legend (Legend::seededDefaults, Hlc{1,0,"genesis"}) — change both repos together or local-born trees silently diverge.',
  );
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    open: false,
  },
  build: {
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
