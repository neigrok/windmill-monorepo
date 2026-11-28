// Writes one shell per landing: dist/index.html with the head, structured data and no-JS body swapped for that
// landing's own, out of landingHeads.js and, for a product's landing, the whole page its product supplies.
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { basename, dirname, extname, join } from 'node:path';
import { LANDING_HEADS, PRODUCT_LANDING_MODULE, SITE_ORIGIN, SITE_SCHEMA } from '../src/shell/marketing/landingHeads.js';
import { LEGAL_LINKS, LEGAL_SHELF_LABEL, PRODUCT_SHELF_LABEL, SURFACE_LINKS } from '../src/shell/marketing/siteIdentity.js';
import { PRODUCTS } from '../src/shell/products.js';
import { htmlAttribute, htmlText, productLandingMain, questionsSchema } from './productLandingBody.mjs';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const built = readFileSync(join(dist, 'index.html'), 'utf8');

const root = LANDING_HEADS.find((head) => head.path === '/');
if (!root) throw new Error('build-landing-shells: landingHeads.js declares no "/" entry — the brand-root shell is what dist/index.html holds and every swap reads from it');

const LEGAL_SHELF = LEGAL_LINKS.map((link) => [link.href, link.label]);
const PRODUCT_SHELF = [
  ...PRODUCTS.map((product) => [product.landing.href, product.label]),
  ...SURFACE_LINKS.map((link) => [link.href, link.label]),
];

function swapOnce(text, from, to, where) {
  const first = text.indexOf(from);
  if (first === -1) throw new Error(`build-landing-shells: ${where} no longer holds the brand-root string landingHeads.js declares:\n  ${from}\nweb/index.html and src/shell/marketing/landingHeads.js are edited together.`);
  if (text.indexOf(from, first + 1) !== -1) throw new Error(`build-landing-shells: ${where} holds that string twice, so a swap would change one and leave the other:\n  ${from}`);
  return text.slice(0, first) + to + text.slice(first + from.length);
}

// description, og:description and twitter:description are byte-identical: scope each swap to one tag.
function swapInTag(html, marker, from, to) {
  const tags = html.match(new RegExp(`<[a-z]+[^>]*${marker}[^>]*>`, 'g'));
  if (!tags) throw new Error(`build-landing-shells: dist/index.html has no <… ${marker} …> tag to swap`);
  if (tags.length > 1) throw new Error(`build-landing-shells: dist/index.html carries ${tags.length} <… ${marker} …> tags — swapping the first and leaving the rest would ship two answers to one crawler`);
  return swapOnce(html, tags[0], swapOnce(tags[0], from, to, `the ${marker} tag`), `dist/index.html at ${marker}`);
}

function renderSchema(head, page = null) {
  if (!head.schema) throw new Error(`build-landing-shells: the ${head.path} row declares no schema — a shell that reuses the brand root's would assert the wrong url from this one`);
  const url = `${SITE_ORIGIN}${head.path}`;
  const webPage = {
    '@type': 'WebPage',
    '@id': `${url}#webpage`,
    'url': url,
    'name': head.title,
    'description': head.description,
    'isPartOf': { '@id': `${SITE_ORIGIN}/#website` },
    'inLanguage': 'en',
  };
  const graph = { '@context': 'https://schema.org', '@graph': [...SITE_SCHEMA, webPage, ...head.schema, ...(page ? [questionsSchema(page, url)] : [])] };
  const json = JSON.stringify(graph, null, 2).replace(/</g, '\\u003c').split('\n').map((line) => `      ${line}`).join('\n');
  return `<script type="application/ld+json">\n${json}\n    </script>`;
}

const shelf = (rows) => rows.map(([href, label]) => `<a href="${htmlAttribute(href)}" style="color: #6B5D4A; margin: 0 10px;">${htmlText(label)}</a>`).join('\n          ');

