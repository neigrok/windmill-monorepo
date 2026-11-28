import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { register } from 'node:module';

// `node --test` speaks no JSX, so the shared loader compiles the picture on the way in.
register('../../../jsxLoader.mjs', import.meta.url);
const React = (await import('react')).default;
const { renderToStaticMarkup } = await import('react-dom/server');
const { RoadmapPicture } = await import('../../../../src/products/roadmap/marketing/RootPicture.jsx');

const file = (name) => readFileSync(new URL(`../../../../src/products/roadmap/marketing/${name}`, import.meta.url), 'utf8');
const CSS = ['roadmapRootPicture.css', 'composedTree.css'].map(file).join('\n');
const SHEETS = ['roadmapRootPicture.css', 'composedTree.css', 'landingPictures.css'].map(file).join('\n');
const SOURCES = ['RootPicture.jsx', 'ComposedTree.jsx', 'LandingPictures.jsx'].map(file).join('\n');
const drawn = (stage) => renderToStaticMarkup(React.createElement(RoadmapPicture, { stage }));
const html = drawn('row');
const text = (markup) => markup.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const treeOf = (markup) => markup.slice(markup.indexOf('<div class="rmTree"'));
const WIDE = treeOf(html);
const NARROW = treeOf(drawn('narrow'));
const stateOf = (tree, name) => new RegExp(`class="nd nd-(\\w+)[^"]*"[^>]*></div><div class="ndlabel[^"]*"[^>]*>${name}<`).exec(tree)?.[1];

test('the picture is the request beside the sail tree: seventeen steps wide, nine narrow', () => {
  assert.equal(text(html.slice(0, html.indexOf('<div class="rmTree"'))), 'Request Plan how I learn to sail');
  assert.equal(treeOf(drawn('column')), WIDE);
  assert.equal(text(WIDE), 'Learn to sail Windmill demo · 6 /17 done Learn to sail Knots &amp; lines Rig the mast Read the wind Docking Capsize drill Whipping &amp; splicing Cleats &amp; hitches Sail trim Points of sail Weather windows Night docking Man overboard drill Reefing Tides &amp; currents First aid afloat First solo sail');
  assert.equal(text(NARROW), 'Learn to sail Knots &amp; lines Rig the mast Read the wind Capsize drill Cleats &amp; hitches Points of sail Reefing Tides &amp; currents');
  assert.deepEqual([WIDE, NARROW].map((tree) => (tree.match(/class="nd nd-/g) ?? []).length), [17, 9]);
  assert.deepEqual([WIDE, NARROW].map((tree) => (tree.match(/class="rmTree-edge/g) ?? []).length), [24, 9]);
});

test('the plaque counts the steps the tree draws as done', () => {
  assert.deepEqual(['done', 'avail', 'dim'].map((state) => (WIDE.match(new RegExp(`class="nd nd-${state}[" ]`, 'g')) ?? []).length), [6, 7, 4]);
  assert.match(WIDE, /<span class="ct">6<\/span>\/17 done/);
});

test('a step whose prerequisites are all done is open, never locked, in both trees', () => {
  const states = (tree, names) => names.map((name) => stateOf(tree, name));
  assert.deepEqual(states(WIDE, ['Docking', 'Capsize drill', 'Whipping &amp; splicing', 'Points of sail', 'Man overboard drill', 'Reefing', 'First aid afloat']),
    ['avail', 'avail', 'avail', 'avail', 'avail', 'avail', 'avail']);
  assert.deepEqual(states(WIDE, ['Weather windows', 'Night docking', 'Tides &amp; currents', 'First solo sail']), ['dim', 'dim', 'dim', 'dim']);
  assert.deepEqual(states(NARROW, ['Capsize drill', 'Points of sail', 'Reefing', 'Tides &amp; currents']), ['avail', 'avail', 'avail', 'dim']);
});

test('an edge is lit where it leaves a step that is done, and dormant out of one not done', () => {
  assert.deepEqual([WIDE, NARROW].map((tree) => (tree.match(/class="rmTree-edge is-lit"/g) ?? []).length), [15, 8]);
});

test('the crowned root is the one step that breathes, and every branch has a reach to answer the pointer', () => {
  assert.deepEqual([WIDE, NARROW].map((tree) => tree.match(/class="nd [^"]*is-crowned[^"]*"/g)), [['class="nd nd-done is-crowned"'], ['class="nd nd-done is-crowned"']]);
  assert.match(WIDE, /<div class="rmTree" data-arrival="frontier"/);
  assert.deepEqual([WIDE, NARROW].map((tree) => (tree.match(/<g class="rmTree-branch"><path class="rmTree-reach" d="([^"]+)"><\/path><path class="rmTree-edge[^"]*" d="\1">/g) ?? []).length), [24, 9]);
});

// Every rule of Roadmap's picture sheets that declares an animation, by its selectors.
const animated = (css) => [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .filter(([, , body]) => /(^|;)\s*animation(-name)?\s*:/.test(body))
  .flatMap(([, selectors]) => selectors.split(',').map((selector) => selector.trim()));

// Every selector of a sheet's rules that answer the pointer.
const hovered = (css) => [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{[^{}]*\}/g)]
  .flatMap(([, selectors]) => selectors.split(',').map((selector) => selector.trim())).filter((selector) => selector.includes(':hover'));

test('the picture holds nothing a person could press, names no raw colour, and moves nothing at rest', () => {
  assert.ok(!/<(a|button|input|details|summary)[ >]|tabindex|onclick|href=/i.test(html), 'the picture draws a control');
  assert.deepEqual(SOURCES.match(/\son[A-Z]\w*=\{/g), null, 'a picture listens for a press or the pointer itself');
  assert.ok(!/#[0-9a-fA-F]{3,6}\b/.test(CSS), 'the sheet names a raw colour');
  assert.deepEqual(hovered(SHEETS).filter((selector) => !selector.startsWith('[data-pointed] ')), [], 'a part answers a pointer the frame does not count, a finger');
  assert.deepEqual(hovered(SHEETS), ['[data-pointed] .rmTree .nd:hover', '[data-pointed] .rmTree-branch:hover .rmTree-edge:not(.is-lit)', '[data-pointed] .rmTree .nd:hover', '[data-pointed] .rmPaths-card:hover .quest-thumb-halo', '[data-pointed] .rmStep-subtasks li:hover::before']);
  const selectors = animated(SHEETS);
  assert.deepEqual(selectors.filter((selector) => !/^\[data-(pointed|beat)\] /.test(selector)), [], 'an animation runs before the pointer arrives');
  assert.deepEqual(selectors, [
    '[data-pointed] .rmTree .nd-done.is-crowned',
    '[data-beat] .rmTree[data-arrival="frontier"] .nd-avail',
    '[data-beat] .rmTree[data-arrival="unlock"] .nd-done',
    '[data-beat] .rmTree[data-arrival="unlock"] .nd.is-opened',
    '[data-beat] .rmTree-travel',
    '[data-beat] .rmTree-travel path',
    '[data-pointed] .rmPaths-card:hover .quest-thumb-halo',
  ]);
});
