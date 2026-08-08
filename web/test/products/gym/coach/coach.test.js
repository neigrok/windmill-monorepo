// The coach panel's words and its one rule. Both are PROMISES: the terms describe a capability a
// lifter is deciding whether to use, and the "what it read" line is the whole difference between an
// instrument and a chatbot. A panel that quietly stopped naming its tools would look identical.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  askFailure, COACH_ABSENT_NOTE, COACH_LOCKED_NOTE, COACH_TERMS, stepsLine, threadFor, TOOL_PHRASE,
} from '../../../../src/products/gym/coach/coach.js';

// THE COPY IS THE CONTRACT. It says what the panel reaches and, in the same breath, what it cannot
// do — because the landing page next door used to promise "there is no chatbot in here", and the
// honest replacement for that promise is this one, on the screen where it matters.
test('the terms name the reach AND the limit, in that order', () => {
  assert.match(COACH_TERMS, /same tools your own AI tools use/);
  assert.match(COACH_TERMS, /It only reads/);
  assert.match(COACH_TERMS, /cannot log a set, change your program, delete a workout, or make a coach link/);
});

test('every tool a panel can be handed has a phrase a lifter can read', () => {
  // Exactly the six reads CoachTools hands the model (backend/products/gym/application/CoachService).
  assert.deepEqual(Object.keys(TOOL_PHRASE).sort(), [
    'get_session', 'get_stats', 'last_time', 'list_exercises', 'list_routines', 'list_sessions',
  ]);
});

test('stepsLine names what it read, in call order, once each', () => {
  assert.equal(
    stepsLine([{ tool: 'get_session', failed: false }, { tool: 'last_time', failed: false }]),
    'It read this workout, then read the last time you trained that movement.',
  );
  // Three reads of the same movement history tell a lifter nothing a single mention does not.
  assert.equal(
    stepsLine([
      { tool: 'get_stats', failed: false },
      { tool: 'get_stats', failed: false },
      { tool: 'get_stats', failed: false },
    ]),
    'It read your movement history.',
  );
});

test('an answer that used no tool says so rather than saying nothing', () => {
  assert.equal(stepsLine([]), 'Answered from this workout alone.');
  assert.equal(stepsLine(undefined), 'Answered from this workout alone.');
});

test('a read that came back empty is named as empty, never hidden', () => {
  assert.equal(
    stepsLine([{ tool: 'get_stats', failed: true }]),
    'It read your movement history (nothing came back).',
  );
});

test('a tool name with no phrase is shown verbatim — a step nobody can read still happened', () => {
  assert.equal(stepsLine([{ tool: 'something_new', failed: false }]), 'It something_new.');
});

// THE TWO 404s ARE DIFFERENT FACTS AND THE CODE IS WHAT TELLS THEM APART. An unconfigured deployment
// never mounts the route, so its 404 is the framework's and carries no code; a workout this account
// cannot read is gym's own 404 and carries `coach-no-session`. Reading the sentence instead would
// break the day either one is reworded.
test('askFailure — a bare 404 means there is no coach here, and the panel retires', () => {
  const failure = askFailure({ status: 404, code: '' });
  assert.equal(failure.note, COACH_ABSENT_NOTE);
  assert.equal(failure.gone, true);
});

test('askFailure — a coded 404 is about the workout, and the panel stays open', () => {
  const failure = askFailure({ status: 404, code: 'coach-no-session' });
  assert.equal(failure.note, 'That workout isn’t in your log.');
  assert.equal(failure.gone, true);
});

test('askFailure — 403 re-locks rather than retiring: the plan is the thing that changed', () => {
  const failure = askFailure({ status: 403, code: 'coach-not-entitled' });
  assert.equal(failure.note, COACH_LOCKED_NOTE);
  assert.equal(failure.locked, true);
  assert.equal(failure.gone, undefined);
});

test('askFailure — the brake and a dead model each say what they are, and neither retires', () => {
  assert.deepEqual(askFailure({ status: 429, code: 'coach-rate-limited' }), {
    note: 'That’s a lot of questions at once. Try again shortly.',
  });
  assert.deepEqual(askFailure({ status: 502 }), {
    note: 'The coach didn’t answer. Ask again in a moment.',
  });
  assert.deepEqual(askFailure(undefined), {
    note: 'The coach didn’t answer. Ask again in a moment.',
  });
});

// The two 429s are different facts and must not share a sentence: the brake is about how fast the
// questions came, the ceiling is about money and clears as a 30-day window rolls. Neither blames the
// lifter, and neither offers a purchase — there is no checkout behind this panel to offer.
test('askFailure — the AI ceiling is its own 429, and it is not the pace brake', () => {
  const failure = askFailure({ status: 429, code: 'coach-out-of-budget' });
  assert.match(failure.note, /rolling 30 days/);
  assert.match(failure.note, /rolls on/);
  assert.doesNotMatch(failure.note, /lot of questions/);
  assert.doesNotMatch(failure.note, /[Uu]pgrade|[Bb]uy|[Pp]lan|[Ss]ubscri/);
  assert.equal(failure.locked, undefined);
  assert.equal(failure.gone, undefined);
});

test('askFailure — a deployment with no vendor answers 503, and that retires too', () => {
  assert.equal(askFailure({ status: 503 }).gone, true);
});

// The server holds none of the conversation, so what travels IS what is on screen plus the new
// question — never a copy kept beside it that could disagree with what the lifter is reading.
test('threadFor sends every turn so far, oldest first, with the new question last', () => {
  const turns = [
    { from: 'lifter', text: 'how did the squats go?' },
    { from: 'coach', text: 'You squatted 100 for five.', steps: [{ tool: 'get_session', failed: false }] },
  ];
  assert.deepEqual(threadFor(turns, 'which set was heaviest?'), [
    { from: 'lifter', text: 'how did the squats go?' },
    { from: 'coach', text: 'You squatted 100 for five.' },   // the steps stay on screen, not on the wire
    { from: 'lifter', text: 'which set was heaviest?' },
  ]);
  assert.deepEqual(threadFor([], 'first question'), [{ from: 'lifter', text: 'first question' }]);
});
