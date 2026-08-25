import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ALLOWANCE_LINE, answerTurn, askFailure, BRAKE_NOTE, CAP_REACHED_NOTE, COACH_ABSENT_NOTE, COACH_TERMS,
  COACH_TITLE, FIX_IS_YOURS, FREE_DOOR_LINE, MAX_TURNS, MID_SESSION_NOTE, NO_ANSWER_NOTE, NO_STEPS,
  NOTES_DOOR, OUT_OF_BUDGET_NOTE, PROPOSAL_NOTE, questionTooLong, QUESTION_BYTES, readLine,
  SIGNED_OUT_NOTE, stepsLine, THREAD_FULL_NOTE, THREAD_PREFIX, THREAD_TAKEN_NOTE, threadFull, TOOL_PHRASE,
  UNREADABLE_NOTE,
} from '../../../../src/products/gym/coach/coach.js';
import { GymError } from '../../../../src/products/gym/gymApi.js';
import { mintId } from '../../../../src/products/gym/mint.js';

// A refusal as gymApi surfaces it off the wire: the status, the body's `error`, the body's `code`.
const sent = (status, sentence, code = '') => new GymError(status, sentence, code);

test('the room is Coach, and the terms name the reach AND the limit, in that order', () => {
  assert.equal(COACH_TITLE, 'Coach');
  assert.equal(COACH_TERMS, 'reads your log · proposes only');
  assert.equal(NOTES_DOOR, 'Notes');
});

test('every tool Coach can be handed has a phrase a lifter can read, and no tool it cannot', () => {
  assert.deepEqual(Object.keys(TOOL_PHRASE).sort(), [
    'get_session', 'get_stats', 'last_time', 'list_exercises', 'list_notes', 'list_routines',
    'list_sessions', 'propose_routine_change', 'propose_routine_removal',
  ]);
  assert.equal(TOOL_PHRASE.list_notes, 'read your notes');
  for (const banned of ['log_set', 'start_session', 'finish_session', 'discard_session', 'create_routine', 'propose_routine_create']) {
    assert.equal(banned in TOOL_PHRASE, false, banned);
  }
});

test('stepsLine names what it read, in call order, once each', () => {
  assert.equal(
    stepsLine([{ tool: 'get_stats', failed: false }, { tool: 'last_time', failed: false }]),
    'It read your movement history, then read the last time you trained a movement.',
  );
  assert.equal(
    stepsLine([
      { tool: 'get_stats', failed: false },
      { tool: 'get_stats', failed: false },
      { tool: 'get_stats', failed: false },
    ]),
    'It read your movement history.',
  );
  assert.equal(
    stepsLine([{ tool: 'list_routines', failed: false }, { tool: 'propose_routine_change', failed: false }]),
    'It read your program, then wrote a proposal for one of your routines.',
  );
  assert.equal(
    stepsLine([{ tool: 'list_notes', failed: false }, { tool: 'list_sessions', failed: false }]),
    'It read your notes, then read your recent workouts.',
  );
});

test('an answer that called no tool names the read it was opened with', () => {
  assert.equal(stepsLine([]), NO_STEPS);
  assert.equal(stepsLine(undefined), NO_STEPS);
  assert.equal(NO_STEPS, 'Answered from your recent workouts alone.');
});

test('a read that came back empty is named as empty, never hidden', () => {
  assert.equal(
    stepsLine([{ tool: 'get_stats', failed: true }]),
    'It read your movement history (nothing came back).',
  );
});

test('a tool with no phrase prints nothing — the step is dropped, and a list of nothing else draws no line', () => {
  assert.equal(stepsLine([{ tool: 'something_new', failed: false }]), null);
  assert.equal(
    stepsLine([{ tool: 'something_new', failed: false }, { tool: 'get_stats', failed: false }]),
    'It read your movement history.',
  );
  assert.equal(stepsLine([{ tool: 'something_new', failed: false }])?.includes('something_new'), undefined);
});

test('readLine prints the server’s three counts, in canon’s order and canon’s spelling', () => {
  assert.equal(readLine({ sets: 214, sessions: 34, weeks: 12 }), 'read 214 sets · 12 weeks · 34 sessions');
});

test('readLine spells a single row as a single row', () => {
  assert.equal(readLine({ sets: 1, sessions: 1, weeks: 1 }), 'read 1 set · 1 week · 1 session');
  assert.equal(readLine({ sets: 5, sessions: 1, weeks: 1 }), 'read 5 sets · 1 week · 1 session');
});

