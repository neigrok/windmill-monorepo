import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { register } from 'node:module';

// `node --test` speaks no JSX, so the shared loader compiles the strip on the way in.
register('../../jsxLoader.mjs', import.meta.url);
const React = (await import('react')).default;
const { renderToStaticMarkup } = await import('react-dom/server');
const { ScaleStrip } = await import('../../../src/products/journal/ScaleStrip.jsx');

const SOURCE = readFileSync(new URL('../../../src/products/journal/ScaleStrip.jsx', import.meta.url), 'utf8');
const CSS = readFileSync(new URL('../../../src/products/journal/journal.css', import.meta.url), 'utf8');
const CODE = SOURCE.replace(/^\s*\/\/.*$/gm, '').replace(/\/\/[^\n'`]*$/gm, '');   // the claims below are about code, not prose

const strip = (props) => renderToStaticMarkup(React.createElement(ScaleStrip, { day: '2026-08-23', ...props }));
const rowOf = (html, field) => html.slice(html.indexOf(`journal-track-${field}`)).split('</div>')[0];
const classesOf = (html, field) => rowOf(html, field).split('"')[0].split(' ').filter(Boolean);

// ─── §6.13 · nothing in the strip animates a layout property ──────────────────────────────────────

test('the head and the fill are positioned by transform, and neither transitions a layout property', () => {
  const rules = Object.fromEntries(
    ['.journal-head {', '.journal-track-fill-bar {', '.journal-stop-rail {', '.journal-head-rail {']
      .map((head) => [head, CSS.slice(CSS.indexOf(head)).split('}')[0]]),
  );
  for (const [name, body] of Object.entries(rules)) {
    const transition = /transition:([^;]*);/.exec(body)?.[1] ?? '';
    for (const layout of ['left', 'right', 'top', 'bottom', 'width', 'height', 'margin', 'inset']) {
      assert.ok(!new RegExp(`\\b${layout}\\b`).test(transition), `${name} transitions ${layout} — §6.13 permits transform, opacity, filter, box-shadow, background-position and stroke-* only`);
    }
  }
  assert.match(rules['.journal-stop-rail {'], /transform: translateX\(calc\(var\(--at\) \* 10%\)\)/);
  assert.match(rules['.journal-head-rail {'], /transition: transform 110ms/);
  assert.match(rules['.journal-track-fill-bar {'], /transform: translateX\(calc\(\(var\(--pos\) - 10\) \* \(100% - var\(--journal-inset\)\) \/ 10\)\)/);
  assert.match(rules['.journal-track-fill-bar {'], /transition: transform 110ms/);
  assert.ok(!/\.journal-track-fill \{[^}]*width:/s.test(CSS), 'the fill sizes itself with a width again');
});

test('the timelines are restarted by a STYLE flush, not by a forced reflow', () => {
  assert.ok(!CODE.includes('offsetWidth'), 'reading offsetWidth to restart an animation reflows the page');
  assert.match(SOURCE, /getComputedStyle\(el\)\.animationName;/);
});

// ─── §2.6 · the focus ring is additive to the head's own ring ─────────────────────────────────────

test("the focus ring's box is the head's BORDER box, so the head's own ring paints under it", () => {
  const ring = CSS.slice(CSS.indexOf('.journal-head::after {')).split('}')[0];
  assert.match(ring, /inset: calc\(-1 \* var\(--head-ring-w\)\);/);
  assert.match(ring, /border-radius: calc\(var\(--head-r\) \+ var\(--head-ring-w\)\);/);
  assert.match(CSS, /border: var\(--head-ring-w\) solid var\(--journal-head-ring\);/);
  // the two-tone spread is unchanged: a ground-coloured spacer first, the ink band 2 -> 4px out
  assert.match(CSS, /box-shadow: 0 0 0 2px var\(--surface-canvas\), 0 0 0 var\(--journal-focus-band\) var\(--journal-focus\);/);
});

// Canon states the GEOMETRY — a centreline 6px clear of the head's edge. Each platform's declaration
// is derived from it: web draws a 1px border INWARD, so its box is head + 13px; iOS strokes a path
// CENTRED, so its box is head + 12px. Same ring. The two numbers must never be "reconciled".
test("the held ring's centreline is 6px clear — head + 13px here, and the hold contracts onto it", () => {
  const held = CSS.slice(CSS.indexOf('.journal-track-mood.is-floor .journal-head::before {')).split('}')[0];
  assert.match(held, /width: calc\(var\(--head-w\) \+ 13px\);/);
  assert.match(held, /height: calc\(var\(--head-h\) \+ 13px\);/);
  assert.match(held, /border: 1px solid var\(--journal-head-ring\);/);
  assert.match(CSS, /--hold-scale: 0\.5;\s*\/\* \(14 \+ 13\) \/ \(14 \+ 40\) \*\//);
  assert.match(CSS, /--hold-scale: 0\.534;\s*\/\* \(18 \+ 13\) \/ \(18 \+ 40\) \*\//);
  // the derivation has to be readable, or the next reader sees 13-vs-12 and "fixes" it
  const why = CSS.slice(CSS.indexOf('/* The hold\'s structural mark'), CSS.indexOf('.journal-head::before { content'));
  assert.match(why, /CENTRELINE/);
  assert.match(why, /do not reconcile them/);
});

test('one focus band for both breakpoints: 2px of ink at +2 -> +4, whatever the head size', () => {
  const controls = CSS.slice(CSS.indexOf('.journal-controls {')).split('}')[0];
  assert.match(controls, /--journal-focus-band: 4px;/);
  const phone = CSS.slice(CSS.indexOf('@media (max-width: 684px) {'));
  assert.ok(!phone.includes('--journal-focus-band'), 'the phone re-widens a band that is one fact');
});

// §2.0 · when two declarations must agree geometrically, express both in units the platform cannot
// round differently. A fractional border is rounded by the engine; the inset that must match it is not.
test('one WHOLE-pixel token drives the head ring, the focus inset and the ghost — no fractional stroke', () => {
  const controls = CSS.slice(CSS.indexOf('.journal-controls {')).split('}')[0];
  assert.match(controls, /--head-ring-w: 1px;/);
  assert.equal(CSS.split('--head-ring-w:').length - 1, 1, 'the ring width is declared in more than one place');
  const phone = CSS.slice(CSS.indexOf('@media (max-width: 684px) {'));
  assert.ok(!phone.includes('--head-ring-w'), 'the phone must not re-declare a width that cannot differ');
  for (const rule of ['.journal-head {', '.journal-head::after {', '.journal-ghost {']) {
    assert.match(CSS.slice(CSS.indexOf(rule)).split('}')[0], /var\(--head-ring-w\)/, `${rule} carries its own stroke width`);
  }
  assert.ok(!/border: 1\.5px/.test(CSS.slice(CSS.indexOf('.journal-controls {'), CSS.indexOf('.journal-scale-why'))),
    'a fractional border is back in the scale control');
});

// ─── §2.4 · the ring is measured against the FILL, and the token contract has three names ─────────

test("night's set-head ring is ink 78% — the floor fill is the ground that matters", () => {
  const night = CSS.slice(CSS.indexOf(".journal-root[data-theme='dark']")).split('}')[0];
  const day = CSS.slice(CSS.indexOf(".journal-root[data-theme='light']")).split('}')[0];
  assert.match(night, /--journal-head-ring: color-mix\(in srgb, var\(--journal-ink\) 78%, transparent\);/);
  assert.match(day, /--journal-head-ring: color-mix\(in srgb, var\(--journal-ink\) 68%, transparent\);/);
  assert.ok(!CSS.includes('--journal-head-glow-end'), 'a retired token name is still in the sheet');
  assert.ok(!CSS.includes('--journal-head-glow:'), 'a retired token name is still in the sheet');
  assert.equal(CSS.split('--surge-shadow:').length - 1, 1, '--surge-shadow is declared outside the day block');
  assert.match(day, /--surge-shadow:/);
});

// ─── the press, the marks and the layers ──────────────────────────────────────────────────────────

test('the press is render-owned state, never a class written onto the node behind React', () => {
  assert.ok(!/classList\.(add|remove)\('is-pressed'\)/.test(SOURCE), 'a React render rewrites className and drops an imperative is-pressed');
  assert.match(SOURCE, /\$\{pressed \? ' is-pressed' : ''\}/);
});

test('a drag reads its stop from a ref, so a pointerdown and pointerup in one task still commit', () => {
  assert.match(SOURCE, /const next = liveRef\.current \?\? drag\.from;/);
  assert.ok(!/const next = live \?\? drag\.from;/.test(SOURCE));
});

test('the pair bloom and the flare share a layer and replace only their own kind', () => {
  assert.match(SOURCE, /host\.querySelectorAll\(`\.journal-bloom\.\$\{className\}`\)/);
  assert.ok(!/bloom\.replaceChildren\(\)/.test(SOURCE), 'a bloom that wipes the whole layer destroys the other one');
  // the key is spent only after the layer is known to be there
  const commit = SOURCE.slice(SOURCE.indexOf('const onCommit'), SOURCE.indexOf('return (\n    <>'));
  assert.ok(commit.indexOf('if (!layer) return;') < commit.indexOf("localStorage.setItem(key, 'shown')"));
  // and the breathe is staggered by ROW, so a row resting at 0 does not hand its delay to the other
  assert.match(commit, /rows\.forEach\(\(row, index\) => \{/);
  assert.match(commit, /`\$\{index \* 90\}ms`/);
});

test('a once-a-day key is spent on animationstart, and never by a timeline that did not play', () => {
  assert.match(SOURCE, /const PLAYED_MIN = 50;/);
  const commit = SOURCE.slice(SOURCE.indexOf('const onCommit'), SOURCE.indexOf('return (\n    <>'));
  assert.match(commit, /bloom\.addEventListener\('animationstart'/);
  assert.match(commit, /if \(!\(ms >= PLAYED_MIN\)\) return;/);
  // the read still guards, but the WRITE may only happen inside the animationstart handler
  assert.equal(commit.split("localStorage.setItem(key, 'shown')").length - 1, 1);
  assert.ok(commit.indexOf("bloom.addEventListener('animationstart'") < commit.indexOf("localStorage.setItem(key, 'shown')"));
});

test('a new extreme event takes the head over from the previous one, whatever the cascade says', () => {
  assert.match(SOURCE, /const HEAD_EVENTS = \['is-blooming', 'is-ticking', 'is-surging', 'is-setting-down', 'is-holding'\];/);
  assert.match(SOURCE, /track\.querySelector\('\.journal-head'\)\?\.classList\.remove\(\.\.\.HEAD_EVENTS\);/);
});

test('every timeout is pruned when it fires, and no dead class is written onto the flare', () => {
  assert.match(SOURCE, /ids\.current\.delete\(id\); fn\(\);/);
  assert.ok(!CODE.includes("'is-still'"), 'is-still matches no rule — the still form comes from the media block');
  assert.ok(!CODE.includes('requestAnimationFrame'), 'the ladder is declarative CSS; nothing here loops');
});

// ─── what the strip renders ───────────────────────────────────────────────────────────────────────

test('every stop-following part rides a rail or a bar, and the fill is hidden rather than absent at 0', () => {
  const html = strip({ mood: 7, energy: 0 });
  assert.equal(html.split('journal-stop-rail journal-head-rail').length - 1, 2);
  assert.equal(html.split('journal-stop-rail journal-ghost-rail').length - 1, 2);
  assert.equal(html.split('journal-track-fill-bar').length - 1, 2);
  assert.ok(!classesOf(html, 'mood').includes('is-empty'));
  assert.ok(classesOf(html, 'energy').includes('is-empty'), 'a row at 0 must still carry its fill node, hidden');
  assert.ok(classesOf(html, 'energy').includes('is-floor'));
  assert.match(CSS, /\.journal-track\.is-empty \.journal-track-fill \{ visibility: hidden; \}/);
});

test('§6.3.1 · the permanent marks follow the COMMITTED value, so a drag through an end flashes nothing', () => {
  // the class is derived from `value`, never from `display` — the drag's live stop
  const marks = SOURCE.slice(SOURCE.indexOf('const marks ='), SOURCE.indexOf('const state ='));
  assert.match(marks, /const marks = value === 10 \? ' is-ceiling' : value === 0 \? ' is-floor' : '';/);
  const state = SOURCE.slice(SOURCE.indexOf('const state ='), SOURCE.indexOf('const headFill'));
  assert.match(state, /display == null/);   // everything else still follows the displayed value
  assert.equal(classesOf(strip({ mood: 10 }), 'mood').includes('is-ceiling'), true);
  assert.equal(classesOf(strip({ mood: 9 }), 'mood').includes('is-ceiling'), false);
});

test('§3.4 · an unset scale carries no aria-valuenow, and says so in words', () => {
  const unset = rowOf(strip({}), 'mood');
  assert.ok(!unset.includes('aria-valuenow'));
  assert.match(unset, /aria-valuetext="not set"/);
  const set = rowOf(strip({ mood: 0 }), 'mood');
  assert.match(set, /aria-valuenow="0"/);
  assert.match(set, /aria-valuetext="0 of 10"/);
});

test('nothing fires on mount: the resting strip carries no overlay and no timeline class', () => {
  const html = strip({ mood: 10, energy: 0 });
  for (const transient of ['is-blooming', 'is-surging', 'is-setting-down', 'is-holding', 'is-ticking',
    'is-washing', 'is-wicking', 'is-hot', 'is-breathing', 'journal-bloom', 'class="journal-surge"', 'will-change']) {
    assert.ok(!html.includes(transient), `${transient} is in the resting markup`);
  }
});
