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
import { BRAND_PROMISE, LANDING_HEADS, START_FREE } from '../src/shell/marketing/landingHeads.js';

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
// The neutral side is EVERYTHING that is not a product — not merely src/shell/. This walked only
// shell/ until 2026-08-05, which skipped 24 files including the whole of design-system/, the layer
// STRUCTURE.md names by name as one that must be provably product-free. Nothing in it was actually
// dirty; the point is that nothing was watching, and Showcase.jsx sat at the src root reaching into
// five roadmap files in plain sight.
//
// The showcase gets a NARROW exemption rather than a blanket one: a design-system gallery whose
// subject includes a product's components has to name them, but it may reach a product only through
// the one module that product declares for it. So `products/<p>/showcase.js` is a door, and every
// other path into a product is still a wall.
const SHOWCASE_DIR = path.join(SRC, 'showcase') + path.sep;
const specimensOf = (product) => path.join(PRODUCTS_DIR, product, 'showcase.js');
// Stylesheets are walked too. A JS file importing a product's CSS was always caught (a bare
// `import './x.css'` is one of the shapes below), but `@import` from one stylesheet to another
// crossed every wall in silence — so a product could have pulled in the /app chrome's sheet, or the
// shell a product's, and the suite would have stayed green while breaking the rule it exists to
// state. Found 2026-08-05, while looking for a home for a shared class and nearly putting it
// somewhere that would have needed exactly that import.
const SOURCE_EXTENSIONS = new Set(['.js', '.jsx', '.mjs', '.css']);

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
  // CSS: `@import 'x'` and `@import url('x')`, with or without a media query after it.
  /@import\s+(?:url\(\s*)?['"]([^'"]+)['"]/g,
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
  const fromProduct = productOf(file);
  const fromShell = !fromProduct && file !== REGISTRY;
  const fromShowcase = file.startsWith(SHOWCASE_DIR);

  const relativeFile = path.relative(SRC, file);
  for (const { specifier, line } of importsOf(file)) {
    // Two in-repo specifier shapes: relative, and Vite-root-absolute ('/src/…') — the second
    // would otherwise slip every rule.
    if (!specifier.startsWith('.') && !specifier.startsWith('/src/')) continue;
    const target = specifier.startsWith('/src/')
      ? path.resolve(SRC, '..', specifier.slice(1))
      : path.resolve(path.dirname(file), specifier);
    const targetProduct = productOf(target);

    if (fromShell && targetProduct && !(fromShowcase && target === specimensOf(targetProduct))) {
      const door = fromShowcase
        ? `the showcase may reach a product only through src/products/${targetProduct}/showcase.js`
        : 'the shell may only reach products through the registry (src/shell/products.js)';
      violations.shellIntoProducts.push(`src/${relativeFile}:${line} imports ${specifier} — ${door}`);
    }
    if (fromProduct && targetProduct && targetProduct !== fromProduct) {
      violations.productIntoProduct.push(`src/${relativeFile}:${line} imports ${specifier} — product "${fromProduct}" must not import from product "${targetProduct}"`);
    }
    if (fromProduct && (target + path.sep).startsWith(APP_CHROME_DIR)) {
      violations.productIntoAppChrome.push(`src/${relativeFile}:${line} imports ${specifier} — products must never import from the /app chrome`);
    }
  }
}

