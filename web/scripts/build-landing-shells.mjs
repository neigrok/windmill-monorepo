// Every landing renders through the SPA, whose dist/index.html carries the BRAND ROOT's shell.
// Served as-is at a landing's own pathname, that shell would tell a crawler the wrong story twice:
// canonical folds the page into /, and the no-JS body — the only body a crawler without JavaScript
// ever sees — greets a journal reader with "Any goal, as a skill tree". This postbuild step writes
// one shell per landing: the same built page (hashed asset URLs are absolute, so it boots from any
// path) with the head, the structured data and the fallback body swapped for that landing's own,
// out of landingHeads.js — the same data the runtime head swap reads, so a shell and its live page
// can never disagree.
//
// Every swap asserts the string it is replacing is there and unambiguous, so a head or a fallback
// edited in web/index.html and forgotten here fails the build instead of shipping a stale shell.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { LANDING_HEADS, SITE_ORIGIN, SITE_SCHEMA } from '../src/shell/marketing/landingHeads.js';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const built = readFileSync(join(dist, 'index.html'), 'utf8');

const root = LANDING_HEADS.find((head) => head.path === '/');
if (!root) throw new Error('build-landing-shells: landingHeads.js declares no "/" entry — the brand-root shell is what dist/index.html holds and every swap reads from it');

// The shelf the React footer renders, written out for the crawler that never runs it — so the
// gallery, the MCP listing and the policies stay reachable from every landing without JavaScript.
// It mirrors LandingChrome's LEGAL_LINKS and the product registry; the registry itself imports
// React, which a plain Node build script cannot.
const LEGAL_SHELF = [
  ['/pricing.html', 'Pricing'],
  ['/privacy.html', 'Privacy'],
  ['/terms.html', 'Terms'],
  ['/refunds.html', 'Refunds'],
  ['/changelog.html', 'Changelog'],
];
const PRODUCT_SHELF = [
  ['/roadmap', 'Roadmap'],
  ['/journal', 'Journal'],
  ['/gym', 'Gym'],
  ['/gallery', 'Gallery'],
  ['/connect.html', 'Connect'],
];

function swapOnce(text, from, to, where) {
  const first = text.indexOf(from);
  if (first === -1) throw new Error(`build-landing-shells: ${where} no longer holds the brand-root string landingHeads.js declares:\n  ${from}\nweb/index.html and src/shell/marketing/landingHeads.js are edited together.`);
  if (text.indexOf(from, first + 1) !== -1) throw new Error(`build-landing-shells: ${where} holds that string twice, so a swap would change one and leave the other:\n  ${from}`);
  return text.slice(0, first) + to + text.slice(first + from.length);
}

// The brand root's description, og:description and twitter:description are byte-identical, so a
// swap has to be scoped to one tag rather than hunt the document for a unique string. `[^>]`
// spans newlines, which is what lets this match a tag however its attributes wrapped.
function swapInTag(html, marker, from, to) {
  const tags = html.match(new RegExp(`<[a-z]+[^>]*${marker}[^>]*>`, 'g'));
  if (!tags) throw new Error(`build-landing-shells: dist/index.html has no <… ${marker} …> tag to swap`);
  if (tags.length > 1) throw new Error(`build-landing-shells: dist/index.html carries ${tags.length} <… ${marker} …> tags — swapping the first and leaving the rest would ship two answers to one crawler`);
  return swapOnce(html, tags[0], swapOnce(tags[0], from, to, `the ${marker} tag`), `dist/index.html at ${marker}`);
}

// Shared site and publisher, this page as a page of it, then whatever this page's own content
// backs — a roadmap app, a journal app, a gym app, the brand root's FAQ. Every landing asserts the
// thing its own page is for; none of them asserts anything the product does not yet do.
function renderSchema(head) {
  if (!head.schema) throw new Error(`build-landing-shells: the ${head.path} row declares no schema — a shell that reuses the brand root's would assert the wrong url from this one`);
  const url = `${SITE_ORIGIN}${head.path}`;
  const page = {
    '@type': 'WebPage',
    '@id': `${url}#webpage`,
    'url': url,
    'name': head.title,
    'description': head.description,
    'isPartOf': { '@id': `${SITE_ORIGIN}/#website` },
    'inLanguage': 'en',
  };
  const graph = { '@context': 'https://schema.org', '@graph': [...SITE_SCHEMA, page, ...head.schema] };
  const json = JSON.stringify(graph, null, 2).split('\n').map((line) => `      ${line}`).join('\n');
  return `<script type="application/ld+json">\n${json}\n    </script>`;
}

