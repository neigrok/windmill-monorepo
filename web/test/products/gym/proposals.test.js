// How a proposal reads, pinned — the rules behind §D14's diff, the card that carries it and the
// routine's dated history. The fixture is canon's own proposal: four changes on Push A, heavier
// bench triples, incline work in place of flies.
//
// The claim under nearly every case here is the one this wave exists to make: the agent proposed
// and NOTHING happened. So the readings are all of something that has not been applied — which is
// why the settled sentences carry an instant, why a removed line names the logged sets it keeps,
// and why "All four or none" is a sentence about a tap rather than about a write.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyLabel, atomicLine, changeLabel, diffRows, documentLine, historyLabel, intentLine, isPending,
  conversationOf, CONVERSATION_VERB,
  logKeptLabel, reviewLabel, settledLine, sourceLabel, stateChip, summaryLine, UNNAMED_AGENT,
} from '../../../src/products/gym/proposals.js';
import { KG, LB, spellWeightsIn } from '../../../src/products/gym/units.js';

// The desk reads in kilograms unless an account says otherwise, and one case below moves the dial
// back after checking that a diff moves with it.
spellWeightsIn(KG);

// Canon's own two instants — written Sunday 21:14, decided Monday 07:12 — built from a LOCAL
// calendar rather than from an epoch number, because every label under test is a wall clock in the
// lifter's own zone and a fixed millisecond would spell a different hour on every machine.
const CREATED_AT = new Date(2026, 7, 2, 21, 14).getTime();
const SETTLED_AT = new Date(2026, 7, 3, 7, 12).getTime();
const READ_AT = new Date(2026, 7, 3, 9, 41).getTime();

// CANON'S OWN PROPOSAL, in the wire's shape: the change rows are the document as well as the diff,
// so the run is in order, the removals are last, and the two `kept` rows are movements this
// proposal does not touch at all.
function proposal(over = {}) {
  return {
    id: 'prop_2f9c40a1',
    routineId: 'rt_push_a',
    intent: 'revise',
    state: 'pending',
    summary: 'Four weeks of heavier bench triples, incline work in place of flies. Everything else unchanged.',
    changeCount: 4,
    createdAt: CREATED_AT,
    source: { door: 'mcp' },
    baseRevision: 1,
    baseName: 'Push A',
    name: 'Push A',
    changes: [
      {
        position: 1,
        kind: 'retargeted',
        exerciseId: 'bench-press',
        before: { sets: 5, reps: 5, weightKg: 82.5, restSeconds: 180 },
        after: { sets: 5, reps: 3, weightKg: 87.5, restSeconds: 180 },
      },
      {
        position: 2,
        kind: 'added',
        exerciseId: 'incline-db-press',
        after: { sets: 3, reps: 10, weightKg: 24 },
      },
      {
        position: 3,
        kind: 'retargeted',
        exerciseId: 'overhead-press',
        before: { sets: 3, reps: 8, weightKg: 45 },
        after: { sets: 3, reps: 8, weightKg: 47.5 },
      },
      { position: 4, kind: 'kept', exerciseId: 'chin-up', before: { sets: 3 }, after: { sets: 3 } },
      { position: 5, kind: 'kept', exerciseId: 'barbell-row', before: { sets: 4, reps: 8, weightKg: 70 }, after: { sets: 4, reps: 8, weightKg: 70 } },
      {
        position: 6,
        kind: 'removed',
        exerciseId: 'cable-fly',
        before: { sets: 3, reps: 12, weightKg: 22.5 },
        loggedSets: 41,
      },
    ],
    ...over,
  };
}

