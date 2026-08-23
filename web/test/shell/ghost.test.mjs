import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { PRODUCTS } from '../../src/shell/products.js';

// `node --test` speaks no JSX, so the shared loader compiles the component on the way in.
register('../jsxLoader.mjs', import.meta.url);
const { GHOST_DELAY_MS, GHOST_FADE_MS, GHOST_OPACITY, ghostVeil } = await import('../../src/design-system/feedback/Ghost.jsx');

test('nothing is on screen before the beat, in either motion setting', () => {
  assert.deepEqual(ghostVeil({ shown: false, reducedMotion: false }), {
    opacity: 0,
    transition: 'opacity 150ms var(--ease-soft)',
  });
  assert.deepEqual(ghostVeil({ shown: false, reducedMotion: true }), { opacity: 0, transition: 'none' });
});

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

test('the registry says which rooms have a ghost and which wait on their ground', () => {
  const declared = Object.fromEntries(PRODUCTS.map((p) => [p.id, Boolean(p.shell?.Ghost)]));
  assert.deepEqual(declared, { roadmap: false, journal: true, gym: true });
});

const { renderToStaticMarkup } = await import('react-dom/server');
const React = (await import('react')).default;
const { CanvasGhost } = await import('../../src/products/journal/CanvasGhost.jsx');
const { RoutinesGhost } = await import('../../src/products/gym/RoutinesGhost.jsx');

test('both product ghosts render their ground and their marks', () => {
  // journal: three days of (one marker + four prose bars), then two scale rows of
  // (label + bed + head + numeral).
  // gym: three cards of (the card itself + one title bar + two line bars).
  for (const [name, Composition, bars] of [['journal', CanvasGhost, 23], ['gym', RoutinesGhost, 12]]) {
    const html = renderToStaticMarkup(React.createElement(Composition));
    assert.match(html, /background:var\(--surface-canvas\)/, `the ${name} ghost draws no ground`);
    assert.match(html, /aria-hidden="true"/, `the ${name} ghost is not hidden from a screen reader`);
    assert.equal(html.split('border-radius').length - 1, bars, `the ${name} ghost drew a different number of marks`);
    assert.ok(!/animation/.test(html), `the ${name} ghost animates — the calm ceiling forbids a loop`);
  }
});