// React's createRoot().render() replaces this on mount, so it is a pure fallback — which is exactly
// why it has to mirror the page's own hero rather than the brand root's. Inline-styled so it reads
// correctly before the CSS bundle loads, and before there is a bundle at all.
function renderFallback(head) {
  const page = head.fallback;
  const missing = ['accent', 'badge', 'h1', 'sub', 'actions', 'trust', 'notes'].filter((field) => !page?.[field]);
  if (missing.length) throw new Error(`build-landing-shells: the ${head.path} row is missing its fallback ${missing.join(', ')} — a shell without a body of its own says the brand root's words to the one visitor who never runs the page`);
  const actions = page.actions.map((action, index) => (index === 0
    ? `<a href="${action.href}" style="display: inline-block; background: ${page.accent}; color: #F9F5EB; font-weight: 700; padding: 12px 22px; border-radius: 12px; text-decoration: none;">${action.label}</a>`
    : `<a href="${action.href}" style="display: inline-block; color: #211B13; font-weight: 700; padding: 12px 22px; text-decoration: none;">${action.label}</a>`));
  const notes = page.notes.map((note) => `        <p style="font-size: 15px; color: #4A4034; line-height: 1.6; margin: 0 0 20px;">${note}</p>`);
  const shelf = (rows) => rows.map(([href, label]) => `<a href="${href}" style="color: #6B5D4A; margin: 0 10px;">${label}</a>`).join('\n          ');

  return `<div id="root">
      <main style="max-width: 720px; margin: 0 auto; padding: 72px 24px; text-align: center; font-family: system-ui, -apple-system, 'Nunito', sans-serif; color: #211B13;">
        <p style="font-size: 12.5px; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; color: #6B5D4A; margin: 0 0 14px;">${page.badge}</p>
        <h1 style="font-family: 'Baloo 2', system-ui, sans-serif; font-weight: 700; font-size: 44px; line-height: 1.07; margin: 0 0 16px;">${page.h1}</h1>
        <p style="font-size: 19px; line-height: 1.5; color: #4A4034; margin: 0 auto 28px; max-width: 560px;">${page.sub}</p>
        <p style="margin: 0 0 28px;">
          ${actions.join('\n          &nbsp;\n          ')}
        </p>
        <p style="font-size: 14px; color: #6B5D4A; margin: 0 0 28px;">${page.trust}</p>
${notes.join('\n')}
        <nav aria-label="Legal and pricing" style="font-size: 14px; color: #6B5D4A;">
          ${shelf(LEGAL_SHELF)}
        </nav>
        <nav aria-label="Windmill products" style="font-size: 14px; color: #6B5D4A; margin-top: 8px;">
          ${shelf(PRODUCT_SHELF)}
        </nav>
      </main>
    </div>`;
}

// windmill_server rewrites everything between these when it serves a share page (/t/:id), so a
// shell that lost them would unfurl every shared tree as the landing it was built from.
const UNFURL_SENTINELS = ['<!-- meta:unfurl:start -->', '<!-- meta:unfurl:end -->'];

// The shell already preloads the entry and its static imports; a landing's own chunk is a dynamic
// import, so nothing in the HTML mentions it and the browser only learns it exists once the entry
// has arrived and run. On a phone that is a whole serial round trip spent looking at the fallback.
// Naming it here moves the request into the same flight as the rest of the page.
const manifest = JSON.parse(readFileSync(join(dist, '.vite', 'manifest.json'), 'utf8'));

function preloadTags(head) {
  const entry = manifest[head.module];
  if (!entry) throw new Error(`build-landing-shells: ${head.path} names the module ${head.module}, which is not in the Vite manifest — rename it in landingHeads.js or the shell preloads nothing`);
  const tags = [`<link rel="modulepreload" crossorigin href="/${entry.file}">`];
  for (const css of entry.css ?? []) tags.push(`<link rel="stylesheet" crossorigin href="/${css}">`);
  return `${tags.join('\n    ')}\n  </head>`;
}

const rootSchema = renderSchema(root);
const rootFallback = renderFallback(root);

const shells = [];
for (const head of LANDING_HEADS) {
  if (head.path === '/') continue;

  const canonical = `${SITE_ORIGIN}${head.path}`;
  let html = swapOnce(built, `<title>${root.title}</title>`, `<title>${head.title}</title>`, 'dist/index.html');
  html = swapInTag(html, 'name="description"', root.description, head.description);
  html = swapInTag(html, 'rel="canonical"', `${SITE_ORIGIN}/`, canonical);
  html = swapInTag(html, 'property="og:url"', `${SITE_ORIGIN}/`, canonical);
  html = swapInTag(html, 'property="og:title"', root.ogTitle, head.ogTitle);
  html = swapInTag(html, 'property="og:description"', root.ogDescription, head.ogDescription);
  html = swapInTag(html, 'property="og:image:alt"', root.imageAlt, head.imageAlt);
  html = swapInTag(html, 'name="twitter:title"', root.twitterTitle, head.twitterTitle);
  html = swapInTag(html, 'name="twitter:description"', root.twitterDescription, head.twitterDescription);
  html = swapInTag(html, 'name="twitter:image:alt"', root.imageAlt, head.imageAlt);
  html = swapOnce(html, rootSchema, renderSchema(head), 'dist/index.html at the JSON-LD block');
  html = swapOnce(html, rootFallback, renderFallback(head), 'dist/index.html at the no-JS fallback body');
  html = swapOnce(html, '</head>', preloadTags(head), 'dist/index.html at </head>');

  for (const sentinel of UNFURL_SENTINELS) {
    const at = html.indexOf(sentinel);
    if (at === -1 || html.indexOf(sentinel, at + 1) !== -1) throw new Error(`build-landing-shells: the ${head.path} shell does not carry exactly one ${sentinel} — the backend's share-page rewriter keys on it`);
  }

  mkdirSync(join(dist, head.path), { recursive: true });
  writeFileSync(join(dist, head.path, 'index.html'), html);
  shells.push(`dist${head.path}/index.html`);
}

console.log(`build-landing-shells: ${shells.length} shells written — head, structured data and no-JS body asserted and swapped in each — ${shells.join(', ')}`);
