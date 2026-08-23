import test from 'node:test';
import assert from 'node:assert/strict';

import {
  deletedLine, deleteFailure, fixDraftOf, fixFailure, fixOf, fixSubtitle, keepsItsOwnNumbers,
  movesAfterRead, SET_KINDS, setsAfter, UNDO_MS, withReps, withWeight,
} from '../../../src/products/gym/fix.js';
import { GymError } from '../../../src/products/gym/gymApi.js';
import { ladderLabels } from '../../../src/products/gym/logger/ladder.js';

const SET = {
  id: 'set_3', exerciseId: 'overhead-press', setNumber: 3, weightKg: 47.5, reps: 4,
  kind: 'working', rpe: 8.5, note: 'felt heavy', completedAt: 1_900_000_300_000,
};

const SESSION = {
  id: 'ses_1',
  startedAt: 1_900_000_000_000,
  finishedAt: 1_900_003_600_000,
  plan: { routine: 'Push A', entries: [{ exerciseId: 'overhead-press', sets: 5, reps: 5, weightKg: 45 }] },
};

test('the draft opens on the set as it stands, and nothing else about the set travels with it', () => {
  assert.deepEqual(fixDraftOf(SET), { weightKg: 47.5, reps: 4, kind: 'working' });
  assert.deepEqual(fixOf(SET, fixDraftOf(SET)), {});
});

test('the weight moves on the logger’s own ladder, which at 47.5 kg is −5 · −2.5 · +2.5 · +5', () => {
  const draft = fixDraftOf(SET);
  assert.deepEqual(ladderLabels(draft.weightKg), ['−5', '−2.5', '+2.5', '+5']);
  assert.deepEqual(withWeight(draft, -1, true), { weightKg: 42.5, reps: 4, kind: 'working' });
  assert.deepEqual(withWeight(draft, -1, false), { weightKg: 45, reps: 4, kind: 'working' });
  assert.deepEqual(withWeight(draft, 1, false), { weightKg: 50, reps: 4, kind: 'working' });
  assert.deepEqual(withWeight(draft, 1, true), { weightKg: 52.5, reps: 4, kind: 'working' });
});

test('an assisted load steps by magnitude, so the sheet needs no sign to know which way is lighter', () => {
  const assisted = fixDraftOf({ ...SET, weightKg: -20 });
  assert.deepEqual(ladderLabels(assisted.weightKg), ['−5', '−2.5', '+1', '+2.5']);
  assert.deepEqual(withWeight(assisted, 1, false), { weightKg: -19, reps: 4, kind: 'working' });
  assert.deepEqual(withWeight(assisted, -1, false), { weightKg: -22.5, reps: 4, kind: 'working' });
});

test('the rep stepper climbs from one and cannot be walked below it', () => {
  const draft = fixDraftOf(SET);
  assert.deepEqual(withReps(draft, 1), { weightKg: 47.5, reps: 5, kind: 'working' });
  assert.deepEqual(withReps({ ...draft, reps: 1 }, -1), { weightKg: 47.5, reps: 1, kind: 'working' });
  assert.deepEqual(withReps({ ...draft, reps: 0 }, -1), { weightKg: 47.5, reps: 1, kind: 'working' });
});

test('a fix carries the fields that moved and nothing else — never the rpe, never the note', () => {
  assert.deepEqual(fixOf(SET, { weightKg: 50, reps: 4, kind: 'working' }), { weightKg: 50 });
  assert.deepEqual(fixOf(SET, { weightKg: 47.5, reps: 5, kind: 'working' }), { reps: 5 });
  assert.deepEqual(fixOf(SET, { weightKg: 47.5, reps: 4, kind: 'drop' }), { kind: 'drop' });
  assert.deepEqual(
    fixOf(SET, { weightKg: 42.5, reps: 6, kind: 'warmup' }),
    { weightKg: 42.5, reps: 6, kind: 'warmup' },
  );
  assert.deepEqual(SET_KINDS, ['warmup', 'working', 'drop', 'failure']);
});