test('nothing product-neutral imports from src/products/ — the registry is the only seam', () => {
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

// The brand root composes a hero band and a section off `landing.root` alone, for the products that
// are OPEN — a product still holding itself shut brings no band and no section, and keeps only its
// place in the cross-nav and the footer. ShellHome reads `landing.tagline` for it instead.
//
// A scene is either a lazy exotic (what every product declares today) or a plain function
// component. `typeof value === 'object'` said yes to `Glimpse: {}`, which passes here and throws at
// render, and no to a function component, which fails here and renders fine.
const isComponent = (value) => typeof value === 'function'
  || (typeof value === 'object' && value !== null && typeof value.$$typeof === 'symbol');
const isText = (value) => typeof value === 'string' && value.length > 0;
const OPEN = PRODUCTS.filter((product) => product.shell.status === 'open');

function rootSeamGaps(product) {
  const root = product.landing?.root;
  if (!root) return ['landing.root'];
  const section = root.section ?? {};
  const proof = Array.isArray(section.proof) ? section.proof : [];
  return [
    ...(isText(root.platforms) ? [] : ['root.platforms']),
    ...(isText(root.band?.title) ? [] : ['root.band.title']),
    ...(isText(root.band?.sub) ? [] : ['root.band.sub']),
    ...(isText(section.title) ? [] : ['root.section.title']),
    ...(isText(section.sub) ? [] : ['root.section.sub']),
    ...(isText(section.trust) ? [] : ['root.section.trust']),
    ...(isText(section.cta?.href) ? [] : ['root.section.cta.href']),
    ...(isText(section.cta?.label) ? [] : ['root.section.cta.label']),
    ...(proof.length === 3 && proof.every((card) => isText(card?.title) && isText(card?.copy)) ? [] : ['root.section.proof (exactly three {title, copy})']),
    ...(isComponent(root.Glimpse) ? [] : ['root.Glimpse']),
    ...(isComponent(root.Illustration) ? [] : ['root.Illustration']),
  ];
}

// The gap is not a missing band: BrandLanding destructures `landing.root` as it composes, so one
// product's gap throws (`Cannot destructure property 'platforms' of 'landing.root'`), the error
// boundary catches it and the entire front door renders empty — every product's band and section
// included.
const rootSeamMissing = OPEN
  .map((p) => [p, rootSeamGaps(p)])
  .filter(([, gaps]) => gaps.length > 0)
  .map(([p, gaps]) => `product "${p.id}" leaves the brand root short of ${gaps.join(', ')} — BrandLanding destructures landing.root as it composes, so the gap throws through render and the whole front door goes blank`);

test('every open product brings the words and the two scenes its band and section on the brand root are made of', () => {
  assert.deepEqual(rootSeamMissing, []);
});

// A closed product used to get the full pitch anyway: HeroBand and ProductSection never read
// `shell.status`, so a band, a section and a live door were drawn for a product nobody can open.
// The root reads the open products and composes those; the nav and the footer still name them all.
const BRAND_LANDING = fs.readFileSync(path.join(SRC, 'shell', 'marketing', 'BrandLanding.jsx'), 'utf8');

// A scene arrives in its product's chunk, so the sheet that draws it cannot hold the space it is
// about to take — the product states that height as `landing.root.reserve` and the shell's own
// sheet, which ships with the shell, holds it from the first paint. A product that states none
// holds nothing and its band jumps the page when its chunk lands.
const LANDING_CSS = fs.readFileSync(path.join(SRC, 'shell', 'marketing', 'landing.css'), 'utf8');
const reserveHalved = PRODUCTS
  .filter((p) => p.landing?.root?.reserve)
  .filter((p) => !isText(p.landing.root.reserve.band) || !isText(p.landing.root.reserve.section))
  .map((p) => `product "${p.id}" states landing.root.reserve without both halves — the shell writes it straight into min-height, so half a reserve holds half the space`);

test('the shell holds the space a scene will take out of the height its product states', () => {
  assert.deepEqual(reserveHalved, []);
  assert.match(BRAND_LANDING, /className="rootBand-scene" style=\{\{ '--rootScene-reserve': reserve\?\.band \}\}/);
  assert.match(BRAND_LANDING, /className="rootSection-scene" style=\{\{ '--rootScene-reserve': reserve\?\.section \}\}/);
  assert.match(LANDING_CSS, /\.rootBand-scene \{[^}]*min-height: var\(--rootScene-reserve, 0px\); \}/);
  assert.match(LANDING_CSS, /\.rootSection-scene \{[^}]*min-height: var\(--rootScene-reserve, 0px\); \}/);
});

test('the brand root composes a band and a section for the open products only', () => {
  assert.match(BRAND_LANDING, /const open = PRODUCTS\.filter\(\(product\) => product\.shell\.status === 'open'\);/);
  assert.equal(BRAND_LANDING.includes('PRODUCTS.map('), false, 'a band or a section is still composed off every product, open or shut');
});

const taglineMissing = PRODUCTS
  .filter((p) => !isText(p.landing?.tagline))
  .map((p) => `product "${p.id}" declares no landing.tagline — ShellHome names a pre-open product by it`);

test('every product brings a tagline', () => {
  assert.deepEqual(taglineMissing, []);
});

// The device hand-off seam (audit JOURNAL-1 / WEB-4). The shell owns the MOMENT an account is
// replaced on this browser and calls forgetDevice on every product; each product owns what it keeps
// on the device. It is optional — a product that writes nothing device-side has nothing to forget —
// but a product that declares one and makes it something other than a function would be skipped in
// silence on the one transition that matters, so the shape is checked here rather than discovered
// on a shared laptop.
const handoffMalformed = PRODUCTS
  .filter((product) => 'forgetDevice' in product && typeof product.forgetDevice !== 'function')
  .map((p) => `product "${p.id}" declares forgetDevice as ${typeof p.forgetDevice} — the shell calls it on an account change, so a non-function is residue left on the device`);