// THE WHOLE DOCUMENT, canon's four changes marked and the two untouched lines drawn flat. The
// unmarked rows are not decoration: the change rows are the run in order, so a movement that only
// MOVED is an unmarked row in a new place and there is nowhere else on the wire it could show.
test('diffRows — every line the routine would run, in order, with the four changes marked', () => {
  assert.deepEqual(diffRows(proposal()), [
    {
      kind: 'retargeted',
      exerciseId: 'bench-press',
      moves: [
        { field: 'sets', from: '5 × 5', to: '5 × 3' },
        { field: 'weight', from: '82.5', to: '87.5' },
      ],
    },
    {
      kind: 'added',
      exerciseId: 'incline-db-press',
      targets: '3 × 10 · 24',
      rest: null,
      follows: 'bench-press',
    },
    {
      kind: 'retargeted',
      exerciseId: 'overhead-press',
      moves: [{ field: 'weight', from: '45', to: '47.5' }],
    },
    { kind: 'kept', exerciseId: 'chin-up', targets: '3 × max' },
    { kind: 'kept', exerciseId: 'barbell-row', targets: '4 × 8 · 70' },
    { kind: 'removed', exerciseId: 'cable-fly', kept: '41 logged sets kept' },
  ]);
  assert.equal(
    documentLine(proposal()),
    'Push A as it would read, top to bottom. The marked lines change; the rest keep their numbers.',
  );
});

// THE MARKS AND THE BUTTON COUNT THE SAME THING. `Apply all 4` is the store's own number and four
// rows carry a mark — if the two could disagree, the missing change would be the one nobody read
// before tapping. The unmarked rows are counted by neither, which is the whole of what unmarked
// means here.
test('diffRows — the marked rows are exactly what the store counted under Apply', () => {
  const document = proposal();
  const marked = diffRows(document).filter((row) => row.kind !== 'kept');
  assert.equal(marked.length, document.changeCount);
  assert.equal(applyLabel(document), 'Apply all 4');
  assert.equal(atomicLine(document), 'All four or none. Nothing is applied until you tap.');
});

// AN AGENT THAT REORDERS THE PROGRAM CANNOT DO IT BEHIND THE SCREEN. A proposal that swaps two
// movements and retargets one arrives as ONE counted change — the store counts a `kept` row as no
// change, and it is right, because the row's numbers did not move — but the routine's ORDER moves
// with it. Drawing only the marked rows put a lifter one tap from a Monday that opens with cable
// flies, having read one line about bench press. So the run is drawn whole: the movement that only
// moved is on the screen, in the place it would take.
test('diffRows — a movement that only changed position is still on the screen, in its new place', () => {
  const reordered = proposal({
    changeCount: 1,
    changes: [
      { position: 1, kind: 'kept', exerciseId: 'cable-fly', before: { sets: 3, reps: 12, weightKg: 22.5 }, after: { sets: 3, reps: 12, weightKg: 22.5 } },
      {
        position: 2,
        kind: 'retargeted',
        exerciseId: 'bench-press',
        before: { sets: 5, reps: 5, weightKg: 82.5 },
        after: { sets: 5, reps: 3, weightKg: 87.5 },
      },
    ],
  });
  const rows = diffRows(reordered);
  assert.deepEqual(rows, [
    { kind: 'kept', exerciseId: 'cable-fly', targets: '3 × 12 · 22.5' },
    {
      kind: 'retargeted',
      exerciseId: 'bench-press',
      moves: [
        { field: 'sets', from: '5 × 5', to: '5 × 3' },
        { field: 'weight', from: '82.5', to: '87.5' },
      ],
    },
  ]);
  // One counted change, two rows read, and the order the routine takes on is the order drawn.
  assert.equal(rows.filter((row) => row.kind !== 'kept').length, reordered.changeCount);
  assert.equal(applyLabel(reordered), 'Apply all 1');
});

// A RENAME IS A ROW, because the store counts it: a proposal that renamed Push A and moved two lines
// is three changes, and without this row the button would offer three over two drawn — the missing
// one being the name of the routine the lifter is about to change.
test('diffRows — a renamed routine is a row of the diff, counted like any other change', () => {
  const renamed = proposal({ name: 'Push A — heavy', changeCount: 5 });
  const rows = diffRows(renamed);
  assert.deepEqual(rows[0], { kind: 'renamed', from: 'Push A', to: 'Push A — heavy' });
  assert.equal(rows.filter((row) => row.kind !== 'kept').length, renamed.changeCount);
  assert.equal(atomicLine(renamed), 'All five or none. Nothing is applied until you tap.');
});

