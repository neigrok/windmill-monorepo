// The wait, drawn — and the rule that makes it worth drawing at all: a load that finishes inside
// the beat shows no ghost. That rule is pure, it is invisible to the eye on a fast machine, and it
// is exactly the kind of thing a later refactor drops without any test going red. Pinned here.

import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { PRODUCTS } from '../../src/shell/products.js';

// `node --test` speaks no JSX and the rules under test live in the component's own module, where
// they belong — so the shared loader compiles it on the way in (test/jsxLoader.mjs).
register('../jsxLoader.mjs', import.meta.url);
const { GHOST_DELAY_MS, GHOST_FADE_MS, GHOST_OPACITY, ghostVeil } = await import('../../src/design-system/feedback/Ghost.jsx');

test('nothing is on screen before the beat, in either motion setting', () => {
  assert.deepEqual(ghostVeil({ shown: false, reducedMotion: false }), {
    opacity: 0,
    transition: 'opacity 150ms var(--ease-soft)',
  });
  assert.deepEqual(ghostVeil({ shown: false, reducedMotion: true }), { opacity: 0, transition: 'none' });
});

// Half strength, never full: this is an apology for a delay, and the thing arriving next is the
// content. A ghost at opacity 1 competes with what it is standing in for.
test('the ghost fades to half strength over 150ms, and reduced motion just appears there', () => {
  assert.deepEqual(ghostVeil({ shown: true, reducedMotion: false }), {
    opacity: 0.5,
    transition: 'opacity 150ms var(--ease-soft)',
  });
  assert.deepEqual(ghostVeil({ shown: true, reducedMotion: true }), { opacity: 0.5, transition: 'none' });
});

test('the beat is 120ms and the half strength is 0.5', () => {
  assert.equal(GHOST_DELAY_MS, 120);
  assert.equal(GHOST_FADE_MS, 150);
  assert.equal(GHOST_OPACITY, 0.5);
});

// The chrome reaches the ghost through the registry and nowhere else, so a product that means to
// draw one has to say so there. Roadmap means NOT to — its own ghost vocabulary already means
// something else (paste/GhostSkeleton.jsx) — and that silence is a decision worth pinning too.
test('the registry says which rooms have a ghost and which wait on their ground', () => {
  const declared = Object.fromEntries(PRODUCTS.map((p) => [p.id, Boolean(p.shell?.Ghost)]));
  assert.deepEqual(declared, { roadmap: false, journal: true, gym: true });
});

// A lazy() handle on the registry proves only that a path was typed. These render the real
// compositions: a ghost that stops parsing — or stops being made of the primitive — ships happily
// and only shows itself on a slow connection, which is the one condition nobody reproduces.
const { renderToStaticMarkup } = await import('react-dom/server');
const React = (await import('react')).default;
const { CanvasGhost } = await import('../../src/products/journal/CanvasGhost.jsx');
const { RoutinesGhost } = await import('../../src/products/gym/RoutinesGhost.jsx');

test('both product ghosts render their ground and their marks', () => {
  // journal: three days of (one marker + four prose bars), five mood dots, three ticks.
  // gym: three cards of (the card itself + one title bar + two line bars).
  for (const [name, Composition, bars] of [['journal', CanvasGhost, 23], ['gym', RoutinesGhost, 12]]) {
    const html = renderToStaticMarkup(React.createElement(Composition));
    assert.match(html, /background:var\(--surface-canvas\)/, `the ${name} ghost draws no ground`);
    assert.match(html, /aria-hidden="true"/, `the ${name} ghost is not hidden from a screen reader`);
    assert.equal(html.split('border-radius').length - 1, bars, `the ${name} ghost drew a different number of marks`);
    assert.ok(!/animation/.test(html), `the ${name} ghost animates — the calm ceiling forbids a loop`);
  }
});
