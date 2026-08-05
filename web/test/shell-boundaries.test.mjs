// Detachment, enforced (shell contract §Detachment). The whole shell — the /app chrome, the
// landing chrome, auth, settings — learns about products only through the registry seam
// (src/shell/products.js); products never learn about the /app chrome or each other. This walks
// every import in src/ and fails naming the offending file and line. Then it reads the registry
// itself — detachment only holds if every product actually declares what the seam promises.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PRODUCTS } from '../src/shell/products.js';
import { LANDING_HEADS } from '../src/shell/marketing/landingHeads.js';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');
const PRODUCTS_DIR = path.join(SRC, 'products') + path.sep;
// Two different walls. Nothing anywhere in the shell may name a product — that is the whole
// shell, not just the /app chrome, because the landing chrome and the settings page are just as
// neutral. Products, in the other direction, are free to use the shell's platform services
// (auth, billing, apiBase, the landing chrome they mount into) but never the /app chrome.
const SHELL_DIR = path.join(SRC, 'shell') + path.sep;
const APP_CHROME_DIR = path.join(SRC, 'shell', 'chrome') + path.sep;
// The one allowlisted file: the registry's job is to name the products, so the seam is where the
// wall has its door.
const REGISTRY = path.join(SRC, 'shell', 'products.js');
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

const violations = { shellIntoProducts: [], productIntoProduct: [], productIntoAppChrome: [] };

for (const file of sourceFiles(SRC)) {
  const fromShell = file.startsWith(SHELL_DIR) && file !== REGISTRY;
  const fromProduct = productOf(file);
  if (!fromShell && !fromProduct) continue;

  const relativeFile = path.relative(SRC, file);
  for (const { specifier, line } of importsOf(file)) {
    // Two in-repo specifier shapes: relative, and Vite-root-absolute ('/src/…') — the second
    // would otherwise slip every rule.
    if (!specifier.startsWith('.') && !specifier.startsWith('/src/')) continue;
    const target = specifier.startsWith('/src/')
      ? path.resolve(SRC, '..', specifier.slice(1))
      : path.resolve(path.dirname(file), specifier);
    const targetProduct = productOf(target);

    if (fromShell && targetProduct) {
      violations.shellIntoProducts.push(`src/${relativeFile}:${line} imports ${specifier} — the shell may only reach products through the registry (src/shell/products.js)`);
    }
    if (fromProduct && targetProduct && targetProduct !== fromProduct) {
      violations.productIntoProduct.push(`src/${relativeFile}:${line} imports ${specifier} — product "${fromProduct}" must not import from product "${targetProduct}"`);
    }
    if (fromProduct && (target + path.sep).startsWith(APP_CHROME_DIR)) {
      violations.productIntoAppChrome.push(`src/${relativeFile}:${line} imports ${specifier} — products must never import from the /app chrome`);
    }
  }
}

test('nothing in src/shell/ imports from src/products/ — the registry is the only seam', () => {
  assert.deepEqual(violations.shellIntoProducts, []);
});

test('no product imports from another product', () => {
  assert.deepEqual(violations.productIntoProduct, []);
});

test('no product imports from the /app chrome', () => {
  assert.deepEqual(violations.productIntoAppChrome, []);
});

// The landing seam. Since the shell stopped hard-coding /roadmap, the router mounts a landing by
// looking up `landing.href` — a product that declares none has no front door at all.
const landingsMissing = PRODUCTS
  .filter((p) => typeof p.landing?.href !== 'string' || !p.landing?.Component)
  .map((p) => `product "${p.id}" declares no mountable landing — shell/App.jsx has no branch of its own left to fall back on, so its pathname would render the brand root`);

// Two faces of the same fact: the /app chrome sends visitors out to shell.landingHref, the router
// answers on landing.href. Let them drift and a product's own "back to the landing" link lands on
// a URL nothing claims.
const landingDrift = PRODUCTS
  .filter((p) => p.shell.landingHref !== p.landing?.href)
  .map((p) => `product "${p.id}": shell.landingHref is ${p.shell.landingHref} but landing.href is ${p.landing?.href} — the /app chrome and the router disagree on where its landing lives`);

test('every product declares a landing the shell router can mount', () => {
  assert.deepEqual(landingsMissing, []);
});

test('every product answers its landing on one pathname — shell.landingHref is landing.href', () => {
  assert.deepEqual(landingDrift, []);
});

// The brand root builds its product doors from the registry alone — a product that brings no
// words for its own card would show up in the cross-nav and the footer and be silently missing
// from the one page whose whole subject is "three tools, one account".
const doorCopyMissing = PRODUCTS
  .filter((p) => !p.landing?.tagline || !p.landing?.summary)
  .map((p) => `product "${p.id}" declares no landing.tagline/landing.summary — its door would be absent from the brand root while its link sits in the nav and the footer`);

test('every product brings the words its door on the brand root is made of', () => {
  assert.deepEqual(doorCopyMissing, []);
});

// The crawlable seam. LANDING_HEADS used to be a hand-written list on the shell side that restated,
// for every product, its pathname and a path into its source tree — the import graph could not see
// it, so nothing here could either, and the only thing that caught a stale module path was the
// bundler. It is composed off the registry now, and these three assertions are what makes that
// composition load-bearing rather than incidental.
test('the crawlable shells are exactly the brand root plus every product, in registry order', () => {
  assert.deepEqual(
    LANDING_HEADS.map((head) => head.path),
    ['/', ...PRODUCTS.map((product) => product.landing.href)],
  );
});

// A head names the module the build script preloads from the shell. It is stated beside the landing
// it names, so a rename moves both together — but only if something checks the file is really there.
const modulesMissing = PRODUCTS
  .filter((product) => !fs.existsSync(path.resolve(SRC, '..', product.landing.head.module)))
  .map((p) => `product "${p.id}" names the landing module ${p.landing.head.module}, which does not exist — the build would preload nothing and throw on the Vite manifest lookup`);

test('every product names a landing module that exists', () => {
  assert.deepEqual(modulesMissing, []);
});

// The brand root's hero is one fact — the front door — and it used to be written out by hand in
// landingHeads.js, in web/index.html and derived a third time in BrandLanding. They agreed only
// because someone kept them agreeing. The static shell now derives from the same registry the
// running page does, so this pins them to each other rather than to a string.
test('the brand root shell offers the first open product, and names it', () => {
  const open = PRODUCTS.find((product) => product.shell.status === 'open');
  const root = LANDING_HEADS.find((head) => head.path === '/');
  assert.deepEqual(root.fallback.actions, [{ href: open.landing.href, label: `Start with ${open.label}` }]);
});
