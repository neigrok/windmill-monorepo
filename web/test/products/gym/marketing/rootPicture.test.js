import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { register } from 'node:module';

// `node --test` speaks no JSX, so the shared loader compiles the picture on the way in.
register('../../../jsxLoader.mjs', import.meta.url);
const React = (await import('react')).default;
const { renderToStaticMarkup } = await import('react-dom/server');
const { GymPicture } = await import('../../../../src/products/gym/marketing/RootPicture.jsx');
const { receiptWords } = await import('../../../../src/products/gym/coach/CoachRoom.jsx');
const { keptRunLabel, TURN_DOWN_VERB } = await import('../../../../src/products/gym/proposals.js');

const CSS = readFileSync(new URL('../../../../src/products/gym/marketing/gymRootPicture.css', import.meta.url), 'utf8');
const html = renderToStaticMarkup(React.createElement(GymPicture, { stage: 'wide' }));
const text = (markup) => markup.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').replace(/ ([.,])/g, '$1').trim();

test('the picture is one Coach turn: the question, the receipt, the answer and the proposal, verbatim', () => {
  assert.equal(text(html), 'Looking at my whole log, should bench go up in Push A? Read 41 workouts · 14 weeks You have benched in 14 of your 41 sessions, from 3 × 8 at 50 up to 3 × 8 at 60. In the last three, every set was completed. 62.5 kg keeps the same eight reps and adds 2.5 kg to every set. Push A · 1 change Bench Press 3 × 8 · 60 → 62.5 and 2 lines unchanged › Apply Logged sets stay unchanged. Turn this down');
});

// The receipt and the proposal's words are the room's own messages, read from the same catalogue keys.
test('the receipt, the unchanged lines and the decline are the room’s own sentences', () => {
  assert.match(html, new RegExp(`<p class="gyPicture-receipt"><svg[^]*?</svg>${receiptWords({ sessions: 41, weeks: 14, sets: 412 })}<svg[^]*?</svg></p>`));
  assert.match(html, new RegExp(`<p class="gyPicture-kept">${keptRunLabel(2)}<span class="gyPicture-more">›</span></p>`));
  assert.match(html, new RegExp(`<span class="gyPicture-turnDown">${TURN_DOWN_VERB}</span>`));
});

test('Apply is the band across the card and the decline a plain row beneath it, and neither is a control', () => {
  assert.match(html, /<span class="gyPicture-apply">Apply<\/span><p class="gyPicture-kept">Logged sets stay unchanged\.<\/p><span class="gyPicture-turnDown">/);
  assert.ok(!/<(a|button|input|details|summary)[ >]|tabindex|onclick|href=/i.test(html), 'the picture draws a control');
  const turnDown = CSS.slice(CSS.indexOf('.gyPicture-turnDown {')).split('}')[0];
  assert.ok(!/background|border/.test(turnDown), 'the decline is drawn as a button');
});

test('the picture wears the gym skin, is still and names no raw colour', () => {
  assert.match(html, /^<div class="gyPicture gym-skin" data-stage="wide">/);
  assert.match(CSS, /^@import '\.\.\/gymTokens\.css';/);
  assert.ok(!/animation|style=/.test(html), 'the picture carries motion or an inline style');
  assert.ok(!/animation|@keyframes|#[0-9a-fA-F]{3,6}\b/.test(CSS), 'the sheet animates or names a raw colour');
});
