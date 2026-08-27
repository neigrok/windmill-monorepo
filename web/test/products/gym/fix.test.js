import test from 'node:test';
import assert from 'node:assert/strict';

import {
  deletedLine, deleteFailure, fixDraftOf, fixFailure, fixOf, fixSubtitle, isSetNoteOverCap,
  keepsItsOwnNumbers, NO_RPE_LABEL, RPE_MAX, RPE_MIN, RPE_RUNGS, SET_KINDS,
  SET_NOTE_BYTES, SET_NOTE_CAPTION, setNoteCountLabel, SET_NOTE_LABEL, setNoteRefusal, setsAfter,
  showsSetNoteCount, UNDO_MS, withReps, withWeight,
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

test('the draft opens on the set as it stands, every field the sheet can touch and no other', () => {
  assert.deepEqual(fixDraftOf(SET), {
    weightKg: 47.5, reps: 4, kind: 'working', rpe: 8.5, note: 'felt heavy',
  });
  assert.deepEqual(fixOf(SET, fixDraftOf(SET)), {});
  // An unrated set opens on null and an unwritten note on the empty string — what each field draws
  // as absent, and what tells `fixOf` neither was touched.
  const plain = { ...SET, rpe: undefined, note: undefined };
  assert.deepEqual(fixDraftOf(plain), { weightKg: 47.5, reps: 4, kind: 'working', rpe: null, note: '' });
  assert.deepEqual(fixOf(plain, fixDraftOf(plain)), {});
});

test('the weight moves on the logger’s own ladder, which at 47.5 kg is −5 · −2.5 · +2.5 · +5', () => {
  const draft = fixDraftOf(SET);
  assert.deepEqual(ladderLabels(draft.weightKg), ['−5', '−2.5', '+2.5', '+5']);
  const rated = { rpe: 8.5, note: 'felt heavy' };
  assert.deepEqual(withWeight(draft, -1, true), { weightKg: 42.5, reps: 4, kind: 'working', ...rated });
  assert.deepEqual(withWeight(draft, -1, false), { weightKg: 45, reps: 4, kind: 'working', ...rated });
  assert.deepEqual(withWeight(draft, 1, false), { weightKg: 50, reps: 4, kind: 'working', ...rated });
  assert.deepEqual(withWeight(draft, 1, true), { weightKg: 52.5, reps: 4, kind: 'working', ...rated });
});

test('an assisted load steps by magnitude, so the sheet needs no sign to know which way is lighter', () => {
  const assisted = fixDraftOf({ ...SET, weightKg: -20 });
  assert.deepEqual(ladderLabels(assisted.weightKg), ['−5', '−2.5', '+1', '+2.5']);
  const rated = { rpe: 8.5, note: 'felt heavy' };
  assert.deepEqual(withWeight(assisted, 1, false), { weightKg: -19, reps: 4, kind: 'working', ...rated });
  assert.deepEqual(withWeight(assisted, -1, false), { weightKg: -22.5, reps: 4, kind: 'working', ...rated });
});

test('the rep stepper climbs from one and cannot be walked below it', () => {
  const draft = fixDraftOf(SET);
  const rated = { rpe: 8.5, note: 'felt heavy' };
  assert.deepEqual(withReps(draft, 1), { weightKg: 47.5, reps: 5, kind: 'working', ...rated });
  assert.deepEqual(withReps({ ...draft, reps: 1 }, -1), { weightKg: 47.5, reps: 1, kind: 'working', ...rated });
  assert.deepEqual(withReps({ ...draft, reps: 0 }, -1), { weightKg: 47.5, reps: 1, kind: 'working', ...rated });
});

test('a fix carries the fields that moved and nothing else', () => {
  const held = { rpe: 8.5, note: 'felt heavy' };
  assert.deepEqual(fixOf(SET, { weightKg: 50, reps: 4, kind: 'working', ...held }), { weightKg: 50 });
  assert.deepEqual(fixOf(SET, { weightKg: 47.5, reps: 5, kind: 'working', ...held }), { reps: 5 });
  assert.deepEqual(fixOf(SET, { weightKg: 47.5, reps: 4, kind: 'drop', ...held }), { kind: 'drop' });
  assert.deepEqual(
    fixOf(SET, { weightKg: 42.5, reps: 6, kind: 'warmup', ...held }),
    { weightKg: 42.5, reps: 6, kind: 'warmup' },
  );
  assert.deepEqual(SET_KINDS, ['warmup', 'working', 'drop', 'failure']);
});

test('clearing an rpe or a note is NAMED, and a field nobody touched is not named at all', () => {
  const draft = fixDraftOf(SET);
  // Named null clears an rpe; named empty clears a note. The store reads exactly that.
  assert.deepEqual(fixOf(SET, { ...draft, rpe: null }), { rpe: null });
  assert.deepEqual(fixOf(SET, { ...draft, note: '' }), { note: '' });
  assert.deepEqual(fixOf(SET, { ...draft, rpe: null, note: '' }), { rpe: null, note: '' });
  assert.deepEqual(fixOf(SET, { ...draft, rpe: 9 }), { rpe: 9 });
  assert.deepEqual(fixOf(SET, { ...draft, note: 'easy' }), { note: 'easy' });
  // A set that never had either: the two absences are the draft's own, so nothing is named — an
  // empty note sent as `""` would clear a note on another device that wrote one since.
  const plain = { ...SET, rpe: undefined, note: undefined };
  assert.deepEqual(fixOf(plain, fixDraftOf(plain)), {});
  assert.deepEqual(fixOf(plain, { ...fixDraftOf(plain), reps: 6 }), { reps: 6 });
  // The wire carries the key: an absent field and a null one are different documents.
  assert.equal(JSON.stringify(fixOf(SET, { ...draft, rpe: null })), '{"rpe":null}');
  assert.equal(JSON.stringify(fixOf(SET, { ...draft, note: '' })), '{"note":""}');
});

test('the rpe band is six to ten by halves, counted off the band and led by no rating at all', () => {
  assert.equal(RPE_MIN, 6);
  assert.equal(RPE_MAX, 10);
  assert.deepEqual(RPE_RUNGS, [6, 6.5, 7, 7.5, 8, 8.5, 9, 9.5, 10]);
  // The seat wears words and not a dash: a dash has nothing for a screen reader to read out.
  assert.equal(NO_RPE_LABEL, 'Not rated');
});

test('a set note is a record, said so under the field, and refused here because the store’s reply cannot say why', () => {
  assert.equal(SET_NOTE_LABEL, 'Set note');
  assert.equal(SET_NOTE_CAPTION, 'A record for you — not an instruction to Coach.');
  assert.equal(SET_NOTE_BYTES, 4000);
  // Bytes, not characters: an em dash is three of them, which is the trap the name cap already met.
  assert.equal(setNoteRefusal('felt heavy'), null);
  assert.equal(setNoteRefusal(''), null);
  assert.equal(setNoteRefusal('a'.repeat(SET_NOTE_BYTES)), null);
  assert.equal(setNoteRefusal('a'.repeat(SET_NOTE_BYTES + 1)), 'A set note runs to 4000 bytes.');
  assert.equal(setNoteRefusal('—'.repeat(SET_NOTE_BYTES / 3)), null);
  assert.notEqual(setNoteRefusal('—'.repeat(SET_NOTE_BYTES / 3 + 1)), null);
  // The counter is chrome a short note does not need: the last fifth of the bound, the rule the
  // name and the note body already read.
  assert.equal(showsSetNoteCount('felt heavy'), false);
  assert.equal(showsSetNoteCount('a'.repeat(3199)), false);
  assert.equal(showsSetNoteCount('a'.repeat(3200)), true);
  assert.equal(setNoteCountLabel('a'.repeat(3200)), '3200 of 4000 bytes');
  assert.equal(setNoteCountLabel('—'), '3 of 4000 bytes');
  // Past the bound the counter goes alarm, the way every byte counter in this room does. The ink and
  // the refusal read ONE predicate, so a quiet counter under a refusing sentence is unreachable.
  assert.equal(isSetNoteOverCap(''), false);
  assert.equal(isSetNoteOverCap('felt heavy'), false);
  assert.equal(isSetNoteOverCap('a'.repeat(SET_NOTE_BYTES)), false);
  assert.equal(isSetNoteOverCap('a'.repeat(SET_NOTE_BYTES + 1)), true);
  assert.equal(isSetNoteOverCap('—'.repeat(SET_NOTE_BYTES / 3)), false);
  assert.equal(isSetNoteOverCap('—'.repeat(SET_NOTE_BYTES / 3 + 1)), true);
  for (const note of ['', 'felt heavy', 'a'.repeat(4000), 'a'.repeat(4001), '—'.repeat(1334)]) {
    assert.equal(isSetNoteOverCap(note), setNoteRefusal(note) !== null);
  }
});

test('a weight that only differs below the grid has not moved', () => {
  const set = { ...SET, weightKg: 47.502 };
  assert.deepEqual(fixOf(set, fixDraftOf(set)), {});
  assert.deepEqual(fixOf(set, { ...fixDraftOf(set), weightKg: 47.5 }), {});
});

test('a set that reached the sheet with no weight at all is still not reported as moved', () => {
  const weightless = { ...SET, weightKg: undefined };
  assert.deepEqual(fixOf(weightless, fixDraftOf(weightless)), {});
  assert.deepEqual(
    fixOf(weightless, { ...fixDraftOf(weightless), reps: 6, kind: 'drop' }),
    { reps: 6, kind: 'drop' },
  );
});

test('an rpe the sheet has no seat for is left exactly where it stood', () => {
  // The store's band is 1–10 and the sheet's is 6–10 by halves, so a set rated 5 by another client
  // draws no selected seat. Untouched, it is not named on the wire and the rating survives.
  const odd = { ...SET, rpe: 5 };
  assert.equal(fixDraftOf(odd).rpe, 5);
  assert.equal(RPE_RUNGS.includes(5), false);
  assert.deepEqual(fixOf(odd, fixDraftOf(odd)), {});
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

test('the delete says which set left, in the log’s own spelling', () => {
  assert.equal(deletedLine(SET), '47.5 × 4 is out of the log.');
  assert.equal(deletedLine({ ...SET, weightKg: 0, reps: 9 }), 'bodyweight × 9 is out of the log.');
  assert.equal(deletedLine({ ...SET, weightKg: -20, reps: 6 }), '−20 × 6 is out of the log.');
  assert.equal(UNDO_MS, 9000);
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

test('a correction moves nothing around it, and a deleted set is not a move at all', () => {
  const sets = [{ ...SET, id: 'set_1', setNumber: 1 }, { ...SET, id: 'set_2', setNumber: 2 }, SET];
  const corrected = { ...sets[1], weightKg: 50 };
  assert.deepEqual(setsAfter(sets, new Map([['set_2', corrected]])), [sets[0], corrected, sets[2]]);
  // A delete never lands here in any form: the room knows what its window holds and what the store
  // has answered for, and it outlives this screen. A screen keeping its own copy of that fact is
  // how a delete came back on screen after it had really gone.
  assert.deepEqual(setsAfter(sets, new Map()), sets);
});