test('a product that declares the device hand-off declares it as a function', () => {
  assert.deepEqual(handoffMalformed, []);
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

// And the room's own module, which the boot preloads so a product's chunk goes out in the first
// flight instead of being discovered two round trips later (scripts/appBoot.js). Same fact as the
// landing above — a registry field naming a source path — so it is checked in the same place.
const roomModulesMissing = PRODUCTS
  .filter((product) => product.shell.status === 'open')
  .filter((product) => !product.shell.module || !fs.existsSync(path.resolve(SRC, '..', product.shell.module)))
  .map((p) => `product "${p.id}" names the room module ${p.shell.module}, which does not exist — the build would throw on the bundle lookup`);

test('every open product names a room module that exists', () => {
  assert.deepEqual(roomModulesMissing, []);
});

// The front door is three surfaces of two facts — the sentence and the door — and each of the three
// used to say them itself. They agreed only because someone kept them agreeing, and they stopped:
// the shell's "Start free" went to /roadmap and the page's button, under the same label, to
// #/app/start. landingHeads.js says both once now, so these pin the three to each other and to
// that one expression, never to a string written out again here.
const SHELL = fs.readFileSync(path.resolve(SRC, '..', 'index.html'), 'utf8');
const ROOT_HEAD = LANDING_HEADS.find((head) => head.path === '/');

test('"Start free" opens one door — the app-start door — in the crawlable shell and on the page', () => {
  const open = PRODUCTS.find((product) => product.shell.status === 'open');
  assert.deepEqual(START_FREE, { href: open.landing.root.section.cta.href, label: 'Start free' });
  assert.deepEqual(ROOT_HEAD.fallback.actions, [START_FREE]);
  assert.equal(SHELL.includes(`<a href="${START_FREE.href}"`), true, 'web/index.html sends the button somewhere else');
  assert.equal(SHELL.includes(`>${START_FREE.label}</a>`), true, 'web/index.html calls the button something else');
  const BRAND_LANDING_CTA = /cta=\{START_FREE\}/;
  assert.match(BRAND_LANDING, BRAND_LANDING_CTA, 'the running page derives its nav door from somewhere else');
});

// A crawler that renders and a crawler that does not have to see the same heading structure. The
// shell shipped `<h1>Three tools. One account.</h1>` while the page demoted that same sentence to a
// span in a presentational div and gave the page no <h1> at all.
test('the shell and the page carry the same one <h1>, and the bands stay <h2>', () => {
  assert.equal(ROOT_HEAD.fallback.h1, BRAND_PROMISE);
  assert.equal(SHELL.includes(`>${BRAND_PROMISE}</h1>`), true, 'web/index.html says something else in its <h1>');
  assert.match(BRAND_LANDING, /<h1 className="visually-hidden">\{BRAND_PROMISE\}<\/h1>/);
  assert.equal((BRAND_LANDING.match(/<h1[ >]/g) ?? []).length, 1, 'the page draws more than one <h1>');
  // and it is the first thing in the page, above the bands it composes, so a screen reader walks
  // the levels in order rather than meeting an h2 first
  assert.ok(BRAND_LANDING.indexOf('<h1 ') < BRAND_LANDING.indexOf('open.map('), 'a band is composed above the heading');
});

// The no-JS body says the hero bands' promises; the page draws a band for each open product.
test('the brand root shell notes are the open products\' hero band promises, in registry order', () => {
  assert.deepEqual(ROOT_HEAD.fallback.notes, OPEN.map((product) => product.landing.root.band.title));
});

// The cost answer is the one place the brand root prices its products, and it is written twice —
// landingHeads.js and web/index.html — which the build pins to each other byte for byte.
test('the brand FAQ prices Gym by its true rule: the log, the connected log and Coach are free, a plan only raises the AI ceiling', () => {
  const root = LANDING_HEADS.find((head) => head.path === '/');
  const faq = root.schema.find((entry) => entry['@type'] === 'FAQPage');
  const cost = faq.mainEntity.find((question) => question.name === 'How much does Windmill cost?').acceptedAnswer.text;
  assert.match(cost, /the log, the connected log and Coach — ten questions a day — cost nothing/);
  assert.match(cost, /a plan only raises the AI ceiling behind Coach/);
  assert.doesNotMatch(cost, /Ask chat|Gym is outside/);
  assert.equal(SHELL.includes(cost), true, 'web/index.html carries the same answer');
});
