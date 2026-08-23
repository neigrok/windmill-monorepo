// The ladder table lives in packages/api-contract/gym-ladder.json; iOS runs it as a test too.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { LADDER_KEYS, bump, bumpReps, ladderLabels, round, steps } from '../../../../src/products/gym/logger/ladder.js';

const goldenPath = new URL('../../../../../packages/api-contract/gym-ladder.json', import.meta.url);
const golden = JSON.parse(readFileSync(goldenPath, 'utf8'));

// `under: null` is the top band, open above.
const bands = golden.bands.map((band) => ({ ...band, under: band.under ?? Infinity }));

test('the golden still carries its cases — an emptied fixture is not a passing one', () => {
  assert.equal(bands.length, 3);
  assert.ok(golden.weightCases.length >= 22, `weightCases shrank to ${golden.weightCases.length}`);
  assert.ok(golden.roundCases.length >= 8, `roundCases shrank to ${golden.roundCases.length}`);
  assert.ok(golden.repCases.length >= 4, `repCases shrank to ${golden.repCases.length}`);
  assert.ok(golden.weightCases.some(({ weight }) => weight < 0), 'no assisted weights left');
  assert.ok(golden.weightCases.some(({ weight }) => weight > 0), 'no loaded weights left');
});

test('steps is total — a weight that is not a number gets the top band, never an exception', () => {
  for (const value of [Infinity, -Infinity, NaN, undefined]) {
    assert.deepEqual(steps(value, false), [2.5, 10], `steps of ${value}`);
    assert.deepEqual(steps(value, true), [2.5, 10], `lightening steps of ${value}`);
    assert.deepEqual(ladderLabels(value), ['−10', '−2.5', '+2.5', '+10'], `labels of ${value}`);
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
  assert.equal(golden.weightCases[0].labels[0].charCodeAt(0), 0x2212);
});

test('every rounding tie in the golden — the keypad can type all of them', () => {
  for (const item of golden.roundCases) {
    assert.equal(round(item.value), item.rounded, `round of ${item.value}`);
  }
});

test('every rep case in the golden — floored at one on the way down, unbounded on the way up', () => {
  for (const item of golden.repCases) {
    assert.equal(bumpReps(item.reps, -1), item.down, `reps down from ${item.reps}`);
    assert.equal(bumpReps(item.reps, 1), item.up, `reps up from ${item.reps}`);
  }
  assert.equal(bumpReps(-3, -1), 1);
});

// `+ 0` folds the sign of zero away — assert/strict compares with Object.is.
test('mirror symmetry — the assisted side is the loaded side reflected through zero', () => {
  for (const { weight } of golden.weightCases) {
    for (const { direction, big } of LADDER_KEYS) {
      const step = big ? 'big' : 'small';
      const reflected = bump(-weight, -direction, big) + 0;
      assert.equal(reflected, -bump(weight, direction, big) + 0, `mirror of ${weight} by ${direction} ${step}`);
    }
  }
  for (const { value } of golden.roundCases) {
    assert.equal(round(-value) + 0, -round(value) + 0, `round mirrors at ${value}`);
  }
});

test('round — the float noise a step leaves behind, and the zero that keeps its sign', () => {
  assert.equal(round(18.999000000000002), 19);
  assert.equal(round(20.01 - 2.5), 17.51);
  assert.equal(round(-0.001), -0);
});

test('LADDER_KEYS — DOM order, the small steps loudest in the middle', () => {
  assert.deepEqual(LADDER_KEYS, [
    { direction: -1, big: true, weight: 'outer' },
    { direction: -1, big: false, weight: 'inner' },
    { direction: 1, big: false, weight: 'inner' },
    { direction: 1, big: true, weight: 'outer' },
  ]);
  assert.deepEqual(ladderLabels(20).map((label) => label[0]), ['−', '−', '+', '+']);
});
