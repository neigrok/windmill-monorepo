import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { register } from 'node:module';

// `node --test` speaks no JSX, so the shared loader compiles the picture on the way in.
register('../../../jsxLoader.mjs', import.meta.url);
const React = (await import('react')).default;
const { renderToStaticMarkup } = await import('react-dom/server');
const { JournalPicture } = await import('../../../../src/products/journal/marketing/RootPicture.jsx');

const file = (name) => readFileSync(new URL(`../../../../src/products/journal/marketing/${name}`, import.meta.url), 'utf8');
const CSS = file('journalRootPicture.css');
const SHEETS = ['journalRootPicture.css', 'landingPictures.css'].map(file).join('\n');
const SOURCES = ['RootPicture.jsx', 'LandingPictures.jsx'].map(file).join('\n');
const html = renderToStaticMarkup(React.createElement(JournalPicture));
const text = (markup) => markup.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

test('the picture is three days of the page with one echo beside it, verbatim', () => {
  assert.equal(text(html), 'Tue 08 Sep The first ten minutes were the hardest. After that, the water made sense. I stopped trying to control everything and started paying attention. Wed 09 Sep Stayed out until the light changed. The walk home was longer than it needed to be. I think that was the point. Thu 10 Sep · Today Walked the long way home. No headphones this time. The city was louder than I remembered. So was my head. By the river, both got quiet. Echo 18 April “Took the path by the river. Ten minutes without my phone and I could hear myself think again.” From your own pages Go to page');
});

test('the picture keeps the journal’s night canvas whatever the page wears', () => {
  assert.match(html, /^<div class="jnPicture" data-brand="journal" data-theme="dark">/);
  assert.ok(!/\[data-theme/.test(CSS), 'a theme rule repaints a picture its own canvas already answers for');
});

// Every rule of the journal's picture sheets that declares an animation, by its selectors.
const animated = (css) => [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .filter(([, , body]) => /(^|;)\s*animation(-name)?\s*:/.test(body))
  .flatMap(([, selectors]) => selectors.split(',').map((selector) => selector.trim()));

// Every selector of a sheet's rules that answer the pointer.
const hovered = (css) => [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{[^{}]*\}/g)]
  .flatMap(([, selectors]) => selectors.split(',').map((selector) => selector.trim())).filter((selector) => selector.includes(':hover'));

test('the picture holds nothing a person could press, names no raw colour, and moves nothing at rest', () => {
  assert.ok(!/<(a|button|input|details|summary)[ >]|tabindex|onclick|href=/i.test(html), 'the picture draws a control');
  assert.match(html, /<span class="jnPicture-go">Go to page<\/span>/, 'the echo’s door is a styled span, not a control');
  assert.ok(!/animation|style=/.test(html), 'the picture carries motion or an inline style');
  assert.deepEqual(SOURCES.match(/\son[A-Z]\w*=\{/g), null, 'a picture listens for a press or the pointer itself');
  assert.ok(!/#[0-9a-fA-F]{3,6}\b/.test(SHEETS), 'a sheet names a raw colour');
  assert.deepEqual(hovered(SHEETS).filter((selector) => !selector.startsWith('[data-pointed] ')), [], 'a part answers a pointer the frame does not count, a finger');
  assert.deepEqual(hovered(SHEETS), ['[data-pointed] .jnSearch li.is-hit:hover::before', '[data-pointed] .jnYear i:hover', '[data-pointed] .jnYear i:hover']);
  const selectors = animated(SHEETS);
  assert.deepEqual(selectors.filter((selector) => !/^\[data-(pointed|beat)\] /.test(selector)), [], 'an animation runs before the pointer arrives');
  assert.deepEqual(selectors, ['[data-beat] .jnPicture-rule', '[data-pointed] .jnCursor', '[data-beat] .jnWindow-echo']);
});
