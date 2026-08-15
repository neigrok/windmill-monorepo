// ASK'S WORDS AND ITS RULES. Most of what is pinned here is a PROMISE: the receipt under an answer
// is the whole difference between an instrument and a chatbot, and a room that quietly stopped
// printing it would look identical. The rest is the wire's grammar, which the room has to obey
// before it sends — a question over the byte cap, or a ninth turn into an eight-turn conversation,
// is a refusal the room can see coming and say in words instead.
//
// §O REVERSED THE ONE DECISION W7 MADE LOUDEST: the server stores the conversation now, so an ask
// carries a thread id and one question rather than every turn on screen. The tests that pinned the
// resent thread are gone rather than left standing beside their replacements.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  answerTurn, ASK_ABSENT_NOTE, ASK_TERMS, askFailure, FIX_IS_YOURS, FREE_DOOR_LINE, MAX_TURNS,
  MID_SESSION_NOTE, NO_ANSWER_NOTE, NO_STEPS, PROPOSAL_NOTE, questionTooLong, QUESTION_BYTES,
  readLine, stepsLine, THREAD_FULL_NOTE, THREAD_PREFIX, threadFull, TOOL_PHRASE,
} from '../../../../src/products/gym/ask/ask.js';
import { mintId } from '../../../../src/products/gym/mint.js';

// THE HEADER IS THE DISCLOSURE and it is four words: what it reaches, and — in the same breath —
// that proposing is the most it can do. It sits under the title before anything is typed.
test('the terms name the reach AND the limit, in that order', () => {
  assert.equal(ASK_TERMS, 'reads your log · proposes only');
});

// EXHAUSTIVE OVER THE GRANT ASK HOLDS, and that is the point of listing it: Ask is offered the six
// gym reads plus the two tools that mint a proposal (backend AskTools — Access::read ∪ mintsProposal)
// and nothing else, so nothing else can ever appear in a step. The five write and delete tools gym
// publishes over MCP are absent here because they are absent from the grant, and a phrase for one of
// them would be this file claiming a capability the server refuses.
test('every tool Ask can be handed has a phrase a lifter can read, and no tool it cannot', () => {
  assert.deepEqual(Object.keys(TOOL_PHRASE).sort(), [
    'get_session', 'get_stats', 'last_time', 'list_exercises', 'list_routines', 'list_sessions',
    'propose_routine_change', 'propose_routine_removal',
  ]);
  for (const banned of ['log_set', 'start_session', 'finish_session', 'discard_session', 'create_routine']) {
    assert.equal(banned in TOOL_PHRASE, false, banned);
  }
});

