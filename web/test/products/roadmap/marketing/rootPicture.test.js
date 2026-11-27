import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { register } from 'node:module';

// `node --test` speaks no JSX, so the shared loader compiles the picture on the way in.
register('../../../jsxLoader.mjs', import.meta.url);
const React = (await import('react')).default;
const { renderToStaticMarkup } = await import('react-dom/server');
const { RoadmapPicture } = await import('../../../../src/products/roadmap/marketing/RootPicture.jsx');

const CSS = readFileSync(new URL('../../../../src/products/roadmap/marketing/roadmapRootPicture.css', import.meta.url), 'utf8');
const drawn = (stage) => renderToStaticMarkup(React.createElement(RoadmapPicture, { stage }));
const html = drawn('row');
const text = (markup) => markup.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const treeOf = (markup) => markup.slice(markup.indexOf('<div class="rmPicture-tree"'));
const WIDE = treeOf(html);
const NARROW = treeOf(drawn('narrow'));
const stateOf = (tree, name) => new RegExp(`class="nd nd-(\\w+)"[^>]*></div><div class="ndlabel[^"]*"[^>]*>${name}<`).exec(tree)?.[1];

test('the picture is the request beside the sail tree: seventeen steps wide, nine narrow', () => {
  assert.equal(text(html.slice(0, html.indexOf('<div class="rmPicture-tree"'))), 'Request Plan how I learn to sail');
  assert.equal(treeOf(drawn('column')), WIDE);
  assert.equal(text(WIDE), 'Learn to sail Windmill demo · 6 /17 done Learn to sail Knots &amp; lines Rig the mast Read the wind Docking Capsize drill Whipping &amp; splicing Cleats &amp; hitches Sail trim Points of sail Weather windows Night docking Man overboard drill Reefing Tides &amp; currents First aid afloat First solo sail');
  assert.equal(text(NARROW), 'Learn to sail Knots &amp; lines Rig the mast Read the wind Capsize drill Cleats &amp; hitches Points of sail Reefing Tides &amp; currents');
  assert.deepEqual([WIDE, NARROW].map((tree) => (tree.match(/class="nd nd-/g) ?? []).length), [17, 9]);
  assert.deepEqual([WIDE, NARROW].map((tree) => (tree.match(/class="rmPicture-edge/g) ?? []).length), [24, 9]);
});

test('the plaque counts the steps the tree draws as done', () => {
  assert.deepEqual(['done', 'avail', 'dim'].map((state) => (WIDE.match(new RegExp(`class="nd nd-${state}"`, 'g')) ?? []).length), [6, 7, 4]);
  assert.match(WIDE, /<span class="ct">6<\/span>\/17 done/);
});

test('a step whose prerequisites are all done is open, never locked, in both trees', () => {
  const states = (tree, names) => names.map((name) => stateOf(tree, name));
  assert.deepEqual(states(WIDE, ['Docking', 'Capsize drill', 'Whipping &amp; splicing', 'Points of sail', 'Man overboard drill', 'Reefing', 'First aid afloat']),
    ['avail', 'avail', 'avail', 'avail', 'avail', 'avail', 'avail']);
  assert.deepEqual(states(WIDE, ['Weather windows', 'Night docking', 'Tides &amp; currents', 'First solo sail']), ['dim', 'dim', 'dim', 'dim']);
  assert.deepEqual(states(NARROW, ['Capsize drill', 'Points of sail', 'Reefing', 'Tides &amp; currents']), ['avail', 'avail', 'avail', 'dim']);
});

test('an edge is lit where it reaches a step that is done or open, and dormant into a locked one', () => {
  assert.deepEqual([WIDE, NARROW].map((tree) => (tree.match(/class="rmPicture-edge is-lit"/g) ?? []).length), [15, 8]);
});

test('the picture is still and holds nothing a person could press', () => {
  assert.ok(!/<(a|button|input|details|summary)[ >]|tabindex|onclick|href=/i.test(html), 'the picture draws a control');
  assert.ok(!/animation|@keyframes/.test(CSS), 'the picture moves');
  assert.ok(!/#[0-9a-fA-F]{3,6}\b/.test(CSS), 'the sheet names a raw colour');
});
