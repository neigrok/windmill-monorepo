import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

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
        // Keep the WebGL vendor (three + troika) and React in their own chunks
        // so app-code changes don't bust their long-lived caches. dagre lands in
        // the layout worker's own chunk automatically.
        manualChunks(id) {
          if (!id.includes('node_modules')) return;
          if (id.includes('node_modules/three') || id.includes('troika')) return 'three';
          if (id.includes('node_modules/react')) return 'react';
        },
      },
    },
  },
});
