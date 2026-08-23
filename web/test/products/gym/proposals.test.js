import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyLabel, atomicLine, changeLabel, diffRows, documentLine, historyLabel, intentLine, isPending,
  conversationOf, CONVERSATION_VERB,
  logKeptLabel, reviewLabel, settledLine, sourceLabel, stateChip, summaryLine, UNNAMED_AGENT,
} from '../../../src/products/gym/proposals.js';
import { KG, LB, spellWeightsIn } from '../../../src/products/gym/units.js';

spellWeightsIn(KG);

const CREATED_AT = new Date(2026, 7, 2, 21, 14).getTime();
const SETTLED_AT = new Date(2026, 7, 3, 7, 12).getTime();
const READ_AT = new Date(2026, 7, 3, 9, 41).getTime();

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

test('diffRows — the marked rows are exactly what the store counted under Apply', () => {
  const document = proposal();
  const marked = diffRows(document).filter((row) => row.kind !== 'kept');
  assert.equal(marked.length, document.changeCount);
  assert.equal(applyLabel(document), 'Apply all 4');
  assert.equal(atomicLine(document), 'All four or none. Nothing is applied until you tap.');
});

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
  assert.equal(rows.filter((row) => row.kind !== 'kept').length, reordered.changeCount);
  assert.equal(applyLabel(reordered), 'Apply all 1');
});

test('diffRows — a reorder the store counted is a row of its own, so the count under Apply is honest', () => {
  const swapped = proposal({
    changeCount: 2,
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
  const rows = diffRows(swapped);
  assert.deepEqual(rows, [
    { kind: 'reordered' },
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
  assert.equal(rows.filter((row) => row.kind !== 'kept').length, swapped.changeCount);
  assert.equal(applyLabel(swapped), 'Apply all 2');

  const both = proposal({ name: 'Push B', changeCount: 3, changes: swapped.changes });
  const bothRows = diffRows(both);
  assert.deepEqual(bothRows.slice(0, 2), [
    { kind: 'renamed', from: 'Push A', to: 'Push B' },
    { kind: 'reordered' },
  ]);
  assert.equal(bothRows.filter((row) => row.kind !== 'kept').length, both.changeCount);
});

test('diffRows — a renamed routine is a row of the diff, counted like any other change', () => {
  const renamed = proposal({ name: 'Push A — heavy', changeCount: 5 });
  const rows = diffRows(renamed);
  assert.deepEqual(rows[0], { kind: 'renamed', from: 'Push A', to: 'Push A — heavy' });
  assert.equal(rows.filter((row) => row.kind !== 'kept').length, renamed.changeCount);
  assert.equal(atomicLine(renamed), 'All five or none. Nothing is applied until you tap.');
});

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

test('diffRows — the weights move with the unit the account reads in', () => {
  spellWeightsIn(LB);
  const rows = diffRows(proposal());
  assert.deepEqual(rows[0].moves, [
    { field: 'sets', from: '5 × 5', to: '5 × 3' },
    { field: 'weight', from: '181.9', to: '192.9' },
  ]);
  spellWeightsIn(KG);
});

test('logKeptLabel — what a removed line takes with it, which is nothing', () => {
  assert.equal(logKeptLabel(41), '41 logged sets kept');
  assert.equal(logKeptLabel(1), '1 logged set kept');
  assert.equal(logKeptLabel(0), 'nothing logged against it yet');
  assert.equal(logKeptLabel(undefined), null);
  assert.equal(logKeptLabel(null), null);
});

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
  assert.equal(
    settledLine(proposal({ state: 'applied', settledAt: SETTLED_AT }), READ_AT + 5 * 86_400_000),
    'Applied to Push A 5 days ago at 07:12. Kept on the routine as a dated record — the program’s history, not a toast that disappears.',
  );
  assert.equal(settledLine(proposal(), READ_AT), null);
});

test('sourceLabel — who wrote it, and never a blank where a name should be', () => {
  assert.equal(sourceLabel({ door: 'mcp', agent: 'Claude Code' }), 'Claude Code');
  assert.equal(sourceLabel({ door: 'mcp' }), UNNAMED_AGENT);
  assert.equal(sourceLabel({ door: 'mcp', agent: '' }), UNNAMED_AGENT);
  assert.equal(sourceLabel({ door: 'ask' }), 'Ask');
  assert.equal(sourceLabel(undefined), UNNAMED_AGENT);
  assert.equal(UNNAMED_AGENT, 'your connected agent');
});

test('conversationOf — the thread behind a diff, and nothing at all when there is none', () => {
  assert.equal(conversationOf({ door: 'ask', thread: 'thr_0a1b2c3d4e5f6071' }), 'thr_0a1b2c3d4e5f6071');
  assert.equal(conversationOf({ door: 'ask' }), null);
  assert.equal(conversationOf({ door: 'mcp', agent: 'Claude Code' }), null);
  assert.equal(conversationOf(undefined), null);
  assert.equal(sourceLabel({ door: 'ask' }), 'Ask');
  assert.equal(CONVERSATION_VERB, 'Open the conversation');
});

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

test('a removal names itself on the card, whatever its summary says', () => {
  const removal = proposal({ intent: 'remove', summary: 'Tidying up your program a little.', changeCount: 1 });
  assert.equal(intentLine(removal, 'Push A'), 'Removes Push A from your routines.');
  assert.equal(intentLine(proposal(), 'Push A'), null);
  assert.equal(summaryLine(removal, 'Push A'), 'Tidying up your program a little.');
  assert.equal(summaryLine(proposal({ intent: 'remove', summary: '' }), 'Push A'), 'A proposal to remove Push A.');
  assert.equal(reviewLabel(removal), 'Read the proposal');
  assert.equal(applyLabel(removal), 'Remove Push A');
  assert.equal(documentLine(removal), null);
  assert.equal(
    atomicLine(removal),
    'The routine goes and your logged sets stay. Nothing is applied until you tap.',
  );
});

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
  assert.equal(
    historyLabel(proposal({ intent: 'remove', state: 'dismissed', settledAt: SETTLED_AT, changeCount: 1 })),
    '3 Aug · dismissed a removal from your connected agent',
  );
});
