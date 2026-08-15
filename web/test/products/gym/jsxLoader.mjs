// The module loader `harness.mjs` registers so a screen can be imported for real under `node --test`:
// a `.jsx` module is compiled through esbuild (the same compiler vite builds with) on the way in, an
// extension-less relative import — the design system's `'../../../design-system'` — is resolved the
// way vite resolves it, and a `.css` import is answered with nothing, since no test reads a style.
// Not a test file: named `.mjs` so the runner leaves it alone.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { transformSync } from 'esbuild';

const CANDIDATES = ['.js', '.jsx', '/index.js', '/index.jsx'];

export async function resolve(specifier, context, next) {
  if (specifier.startsWith('.') && !path.extname(specifier) && context.parentURL?.startsWith('file:')) {
    const base = path.resolve(path.dirname(fileURLToPath(context.parentURL)), specifier);
    for (const tail of CANDIDATES) {
      if (fs.existsSync(base + tail) && fs.statSync(base + tail).isFile()) return { url: pathToFileURL(base + tail).href, shortCircuit: true };
    }
  }
  return next(specifier, context);
}

export async function load(url, context, next) {
  if (url.endsWith('.css')) return { format: 'module', source: 'export default {};', shortCircuit: true };
  if (!url.endsWith('.jsx')) return next(url, context);
  const source = fs.readFileSync(fileURLToPath(url), 'utf8');
  const { code } = transformSync(source, { loader: 'jsx', jsx: 'automatic', sourcefile: url, format: 'esm' });
  return { format: 'module', source: code, shortCircuit: true };
}
