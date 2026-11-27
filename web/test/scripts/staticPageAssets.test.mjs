import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { checkStaticPage, instrumentTokens, staticPageAssets } from '../../scripts/staticPageAssets.js';

const page = (name) => readFileSync(new URL(`../../public/${name}`, import.meta.url), 'utf8');
const token = (name) => readFileSync(new URL(`../../src/styles/tokens/${name}`, import.meta.url), 'utf8');

// The gate is what forces a page to dress for its look: a page that forgets a link, or the box the switch fills, fails
// the build, not the visitor.
test('a family page must link the family sheets and open .navr with the empty switch box', () => {
  const terms = page('terms.html');
  assert.doesNotThrow(() => checkStaticPage('terms.html', terms));
  const boxless = terms.replace('<span class="wm-appearance" aria-hidden="true"></span>', '');
  assert.throws(() => checkStaticPage('terms.html', boxless), {
    message: 'public/terms.html does not open .navr with <span class="wm-appearance" aria-hidden="true"></span> — /appearance.js mounts into that box, and reserving it in the HTML is what keeps the page from sliding when the script lands',
  });
  const boxLater = terms.replace('<span class="wm-appearance" aria-hidden="true"></span>\n', '').replace('</span>\n    </header>', '<span class="wm-appearance" aria-hidden="true"></span></span>\n    </header>');
  assert.throws(() => checkStaticPage('terms.html', boxLater), /does not open .navr with/, 'a box anywhere but first in .navr is a nav that still slides');
  assert.throws(() => checkStaticPage('terms.html', terms.replace('<script defer src="/appearance.js"></script>', '')), {
    message: 'public/terms.html does not link /appearance.js — it would render outside its look, or light whatever the visitor chose',
  });
});

test('an instrument page must link /instrument.css, not the family chrome, and hold the Auto switch box in its footer', () => {
  const pricing = page('pricing.html');
  assert.doesNotThrow(() => checkStaticPage('pricing.html', pricing));
  assert.throws(() => checkStaticPage('pricing.html', pricing.replace('href="/instrument.css"', 'href="/chrome.css"')), {
    message: 'public/pricing.html does not link /instrument.css — it would render outside its look, or light whatever the visitor chose',
  });
  assert.throws(() => checkStaticPage('pricing.html', pricing.replace(' data-choices="system light dark"', '')), {
    message: 'public/pricing.html does not hold <span class="wm-appearance" data-choices="system light dark" aria-hidden="true"></span> alone in .site-switch — /appearance.js mounts into that box, and reserving it in the HTML is what keeps the page from sliding when the script lands',
  });
  assert.throws(() => checkStaticPage('pricing.html', pricing.replace('data-look="instrument"', 'data-look="paper"')), {
    message: 'public/pricing.html wears data-look="paper", and public/ has no sheet for that look',
  });
});

test('an indexable page must unfurl as itself, and a noindex page need not', () => {
  const privacy = page('privacy.html');
  assert.throws(() => checkStaticPage('privacy.html', privacy.replace('<meta property="og:title" content="Privacy — Windmill" />', '<meta property="og:title" content="Windmill" />')), {
    message: 'public/privacy.html unfurls as something other than itself — og:title. og/twitter must repeat this page\'s own <title>, description and canonical',
  });
  assert.throws(() => checkStaticPage('privacy.html', privacy.replace(/<link rel="canonical"[^>]*>/, '')), /names no canonical and is not noindex/);
  assert.doesNotThrow(() => checkStaticPage('404.html', page('404.html')));
});

// The static pricing page and the front page wear one look: its colours are read off the same tokens, never copied.
test('the instrument tokens are the front page\'s, resolved off the family ramp by day and by night', () => {
  const lines = {
    '--look-line-faint': 'color-mix(in srgb, var(--look-ink-1) 8%, transparent)',
    '--look-line': 'color-mix(in srgb, var(--look-ink-1) 12%, transparent)',
    '--look-line-firm': 'color-mix(in srgb, var(--look-ink-1) 16%, transparent)',
    '--look-wash': 'color-mix(in srgb, var(--look-ink-1) 7%, transparent)',
    '--look-radius-frame': '16px',
    '--look-radius-inner': '12px',
  };
  const font = "'Inter Variable', system-ui, -apple-system, 'Segoe UI', sans-serif";
  assert.deepEqual(instrumentTokens(token('looks.css'), token('colors.css')), {
    day: {
      '--look-font': font, '--look-ground': '#F9F5EB', '--look-panel': '#FDFBF5',
      '--look-ink-1': '#211B13', '--look-ink-2': '#5C5246', '--look-ink-3': '#766C5E',
      '--look-accent': '#BC6C42', '--look-pill': '#9D5330', '--look-pill-ink': '#FFFFFF', ...lines,
    },
    night: {
      '--look-font': font, '--look-ground': '#0B0B0C', '--look-panel': '#111112',
      '--look-ink-1': '#F2F0EB', '--look-ink-2': '#B4B2AC', '--look-ink-3': '#86847E',
      '--look-accent': '#D98B5F', '--look-pill': '#D98B5F', '--look-pill-ink': '#1B1408', ...lines,
    },
  });
});

test('a look token naming a colour the family ramp lacks stops the build', () => {
  assert.throws(() => instrumentTokens('[data-look="instrument"] { --look-ink-1: var(--neutral-950); }', token('colors.css')), {
    message: 'staticPageAssets: the instrument look names --neutral-950, which tokens/colors.css does not resolve — a static page would draw a colour the front page does not',
  });
});

test('/instrument.css holds Inter, the day tokens, only what night changes, then the look\'s chrome; the family sheets name no Inter', () => {
  const emitted = new Map();
  staticPageAssets().generateBundle.call({ emitFile: ({ fileName, source }) => emitted.set(fileName, source) });
  const sheet = emitted.get('instrument.css');
  const faces = sheet.match(/@font-face \{[^}]*\}/g);
  assert.deepEqual(faces.map((face) => [/font-family: ([^;]+);/.exec(face)[1], /font-weight: ([^;]+);/.exec(face)[1], /src: ([^;]+);/.exec(face)[1]]), [
    ["'Inter Variable'", '100 900', "url(/fonts/inter-latin-ext-wght-normal.woff2) format('woff2-variations')"],
    ["'Inter Variable'", '100 900', "url(/fonts/inter-latin-wght-normal.woff2) format('woff2-variations')"],
  ]);
  assert.ok(emitted.has('fonts/inter-latin-ext-wght-normal.woff2') && emitted.has('fonts/inter-latin-wght-normal.woff2'));
  assert.equal(/\[data-look="instrument"\]\[data-theme="dark"\] \{\n([^}]*)\}/.exec(sheet)[1], [
    '  --look-ground: #0B0B0C;', '  --look-panel: #111112;', '  --look-ink-1: #F2F0EB;', '  --look-ink-2: #B4B2AC;',
    '  --look-ink-3: #86847E;', '  --look-accent: #D98B5F;', '  --look-pill: #D98B5F;', '  --look-pill-ink: #1B1408;', '',
  ].join('\n'));
  assert.ok(sheet.endsWith(readFileSync(new URL('../../scripts/staticInstrument.css', import.meta.url), 'utf8')));
  assert.ok(sheet.indexOf('[data-look="instrument"] {') < sheet.indexOf('/* The instrument look\'s chrome'));
  assert.equal(/Inter/.test(emitted.get('fonts.css') + emitted.get('chrome.css')), false);
});