// A movement joining at the top of the routine has nothing above it, and "after nothing" is not a
// sentence. The run is in order and removals sort last, so the row before an added one is always
// part of the routine it is joining.
//
// AND A REST IT SETS IS DRAWN. Rest is a field this diff already moves on a line that already stood,
// so an added line is the one place a rest target could arrive without being read; an absent one
// sets nothing — the line takes the account's own target — and draws no words.
test('diffRows — an added movement names the line it lands after, or says it is first', () => {
  const opener = proposal({
    changeCount: 1,
    changes: [
      { position: 1, kind: 'added', exerciseId: 'incline-db-press', after: { sets: 3, reps: 10, weightKg: 24, restSeconds: 300 } },
      { position: 2, kind: 'kept', exerciseId: 'bench-press', before: { sets: 5 }, after: { sets: 5 } },
    ],
  });
  assert.deepEqual(diffRows(opener), [
    { kind: 'added', exerciseId: 'incline-db-press', targets: '3 × 10 · 24', rest: '5:00', follows: null },
    { kind: 'kept', exerciseId: 'bench-press', targets: '5 × max' },
  ]);
});

// THE THREE ABSENCES A TARGET HAS, each spelled the way the rest of the product spells it: an absent
// rep target is `max`, an absent load is "whatever you did last time", and an absent rest is the
// account's own target rather than the settings screen's `off` — a routine saying nothing about rest
// is not a routine switching a clock off. Zero is not a load either: it is the absence of one.
test('diffRows — an omitted target reads as the word the wire means by omitting it', () => {
  const rows = diffRows(proposal({
    changeCount: 1,
    changes: [{
      position: 1,
      kind: 'retargeted',
      exerciseId: 'chin-up',
      before: { sets: 3, reps: 8, weightKg: 0, restSeconds: 120 },
      after: { sets: 3 },
    }],
  }));
  assert.deepEqual(rows, [{
    kind: 'retargeted',
    exerciseId: 'chin-up',
    moves: [
      { field: 'sets', from: '3 × 8', to: '3 × max' },
      { field: 'rest', from: '2:00', to: 'your rest target' },
    ],
  }]);
});

// AND THE FOURTH ABSENCE IS THE OPEN LINE (§M). A side with no `sets` is a row that asks at the
// rack, which is a target like any other as far as this diff is concerned: it moves to one, or one
// moves to it, and both readings are the word every other screen prints.
//
// WHICH SIDE IS MISSING IS THE ROW'S `kind` AND NOTHING ELSE. An added line has no `before` and a
// removed one has no `after`; a screen that read an absent `sets` as an absent side would draw
// `+ Deadlift` with nothing added to it.
test('diffRows — a line that asks at the rack reads as open, on either side of the arrow', () => {
  const rows = diffRows(proposal({
    changeCount: 2,
    changes: [
      {
        position: 1,
        kind: 'retargeted',
        exerciseId: 'barbell-row',
        before: { sets: 4, reps: 8, weightKg: 70 },
        after: { restSeconds: 120 },
      },
      { position: 2, kind: 'added', exerciseId: 'deadlift', after: {} },
    ],
  }));
  assert.deepEqual(rows, [
    {
      kind: 'retargeted',
      exerciseId: 'barbell-row',
      moves: [
        { field: 'sets', from: '4 × 8', to: 'open' },
        { field: 'weight', from: '70', to: 'last time' },
        { field: 'rest', from: 'your rest target', to: '2:00' },
      ],
    },
    { kind: 'added', exerciseId: 'deadlift', targets: 'open', rest: null, follows: 'barbell-row' },
  ]);
});

// A weight is read in the account's own unit, here as everywhere: the diff is a reading, not a
// field, so a lifter in pounds decides on the numbers their log speaks in.
test('diffRows — the weights move with the unit the account reads in', () => {
  spellWeightsIn(LB);
  const rows = diffRows(proposal());
  assert.deepEqual(rows[0].moves, [
    { field: 'sets', from: '5 × 5', to: '5 × 3' },
    { field: 'weight', from: '181.9', to: '192.9' },
  ]);
  spellWeightsIn(KG);
});

