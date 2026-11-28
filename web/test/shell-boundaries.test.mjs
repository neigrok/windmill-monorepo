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
  { shape: /\bfrom\s+['"]([^'"]+)['"]/g, dynamic: false },
  { shape: /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g, dynamic: true },
  { shape: /^\s*import\s+['"]([^'"]+)['"]/g, dynamic: false },
  // CSS: `@import 'x'` and `@import url('x')`, with or without a media query after it.
  { shape: /@import\s+(?:url\(\s*)?['"]([^'"]+)['"]/g, dynamic: false },
];

function importsOf(file) {
  const found = [];
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  lines.forEach((text, index) => {
    for (const { shape, dynamic } of IMPORT_SHAPES) {
      shape.lastIndex = 0;
      for (let match = shape.exec(text); match; match = shape.exec(text)) {
        found.push({ specifier: match[1], line: index + 1, dynamic });
      }
    }
  });
  return found;
}

// Two in-repo specifier shapes: relative, and Vite-root-absolute ('/src/…') — the second would
// otherwise slip every rule.
function targetOf(file, specifier) {
  if (specifier.startsWith('/src/')) return path.resolve(SRC, '..', specifier.slice(1));
  return specifier.startsWith('.') ? path.resolve(path.dirname(file), specifier) : null;
}

// What the brand root loads before any room or product page: main.jsx and each product's brand-root picture
// (marketing/RootPicture.jsx, mounted on the brand root through the registry's landing.root), with every module
// their static imports reach.
function entryLoaded(starts) {
  const loaded = new Set(starts);
  const queue = [...loaded];
  while (queue.length) {
    const file = queue.shift();
    for (const { specifier, dynamic } of importsOf(file)) {
      const target = !dynamic && targetOf(file, specifier);
      if (!target) continue;
      const module = [target, `${target}.js`, `${target}.jsx`, path.join(target, 'index.js'), path.join(target, 'index.jsx')]
        .find((candidate) => /\.(js|jsx|mjs)$/.test(candidate) && fs.existsSync(candidate) && fs.statSync(candidate).isFile());
      if (!module || loaded.has(module)) continue;
      loaded.add(module);
      queue.push(module);
    }
  }
  return loaded;
}

function productOf(absolutePath) {
  if (!absolutePath.startsWith(PRODUCTS_DIR)) return null;
  return absolutePath.slice(PRODUCTS_DIR.length).split(path.sep)[0];
}