test('an answer that read none of your log says so in words', () => {
  assert.equal(readLine({ sets: 0, sessions: 0, weeks: 0 }), 'read nothing from your log');
});

test('readLine says nothing rather than guessing when the wire carried no count', () => {
  assert.equal(readLine(undefined), null);
  assert.equal(readLine(null), null);
  assert.equal(readLine({ sets: 12, weeks: 3 }), null);
  assert.equal(readLine({ sets: '12', sessions: 3, weeks: 1 }), null);
});

test('an answer with a receipt becomes the turn the room draws, passed through whole, under the wire’s enum', () => {
  const reply = {
    answer: 'Flat for three weeks.',
    steps: [{ tool: 'get_stats', failed: false }],
    read: { sets: 214, sessions: 34, weeks: 12 },
    proposals: ['prop_0a1b2c3d'],
  };
  assert.deepEqual(answerTurn(reply), {
    from: 'ask',
    text: 'Flat for three weeks.',
    steps: [{ tool: 'get_stats', failed: false }],
    read: { sets: 214, sessions: 34, weeks: 12 },
    proposals: ['prop_0a1b2c3d'],
  });
  assert.equal(answerTurn(reply).read, reply.read);
  assert.deepEqual(answerTurn({ answer: 'Yes.', read: { sets: 0, sessions: 0, weeks: 0 } }), {
    from: 'ask', text: 'Yes.', steps: undefined, read: { sets: 0, sessions: 0, weeks: 0 }, proposals: [],
  });
});

test('every proposal an answer minted is passed through; the one-per-turn rule is the server’s', () => {
  const reply = { answer: 'Two.', read: { sets: 1, sessions: 1, weeks: 1 }, proposals: ['prop_1', 'prop_2'] };
  assert.deepEqual(answerTurn(reply).proposals, ['prop_1', 'prop_2']);
});

test('a reply the receipt is missing from is refused, and so is one with no prose', () => {
  const read = { sets: 9, sessions: 3, weeks: 3 };
  assert.equal(answerTurn({ answer: 'Three sessions at the same top set.', steps: [{ tool: 'get_stats' }] }), null);
  assert.equal(answerTurn({ answer: 'a', read: null }), null);
  assert.equal(answerTurn({ answer: 'a', read: { sets: 12, weeks: 3 } }), null);
  assert.equal(answerTurn({ answer: 'a', read: { sets: '12', sessions: 3, weeks: 1 } }), null);
  assert.equal(answerTurn({ read }), null);
  assert.equal(answerTurn({ answer: 42, read }), null);
  assert.equal(answerTurn(undefined), null);
  assert.equal(NO_ANSWER_NOTE, 'Coach didn’t answer. Try again in a moment.');
  assert.equal(askFailure({ status: 502 }).note, NO_ANSWER_NOTE);
});

test('a conversation is named by a client-minted id, and the prefix says what it names', () => {
  assert.equal(THREAD_PREFIX, 'thr_');
  const id = mintId(THREAD_PREFIX);
  assert.match(id, /^thr_[0-9a-f]{16}$/);
  assert.match(id, /^[A-Za-z0-9_-]{8,64}$/);
  assert.notEqual(mintId(THREAD_PREFIX), id);
});

test('threadFull turns the composer off exactly one question before the wire would refuse it', () => {
  assert.equal(MAX_TURNS, 8);
  const exchange = [{ from: 'lifter', text: 'q' }, { from: 'ask', text: 'a' }];
  const after = (rounds) => Array.from({ length: rounds }, () => exchange).flat();

  assert.equal(threadFull([]), false);
  assert.equal(threadFull(after(3)), false);
  assert.equal(threadFull(after(4)), true);
  assert.equal(threadFull([...after(3), { from: 'lifter', text: 'never landed' }]), false);
});

test('the thread ceiling says four, never eight, and offers the way out', () => {
  assert.equal(THREAD_FULL_NOTE, 'This conversation holds four questions. Start a new one.');
  assert.equal(askFailure({ status: 409, code: 'ask-thread-full' }).note, THREAD_FULL_NOTE);
  assert.equal(askFailure({ status: 409, code: 'ask-thread-full' }).full, true);
  assert.equal(askFailure({ status: 409, code: 'ask-thread-full' }).refused, true);
});

test('a conversation id somebody else holds asks for a new one, and retires nothing', () => {
  const failure = askFailure({ status: 409, code: 'ask-thread-taken' });
  assert.equal(THREAD_TAKEN_NOTE, 'That conversation id was already taken. Ask again — it opens a new one.');
  assert.equal(failure.note, THREAD_TAKEN_NOTE);
  assert.equal(failure.fresh, true);
  assert.equal(failure.refused, true);
  assert.equal(failure.gone, undefined);
});