test('a weight that only differs below the grid has not moved', () => {
  assert.deepEqual(fixOf({ ...SET, weightKg: 47.502 }, fixDraftOf({ ...SET, weightKg: 47.502 })), {});
  assert.deepEqual(fixOf({ ...SET, weightKg: 47.502 }, { weightKg: 47.5, reps: 4, kind: 'working' }), {});
});

test('a set that reached the sheet with no weight at all is still not reported as moved', () => {
  const weightless = { ...SET, weightKg: undefined };
  assert.deepEqual(fixOf(weightless, fixDraftOf(weightless)), {});
  assert.deepEqual(
    fixOf(weightless, { ...fixDraftOf(weightless), reps: 6, kind: 'drop' }),
    { reps: 6, kind: 'drop' },
  );
});

test('the sheet names the set it is over, and a set the store never numbered is named by its movement', () => {
  assert.equal(fixSubtitle('Overhead Press', SET), 'Overhead Press · set 3');
  assert.equal(fixSubtitle('Overhead Press', { ...SET, setNumber: undefined }), 'Overhead Press');
});

test('the line beside Delete names the routine, and says nothing at all when there is none', () => {
  assert.equal(keepsItsOwnNumbers(SESSION), 'Push A keeps its own numbers');
  assert.equal(keepsItsOwnNumbers({ ...SESSION, plan: null }), null);
  assert.equal(keepsItsOwnNumbers({ ...SESSION, plan: { entries: [] } }), null);
});

test('the delete says which set left, in the log’s own spelling, and promises no recovery', () => {
  assert.equal(deletedLine(SET), '47.5 × 4 is out of the log.');
  assert.equal(deletedLine({ ...SET, weightKg: 0, reps: 9 }), 'bodyweight × 9 is out of the log.');
  assert.equal(deletedLine({ ...SET, weightKg: -20, reps: 6 }), '−20 × 6 is out of the log.');
  assert.equal(UNDO_MS, 5000);
});

test('a refused fix is spoken by its code, and the missing set is not blamed on the network', () => {
  assert.equal(
    fixFailure(new GymError(404, 'no such set', 'set-not-found')),
    'That set isn’t in this workout any more.',
  );
  assert.equal(
    fixFailure(new GymError(400, 'could not read that fix', 'fix-unreadable')),
    'That fix didn’t land — the log wouldn’t take it as written.',
  );
  assert.equal(
    fixFailure(new GymError(500, '')),
    'That fix didn’t land — the log didn’t answer. Try again when you have signal.',
  );
  assert.equal(
    deleteFailure(new GymError(500, '')),
    'That set is still in the log — the log didn’t answer. Try again when you have signal.',
  );
});

test('a corrected set replaces the one it corrects, in the order it already stood in', () => {
  const sets = [{ ...SET, id: 'set_1', setNumber: 1 }, { ...SET, id: 'set_2', setNumber: 2 }, SET];
  const stored = { ...SET, weightKg: 50, reps: 5 };
  assert.deepEqual(setsAfter(sets, new Map([['set_3', stored]])), [sets[0], sets[1], stored]);
  assert.deepEqual(setsAfter(sets, new Map()), sets);
});

test('a set withheld for deletion leaves the screen and the ones around it do not move', () => {
  const sets = [{ ...SET, id: 'set_1', setNumber: 1 }, { ...SET, id: 'set_2', setNumber: 2 }, SET];
  assert.deepEqual(setsAfter(sets, new Map([['set_2', null]])), [sets[0], sets[2]]);
  const corrected = { ...sets[1], weightKg: 50 };
  assert.deepEqual(setsAfter(sets, new Map([['set_2', corrected]])), [sets[0], corrected, sets[2]]);
});

test('a session read again lets the corrections go and keeps the withheld deletes', () => {
  const moves = new Map([
    ['set_1', { ...SET, id: 'set_1', weightKg: 50 }],
    ['set_2', null],
    ['set_3', { ...SET, weightKg: 42.5 }],
  ]);
  assert.deepEqual([...movesAfterRead(moves)], [['set_2', null]]);
  assert.deepEqual([...moves.keys()], ['set_1', 'set_2', 'set_3']);
  assert.deepEqual([...movesAfterRead(new Map())], []);
});