test('stepsLine names what it read, in call order, once each', () => {
  assert.equal(
    stepsLine([{ tool: 'get_stats', failed: false }, { tool: 'last_time', failed: false }]),
    'It read your movement history, then read the last time you trained a movement.',
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
  // A proposal is a step like any other, and it is named as the write it is rather than as a read.
  assert.equal(
    stepsLine([{ tool: 'list_routines', failed: false }, { tool: 'propose_routine_change', failed: false }]),
    'It read your program, then wrote a proposal for one of your routines.',
  );
});

// AN ANSWER WITH NO STEPS IS NOT AN ANSWER FROM NOWHERE. Ask welds a read of your newest workouts to
// the first turn before the model says anything, and that read is not a step because Ask made it and
// not the model — so the sentence says which, rather than leaving a silence to be read as either.
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

test('a tool name with no phrase is shown verbatim — a step nobody can read still happened', () => {
  assert.equal(stepsLine([{ tool: 'something_new', failed: false }]), 'It something_new.');
});

// ── The receipt ─────────────────────────────────────────────────────────────────────────────────

// CANON'S OWN LINE, and every number in it was counted by the SERVER over the rows it served —
// deduped by id across the whole exchange, so two calls that overlap count once. The order is
// canon's too: sets, then weeks, then sessions.
test('readLine prints the server’s three counts, in canon’s order and canon’s spelling', () => {
  assert.equal(readLine({ sets: 214, sessions: 34, weeks: 12 }), 'read 214 sets · 12 weeks · 34 sessions');
});

// A ONE IS A ONE. The plural is the only thing this line decides, and it decides it per field —
// a lifter who has trained once must not read "1 sets · 1 weeks · 1 sessions".
test('readLine spells a single row as a single row', () => {
  assert.equal(readLine({ sets: 1, sessions: 1, weeks: 1 }), 'read 1 set · 1 week · 1 session');
  assert.equal(readLine({ sets: 5, sessions: 1, weeks: 1 }), 'read 5 sets · 1 week · 1 session');
});

// ZERO ACROSS ALL THREE IS AN ANSWER AND IT GETS WORDS. An answer built from none of a lifter's own
// rows is precisely what they would want to know, and three noughts in a mono line is not how a
// person reads that.
test('an answer that read none of your log says so in words', () => {
  assert.equal(readLine({ sets: 0, sessions: 0, weeks: 0 }), 'read nothing from your log');
});

// AND A MISSING COUNT IS ANSWERED WITH NOTHING. Silence is an omission; a zero would be an
// assertion, and the only assertion this line could make wrongly is that a model answered off
// nothing. What the room does with that nothing is the next test's subject: it draws no answer.
test('readLine says nothing rather than guessing when the wire carried no count', () => {
  assert.equal(readLine(undefined), null);
  assert.equal(readLine(null), null);
  assert.equal(readLine({ sets: 12, weeks: 3 }), null);
  assert.equal(readLine({ sets: '12', sessions: 3, weeks: 1 }), null);
});

// AND A REPLY WITH NO RECEIPT IS NOT AN ANSWER THIS ROOM MAY DRAW — the other half of the rule
// above, and the half that decides whether §L's "every answer states what it read" is a rule or a
// coincidence of what the server happens to send. Drawn anyway, an unreceipted body is model prose
// standing in front of a lifter with nothing to check it against, which is the one thing this door
// exists to prevent. Both phones already fail closed on the same body — iOS decodes `read` strictly
// (WindmillGym/Ask.swift), Android declares it without a default (gym/domain/Ask.kt) — and they say
// what this says: nobody answered.
test('an answer with a receipt becomes the turn the room draws, passed through whole', () => {
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
  // The receipt is the SERVER's object, carried across rather than rebuilt: a copy assembled here
  // is a copy this surface could have edited.
  assert.equal(answerTurn(reply).read, reply.read);
  // Steps and proposals are legitimately empty — neither is a claim about the log, and an answer
  // that called nothing still names the read Ask welded to the first turn.
  assert.deepEqual(answerTurn({ answer: 'Yes.', read: { sets: 0, sessions: 0, weeks: 0 } }), {
    from: 'ask', text: 'Yes.', steps: undefined, read: { sets: 0, sessions: 0, weeks: 0 }, proposals: [],
  });
});

test('a reply the receipt is missing from is refused, and so is one with no prose', () => {
  const read = { sets: 9, sessions: 3, weeks: 3 };
  // The shape today's server cannot send and tomorrow's might: prose, steps, and no receipt.
  assert.equal(answerTurn({ answer: 'Three sessions at the same top set.', steps: [{ tool: 'get_stats' }] }), null);
  assert.equal(answerTurn({ answer: 'a', read: null }), null);
  assert.equal(answerTurn({ answer: 'a', read: { sets: 12, weeks: 3 } }), null);
  assert.equal(answerTurn({ answer: 'a', read: { sets: '12', sessions: 3, weeks: 1 } }), null);
  assert.equal(answerTurn({ read }), null);
  assert.equal(answerTurn({ answer: 42, read }), null);
  assert.equal(answerTurn(undefined), null);
  // And the sentence the room says instead is the one it says for a model that did not answer,
  // because that is what happened: nothing arrived that may go on screen.
  assert.equal(NO_ANSWER_NOTE, 'Ask didn’t answer. Try again in a moment.');
  assert.equal(askFailure({ status: 502 }).note, NO_ANSWER_NOTE);
});

// ── The thread the wire will take ───────────────────────────────────────────────────────────────

// W7 SENT THE WHOLE CONVERSATION EVERY TIME and §O reversed it: the server stores the thread, so an
// ask carries an id and one question. `threadFor` — which assembled the body out of what was on
// screen — went with the statelessness that made it necessary, and this is the test that used to
// pin it. What is left of that rule is the id: a fresh one opens a conversation, and it is minted
// here rather than asked for, because there is no route that opens one.
test('a conversation is named by a client-minted id, and the prefix says what it names', () => {
  assert.equal(THREAD_PREFIX, 'thr_');
  const id = mintId(THREAD_PREFIX);
  // The wire's own charset, and comfortably inside its 8–64 (backend AskApi).
  assert.match(id, /^thr_[0-9a-f]{16}$/);
  assert.match(id, /^[A-Za-z0-9_-]{8,64}$/);
  assert.notEqual(mintId(THREAD_PREFIX), id);
});

// EIGHT STORED TURNS IS THE CAP, so four answers is a whole conversation and a fifth question would
// be a ninth turn — 409 `ask-thread-full`. The room predicts it one question early and offers a new
// conversation rather than letting the send button earn a refusal.
//
// IT COUNTS THE STORED TURNS AND NOT THE SCREEN, which is the half that moved with §O: nothing is
// stored until an answer lands, so a question whose ask failed is on screen and not in the thread.
test('threadFull turns the composer off exactly one question before the wire would refuse it', () => {
  assert.equal(MAX_TURNS, 8);
  const exchange = [{ from: 'lifter', text: 'q' }, { from: 'ask', text: 'a' }];
  const after = (rounds) => Array.from({ length: rounds }, () => exchange).flat();

  assert.equal(threadFull([]), false);
  assert.equal(threadFull(after(3)), false);
  assert.equal(threadFull(after(4)), true);
  // A failed question on screen does not count toward the cap: the server stored nothing for it.
  assert.equal(threadFull([...after(3), { from: 'lifter', text: 'never landed' }]), false);
});

// AND A FULL THREAD IS NOT A LOST ONE ANY MORE. W7's sentence — starting again costs you nothing,
// because the server kept none of it — stopped being true the day §O landed, and what stands in its
// place says where the conversation went.
test('a full conversation says it is kept, not that nothing was lost', () => {
  assert.equal(THREAD_FULL_NOTE, 'That’s as long as one conversation goes here. It’s kept in Threads.');
  assert.equal(askFailure({ status: 409, code: 'ask-thread-full' }).note, THREAD_FULL_NOTE);
  assert.equal(askFailure({ status: 409, code: 'ask-thread-full' }).full, true);
});

// AN ID ANOTHER ACCOUNT HOLDS can only ever arrive on the FIRST question of a conversation — once one
// has landed, the thread is this account's — so the repair is a fresh id under a question that is
// still on screen, and nothing that was answered can be lost this way.
test('a conversation id somebody else holds asks for a new one, and retires nothing', () => {
  const failure = askFailure({ status: 409, code: 'ask-thread-taken' });
  assert.equal(failure.note, 'That conversation id was already taken. Ask again — it opens a new one.');
  assert.equal(failure.fresh, true);
  assert.equal(failure.gone, undefined);
});

// THE CAP IS IN BYTES AND A TEXTAREA COUNTS CHARACTERS, which are not the same number the moment a
// question carries an emoji or an accent. Counting it here is what keeps a long question on screen
// instead of sending it to be refused — nothing a lifter typed disappears into a 400.
test('a question is measured in the bytes the wire counts, not in characters', () => {
  assert.equal(QUESTION_BYTES, 1000);
  assert.equal(questionTooLong('a'.repeat(1000)), false);
  assert.equal(questionTooLong('a'.repeat(1001)), true);
  // 500 four-byte characters is 500 characters and 2000 bytes: the field would have let it through.
  assert.equal(questionTooLong('🏋'.repeat(500)), true);
  assert.equal(questionTooLong('é'.repeat(500)), false);
  assert.equal(questionTooLong('é'.repeat(501)), true);
});

// ── Why an ask did not come back ────────────────────────────────────────────────────────────────

// A DEPLOYMENT WITH NO MODEL NEVER MOUNTS THE ROUTE, so its absence is the framework's own bare 404
// and there is nothing here to configure. The room retires: asking again is not the repair, and a
// composer that still took typing would be a lie.
test('askFailure — no Ask on this deployment retires the room: the bare 404, or the server saying so', () => {
  for (const error of [{ status: 404, code: '' }, { status: 503, code: 'ask-not-configured' }]) {
    const failure = askFailure(error);
    assert.equal(failure.note, ASK_ABSENT_NOTE);
    assert.equal(failure.gone, true);
  }
});

// A 503 with any other face is a proxy or a restart, and asking again is the repair — it must not
// retire the room for the rest of the session.
test('askFailure — a bare 503 is a no-answer, not an absent Ask', () => {
  const failure = askFailure({ status: 503, code: '' });
  assert.equal(failure.note, NO_ANSWER_NOTE);
  assert.equal(failure.gone, undefined);
});

test('askFailure — an account that went sends the lifter back to the door', () => {
  const failure = askFailure({ status: 401 });
  assert.equal(failure.note, 'Sign in to open your training log.');
  assert.equal(failure.gone, true);
});

// NEVER MID-SESSION, and the server is the floor under the rule rather than a substitute for it: the
// door is hidden while a workout is running, and a workout STARTED on the phone while this room was
// open lands here. The composer stays — finishing the workout is the repair.
test('askFailure — a workout that opened underneath is said in the room’s own words', () => {
  const failure = askFailure({ status: 409, code: 'ask-session-open' });
  assert.equal(failure.note, MID_SESSION_NOTE);
  assert.equal(failure.gone, undefined);
});

// THE TWO 429s ARE DIFFERENT FACTS AND MUST NOT SHARE A SENTENCE: one is about pace and clears in a
// couple of hours, the other is about money and clears as a 30-day window rolls. NEITHER OFFERS A
// PURCHASE — Ask is open to everyone, Windmill One cannot be bought, and a door that does not exist
// is not something to offer somebody standing at a limit.
test('askFailure — the daily cap says what it is, in hours, and sells nothing', () => {
  const failure = askFailure({ status: 429, code: 'ask-daily-limit' });
  assert.match(failure.note, /about ten questions a day, three back to back/);
  assert.match(failure.note, /couple of hours/);
  assert.doesNotMatch(failure.note, /[Uu]pgrade|[Bb]uy|[Pp]lan|[Ss]ubscri|Windmill One/);
  assert.equal(failure.gone, undefined);
});

test('askFailure — the AI ceiling is its own 429, and it is not the daily cap', () => {
  const failure = askFailure({ status: 429, code: 'ask-out-of-budget' });
  assert.match(failure.note, /30 days/);
  assert.match(failure.note, /rolls on/);
  assert.doesNotMatch(failure.note, /ten questions/);
  assert.doesNotMatch(failure.note, /[Uu]pgrade|[Bb]uy|[Pp]lan|[Ss]ubscri|Windmill One/);
});

// A 429 WITH NO CODE IS AN OLDER BRAKE AND STILL NOT A PURCHASE. And a 400 is terminal: the thread
// or the question was unreadable, and sending the same bytes again fails identically forever.
test('askFailure — an uncoded brake and an unreadable request each say what they are', () => {
  assert.deepEqual(askFailure({ status: 429 }), {
    note: 'That’s a lot of questions at once. Try again shortly.',
  });
  assert.deepEqual(askFailure({ status: 400 }), {
    note: 'Ask couldn’t read that. Start a new question and send it on its own.',
  });
});

// The one worth offering a retry on, and the fallback for a throw that carried no status at all —
// a request that never produced a response is the same fact from the client's side.
test('askFailure — a model that did not answer is the one to try again', () => {
  assert.deepEqual(askFailure({ status: 502 }), { note: 'Ask didn’t answer. Try again in a moment.' });
  assert.deepEqual(askFailure(undefined), { note: 'Ask didn’t answer. Try again in a moment.' });
});

// ── The two sentences this wave exists to make true ─────────────────────────────────────────────

// THE FREE DOOR, in the empty room. An in-app chat that tells you how to stop paying us costs one
// paragraph and is the strongest available proof the MCP thesis is real: the log is yours, the tools
// are open, and the agent you already have reads it better than ours can.
test('the empty room points at the free door, and says why it is better', () => {
  assert.match(FREE_DOOR_LINE, /If you already use Claude or ChatGPT, connect them instead/);
  assert.match(FREE_DOOR_LINE, /it’s free/);
  assert.match(FREE_DOOR_LINE, /it knows the rest of your life/);
});

// IT PROPOSES AND IT NEVER WRITES — both halves, in canon's own words, under the diff it minted.
// The second half is the one a lifter cannot verify for themselves and therefore the one that has to
// be said: a proposal cannot reach a set you lifted at all, at any grant level.
test('a proposal Ask minted says the tap is elsewhere and that your sets are not in it', () => {
  assert.equal(
    PROPOSAL_NOTE,
    'Nothing changes until you tap Apply on the diff. Your logged sets are never part of a proposal.',
  );
});

// AND WHAT IT HANDS BACK. Ask can read what you lifted and cannot edit it, so the room names the
// door that can rather than leaving a lifter to discover the refusal by asking for one.
test('the room says a correction is the lifter’s, and where it is made', () => {
  assert.match(FIX_IS_YOURS, /Correcting a set is yours/);
  assert.match(FIX_IS_YOURS, /tap the set/);
});