// A product landing's body: the whole page in its product's words, then the site's links. Replaced on mount.
function renderProductBody(page) {
  return `<div id="root">
      ${productLandingMain(page).split('\n').join('\n      ')}
      <nav aria-label="${htmlAttribute(LEGAL_SHELF_LABEL)}">
        ${shelf(LEGAL_SHELF)}
      </nav>
      <nav aria-label="${htmlAttribute(PRODUCT_SHELF_LABEL)}">
        ${shelf(PRODUCT_SHELF)}
      </nav>
    </div>`;
}

// The brand root's body: its heading, the two lines under it, the three tools and the site's links.
function renderRootFallback(head) {
  const page = head.fallback;
  const missing = ['h1', 'what', 'stance', 'tools'].filter((field) => !page?.[field]?.length);
  if (missing.length) throw new Error(`build-landing-shells: the / row is missing its fallback ${missing.join(', ')} — the front page would reach a visitor who never runs it with no words of its own`);
  const tools = page.tools.map((tool) => `        <h2 style="font-weight: 500; font-size: 22px; line-height: 28px; margin: 0;">${htmlText(tool.name)}</h2>
        <p style="font-size: 14px; line-height: 20px; color: #766C5E; margin: 2px 0 8px;">${htmlText(tool.kind)}</p>
        <p style="font-size: 17px; line-height: 26px; margin: 0 0 28px;">${htmlText(tool.line)} <a href="${htmlAttribute(tool.link.href)}" style="color: #211B13; font-weight: 500;">${htmlText(tool.link.label)}</a></p>`);

  return `<div id="root">
      <main style="max-width: 720px; margin: 0 auto; padding: 72px 24px; font-family: system-ui, -apple-system, 'Segoe UI', sans-serif; color: #211B13;">
        <h1 style="font-weight: 500; font-size: 40px; line-height: 42px; letter-spacing: -0.022em; margin: 0 0 16px;">${htmlText(page.h1)}</h1>
        <p style="font-size: 22px; line-height: 30px; margin: 0 0 6px;">${htmlText(page.what)}</p>
        <p style="font-size: 16px; line-height: 24px; color: #5C5246; margin: 0 0 40px;">${htmlText(page.stance)}</p>
${tools.join('\n')}
        <nav aria-label="${htmlAttribute(LEGAL_SHELF_LABEL)}" style="font-size: 14px; color: #6B5D4A; margin: 0 -10px;">
          ${shelf(LEGAL_SHELF)}
        </nav>
        <nav aria-label="${htmlAttribute(PRODUCT_SHELF_LABEL)}" style="font-size: 14px; color: #6B5D4A; margin: 8px -10px 0;">
          ${shelf(PRODUCT_SHELF)}
        </nav>
      </main>
    </div>`;
}

// windmill_server rewrites everything between these when it serves a share page (/t/:id).
const UNFURL_SENTINELS = ['<!-- meta:unfurl:start -->', '<!-- meta:unfurl:end -->'];

const manifest = JSON.parse(readFileSync(join(dist, '.vite', 'manifest.json'), 'utf8'));

// A module's chunk in the manifest. Rollup gives a product's page chunk no facade, so the manifest keys it by its file:
// it is the dynamic entry named after the page that lazily loads its own folder's pictures.
function chunkOf(module) {
  const name = basename(module, extname(module));
  return manifest[module] ?? Object.values(manifest).find((entry) => entry.isDynamicEntry && entry.name === name
    && entry.dynamicImports?.some((imported) => dirname(imported) === dirname(module)));
}

// The shell's product landing and the product's page, each with its stylesheets.
function preloadTags(head) {
  const tags = [PRODUCT_LANDING_MODULE, head.module].flatMap((module) => {
    const entry = chunkOf(module);
    if (!entry) throw new Error(`build-landing-shells: ${head.path} needs the module ${module}, which is not in the Vite manifest — rename it where it is named or the shell preloads nothing`);
    return [`<link rel="modulepreload" crossorigin href="/${entry.file}">`, ...(entry.css ?? []).map((css) => `<link rel="stylesheet" crossorigin href="/${css}">`)];
  });
  return `${tags.join('\n    ')}\n  </head>`;
}

