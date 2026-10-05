import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const PRECACHE_BUDGET = 4 * 1024 * 1024;

export function offlineShell() {
  return {
    name: 'windmill-offline-shell',
    enforce: 'post',
    generateBundle(_options, bundle) {
      const assets = new Set();
      const visited = new Set();
      const visit = (name) => {
        if (visited.has(name)) return;
        visited.add(name);
        const item = bundle[name];
        if (!item) throw new Error(`offline-shell: missing bundled dependency ${name}`);
        if (item.type !== 'chunk') { assets.add(name); return; }
        if (Object.keys(item.modules).some((path) => /\/src\/(?:showcase\/|products\/journal\/search\/neural\/)/.test(path))) return;
        assets.add(name);
        for (const dependency of [...item.imports, ...item.dynamicImports,
          ...item.viteMetadata.importedCss, ...item.viteMetadata.importedAssets]) visit(dependency);
      };
      for (const [name, item] of Object.entries(bundle)) if (item.type === 'chunk' && item.isEntry) visit(name);
      const manifest = [...assets].sort();
      const bytes = manifest.reduce((total, name) => total + Buffer.byteLength(bundle[name].code ?? bundle[name].source),
        Buffer.byteLength(bundle['index.html']?.source ?? ''));
      if (bytes > PRECACHE_BUDGET) throw new Error(`offline-shell: precache ${bytes} bytes exceeds ${PRECACHE_BUDGET}-byte budget`);
      this.emitFile({ type: 'asset', fileName: 'offline-assets.json', source: JSON.stringify(manifest.map((name) => `/${name}`)) });
    },
    writeBundle({ dir }) {
      const manifest = JSON.parse(readFileSync(join(dir, 'offline-assets.json'), 'utf8'));
      const bytes = ['index.html', ...manifest.map((url) => url.slice(1))]
        .reduce((total, name) => total + statSync(join(dir, name)).size, 0);
      if (bytes > PRECACHE_BUDGET) throw new Error(`offline-shell: precache ${bytes} bytes exceeds ${PRECACHE_BUDGET}-byte budget`);
      console.log(`Offline shell: ${manifest.length} assets, ${bytes}/${PRECACHE_BUDGET} bytes`);
    },
  };
}