test('askFailure — the words are the server’s wherever it sent a sentence; only the state is the room’s', () => {
  const table = [
    [401, 'sign in to open your training log', '', { gone: true }],
    [400, 'that isn’t a conversation Coach can answer', '', {}],
    [400, 'ask something about your training', '', {}],
    [400, 'that question is longer than Coach takes', '', {}],
    [400, 'that question has characters Coach can’t store', '', {}],
    [409, 'that conversation id is already in use — start a new one', 'ask-thread-taken', { fresh: true, refused: true }],
    [409, 'this conversation holds four questions — start a new one', 'ask-thread-full', { full: true, refused: true }],
    [409, 'finish your workout first — Coach reads a log that has stopped moving', 'ask-session-open', { refused: true }],
    [429, 'the next question frees up in a couple of hours', 'ask-daily-limit', { capped: true, refused: true }],
    [429, 'this account has reached its AI ceiling for the last 30 days. Coach will answer again as that window rolls on', 'ask-out-of-budget', { refused: true }],
    [503, 'Coach isn’t part of this Windmill. Your log is still yours to read.', 'ask-not-configured', { gone: true }],
    [502, 'Coach didn’t answer. Try again in a moment', '', {}],
  ];
  for (const [status, sentence, code, state] of table) {
    assert.deepEqual(askFailure(sent(status, sentence, code)), { note: sentence, ...state }, sentence);
  }
});

test('askFailure — the room’s own sentence is only the wordless fallback, and the state never reads the sentence', () => {
  assert.equal(askFailure(sent(429, '', 'ask-out-of-budget')).note, OUT_OF_BUDGET_NOTE);
  assert.equal(askFailure(sent(409, '', 'ask-session-open')).note, MID_SESSION_NOTE);
  assert.equal(askFailure(sent(401, '')).note, SIGNED_OUT_NOTE);
  assert.deepEqual(
    askFailure(sent(429, 'a sentence from a newer server', 'ask-daily-limit')),
    { note: 'a sentence from a newer server', capped: true, refused: true },
  );
  assert.deepEqual(askFailure(sent(409, 'the next question frees up in a couple of hours', 'ask-thread-full')).capped, undefined);
});

test('a refusal the server stored nothing of is marked so the room can take the question back; an answer that failed is not', () => {
  for (const error of [
    { status: 409, code: 'ask-session-open' }, { status: 409, code: 'ask-thread-full' },
    { status: 409, code: 'ask-thread-taken' }, { status: 429, code: 'ask-daily-limit' },
    { status: 429, code: 'ask-out-of-budget' }, { status: 429 },
  ]) {
    assert.equal(askFailure(error).refused, true, JSON.stringify(error));
  }
  for (const error of [{ status: 401 }, { status: 404 }, { status: 400 }, { status: 502 }, { status: 503, code: 'ask-not-configured' }, undefined]) {
    assert.equal(askFailure(error).refused, undefined, JSON.stringify(error));
  }
});

test('a question is measured in the bytes the wire counts, not in characters', () => {
  assert.equal(QUESTION_BYTES, 1000);
  assert.equal(questionTooLong('a'.repeat(1000)), false);
  assert.equal(questionTooLong('a'.repeat(1001)), true);
  assert.equal(questionTooLong('🏋'.repeat(500)), true);
  assert.equal(questionTooLong('é'.repeat(500)), false);
  assert.equal(questionTooLong('é'.repeat(501)), true);
});

test('askFailure — no Coach on this deployment retires the room: the bare 404, or the server saying so', () => {
  assert.equal(COACH_ABSENT_NOTE, 'Coach isn’t part of this Windmill. Your log is still yours to read.');
  for (const error of [{ status: 404, code: '' }, { status: 503, code: 'ask-not-configured' }]) {
    const failure = askFailure(error);
    assert.equal(failure.note, COACH_ABSENT_NOTE);
    assert.equal(failure.gone, true);
  }
});

test('askFailure — a bare 503 is a no-answer, not an absent Coach', () => {
  const failure = askFailure({ status: 503, code: '' });
  assert.equal(failure.note, NO_ANSWER_NOTE);
  assert.equal(failure.gone, undefined);
});

test('askFailure — an account that went is told why the room needs one', () => {
  assert.equal(SIGNED_OUT_NOTE, 'Coach reads your log, so it needs you signed in.');
  const failure = askFailure({ status: 401 });
  assert.equal(failure.note, SIGNED_OUT_NOTE);
  assert.equal(failure.gone, true);
});