// YOUR LOGGED SETS ARE NEVER PART OF A PROPOSAL. A removed line stops the routine asking for the
// movement and the log keeps every set of it — the count says so out loud. A zero is a real answer
// and gets words rather than "0 logged sets kept", and a proposal that carried no count at all is
// given none: a sentence invented here would be a claim about a lifter's history.
test('logKeptLabel — what a removed line takes with it, which is nothing', () => {
  assert.equal(logKeptLabel(41), '41 logged sets kept');
  assert.equal(logKeptLabel(1), '1 logged set kept');
  assert.equal(logKeptLabel(0), 'nothing logged against it yet');
  assert.equal(logKeptLabel(undefined), null);
  assert.equal(logKeptLabel(null), null);
});

// FOUR STATES AND NOT CANON'S THREE. `superseded` is what a proposal becomes when the routine moves
// under it — the human's own hand saved Push A first — and drawing that as "Dismissed" would say a
// lifter turned down something they never saw.
test('stateChip — every state the wire has says its own word', () => {
  assert.equal(stateChip(proposal()), 'Pending');
  assert.equal(stateChip(proposal({ state: 'applied' })), 'Applied');
  assert.equal(stateChip(proposal({ state: 'dismissed' })), 'Dismissed');
  assert.equal(stateChip(proposal({ state: 'superseded' })), 'Superseded');
  assert.equal(stateChip({}), null);
  assert.equal(isPending(proposal()), true);
  assert.equal(isPending(proposal({ state: 'applied' })), false);
  assert.equal(isPending(proposal({ state: 'superseded' })), false);
});

// A SETTLED PROPOSAL STAYS, with the instant it was settled at. All three end the same way: the
// record is kept on the routine, because an agent's suggestion is part of the program's history and
// not a toast that disappeared.
test('settledLine — applied, dismissed and superseded each say what happened and that it stays', () => {
  assert.equal(
    settledLine(proposal({ state: 'applied', settledAt: SETTLED_AT }), READ_AT),
    'Applied to Push A today at 07:12. Kept on the routine as a dated record — the program’s history, not a toast that disappears.',
  );
  assert.equal(
    settledLine(proposal({ state: 'dismissed', settledAt: SETTLED_AT }), READ_AT),
    'Dismissed today at 07:12. No reason asked for, nothing changed, and it stays in the routine’s history in case you want it back.',
  );
  assert.equal(
    settledLine(proposal({ state: 'superseded', settledAt: SETTLED_AT }), READ_AT),
    'Push A changed today at 07:12, after this was written. Nothing from it was applied, and it stays in the routine’s history.',
  );
  // A record read a week later is still dated rather than relative-to-nothing.
  assert.equal(
    settledLine(proposal({ state: 'applied', settledAt: SETTLED_AT }), READ_AT + 5 * 86_400_000),
    'Applied to Push A 5 days ago at 07:12. Kept on the routine as a dated record — the program’s history, not a toast that disappears.',
  );
  assert.equal(settledLine(proposal(), READ_AT), null);
});

// "A change appeared in my Tuesday and I cannot tell whether it was my Claude or Windmill's coach"
// is the exact failure `source` exists to prevent — so an unnamed agent is named as far as is true.
// The transport carries no connection identity today, which is why the fallback is the common case
// rather than the edge one.
test('sourceLabel — who wrote it, and never a blank where a name should be', () => {
  assert.equal(sourceLabel({ door: 'mcp', agent: 'Claude Code' }), 'Claude Code');
  assert.equal(sourceLabel({ door: 'mcp' }), UNNAMED_AGENT);
  assert.equal(sourceLabel({ door: 'mcp', agent: '' }), UNNAMED_AGENT);
  assert.equal(sourceLabel({ door: 'ask' }), 'Ask');
  assert.equal(sourceLabel(undefined), UNNAMED_AGENT);
  assert.equal(UNNAMED_AGENT, 'your connected agent');
});

