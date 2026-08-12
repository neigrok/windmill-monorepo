// FIXING A SET, without a browser — the draft the sheet opens on, the document it sends, and what
// the session looks like around a set that moved. The two rules that matter most here are the ones
// a lifter would pay for if they broke: a fix carries ONLY what changed, so the rpe and the note
// the sheet never draws are not quietly rewritten by it; and a withheld delete takes a set off the
// screen without anything being destroyed, so the take-back is exact.

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
  // Opened and saved untouched, the fix is empty: the sheet closing is the whole of what happens.
  assert.deepEqual(fixOf(SET, fixDraftOf(SET)), {});
});

// THE LADDER IS THE ONE THAT EXISTS. At 47.5 kg the row reads −5 · −2.5 · +2.5 · +5 (§G18), and
// every step the sheet takes is `bump`'s — a second table here would drift from the phones' golden.
test('the weight moves on the logger’s own ladder, which at 47.5 kg is −5 · −2.5 · +2.5 · +5', () => {
  const draft = fixDraftOf(SET);
  assert.deepEqual(ladderLabels(draft.weightKg), ['−5', '−2.5', '+2.5', '+5']);
  assert.deepEqual(withWeight(draft, -1, true), { weightKg: 42.5, reps: 4, kind: 'working' });
  assert.deepEqual(withWeight(draft, -1, false), { weightKg: 45, reps: 4, kind: 'working' });
  assert.deepEqual(withWeight(draft, 1, false), { weightKg: 50, reps: 4, kind: 'working' });
  assert.deepEqual(withWeight(draft, 1, true), { weightKg: 52.5, reps: 4, kind: 'working' });
});

// A band-assisted load is a point on the number line and never a mode, so the ladder mirrors on it
// here exactly as it does under the logger's thumb.
test('an assisted load steps by magnitude, so the sheet needs no sign to know which way is lighter', () => {
  const assisted = fixDraftOf({ ...SET, weightKg: -20 });
  assert.deepEqual(ladderLabels(assisted.weightKg), ['−5', '−2.5', '+1', '+2.5']);
  assert.deepEqual(withWeight(assisted, 1, false), { weightKg: -19, reps: 4, kind: 'working' });
  assert.deepEqual(withWeight(assisted, -1, false), { weightKg: -22.5, reps: 4, kind: 'working' });
});

// The floor is a CLAMP INTO the range and never a hold at the value — the store refuses reps < 1,
// and the stepper must never be the thing preserving a number the log can only refuse.
test('the rep stepper climbs from one and cannot be walked below it', () => {
  const draft = fixDraftOf(SET);
  assert.deepEqual(withReps(draft, 1), { weightKg: 47.5, reps: 5, kind: 'working' });
  assert.deepEqual(withReps({ ...draft, reps: 1 }, -1), { weightKg: 47.5, reps: 1, kind: 'working' });
  assert.deepEqual(withReps({ ...draft, reps: 0 }, -1), { weightKg: 47.5, reps: 1, kind: 'working' });
});

// ONLY WHAT MOVED. `rpe` and `note` are on the wire and are not on this sheet, so the one thing
// that must never happen is a fix that carries them — an omitted field is left as stored, and a
// client sending the whole set back would rewrite two fields it never showed anybody.
test('a fix carries the fields that moved and nothing else — never the rpe, never the note', () => {
  assert.deepEqual(fixOf(SET, { weightKg: 50, reps: 4, kind: 'working' }), { weightKg: 50 });
  assert.deepEqual(fixOf(SET, { weightKg: 47.5, reps: 5, kind: 'working' }), { reps: 5 });
  assert.deepEqual(fixOf(SET, { weightKg: 47.5, reps: 4, kind: 'drop' }), { kind: 'drop' });
  assert.deepEqual(
    fixOf(SET, { weightKg: 42.5, reps: 6, kind: 'warmup' }),
    { weightKg: 42.5, reps: 6, kind: 'warmup' },
  );
  // The four the store knows, in the order the control draws them.
  assert.deepEqual(SET_KINDS, ['warmup', 'working', 'drop', 'failure']);
});

// A stored weight and a drafted one are spelled on the same grid, so a set the store holds at a
// value the ladder would round is not reported as moved by the act of opening the sheet.
test('a weight that only differs below the grid has not moved', () => {
  assert.deepEqual(fixOf({ ...SET, weightKg: 47.502 }, fixDraftOf({ ...SET, weightKg: 47.502 })), {});
  assert.deepEqual(fixOf({ ...SET, weightKg: 47.502 }, { weightKg: 47.5, reps: 4, kind: 'working' }), {});
});