test('askFailure — a workout that opened underneath is said in the room’s own words', () => {
  assert.equal(MID_SESSION_NOTE, 'Finish your workout first — Coach reads a log that has stopped moving.');
  const failure = askFailure({ status: 409, code: 'ask-session-open' });
  assert.equal(failure.note, MID_SESSION_NOTE);
  assert.equal(failure.gone, undefined);
});

test('the allowance is the promise above the composer; the cap-reached state is the moment, and says what to do next', () => {
  assert.equal(ALLOWANCE_LINE, 'Ten questions a day, three back to back.');
  assert.equal(CAP_REACHED_NOTE, 'The next question frees up in a couple of hours.');
  const failure = askFailure({ status: 429, code: 'ask-daily-limit' });
  assert.equal(failure.note, CAP_REACHED_NOTE);
  assert.equal(failure.capped, true);
  assert.equal(failure.refused, true);
  assert.equal(failure.gone, undefined);
  assert.doesNotMatch(failure.note, /ten questions|[Uu]pgrade|[Bb]uy|[Pp]lan|[Ss]ubscri|Windmill One/);
});

test('askFailure — the AI ceiling is its own 429, and it is not the daily cap', () => {
  const failure = askFailure({ status: 429, code: 'ask-out-of-budget' });
  assert.equal(failure.note, OUT_OF_BUDGET_NOTE);
  assert.match(failure.note, /30 days/);
  assert.match(failure.note, /rolls on/);
  assert.doesNotMatch(failure.note, /ten questions/);
  assert.doesNotMatch(failure.note, /[Uu]pgrade|[Bb]uy|[Pp]lan|[Ss]ubscri|Windmill One/);
  assert.doesNotMatch(failure.note, /untouched/, 'the fallback claims no more than the server’s sentence does');
  assert.equal(failure.capped, undefined);
});

test('askFailure — an uncoded brake and an unreadable request each say what they are', () => {
  assert.equal(BRAKE_NOTE, 'That’s a lot of questions at once. Try again shortly.');
  assert.equal(UNREADABLE_NOTE, 'Coach couldn’t read that. Start a new question and send it on its own.');
  assert.deepEqual(askFailure({ status: 429 }), { note: BRAKE_NOTE, refused: true });
  assert.deepEqual(askFailure({ status: 400 }), { note: UNREADABLE_NOTE });
});

test('askFailure — a model that did not answer is the one to try again', () => {
  assert.deepEqual(askFailure({ status: 502 }), { note: 'Coach didn’t answer. Try again in a moment.' });
  assert.deepEqual(askFailure(undefined), { note: 'Coach didn’t answer. Try again in a moment.' });
});

test('the empty room points at the free door, and contrasts it on scope, never on quality', () => {
  assert.match(FREE_DOOR_LINE, /If you already use Claude or ChatGPT, connect them instead/);
  assert.match(FREE_DOOR_LINE, /it’s free/);
  assert.match(FREE_DOOR_LINE, /it reaches what Coach can’t/);
  assert.match(FREE_DOOR_LINE, /it knows the rest of your life/);
  assert.doesNotMatch(FREE_DOOR_LINE, /better|smarter|worse|instead of a coach|your coach/i);
});

test('a proposal Coach minted says the tap is elsewhere and that your sets are not in it', () => {
  assert.equal(
    PROPOSAL_NOTE,
    'Nothing changes until you tap Apply on the diff. Your logged sets are never part of a proposal.',
  );
});

test('the room says a correction is the lifter’s, and where it is made', () => {
  assert.match(FIX_IS_YOURS, /Correcting a set is yours, not Coach’s/);
  assert.match(FIX_IS_YOURS, /tap the set/);
});

test('every sentence of the room’s own says Coach, never Ask, and uses the typographic apostrophe', () => {
  const sentences = [
    COACH_ABSENT_NOTE, SIGNED_OUT_NOTE, MID_SESSION_NOTE, NO_ANSWER_NOTE, OUT_OF_BUDGET_NOTE,
    FIX_IS_YOURS, THREAD_FULL_NOTE, CAP_REACHED_NOTE, ALLOWANCE_LINE, BRAKE_NOTE, UNREADABLE_NOTE,
    FREE_DOOR_LINE,
  ];
  for (const sentence of sentences) {
    assert.doesNotMatch(sentence, /\bAsk\b/, sentence);
    assert.equal(sentence.includes("'"), false, sentence);
    assert.doesNotMatch(sentence, /\beight\b/, sentence);
  }
});