// AND WHERE IT WAS ASKED FOR (§O), which is a door and not a sentence — offered only where the wire
// carried a thread. Two ways it is absent and both are ordinary: the MCP door, where there was never
// a conversation, and a conversation the lifter deleted, which takes the messages and leaves the
// change. Neither is a fault to explain, so the door simply is not drawn.
test('conversationOf — the thread behind a diff, and nothing at all when there is none', () => {
  assert.equal(conversationOf({ door: 'ask', thread: 'thr_0a1b2c3d4e5f6071' }), 'thr_0a1b2c3d4e5f6071');
  assert.equal(conversationOf({ door: 'ask' }), null);
  assert.equal(conversationOf({ door: 'mcp', agent: 'Claude Code' }), null);
  assert.equal(conversationOf(undefined), null);
  // The row still names the door either way: the change came from Ask whether or not the
  // conversation about it still exists.
  assert.equal(sourceLabel({ door: 'ask' }), 'Ask');
  assert.equal(CONVERSATION_VERB, 'Open the conversation');
});

// The card's own two lines. An empty summary is a real reply — the wire always sends the field and
// it may be empty — and the count and the routine are the fact under the prose.
test('summaryLine and reviewLabel — the card says what is waiting, with or without the agent’s prose', () => {
  assert.equal(
    summaryLine(proposal(), 'Push A'),
    'Four weeks of heavier bench triples, incline work in place of flies. Everything else unchanged.',
  );
  assert.equal(summaryLine(proposal({ summary: '' }), 'Push A'), '4 changes to Push A.');
  assert.equal(summaryLine(proposal({ summary: '   ' }), 'Push A'), '4 changes to Push A.');
  assert.equal(summaryLine(proposal({ summary: '', changeCount: 1 }), 'Push A'), '1 change to Push A.');
  assert.equal(reviewLabel(proposal()), 'Review 4 changes');
  assert.equal(reviewLabel(proposal({ changeCount: 1 })), 'Review 1 change');
  assert.equal(changeLabel(1), '1 change');
  assert.equal(changeLabel(0), '0 changes');
});

// A REMOVAL SAYS WHAT IT IS IN OUR WORDS, not in the agent's. The summary is prose somebody else
// wrote, and a gently worded one over a routine disappearing is exactly the sentence a lifter skims
// — so the consequence is drawn from the intent, always, and the atomic line names the one thing
// that is NOT at risk.
test('a removal names itself on the card, whatever its summary says', () => {
  const removal = proposal({ intent: 'remove', summary: 'Tidying up your program a little.', changeCount: 1 });
  assert.equal(intentLine(removal, 'Push A'), 'Removes Push A from your routines.');
  assert.equal(intentLine(proposal(), 'Push A'), null);
  assert.equal(summaryLine(removal, 'Push A'), 'Tidying up your program a little.');
  assert.equal(summaryLine(proposal({ intent: 'remove', summary: '' }), 'Push A'), 'A proposal to remove Push A.');
  assert.equal(reviewLabel(removal), 'Read the proposal');
  assert.equal(applyLabel(removal), 'Remove Push A');
  // And no line about the run it would leave behind, because it leaves none.
  assert.equal(documentLine(removal), null);
  assert.equal(
    atomicLine(removal),
    'The routine goes and your logged sets stay. Nothing is applied until you tap.',
  );
});

// THE ROUTINE'S HISTORY (canon screen 6). A settled proposal is a dated row on the routine and a
// pending one is in the same list, saying it is still waiting rather than borrowing a verb it has
// not earned — because the routine is where a lifter goes looking for the card they saw on Today.
test('historyLabel — one dated row per proposal, whatever became of it', () => {
  assert.equal(
    historyLabel(proposal({ state: 'applied', settledAt: SETTLED_AT, changeCount: 3 })),
    '3 Aug · applied 3 changes from your connected agent',
  );
  assert.equal(
    historyLabel(proposal({ state: 'dismissed', settledAt: SETTLED_AT, source: { door: 'mcp', agent: 'Claude Code' } })),
    '3 Aug · dismissed 4 changes from Claude Code',
  );
  assert.equal(
    historyLabel(proposal({ state: 'superseded', settledAt: SETTLED_AT })),
    '3 Aug · superseded 4 changes from your connected agent',
  );
  assert.equal(
    historyLabel(proposal()),
    '2 Aug · 4 changes from your connected agent · waiting for you',
  );
  // A removal is one act rather than a count of lines, and the row says so.
  assert.equal(
    historyLabel(proposal({ intent: 'remove', state: 'dismissed', settledAt: SETTLED_AT, changeCount: 1 })),
    '3 Aug · dismissed a removal from your connected agent',
  );
});