// THE PROMISE HOLDS FOR THE INPUT THAT WOULD BREAK IT. A set that arrived with no weight at all
// spells NaN on both sides of the comparison, and NaN is the one value `!==` reports as different
// from itself — so the fix would carry `weightKg: null` for a Save that touched nothing, on the one
// module whose whole promise is that only what moved goes over the wire. No store can send such a
// set today (`gym_sets.weight_kg` is NOT NULL), which is exactly why the case is worth a test rather
// than a hope.
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

// THE CAPTION OF THE WHOLE SCREEN: the log moves and the routine does not. A session run against no
// routine has no program to reassure anybody about, and the line is not widened into a claim about
// the rest of the log — the tonnage, the top e1RM and the records all DO move with the set.
test('the line beside Delete names the routine, and says nothing at all when there is none', () => {
  assert.equal(keepsItsOwnNumbers(SESSION), 'Push A keeps its own numbers');
  assert.equal(keepsItsOwnNumbers({ ...SESSION, plan: null }), null);
  assert.equal(keepsItsOwnNumbers({ ...SESSION, plan: { entries: [] } }), null);
});

// The toast names WHICH set, because the row it stood on has just left the screen — and it promises
// nothing beyond the Undo standing beside it for as long as the write is withheld.
test('the delete says which set left, in the log’s own spelling, and promises no recovery', () => {
  assert.equal(deletedLine(SET), '47.5 × 4 is out of the log.');
  assert.equal(deletedLine({ ...SET, weightKg: 0, reps: 9 }), 'bodyweight × 9 is out of the log.');
  assert.equal(deletedLine({ ...SET, weightKg: -20, reps: 6 }), '−20 × 6 is out of the log.');
  assert.equal(UNDO_MS, 5000);
});

// EVERY REFUSAL IS READ OFF THE CODE. A 404 on this route is neither the log failing to answer nor
// a document it would not take, so it gets its own sentence rather than one of `failureReason`'s
// two — both of which would be false.
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
  // The delete has no 400 and no 404 at all, so there is one other sentence and it leads with what
  // is still true: the set is in the log, and it is back on the screen by the time this is read.
  assert.equal(
    deleteFailure(new GymError(500, '')),
    'That set is still in the log — the log didn’t answer. Try again when you have signal.',
  );
});

// The corrected set is substituted IN PLACE, which is what makes the header's working count, the
// tonnage and every plan note agree with the fix in the same render as the row does.
test('a corrected set replaces the one it corrects, in the order it already stood in', () => {
  const sets = [{ ...SET, id: 'set_1', setNumber: 1 }, { ...SET, id: 'set_2', setNumber: 2 }, SET];
  const stored = { ...SET, weightKg: 50, reps: 5 };
  assert.deepEqual(setsAfter(sets, new Map([['set_3', stored]])), [sets[0], sets[1], stored]);
  assert.deepEqual(setsAfter(sets, new Map()), sets);
});

// A WITHHELD DELETE IS A NULL, and nothing has happened to the store yet — which is the whole
// reason the take-back can be exact rather than a re-post landing at the bottom of the movement.
test('a set withheld for deletion leaves the screen and the ones around it do not move', () => {
  const sets = [{ ...SET, id: 'set_1', setNumber: 1 }, { ...SET, id: 'set_2', setNumber: 2 }, SET];
  assert.deepEqual(setsAfter(sets, new Map([['set_2', null]])), [sets[0], sets[2]]);
  // Undo puts back the set that was withheld, whole — including a correction made before it.
  const corrected = { ...sets[1], weightKg: 50 };
  assert.deepEqual(setsAfter(sets, new Map([['set_2', corrected]])), [sets[0], corrected, sets[2]]);
});

// THE READ IS THE NEWER ANSWER. The session is read again only because the log moved underneath the
// screen — another device wrote, or the row being corrected is not there any more — and the store is
// where every correction in hand already landed, so keeping them would substitute a stale row over
// the read that was taken to replace it. A withheld delete is the opposite case: nothing has been
// sent for it, every read carries that row back, and it has to stay off the screen for the rest of
// its five seconds or the take-back is offered on a row the lifter can see.
test('a session read again lets the corrections go and keeps the withheld deletes', () => {
  const moves = new Map([
    ['set_1', { ...SET, id: 'set_1', weightKg: 50 }],
    ['set_2', null],
    ['set_3', { ...SET, weightKg: 42.5 }],
  ]);
  assert.deepEqual([...movesAfterRead(moves)], [['set_2', null]]);
  // The map handed in is not touched: it is the state the screen is still rendering from.
  assert.deepEqual([...moves.keys()], ['set_1', 'set_2', 'set_3']);
  assert.deepEqual([...movesAfterRead(new Map())], []);
});
