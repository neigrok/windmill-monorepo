import fs from 'node:fs';
import { createRequire } from 'node:module';
import { declarations, readGrounds, staticBootScript } from './appBoot.js';
import { staticAppearanceScript } from './staticAppearance.js';
import { LABELS, staticEventsScript } from './staticEvents.js';
import { KEY } from '../src/shell/appearance.js';

const require = createRequire(import.meta.url);

// Serves what the plain HTML pages in public/ link — each look's sheets with the faces they name under /fonts/,
// /boot.js, the theme stamp, /appearance.js, the appearance switch, and /events.js, the instrument look's events — by
// middleware in dev and emitted into dist at build.

// A face is the package sheet that declares it (the aggregate one: per-subset entry files omit unicode-range) and
// the woff2 file it names there.
const fontsourceFaces = (name, subsets, weights) => weights.flatMap((weight) => subsets.map((subset) => (
  { sheet: `@fontsource/${name}/${weight}.css`, file: `${name}-${subset}-${weight}-normal.woff2` })));
const FAMILY_FACES = [
  ...fontsourceFaces('baloo-2', ['latin', 'latin-ext'], [600, 700, 800]),
  ...fontsourceFaces('nunito', ['latin', 'latin-ext'], [400, 700, 800]),
  ...fontsourceFaces('jetbrains-mono', ['latin'], [400, 600, 700]),
];
// The front page's Inter, the two subsets its own sheet (src/shell/marketing/brandLanding.css) declares.
const INSTRUMENT_FACES = ['latin-ext', 'latin'].map((subset) => (
  { sheet: '@fontsource-variable/inter/index.css', file: `inter-${subset}-wght-normal.woff2` }));

// The looks a page in public/ can wear, named on its <html data-look> (a page that names none wears the family look):
// the files it must link, the empty box /appearance.js fills, reserved in the HTML so the deferred mount moves
// nothing, and whether it tells the site's events, as the front page in that look does.
const FAMILY_BOX = '<span class="wm-appearance" aria-hidden="true"></span>';
const INSTRUMENT_BOX = '<span class="wm-appearance" data-choices="system light dark" aria-hidden="true"></span>';
const LOOKS = {
  family: {
    links: ['fonts.css', 'chrome.css', 'boot.js', 'appearance.js'],
    box: new RegExp(`<span class="navr">\\s*${FAMILY_BOX}`),
    boxPlace: `open .navr with ${FAMILY_BOX}`,
  },
  instrument: {
    links: ['instrument.css', 'boot.js', 'appearance.js'],
    box: new RegExp(`<div class="site-switch">\\s*${INSTRUMENT_BOX}\\s*</div>`),
    boxPlace: `hold ${INSTRUMENT_BOX} alone in .site-switch`,
    tellsEvents: true,
  },
};

// Pages that are no page of their own: a redirect wears no look and links nothing.
const UNDRESSED = ['pricing-preview.html'];
const PAGES = new URL('../public/', import.meta.url);

// Throws on the first way a dressed page would ship wrong.
export function checkStaticPage(page, html) {
  const lookName = /<html\b[^>]*\sdata-look="([^"]*)"/.exec(html)?.[1] ?? 'family';
  const look = LOOKS[lookName];
  if (!look) {
    throw new Error(`public/${page} wears data-look="${lookName}", and public/ has no sheet for that look`);
  }
  const missing = look.links.filter((file) => !html.includes(`href="/${file}"`) && !html.includes(`src="/${file}"`));
  if (missing.length) {
    throw new Error(`public/${page} does not link ${missing.map((file) => `/${file}`).join(' or ')} — it would render outside its look, or light whatever the visitor chose`);
  }
  if (!look.box.test(html)) {
    throw new Error(`public/${page} does not ${look.boxPlace} — /appearance.js mounts into that box, and reserving it in the HTML is what keeps the page from sliding when the script lands`);
  }
  const named = /<html\b[^>]*\sdata-page="([^"]*)"/.exec(html)?.[1];
  if (look.tellsEvents && !(LABELS.page.includes(named) && html.includes('<script defer src="/events.js"></script>'))) {
    throw new Error(`public/${page} wears the ${lookName} look but does not name its page on <html data-page> (${LABELS.page.join(' or ')}) and link /events.js deferred — it would tell none of the site's events`);
  }

  const canonical = /<link rel="canonical" href="([^"]+)"/.exec(html)?.[1];
  const noindex = /<meta name="robots" content="[^"]*noindex/.test(html);
  if (!canonical && !noindex) {
    throw new Error(`public/${page} names no canonical and is not noindex — the sitemap is built from these, so the page would ship unlisted`);
  }
  if (noindex) return;

  const title = /<title>([^<]*)<\/title>/.exec(html)?.[1];
  const description = /<meta name="description" content="([^"]*)"/.exec(html)?.[1];
  const said = (attribute, value) => html.includes(`${attribute} content="${value}" />`);
  const wrong = [
    ['og:title', 'property="og:title"', title],
    ['og:description', 'property="og:description"', description],
    ['og:url', 'property="og:url"', canonical],
    ['twitter:title', 'name="twitter:title"', title],
    ['twitter:description', 'name="twitter:description"', description],
  ].filter(([, attribute, value]) => !value || !said(attribute, value));
  if (wrong.length || !html.includes('name="twitter:card"') || !html.includes('property="og:image"')) {
    throw new Error(`public/${page} unfurls as something other than itself — ${wrong.map(([tag]) => tag).join(', ') || 'no twitter:card or og:image'}. og/twitter must repeat this page's own <title>, description and canonical`);
  }
}

