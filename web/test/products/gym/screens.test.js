// TWO REACT-IDENTITY RULES, READ OFF THE SOURCE — because that is the only place this runner can
// read them. `node --test` has no JSX transform, so nothing under test/ can mount a gym screen; the
// rules below are about which component instance React keeps and which list rows it can tell apart,
// and both are decided by one attribute in the tree rather than by anything a pure module returns.
// The behaviour behind them is driven for real against the rendered components in the wave's
// server-render smoke; what is pinned here is the attribute, so removing it fails a test rather
// than only a screenshot nobody takes again.
//
// The same file (test/shell-boundaries.test.mjs) walks every import in src/ the same way, for the
// same reason: some invariants live in the shape of the source and nowhere else.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const GYM = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../src/products/gym');
const read = (file) => fs.readFileSync(path.join(GYM, file), 'utf8');

// A DRAFT MAY NOT OUTLIVE THE DOCUMENT IT IS OF. The editor holds one routine under the lifter's
// hand and nothing reaches the store until Done, so the instance is scoped to the routine id: the
// key is what makes React drop it when the hash moves to another routine. Without it, the editor's
// own Duplicate button — which moves the hash to the copy — left the ORIGINAL's unsaved draft on
// screen under the copy's URL, and Done then whole-document PUT it back onto the original. A
// routine renamed and reprogrammed into another one, with no undo.
test('the routine editor is keyed on the routine it edits, so a hash move remounts it', () => {
  const app = read('GymApp.jsx');
  // The seam, not an effect copying the prop into state: a draft synced out of props still has a
  // frame where the screen holds one routine's edits under another routine's URL.
  assert.equal(app.includes('<RoutineEditor key={routineIdOf(hash)} id={routineIdOf(hash)} live={live} />'), true);
});

// A ROUTINE MAY NAME ONE LIFT TWICE — the heavy line and the back-off line — which is the case
// `(routine_id, position)` exists to make representable. Two rows sharing a React key is a list
// React reconciles however it likes: the rows can swap or one can be dropped, and Today's card
// re-renders on its own when the catalog answers.
test('every list of a routine’s entries is keyed on the position as well as the movement', () => {
  for (const file of ['Today.jsx', 'Routines.jsx']) {
    const source = read(file);
    assert.equal(source.includes('key={`${entry.exerciseId}-${index}`}'), true, file);
    assert.equal(source.includes('key={entry.exerciseId}'), false, file);
  }
});