const rootSchema = renderSchema(root);
const rootFallback = renderRootFallback(root);

const shells = [];
for (const product of PRODUCTS) {
  const head = product.landing.head;
  const page = await product.landing.page();
  const canonical = `${SITE_ORIGIN}${head.path}`;
  let html = swapOnce(built, `<title>${htmlText(root.title)}</title>`, `<title>${htmlText(head.title)}</title>`, 'dist/index.html');
  html = swapInTag(html, 'name="description"', htmlAttribute(root.description), htmlAttribute(head.description));
  html = swapInTag(html, 'rel="canonical"', htmlAttribute(`${SITE_ORIGIN}/`), htmlAttribute(canonical));
  html = swapInTag(html, 'property="og:url"', htmlAttribute(`${SITE_ORIGIN}/`), htmlAttribute(canonical));
  html = swapInTag(html, 'property="og:title"', htmlAttribute(root.ogTitle), htmlAttribute(head.ogTitle));
  html = swapInTag(html, 'property="og:description"', htmlAttribute(root.ogDescription), htmlAttribute(head.ogDescription));
  html = swapInTag(html, 'property="og:image:alt"', htmlAttribute(root.imageAlt), htmlAttribute(head.imageAlt));
  html = swapInTag(html, 'name="twitter:title"', htmlAttribute(root.twitterTitle), htmlAttribute(head.twitterTitle));
  html = swapInTag(html, 'name="twitter:description"', htmlAttribute(root.twitterDescription), htmlAttribute(head.twitterDescription));
  html = swapInTag(html, 'name="twitter:image:alt"', htmlAttribute(root.imageAlt), htmlAttribute(head.imageAlt));
  html = swapOnce(html, rootSchema, renderSchema(head, page), 'dist/index.html at the JSON-LD block');
  html = swapOnce(html, rootFallback, renderProductBody(page), 'dist/index.html at the no-JS fallback body');
  html = swapOnce(html, '</head>', preloadTags(head), 'dist/index.html at </head>');

  for (const sentinel of UNFURL_SENTINELS) {
    const at = html.indexOf(sentinel);
    if (at === -1 || html.indexOf(sentinel, at + 1) !== -1) throw new Error(`build-landing-shells: the ${head.path} shell does not carry exactly one ${sentinel} — the backend's share-page rewriter keys on it`);
  }

  mkdirSync(join(dist, head.path), { recursive: true });
  writeFileSync(join(dist, head.path, 'index.html'), html);
  shells.push(`dist${head.path}/index.html`);
}

console.log(`build-landing-shells: ${shells.length} shells written — head, structured data with the page's questions and the whole page as the no-JS body in each — ${shells.join(', ')}`);

const sitemap = new Set(LANDING_HEADS.map((head) => `${SITE_ORIGIN}${head.path}`));
for (const file of readdirSync(dist).filter((name) => name.endsWith('.html'))) {
  const html = readFileSync(join(dist, file), 'utf8');
  if (/<meta name="robots" content="[^"]*noindex/.test(html)) continue;
  const canonical = /<link rel="canonical" href="([^"]+)"/.exec(html)?.[1];
  if (!canonical) throw new Error(`build-landing-shells: dist/${file} is indexable but names no canonical — it cannot be placed in the sitemap`);
  sitemap.add(canonical);
}
const urls = [...sitemap].sort();
writeFileSync(join(dist, 'sitemap.xml'), [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<!-- Generated by scripts/build-landing-shells.mjs from each page\'s own canonical. Do not hand-edit. -->',
  '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
  ...urls.map((url) => `  <url><loc>${url}</loc></url>`),
  '</urlset>',
  '',
].join('\n'));

console.log(`build-landing-shells: sitemap.xml written with ${urls.length} urls — ${urls.join(', ')}`);
