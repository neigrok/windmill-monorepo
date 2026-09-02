// The desktop panel has two entrances that mean different things, and the whole risk is confusing
// them. A FOLLOW is the scroll carrying the panel to another page's ink — a moment, 180ms. An
// ARRIVAL is news landing in the page the panel is already beside — a signal, 1200ms. And an arrival
// may never change WHICH page the panel addresses: that answer belongs to the scroll and to the
// reader's hold, and nothing the journal receives is allowed to take it.

import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { findByClass, loadScreen, renderHook, settle } from '../../gym/harness.mjs';

const { EchoMargin } = await loadScreen('products/journal/echoes/EchoMargin.jsx');

const PAGE = {
  day: '2026-08-11',
  entitled: true,
  matches: [{ day: '2026-05-02', text: 'the older words', useful: false, withheldWords: 0 }],
};

const now = Date.now();
const lit = (over = {}) => ({ day: PAGE.day, landedAt: now, kindledAt: now, count: 1, born: false, ...over });

function echoesWith(over = {}) {
  return {
    verify: () => {},
    walkTo: () => {},
    openSheet: () => {},
    markUseful: () => {},
    retireMatch: () => {},
    lit: null,
    settling: null,
    ...over,
  };
}

const draw = (echoes, page) => renderToStaticMarkup(React.createElement(EchoMargin, { echoes, page }));

test('the seam lights while a light burns anywhere, and settles when it goes out', () => {
  assert.match(draw(echoesWith(), PAGE), /class="je-margin"/);
  assert.match(draw(echoesWith({ lit: lit() }), PAGE), /class="je-margin is-lit"/);
  // a light on a page the panel is NOT beside still lights the seam: it is the desk's own channel
  assert.match(draw(echoesWith({ lit: lit({ day: '2026-03-03' }) }), PAGE), /class="je-margin is-lit"/);
  assert.match(draw(echoesWith({ settling: PAGE.day }), PAGE), /class="je-margin is-settling"/);
  // and a light still held under an overlay has not kindled, so the seam is dark
  assert.match(draw(echoesWith({ lit: lit({ kindledAt: null }) }), PAGE), /class="je-margin"/);
});

test('news in the page the panel already addresses plays the arrival ramp, not the follow', () => {
  const follow = draw(echoesWith(), PAGE);
  assert.match(follow, /class="je-margin-body"/);
  assert.ok(!follow.includes('is-arrival'));

  const arrival = draw(echoesWith({ lit: lit() }), PAGE);
  assert.match(arrival, /class="je-margin-body is-arrival"/);
});

test('a light on another page leaves this panel’s entrance alone — an arrival never moves the panel', () => {
  const elsewhere = draw(echoesWith({ lit: lit({ day: '2026-03-03' }) }), PAGE);
  assert.ok(!elsewhere.includes('is-arrival'),
    'the panel replayed an entrance for news it is not showing');
  // and the panel still draws the page it was given, whatever the light says
  assert.match(elsewhere, /2026-05-02|the older words/);
});

test('THE PANEL MOUNTING ONTO AN ARRIVAL FADES OUT NO REST LINE — there was never one on screen', async (t) => {
  // The first echo an account ever gets opens the margin and arms the arrival in the same read, so
  // this panel's very first render is a page AND a light at once. A first-render sentinel that could
  // not tell "never drawn" from "drawn while resting" would ghost a line nobody saw.
  const run = renderHook(t, () => EchoMargin({ echoes: echoesWith({ lit: lit() }), page: PAGE }));
  await settle(6);
  const html = renderToStaticMarkup(run.tree);
  assert.ok(!html.includes('is-leaving'), 'a rest line that was never on screen was faded out');
});

