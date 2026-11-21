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
const html = renderToStaticMarkup(React.createElement(RoadmapPicture));
const text = (markup) => markup.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const WIDE_AT = html.indexOf('<div class="rmPicture-tree rmPicture-tree--wide"');
const NARROW_AT = html.indexOf('<div class="rmPicture-tree rmPicture-tree--narrow"');
const WIDE = html.slice(WIDE_AT, NARROW_AT);
const NARROW = html.slice(NARROW_AT);

test('the picture is the request beside the sail tree: seventeen steps wide, nine narrow', () => {
  assert.equal(text(html.slice(0, WIDE_AT)), 'Request Plan how I learn to sail');
  assert.equal(text(WIDE), 'Learn to sail Windmill demo · 6 /17 done Learn to sail Knots &amp; lines Rig the mast Read the wind Docking Capsize drill Whipping &amp; splicing Cleats &amp; hitches Sail trim Points of sail Weather windows Night docking Man overboard drill Reefing Tides &amp; currents First aid afloat First solo sail');
  assert.equal(text(NARROW), 'Learn to sail Knots &amp; lines Rig the mast Read the wind Capsize drill Cleats &amp; hitches Points of sail Reefing Tides &amp; currents');
  assert.deepEqual([WIDE, NARROW].map((tree) => (tree.match(/class="nd nd-/g) ?? []).length), [17, 9]);
  assert.deepEqual([WIDE, NARROW].map((tree) => (tree.match(/class="rmPicture-edge/g) ?? []).length), [24, 9]);
});

test('the plaque counts the steps the tree draws as done', () => {
  assert.deepEqual(['done', 'avail', 'dim'].map((state) => (WIDE.match(new RegExp(`class="nd nd-${state}"`, 'g')) ?? []).length), [6, 4, 7]);
  assert.match(WIDE, /<span class="ct">6<\/span>\/17 done/);
});

test('an edge is lit where it reaches a step that is done or open, and dormant into a locked one', () => {
  assert.deepEqual([WIDE, NARROW].map((tree) => (tree.match(/class="rmPicture-edge is-lit"/g) ?? []).length), [11, 7]);
});

test('the picture is still and holds nothing a person could press', () => {
  assert.ok(!/<(a|button|input|details|summary)[ >]|tabindex|onclick|href=/i.test(html), 'the picture draws a control');
  assert.ok(!/animation|@keyframes/.test(CSS), 'the picture moves');
  assert.ok(!/#[0-9a-fA-F]{3,6}\b/.test(CSS), 'the sheet names a raw colour');
});
