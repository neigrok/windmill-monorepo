// Detachment, enforced (shell contract §Detachment). The chrome learns about products only
// through the registry seam (src/shell/products.js); products never learn about the chrome or
// each other. This walks every import in src/ and fails naming the offending file and line.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');
const PRODUCTS_DIR = path.join(SRC, 'products') + path.sep;
const CHROME_DIR = path.join(SRC, 'shell', 'chrome') + path.sep;
const SOURCE_EXTENSIONS = new Set(['.js', '.jsx', '.mjs']);

function sourceFiles(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(full));
    else if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) files.push(full);
  }
  return files;
}

// Static `from '…'` (import and re-export), bare side-effect imports, and dynamic import(…).
const IMPORT_SHAPES = [
  /\bfrom\s+['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /^\s*import\s+['"]([^'"]+)['"]/g,
];

function importsOf(file) {
  const found = [];
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  lines.forEach((text, index) => {
    for (const shape of IMPORT_SHAPES) {
      shape.lastIndex = 0;
      for (let match = shape.exec(text); match; match = shape.exec(text)) {
        found.push({ specifier: match[1], line: index + 1 });
      }
    }
  });
  return found;
}

function productOf(absolutePath) {
  if (!absolutePath.startsWith(PRODUCTS_DIR)) return null;
  return absolutePath.slice(PRODUCTS_DIR.length).split(path.sep)[0];
}

const violations = { chromeIntoProducts: [], productIntoProduct: [], productIntoChrome: [] };

for (const file of sourceFiles(SRC)) {
  const fromChrome = file.startsWith(CHROME_DIR);
  const fromProduct = productOf(file);
  if (!fromChrome && !fromProduct) continue;

  const relativeFile = path.relative(SRC, file);
  for (const { specifier, line } of importsOf(file)) {
    // Two in-repo specifier shapes: relative, and Vite-root-absolute ('/src/…') — the second
    // would otherwise slip every rule.
    if (!specifier.startsWith('.') && !specifier.startsWith('/src/')) continue;
    const target = specifier.startsWith('/src/')
      ? path.resolve(SRC, '..', specifier.slice(1))
      : path.resolve(path.dirname(file), specifier);
    const targetProduct = productOf(target);

    if (fromChrome && targetProduct) {
      violations.chromeIntoProducts.push(`src/${relativeFile}:${line} imports ${specifier} — the chrome may only reach products through the registry (src/shell/products.js)`);
    }
    if (fromProduct && targetProduct && targetProduct !== fromProduct) {
      violations.productIntoProduct.push(`src/${relativeFile}:${line} imports ${specifier} — product "${fromProduct}" must not import from product "${targetProduct}"`);
    }
    if (fromProduct && (target + path.sep).startsWith(CHROME_DIR)) {
      violations.productIntoChrome.push(`src/${relativeFile}:${line} imports ${specifier} — products must never import from the shell chrome`);
    }
  }
}

test('shell chrome imports nothing from src/products/ — the registry is the only seam', () => {
  assert.deepEqual(violations.chromeIntoProducts, []);
});

test('no product imports from another product', () => {
  assert.deepEqual(violations.productIntoProduct, []);
});

test('no product imports from the shell chrome', () => {
  assert.deepEqual(violations.productIntoChrome, []);
});