// The instrument look's tokens as the front page's frame resolves them, by day and by night: styles/tokens/looks.css
// read against the family ramp of tokens/colors.css, so a static page cannot drift from the front page's colours.
// A token naming another look token keeps the reference; one naming anything the ramp lacks stops the build.
export function instrumentTokens(looksCss, colorsCss) {
  const dayRamp = declarations(colorsCss, ':root');
  const nightRamp = { ...dayRamp, ...declarations(colorsCss, '[data-theme="dark"]') };
  const day = declarations(looksCss, '[data-look="instrument"]');
  const night = { ...day, ...declarations(looksCss, '[data-look="instrument"][data-theme="dark"]') };
  const resolve = (value, ramp, through = []) => value.replace(/var\((--[\w-]+)\)/g, (reference, name) => {
    if (name.startsWith('--look-')) return reference;
    if (!(name in ramp) || through.includes(name)) {
      throw new Error(`staticPageAssets: the instrument look names ${name}, which tokens/colors.css does not resolve — a static page would draw a colour the front page does not`);
    }
    return resolve(ramp[name], ramp, [...through, name]);
  });
  const resolved = (tokens, ramp) => Object.fromEntries(Object.entries(tokens).map(([name, value]) => [name, resolve(value, ramp)]));
  return { day: resolved(day, dayRamp), night: resolved(night, nightRamp) };
}

export function staticPageAssets() {
  const woff2 = new Map();
  const fontFaces = (faces) => faces.map(({ sheet, file }) => {
    const declared = fs.readFileSync(require.resolve(sheet), 'utf8').split('@font-face').find((block) => block.includes(file));
    if (!declared) {
      throw new Error(`${sheet} no longer declares ${file} — a static page would quietly lose a face`);
    }
    const family = /font-family:\s*([^;]+);/.exec(declared)[1];
    const weight = /font-weight:\s*([^;]+);/.exec(declared)[1];
    const format = new RegExp(`${file}\\) format\\('([^']+)'\\)`).exec(declared)[1];
    const range = /unicode-range:\s*([^;]+);/.exec(declared);
    woff2.set(file, require.resolve(`${sheet.slice(0, sheet.lastIndexOf('/'))}/files/${file}`));
    return [
      '@font-face {',
      `  font-family: ${family};`,
      '  font-style: normal;',
      '  font-display: swap;',
      `  font-weight: ${weight};`,
      `  src: url(/fonts/${file}) format('${format}');`,
      ...(range ? [`  unicode-range: ${range[1]};`] : []),
      '}',
    ].join('\n');
  });

  const tokens = new URL('../src/styles/tokens/', import.meta.url);
  const readToken = (name) => fs.readFileSync(new URL(name, tokens), 'utf8');
  const grounds = readGrounds(readToken('colors.css'), readToken('palettes.css'), ['clay']);
  const look = instrumentTokens(readToken('looks.css'), readToken('colors.css'));
  const block = (selector, values) => `${selector} {\n${Object.entries(values).map(([name, value]) => `  ${name}: ${value};`).join('\n')}\n}`;

  const sheets = new Map([
    ['fonts.css', `/* Generated by scripts/staticPageAssets.js from @fontsource — do not edit, do not commit. */\n${fontFaces(FAMILY_FACES).join('\n\n')}\n`],
    ['chrome.css', fs.readFileSync(new URL('./staticPageChrome.css', import.meta.url), 'utf8')],
    ['instrument.css', [
      '/* Generated by scripts/staticPageAssets.js from @fontsource-variable/inter, styles/tokens/looks.css and scripts/staticInstrument.css — do not edit, do not commit. */',
      ...fontFaces(INSTRUMENT_FACES),
      block('[data-look="instrument"]', look.day),
      block('[data-look="instrument"][data-theme="dark"]', Object.fromEntries(Object.entries(look.night).filter(([name, value]) => look.day[name] !== value))),
      fs.readFileSync(new URL('./staticInstrument.css', import.meta.url), 'utf8'),
    ].join('\n\n')],
    ['boot.js', staticBootScript(grounds, KEY)],
    ['appearance.js', staticAppearanceScript(KEY)],
    ['events.js', staticEventsScript()],
  ]);

  for (const page of fs.readdirSync(PAGES).filter((name) => name.endsWith('.html'))) {
    if (UNDRESSED.includes(page)) continue;
    checkStaticPage(page, fs.readFileSync(new URL(page, PAGES), 'utf8'));
  }

  return {
    name: 'windmill:static-page-assets',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = (req.url || '').split('?')[0];
        const sheet = sheets.get(url.slice(1));
        if (sheet) {
          res.setHeader('content-type', url.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8');
          res.end(sheet);
          return;
        }
        const source = url.startsWith('/fonts/') ? woff2.get(url.slice('/fonts/'.length)) : null;
        if (!source) {
          next();
          return;
        }
        res.setHeader('content-type', 'font/woff2');
        res.end(fs.readFileSync(source));
      });
    },
    generateBundle() {
      for (const [fileName, source] of sheets) {
        this.emitFile({ type: 'asset', fileName, source });
      }
      for (const [file, source] of woff2) {
        this.emitFile({ type: 'asset', fileName: `fonts/${file}`, source: fs.readFileSync(source) });
      }
    },
  };
}
