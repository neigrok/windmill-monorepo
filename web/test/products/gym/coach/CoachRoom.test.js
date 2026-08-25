import test from 'node:test';
import assert from 'node:assert/strict';

import { API_BASE } from '../../../../src/shell/apiBase.js';
import { browserWith, elementsOf, loadScreen, renderHook, settle } from '../harness.mjs';

const realFetch = global.fetch;
test.afterEach(() => { global.fetch = realFetch; });

// The room's wire: every POST /ask answers from the queue, in order; the bodies sent are kept.
function coachOnTheWire(replies) {
  const sent = [];
  global.fetch = async (url, options = {}) => {
    const path = url.slice(`${API_BASE}/v1/gym`.length);
    if (path !== '/ask' || options.method !== 'POST') throw new Error(`unexpected ${options.method ?? 'GET'} ${path}`);
    sent.push(JSON.parse(options.body));
    const { status, body } = replies.shift();
    return { ok: status < 300, status, json: async () => body };
  };
  return sent;
}

const quiet = { phase: 'ready', session: null, catalog: [], preferences: {} };
const body = (tree) => elementsOf(tree).find((each) => typeof each.type === 'function' && each.type.name === 'CoachBody');

async function asked(t, screen, question) {
  body(screen.tree).props.setDraft(question);
  body(screen.tree).props.onAsk();
  await settle();
  return body(screen.tree).props;
}

test('a question the day’s allowance refused is not a turn of the conversation: the server stored nothing', async (t) => {
  browserWith();
  const sent = coachOnTheWire([
    { status: 429, body: { error: 'the next question frees up in a couple of hours', code: 'ask-daily-limit' } },
  ]);
  const { CoachRoom } = await loadScreen('products/gym/coach/CoachRoom.jsx');
  const screen = renderHook(t, () => CoachRoom({ log: quiet }));

  const after = await asked(t, screen, 'Why did my squat stall?');
  assert.equal(sent.length, 1);
  assert.deepEqual(after.turns, []);
  assert.equal(after.capped, true);
  assert.equal(after.note, '', 'the cap-reached state carries the fact; no refusal line says it twice');
  assert.equal(after.draft, 'Why did my squat stall?', 'the words go back to the composer');
});

test('a question a full or taken conversation refused comes off the screen too, and the next ask opens a new conversation', async (t) => {
  browserWith();
  const sent = coachOnTheWire([
    { status: 409, body: { error: 'that conversation id is already in use — start a new one', code: 'ask-thread-taken' } },
    { status: 409, body: { error: 'finish your workout first — Coach reads a log that has stopped moving', code: 'ask-session-open' } },
  ]);
  const { CoachRoom } = await loadScreen('products/gym/coach/CoachRoom.jsx');
  const screen = renderHook(t, () => CoachRoom({ log: quiet }));

  const taken = await asked(t, screen, 'Is my bench moving?');
  assert.deepEqual(taken.turns, []);
  assert.equal(taken.note, 'that conversation id is already in use — start a new one', 'the server’s bytes, not the room’s');
  assert.equal(taken.draft, 'Is my bench moving?');

  const open = await asked(t, screen, 'Is my bench moving?');
  assert.deepEqual(open.turns, []);
  assert.equal(open.note, 'finish your workout first — Coach reads a log that has stopped moving');
  assert.equal(sent.length, 2);
  assert.notEqual(sent[0].thread, sent[1].thread, 'a taken id is replaced before the next ask');
  assert.match(sent[1].thread, /^thr_[0-9a-f]{16}$/);
});

test('a question the server answered stays drawn as the first turn, under the answer', async (t) => {
  browserWith();
  coachOnTheWire([
    { status: 200, body: { answer: 'Flat for three weeks.', steps: [{ tool: 'list_notes', failed: false }], read: { sets: 40, sessions: 8, weeks: 3 } } },
  ]);
  const { CoachRoom } = await loadScreen('products/gym/coach/CoachRoom.jsx');
  const screen = renderHook(t, () => CoachRoom({ log: quiet }));

  const after = await asked(t, screen, 'Why did my squat stall?');
  assert.deepEqual(after.turns.map((turn) => [turn.from, turn.text]), [
    ['lifter', 'Why did my squat stall?'],
    ['ask', 'Flat for three weeks.'],
  ]);
  assert.equal(after.draft, '');
  assert.equal(after.capped, false);
});