// An owner's catalog lives in its i18n/ beside its code and is read only by that owner, through i18n/index.js.
// An owner whose modules load at different moments keeps a catalog per moment: a module the brand root loads
// reads i18n/entry/, one the app's chrome or home loads i18n/app/, one the settings page loads i18n/settings/,
// one a product's landing loads i18n/landing/, and every other module i18n/index.js, which loads with the room.
// A module two moments load reads the latest catalog both read. Each page then downloads only the copy it shows.
const PLATFORM_I18N = path.join(SRC, 'platform', 'i18n') + path.sep;
const BRAND_ROOT_PICTURES = PRODUCTS.map((product) => path.join(PRODUCTS_DIR, product.id, 'marketing', 'RootPicture.jsx'));
const ENTRY_LOADED = entryLoaded([path.join(SRC, 'main.jsx'), ...BRAND_ROOT_PICTURES]);
// A product's landing is the page its head names and the pictures that page loads lazily into the shell's frames.
const LANDINGS = PRODUCTS.flatMap((product) => {
  const page = path.resolve(SRC, '..', product.landing.head.module);
  return [page, ...importsOf(page).filter(({ dynamic }) => dynamic).map(({ specifier }) => targetOf(page, specifier))];
});
const LANDING_LOADED = new Set([...entryLoaded(LANDINGS)].filter((file) => !ENTRY_LOADED.has(file)));
// The app's chrome and home: the /app chrome App.jsx loads lazily and each product's home card. The settings page:
// the page App.jsx loads lazily and each product's settings sections. A door names where its route table keeps them.
const DOORS = {
  app: [[path.join(SRC, 'shell', 'App.jsx'), /^\.\/chrome\//], ...PRODUCTS.map((product) => [path.join(PRODUCTS_DIR, product.id, 'routes.js'), /^\.\/HomeCard\.jsx$/])],
  settings: [[path.join(SRC, 'shell', 'App.jsx'), /^\.\/settings\//], ...PRODUCTS.map((product) => [path.join(PRODUCTS_DIR, product.id, 'routes.js'), /^\.\/settings\//])],
};
const doorRoots = (doors) => doors.map(([file, door]) => importsOf(file).filter(({ specifier, dynamic }) => dynamic && door.test(specifier)).map(({ specifier }) => targetOf(file, specifier)));
const DOOR_ROOTS = { app: doorRoots(DOORS.app), settings: doorRoots(DOORS.settings) };
const MOMENTS = {
  entry: ENTRY_LOADED,
  app: entryLoaded(DOOR_ROOTS.app.flat()),
  settings: entryLoaded(DOOR_ROOTS.settings.flat()),
  landing: LANDING_LOADED,
};
const READS = { entry: ['entry'], app: ['entry', 'app'], settings: ['entry', 'app', 'settings'], landing: ['entry', 'landing'] };
function momentOf(file) {
  const loading = Object.keys(MOMENTS).filter((moment) => MOMENTS[moment].has(file));
  if (!loading.length) return null;
  return Object.keys(READS).filter((tier) => loading.every((moment) => READS[moment].includes(tier)))
    .reduce((latest, tier) => (READS[tier].length > READS[latest].length ? tier : latest));
}
function catalogOwnerOf(target) {
  const parts = path.relative(SRC, target).split(path.sep);
  const at = parts.indexOf('i18n');
  if (at < 1 || (target + path.sep).startsWith(PLATFORM_I18N)) return null;
  return path.join(SRC, ...parts.slice(0, at));
}

const violations = { shellIntoProducts: [], productIntoProduct: [], productIntoAppChrome: [], catalogAcrossOwners: [], catalogByLoading: [], computedImports: [] };

// A dynamic import whose module is not a string literal leads somewhere no rule here can see.
const COMPUTED_IMPORT = /\bimport\s*\(\s*(?:[^'"\s]|$)/;
for (const file of sourceFiles(SRC)) {
  fs.readFileSync(file, 'utf8').split('\n').forEach((text, index) => {
    if (COMPUTED_IMPORT.test(text)) violations.computedImports.push(`src/${path.relative(SRC, file)}:${index + 1} imports a module it computes; name it as a string literal`);
  });
}

for (const file of sourceFiles(SRC)) {
  const fromProduct = productOf(file);
  const fromShell = !fromProduct && file !== REGISTRY;
  const fromShowcase = file.startsWith(SHOWCASE_DIR);

  const relativeFile = path.relative(SRC, file);
  for (const { specifier, line } of importsOf(file)) {
    const target = targetOf(file, specifier);
    if (!target) continue;
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
    const catalogOwner = catalogOwnerOf(target);
    if (catalogOwner && !file.startsWith(path.join(catalogOwner, 'i18n') + path.sep)) {
      const owner = `src/${path.relative(SRC, catalogOwner)}`;
      const indexOf = (tier) => path.join(catalogOwner, 'i18n', ...(tier ? [tier] : []), 'index.js');
      const doors = [null, ...Object.keys(READS)].map(indexOf).filter((index) => fs.existsSync(index));
      const moment = momentOf(file);
      const expected = moment && fs.existsSync(indexOf(moment)) ? moment : null;
      const loads = { entry: 'with the brand root, or with both the app and a landing', app: 'with the app\'s chrome or home', settings: 'with the settings page', landing: 'with its product\'s landing', null: 'with a lazy chunk' }[expected];
      const where = `${owner}/i18n${expected ? `/${expected}` : ''}`;
      if (!file.startsWith(catalogOwner + path.sep)) violations.catalogAcrossOwners.push(`src/${relativeFile}:${line} imports ${specifier} — only ${owner} reads its own catalog`);
      else if (!doors.includes(target)) violations.catalogAcrossOwners.push(`src/${relativeFile}:${line} imports ${specifier} — read the catalog through its i18n/index.js`);
      else if (target !== indexOf(expected)) violations.catalogByLoading.push(`src/${relativeFile}:${line} loads ${loads}, so it reads ${where}/index.js and its copy lives in ${where}/en.json`);
    }
  }
}

test('nothing product-neutral imports from src/products/ — the registry is the only seam', () => {
  assert.deepEqual(violations.shellIntoProducts, []);
});

test('no product imports from another product', () => {
  assert.deepEqual(violations.productIntoProduct, []);
});

test('every dynamic import names its module as a string literal', () => {
  assert.deepEqual(violations.computedImports, []);
});

test('no product imports from the /app chrome', () => {
  assert.deepEqual(violations.productIntoAppChrome, []);
});

test('every catalog is read only by its owner, through its i18n/index.js', () => {
  assert.deepEqual(violations.catalogAcrossOwners, []);
});

test('a module reads the catalog of the moment it loads: the brand root\'s, the app\'s, the settings page\'s, its product\'s landing\'s, or its room\'s', () => {
  assert.deepEqual(BRAND_ROOT_PICTURES.filter((picture) => !fs.existsSync(picture)).map((picture) => `${path.relative(SRC, picture)} is gone; name the brand-root picture here`), []);
  assert.deepEqual(Object.entries(DOOR_ROOTS).flatMap(([moment, roots]) => roots.map((found, door) => (found.length ? null : `${path.relative(SRC, DOORS[moment][door][0])} lazily loads no ${moment} module`))).filter(Boolean), []);
  assert.deepEqual(violations.catalogByLoading, []);
});

// The landing seam. Since the shell stopped hard-coding /roadmap, the router mounts a landing by
// looking up `landing.href` — a product that declares none has no front door at all.
const landingsMissing = PRODUCTS
  .filter((p) => typeof p.landing?.href !== 'string' || typeof p.landing?.page !== 'function')
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

// The brand root composes a row among the three tools and a section off `landing.root` alone, for the
// products that are OPEN. A product still holding itself shut brings neither, and keeps only its place in
// the header and the footer. ShellHome reads `landing.tagline` for it instead.
//
// A picture is either a lazy exotic (what every product declares today) or a plain function component.
const isComponent = (value) => typeof value === 'function'
  || (typeof value === 'object' && value !== null && typeof value.$$typeof === 'symbol');
const isText = (value) => typeof value === 'string' && value.length > 0;
const isSize = (value) => Number.isInteger(value) && value > 0;
const stagesHold = (stages) => Array.isArray(stages) && stages.length > 0
  && stages.every((stage, index) => isText(stage?.name) && isSize(stage.width) && isSize(stage.height) && (index === 0 || stages[index - 1].width < stage.width));
const OPEN = PRODUCTS.filter((product) => product.shell.status === 'open');

function rootSeamGaps(product) {
  const root = product.landing?.root;
  if (!root) return ['landing.root'];
  const features = Array.isArray(root.features) ? root.features : [];
  return [
    ...(isText(root.kind) ? [] : ['root.kind']),
    ...(isText(root.line) ? [] : ['root.line']),
    ...(isText(root.link?.href) ? [] : ['root.link.href']),
    ...(isText(root.link?.label) ? [] : ['root.link.label']),
    ...(['room', 'landing'].includes(root.link?.to) ? [] : ['root.link.to (room or landing)']),
    ...(root.title ? [] : ['root.title']),
    ...(isText(root.paragraph) ? [] : ['root.paragraph']),
    ...(features.length === 3 && features.every((feature) => isText(feature?.title) && isText(feature?.text)) ? [] : ['root.features (exactly three {title, text})']),
    ...(/^[a-z][a-z0-9_]*$/.test(root.picture?.name ?? '') ? [] : ['root.picture.name (lower snake case, as every label its event tells)']),
    ...(isText(root.picture?.label) ? [] : ['root.picture.label']),
    ...(stagesHold(root.picture?.stages) ? [] : ['root.picture.stages (named sizes, narrowest first)']),
    ...(isComponent(root.picture?.Picture) ? [] : ['root.picture.Picture']),
  ];
}

// The gap is not a missing section: BrandLanding destructures `landing.root` as it composes, so one
// product's gap throws, the error boundary catches it and the entire front door renders empty.
const rootSeamMissing = OPEN
  .map((p) => [p, rootSeamGaps(p)])
  .filter(([, gaps]) => gaps.length > 0)
  .map(([p, gaps]) => `product "${p.id}" leaves the brand root short of ${gaps.join(', ')} — BrandLanding destructures landing.root as it composes, so the gap throws through render and the whole front door goes blank`);

test('every open product brings the words and the picture its row and section on the brand root are made of', () => {
  assert.deepEqual(rootSeamMissing, []);
});

const BRAND_LANDING = fs.readFileSync(path.join(SRC, 'shell', 'marketing', 'BrandLanding.jsx'), 'utf8');

test('the brand root composes a row and a section for the open products only', () => {
  assert.match(BRAND_LANDING, /const open = PRODUCTS\.filter\(\(product\) => product\.shell\.status === 'open'\);/);
  assert.equal((BRAND_LANDING.match(/open\.map\(/g) ?? []).length, 2, 'the tools and the sections are not both composed off the open products');
  assert.equal(BRAND_LANDING.includes('PRODUCTS.map('), false, 'a row or a section is still composed off every product, open or shut');
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

// The front door is said twice: by the crawlable shell in web/index.html, which the build pins byte for
// byte to landingHeads.js, and by the running page. These pin both to the catalog's one sentence each.
const SHELL = fs.readFileSync(path.resolve(SRC, '..', 'index.html'), 'utf8');
const ROOT_HEAD = LANDING_HEADS.find((head) => head.path === '/');

test('the shell and the page carry the same one <h1>, above everything they compose', () => {
  assert.equal(ROOT_HEAD.fallback.h1, 'Windmill is where a person keeps growing in body, skill and\u00A0mind.');
  assert.equal(SHELL.includes('>Windmill is where a person keeps growing in body, skill and&nbsp;mind.</h1>'), true, 'web/index.html says something else in its <h1>');
  assert.match(BRAND_LANDING, /<h1 className="front-heading">\{t\('shell\.landingHead\.heading', \{ break: <br \/> \}\)\}<\/h1>/);
  assert.equal((BRAND_LANDING.match(/<h1[ >]/g) ?? []).length, 1, 'the page draws more than one <h1>');
  assert.ok(BRAND_LANDING.indexOf('<h1 ') < BRAND_LANDING.indexOf('{open.map('), 'a tool or a section is composed above the heading');
});

test('the shell names the open products\' tools as the page does, in registry order', () => {
  assert.deepEqual(ROOT_HEAD.fallback.tools, OPEN.map((product) => ({
    name: `Windmill ${product.label}`,
    kind: product.landing.root.kind,
    line: product.landing.root.line,
    link: { href: product.landing.root.link.href, label: product.landing.root.link.label },
  })));
  for (const tool of ROOT_HEAD.fallback.tools) {
    assert.equal(SHELL.includes(`>${tool.name}</h2>`), true, `web/index.html does not name ${tool.name}`);
    assert.equal(SHELL.includes(`<a href="${tool.link.href}" style="color: #211B13; font-weight: 500;">${tool.link.label}</a>`), true, `web/index.html sends ${tool.name} somewhere else`);
  }
});

test('the brand root says one title and one description everywhere, and marks up no FAQ', () => {
  assert.deepEqual(
    { title: ROOT_HEAD.title, ogTitle: ROOT_HEAD.ogTitle, twitterTitle: ROOT_HEAD.twitterTitle, description: ROOT_HEAD.description, ogDescription: ROOT_HEAD.ogDescription, twitterDescription: ROOT_HEAD.twitterDescription, schema: ROOT_HEAD.schema },
    {
      title: 'Windmill — a skill tree, a workout log and a journal',
      ogTitle: 'Windmill — a skill tree, a workout log and a journal',
      twitterTitle: 'Windmill — a skill tree, a workout log and a journal',
      description: 'Windmill is where a person keeps growing in body, skill and mind. An AI-native workout log, skill tree and journal. Use your own AI or ours.',
      ogDescription: 'Windmill is where a person keeps growing in body, skill and mind. An AI-native workout log, skill tree and journal. Use your own AI or ours.',
      twitterDescription: 'Windmill is where a person keeps growing in body, skill and mind. An AI-native workout log, skill tree and journal. Use your own AI or ours.',
      schema: [],
    },
  );
  assert.equal(SHELL.includes('FAQPage'), false, 'web/index.html still marks up an FAQ the page does not draw');
});

test('nothing imports the retired roadmap List or Board gate', () => {
  const list = path.join(PRODUCTS_DIR, 'roadmap', 'list') + path.sep;
  const gate = path.join(PRODUCTS_DIR, 'roadmap', 'board', 'gate.js');
  assert.deepEqual([fs.existsSync(list), fs.existsSync(gate)], [false, false]);
  const offenders = [];
  for (const file of sourceFiles(SRC)) {
    for (const { specifier, line } of importsOf(file)) {
      if (!specifier.startsWith('.')) continue;
      const resolved = path.resolve(path.dirname(file), specifier);
      if (`${resolved}${path.sep}`.startsWith(list) || resolved === gate) offenders.push(`${path.relative(SRC, file)}:${line}`);
    }
  }
  assert.deepEqual(offenders, []);
});
