// THE LADDER, pinned at every boundary. Lift pasted this rule into three targets and let them
// drift; the table now lives in packages/api-contract/gym-ladder.json — hand-written from the rule,
// read from the repo rather than copied in here, and run as a test by iOS too. It is the only thing
// standing between a lifter and a phone that adds the wrong plate.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { LADDER_KEYS, bump, bumpReps, ladderLabels, round, steps } from '../../../../src/products/gym/logger/ladder.js';

const goldenPath = new URL('../../../../../packages/api-contract/gym-ladder.json', import.meta.url);
const golden = JSON.parse(readFileSync(goldenPath, 'utf8'));

// `under: null` is the top band, open above — JSON has no Infinity to write.
const bands = golden.bands.map((band) => ({ ...band, under: band.under ?? Infinity }));

// A loop over an empty array is a green test, so every case-driven suite below is only as honest as
// the fixture is full. Emptying it is exactly the move someone makes to turn a red build green, and
// it disarms BOTH languages at once from a file neither of them owns.
test('the golden still carries its cases — an emptied fixture is not a passing one', () => {
  assert.equal(bands.length, 3);
  assert.ok(golden.weightCases.length >= 22, `weightCases shrank to ${golden.weightCases.length}`);
  assert.ok(golden.roundCases.length >= 8, `roundCases shrank to ${golden.roundCases.length}`);
  assert.ok(golden.repCases.length >= 4, `repCases shrank to ${golden.repCases.length}`);
  // Both signs must survive. The assisted rows are the only ones that kill a rule read off the
  // SIGNED weight, which makes them the first thing a pruner mistakes for redundant.
  assert.ok(golden.weightCases.some(({ weight }) => weight < 0), 'no assisted weights left');
  assert.ok(golden.weightCases.some(({ weight }) => weight > 0), 'no loaded weights left');
});

// A weight is rehydrated from localStorage, so it is not always a number a lifter typed. Before the
// band table it fell through to an unconditional `return [5, 10]`; the table must not regress that
// into a throw, which Logger.jsx would take during render and repeat on every reload.
test('steps is total — a weight that is not a number gets the top band, never an exception', () => {
  for (const value of [Infinity, -Infinity, NaN, undefined]) {
    assert.deepEqual(steps(value, false), [5, 10], `steps of ${value}`);
    assert.deepEqual(steps(value, true), [5, 10], `lightening steps of ${value}`);
    assert.deepEqual(ladderLabels(value), ['−10', '−5', '+5', '+10'], `labels of ${value}`);
  }
});

test('the bands are the golden’s bands — every boundary, loaded and lightening, both signs', () => {
  bands.forEach((band, index) => {
    const pair = [band.small, band.large];
    const floor = index === 0 ? 0 : bands[index - 1].under;
    const top = Number.isFinite(band.under) ? band.under : floor + 1000;

    for (const sign of [1, -1]) {
      assert.deepEqual(steps(sign * floor, false), pair, `loaded at ${sign * floor}`);
      assert.deepEqual(steps(sign * (top - golden.grid), false), pair, `loaded at ${sign * (top - golden.grid)}`);
      assert.deepEqual(steps(sign * (floor + golden.grid), true), pair, `lightening at ${sign * (floor + golden.grid)}`);
      if (Number.isFinite(band.under)) assert.deepEqual(steps(sign * band.under, true), pair, `lightening at ${sign * band.under}`);
    }
  });
});

test('every weight in the golden — the four labels and the four steps under them', () => {
  for (const item of golden.weightCases) {
    assert.deepEqual(ladderLabels(item.weight), item.labels, `labels at ${item.weight}`);
    assert.equal(bump(item.weight, -1, false), item.down, `down from ${item.weight}`);
    assert.equal(bump(item.weight, -1, true), item.downBig, `down big from ${item.weight}`);
    assert.equal(bump(item.weight, 1, false), item.up, `up from ${item.weight}`);
    assert.equal(bump(item.weight, 1, true), item.upBig, `up big from ${item.weight}`);
  }
  // The golden's minus is U+2212, not a hyphen — a label mismatch above can otherwise look identical.
  assert.equal(golden.weightCases[0].labels[0].charCodeAt(0), 0x2212);
});

// Every value here is an exact IEEE tie — |value| × 100 lands on .5 with no float slack — so the
// answer is a choice, not an artefact, and the keypad reaches all of them: MAX_BUFFER is 8 and
// parseEntry rounds what you type. Half away from zero is the pinned choice.
test('every rounding tie in the golden — the keypad can type all of them', () => {
  for (const item of golden.roundCases) {
    assert.equal(round(item.value), item.rounded, `round of ${item.value}`);
  }
});

test('every rep case in the golden — floored at zero on the way down, unbounded on the way up', () => {
  for (const item of golden.repCases) {
    assert.equal(bumpReps(item.reps, -1), item.down, `reps down from ${item.reps}`);
    assert.equal(bumpReps(item.reps, 1), item.up, `reps up from ${item.reps}`);
  }
});

// The law that ties the loaded side to the assisted one, checked as a property over every weight the
// golden names and all four buttons. −0 and 0 are the same weight to a lifter and assert/strict
// compares with Object.is, so `+ 0` folds the sign of zero away before the two sides meet.
test('mirror symmetry — the assisted side is the loaded side reflected through zero', () => {
  for (const { weight } of golden.weightCases) {
    for (const { direction, big } of LADDER_KEYS) {
      const step = big ? 'big' : 'small';
      const reflected = bump(-weight, -direction, big) + 0;
      assert.equal(reflected, -bump(weight, direction, big) + 0, `mirror of ${weight} by ${direction} ${step}`);
    }
  }
  // The same law one level down, on the rounding the ladder is built out of: half away from zero is
  // the only tie-break that survives a reflection, and half-up is the one that does not.
  for (const { value } of golden.roundCases) {
    assert.equal(round(-value) + 0, -round(value) + 0, `round mirrors at ${value}`);
  }
});

// What is left after the ties moved into the golden — they are pinned there because the keypad
// reaches them, not excluded as unreachable. These two are JS's own: float noise a step leaves
// behind, and a negative that rounds to nothing, where JS keeps the sign and the shared file has no
// way to say −0.
test('round — the float noise a step leaves behind, and the zero that keeps its sign', () => {
  assert.equal(round(18.999000000000002), 19);
  assert.equal(round(20.01 - 2), 18.01);
  assert.equal(round(-0.001), -0);
});

test('LADDER_KEYS — DOM order, the small steps loudest in the middle', () => {
  assert.deepEqual(LADDER_KEYS, [
    { direction: -1, big: true, weight: 'outer' },
    { direction: -1, big: false, weight: 'inner' },
    { direction: 1, big: false, weight: 'inner' },
    { direction: 1, big: true, weight: 'outer' },
  ]);
  // Logger.jsx reads the keys and the labels side by side, so the two must agree on order.
  assert.deepEqual(ladderLabels(20).map((label) => label[0]), ['−', '−', '+', '+']);
});