test('a rest line the news replaces DOES leave, on the arrival’s own clock and outside the body', async (t) => {
  let page = null;
  let echoes = echoesWith();
  const run = renderHook(t, () => EchoMargin({ echoes, page }));
  await settle(6);
  assert.match(renderToStaticMarkup(run.tree), /class="je-margin-rest"/);

  page = PAGE;
  echoes = echoesWith({ lit: lit() });
  run.redraw();
  await settle(6);
  const html = renderToStaticMarkup(run.tree);
  assert.match(html, /class="je-margin-rest is-leaving"/);
  // OUTSIDE the ramping body: inside it the fade would be multiplied by the body's own 0 -> 1 ramp
  // and start from nothing, which is the step a cross-fade exists to avoid.
  assert.ok(html.indexOf('is-leaving') < html.indexOf('je-margin-body'),
    'the leaving line is inside the body it is supposed to cross-fade with');
});

test('a follow onto a page with an echo leaves nothing behind — that entrance is a moment, not a signal', async (t) => {
  let page = null;
  const echoes = echoesWith();
  const run = renderHook(t, () => EchoMargin({ echoes, page }));
  await settle(6);

  page = PAGE;                       // the scroll arrived; no news landed
  run.redraw();
  await settle(6);
  const html = renderToStaticMarkup(run.tree);
  assert.ok(!html.includes('is-leaving'));
  assert.ok(!html.includes('is-arrival'));
});

// The key is what replays an entrance, so it may only ever move FORWARD. Read straight off the live
// light it would fall back the moment the light was spent, unmounting the panel's prose and re-fading
// it under the reader — and the dwell ends on a pointerdown anywhere in the canvas, so one click in
// the writing would do it, destroying any selection inside the panel on the way.
const bodyOf = (tree) => findByClass(tree, 'je-margin-body')[0];

test('A SPENT LIGHT DOES NOT RE-FADE THE PANEL: the entrance key never falls back', async (t) => {
  let echoes = echoesWith({ lit: lit() });
  const run = renderHook(t, () => EchoMargin({ echoes, page: PAGE }));
  await settle(6);

  const arriving = bodyOf(run.tree);
  assert.match(arriving.props.className, /is-arrival/);
  const key = arriving.key;

  echoes = echoesWith({ settling: PAGE.day });      // the writer surfaced; the light is spent
  run.redraw();
  await settle(6);

  const after = bodyOf(run.tree);
  assert.equal(after.key, key, 'the body remounted and replayed the follow fade under the reader');
  assert.match(after.props.className, /is-arrival/, 'and dropped the ramp it was still running');
});

test('a follow to another page and back is a follow both ways, never a replayed arrival', async (t) => {
  let page = PAGE;
  let echoes = echoesWith({ lit: lit() });
  const run = renderHook(t, () => EchoMargin({ echoes, page }));
  await settle(6);
  const arrived = bodyOf(run.tree).key;

  const OTHER = { ...PAGE, day: '2026-07-04' };
  page = OTHER;
  echoes = echoesWith();
  run.redraw();
  await settle(6);
  const away = bodyOf(run.tree);
  assert.notEqual(away.key, arrived, 'the scroll moved the panel, so the entrance replays');
  assert.ok(!away.props.className.includes('is-arrival'), 'as a follow');

  page = PAGE;
  run.redraw();
  await settle(6);
  const back = bodyOf(run.tree);
  assert.ok(!back.props.className.includes('is-arrival'),
    'coming back to a page that was once lit replayed its arrival ramp for a plain follow');
});

test('a NEW arrival on the page the panel is already beside does move the key forward', async (t) => {
  let echoes = echoesWith({ lit: lit() });
  const run = renderHook(t, () => EchoMargin({ echoes, page: PAGE }));
  await settle(6);
  const first = bodyOf(run.tree).key;

  echoes = echoesWith({ lit: lit({ kindledAt: now + 30000, count: 2 }) });
  run.redraw();
  await settle(6);

  const second = bodyOf(run.tree);
  assert.notEqual(second.key, first, 'news landing in the panel played no entrance at all');
  assert.match(second.props.className, /is-arrival/);
});
