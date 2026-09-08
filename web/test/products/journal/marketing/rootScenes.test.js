import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { register } from 'node:module';

// `node --test` speaks no JSX, so the shared loader compiles the scenes on the way in.
register('../../../jsxLoader.mjs', import.meta.url);
const React = (await import('react')).default;
const { renderToStaticMarkup } = await import('react-dom/server');
const { JournalGlimpse, JournalIllustration } = await import('../../../../src/products/journal/marketing/RootScenes.jsx');

const ROOT_CSS = readFileSync(new URL('../../../../src/products/journal/marketing/journalRootScenes.css', import.meta.url), 'utf8');
const LANDING_CSS = readFileSync(new URL('../../../../src/products/journal/marketing/journalLanding.css', import.meta.url), 'utf8');
const SCENES = readFileSync(new URL('../../../../src/products/journal/marketing/RootScenes.jsx', import.meta.url), 'utf8');
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

test('the glimpse is the Tonight page, captioned as composed, with a still caret after the last word', () => {
  const html = renderToStaticMarkup(React.createElement(JournalGlimpse));
  assert.equal(text(html), 'Tonight Yesterday — walked before work. Slept better than the week before. Finished the chapter I kept avoiding. Lighter than expected Composed page');
  assert.match(html, /Lighter than expected<span class="jn-root-caret"><\/span><\/p>/);
  assert.match(html, /<figcaption class="composed">Composed page<\/figcaption>/);
});

test('the illustration is the search field, the echo pill and the 14 March page, verbatim', () => {
  const html = renderToStaticMarkup(React.createElement(JournalIllustration));
  assert.equal(text(html), 'the night I felt lighter ⌘K Found by meaning · 14 March “…lighter than expected.” 14 March Yesterday — walked before work, skipped the second coffee. Finished the chapter I kept avoiding. It was shorter than the dread of it. Lighter than expected, and I want to remember that the next time something sits unread for a month. Composed page');
  assert.match(html, /<kbd class="jn-root-key">⌘K<\/kbd>/);
  assert.match(html, /<circle cx="11" cy="11" r="8"><\/circle>/, 'the search field carries the landing’s magnifier');
});

// The composed page is decoration; the caption is the only thing a reader is told about it. An
// aria-hidden on the figure would swallow the caption with it, which is the whole defect.
test('each scene hides one stage and announces the caption outside it', () => {
  for (const [Scene, stage] of [[JournalGlimpse, 'jn-root-stage'], [JournalIllustration, 'jn-root-search']]) {
    const html = renderToStaticMarkup(React.createElement(Scene));
    assert.match(html, new RegExp(`^<figure class="jn-root-scene"><div class="${stage}" aria-hidden="true">`), `${Scene.name} does not open with its figure and one hidden stage`);
    assert.match(html, /<\/div><figcaption class="composed">Composed page<\/figcaption><\/figure>$/, `${Scene.name} does not close with the caption outside the stage`);
    assert.ok(!/<(figure|figcaption)[^>]*aria-hidden/.test(html), `${Scene.name} hides the figure or the caption with the stage`);
  }
});

test('both scenes are still, fluid and free of raw colour', () => {
  for (const Scene of [JournalGlimpse, JournalIllustration]) {
    const html = renderToStaticMarkup(React.createElement(Scene));
    assert.ok(!/animation|style=/.test(html), `${Scene.name} carries motion or an inline style`);
    assert.ok(!/#[0-9a-fA-F]{3,6}\b/.test(html), `${Scene.name} names a raw colour`);
  }
  assert.ok(!/animation|#[0-9a-fA-F]{3,6}\b/.test(ROOT_CSS), 'the root sheet animates or names a raw colour');
  assert.match(ROOT_CSS, /\.jn-root-card \{\n  width: 100%;/);
  assert.match(ROOT_CSS, /\.jn-root-stage, \.jn-root-search \{ width: 100%; text-align: left; \}/);
});

// The root draws six static cards; it may not pull the landing's moat, week columns and beat stages
// to do it. The scenes import their own sheet, and the root block lives in no other file.
test('the scenes carry their own sheet and the landing keeps none of it', () => {
  assert.match(SCENES, /^import '\.\/journalRootScenes\.css';$/m);
  assert.ok(!/journalLanding\.css/.test(SCENES), 'the scenes still pull the full landing sheet');
  assert.ok(!/\.jn-root-/.test(LANDING_CSS), 'a root-scene rule is still in the landing sheet');
  assert.ok(!/\.jn-moat|\.jn-scene|\.jn-day|\.jn-weekday|@keyframes/.test(ROOT_CSS), 'a landing-only rule leaked into the root sheet');
});

test('the echo pill is a 12% wash of the brand in either theme, never a solid', () => {
  const pill = ROOT_CSS.slice(ROOT_CSS.indexOf('.jn-root-echo {')).split('}')[0];
  assert.match(pill, /background: color-mix\(in srgb, var\(--color-brand\) 12%, transparent\);/);
  assert.match(pill, /color: var\(--color-brand\);/);
  assert.equal(ROOT_CSS.split('.jn-root-echo {').length, 2, 'a second rule repaints the pill');
  assert.ok(!/\[data-theme="dark"\]/.test(ROOT_CSS), 'a night rule repaints a scene the ground already answers for');
});
