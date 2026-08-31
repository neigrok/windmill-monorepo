import test from 'node:test';
import assert from 'node:assert/strict';

import { API_BASE } from '../../../../src/shell/apiBase.js';
import { browserWith, elementsOf, findByClass, loadScreen, renderHook, settle, textOf } from '../harness.mjs';

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
  assert.deepEqual(after.capped, { note: 'the next question frees up in a couple of hours', ceiling: false });
  assert.equal(after.note, '', 'the cap-reached state carries the fact; no refusal line says it twice');
  assert.equal(after.draft, 'Why did my squat stall?', 'the words go back to the composer');
});

// The point of the change: BOTH 429s reach the one state that draws the unrationed door, and that
// state says whichever sentence the server sent — never a constant of the room's own, which under
// one of the two ceilings would be false.
test('the AI ceiling reaches the cap-reached state and says the SERVER’s sentence there, with the door as the primary', async (t) => {
  browserWith();
  const ceiling = 'this account has reached its AI ceiling for the last 30 days. Coach will answer again as that window rolls on';
  coachOnTheWire([
    { status: 429, body: { error: ceiling, code: 'ask-out-of-budget' } },
    { status: 429, body: { error: 'the next question frees up in a couple of hours', code: 'ask-daily-limit' } },
  ]);
  const { CoachRoom } = await loadScreen('products/gym/coach/CoachRoom.jsx');
  const screen = renderHook(t, () => CoachRoom({ log: quiet }));

  const after = await asked(t, screen, 'How am I tracking?');
  assert.deepEqual(after.capped, { note: ceiling, ceiling: true });
  const drawn = body(screen.tree).type(body(screen.tree).props);
  const block = elementsOf(drawn).find((each) => typeof each.type === 'function' && each.type.name === 'CapReached');
  const moment = block.type(block.props);
  assert.equal(moment.props.className, 'gym-coach-capped is-ceiling');
  assert.equal(textOf(findByClass(moment, 'gym-coach-closed')[0]), ceiling);
  assert.doesNotMatch(textOf(findByClass(moment, 'gym-coach-closed')[0]), /couple of hours/, 'never the daily cap’s sentence');
  assert.equal(findByClass(drawn, 'gym-coach-compose').length, 0, 'the composer is gone');
  assert.equal(moment.props.role, 'status', 'the composer vanished under the lifter, so the sentence stands on a live region');
  // The unrationed way out leads; a new conversation cannot take a question under this one.
  const doorsOf = (block) => elementsOf(block)
    .filter((each) => each.props?.className === 'gym-coach-free-door' || each.props?.className === 'gym-coach-again')
    .map((each) => each.props.className);
  assert.deepEqual(doorsOf(moment), ['gym-coach-free-door', 'gym-coach-again']);
  // Ten a day is not the rule that stopped this question, so the promise is not drawn over the
  // sentence that refuses it.
  assert.equal(findByClass(drawn, 'gym-coach-allowance').length, 0);

  // Starting again clears the state and the sentence with it, and the day's cap says its own.
  body(screen.tree).props.onStartAgain();
  assert.equal(body(screen.tree).props.capped, null);
  const daily = await asked(t, screen, 'And now?');
  assert.deepEqual(daily.capped, { note: 'the next question frees up in a couple of hours', ceiling: false });
  const again = body(screen.tree).type(body(screen.tree).props);
  const nextBlock = elementsOf(again).find((each) => typeof each.type === 'function' && each.type.name === 'CapReached');
  const second = nextBlock.type(nextBlock.props);
  assert.equal(second.props.className, 'gym-coach-capped');
  assert.equal(textOf(findByClass(second, 'gym-coach-closed')[0]), 'the next question frees up in a couple of hours');
  // The other order, and it is the phones' too: under the day's ten a new conversation is the way
  // back to a composer that will answer, so it leads and the connect door sits beneath it.
  assert.deepEqual(doorsOf(second), ['gym-coach-again', 'gym-coach-free-door']);
  // And here ten a day is still the standing promise, so it keeps its place above the moment.
  assert.equal(textOf(findByClass(again, 'gym-coach-allowance')[0]), 'Ten questions a day, three back to back.');
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
  assert.equal(after.capped, null);
});
