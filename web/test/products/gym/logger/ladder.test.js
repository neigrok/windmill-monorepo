// THE LADDER, pinned at every boundary. Lift pasted this rule into three targets and let them
// drift; the table below is the design canon's own worked cases, and it is the only thing standing
// between a lifter and a phone that adds the wrong plate.

import test from 'node:test';
import assert from 'node:assert/strict';

import { bump, bumpReps, ladderLabels, round, steps } from '../../../../src/products/gym/logger/ladder.js';

test('steps — three bands, read off the magnitude so the negative side behaves identically', () => {
  assert.deepEqual(steps(0), [1, 5]);
  assert.deepEqual(steps(19.999), [1, 5]);
  assert.deepEqual(steps(20), [2, 5]);
  assert.deepEqual(steps(49.999), [2, 5]);
  assert.deepEqual(steps(50), [5, 10]);
  assert.deepEqual(steps(500), [5, 10]);
  assert.deepEqual(steps(-19.999), [1, 5]);
  assert.deepEqual(steps(-20), [2, 5]);
  assert.deepEqual(steps(-49.999), [2, 5]);
  assert.deepEqual(steps(-50), [5, 10]);
});

test('ladderLabels — the four buttons re-derive themselves, minus sign and all', () => {
  assert.deepEqual(ladderLabels(17.5), ['−5', '−1', '+1', '+5']);
  assert.deepEqual(ladderLabels(19.999), ['−5', '−1', '+1', '+5']);
  assert.deepEqual(ladderLabels(20), ['−5', '−1', '+2', '+5']);
  assert.deepEqual(ladderLabels(50), ['−5', '−2', '+5', '+10']);
  assert.deepEqual(ladderLabels(60), ['−10', '−5', '+5', '+10']);
  assert.deepEqual(ladderLabels(102.5), ['−10', '−5', '+5', '+10']);
  assert.deepEqual(ladderLabels(0), ['−5', '−1', '+1', '+5']);
  assert.deepEqual(ladderLabels(-20), ['−5', '−2', '+2', '+5']);
  assert.equal(ladderLabels(20)[0].charCodeAt(0), 0x2212);
});

// The asymmetry at 20 kg is the visible proof that the down-step respects the band you are
// leaving: the row reads −5 · −1 · +2 · +5, and stepping down lands on 19 rather than 18.
test('bump — the down-step is evaluated just below the current weight', () => {
  assert.equal(bump(20, -1, false), 19);
  assert.equal(bump(20, -1, true), 15);
  assert.equal(bump(20, 1, false), 22);
  assert.equal(bump(20, 1, true), 25);

  assert.equal(bump(50, -1, false), 48);
  assert.equal(bump(50, -1, true), 45);
  assert.equal(bump(50, 1, false), 55);
  assert.equal(bump(50, 1, true), 60);

  assert.equal(bump(17.5, -1, false), 16.5);
  assert.equal(bump(17.5, 1, true), 22.5);
  assert.equal(bump(60, -1, false), 55);
  assert.equal(bump(102.5, -1, false), 97.5);
  assert.equal(bump(102.5, 1, true), 112.5);
});

// A chin-up logs at 0 kg and a band-assisted pull-up at −20: the sign is data, never a mode, so
// the ladder walks straight through zero without a toggle in sight.
test('bump — zero and the negative side are ordinary points on the number line', () => {
  assert.equal(bump(0, -1, false), -1);
  assert.equal(bump(0, -1, true), -5);
  assert.equal(bump(0, 1, false), 1);
  assert.equal(bump(-20, -1, false), -22);
  assert.equal(bump(-20, -1, true), -25);
  assert.equal(bump(-20, 1, false), -18);
  assert.equal(bump(-20, 1, true), -15);
  assert.equal(bump(-1, 1, false), 0);
  assert.equal(bump(-50, -1, false), -55);
  assert.equal(bump(-50, 1, false), -45);
});

// The buttons do not clamp — only typed entry is bounded. A step off the top is the lifter's to
// take back with the button beside it.
test('bump — the step buttons never clamp, and every result is stored to two decimals', () => {
  assert.equal(bump(500, 1, true), 510);
  assert.equal(bump(-500, -1, true), -510);
  assert.equal(round(18.999000000000002), 19);
  assert.equal(bump(19.999, -1, false), 19);
  assert.equal(bump(0.5, -1, false), -0.5);
  assert.equal(round(102.505), 102.51);
  assert.equal(round(-0.001), -0);
});

test('bumpReps — floored at zero on the way down, unbounded from the button on the way up', () => {
  assert.equal(bumpReps(5, -1), 4);
  assert.equal(bumpReps(1, -1), 0);
  assert.equal(bumpReps(0, -1), 0);
  assert.equal(bumpReps(5, 1), 6);
  assert.equal(bumpReps(99, 1), 100);
});
