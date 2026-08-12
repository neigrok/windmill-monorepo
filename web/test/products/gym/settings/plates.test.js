// THE READOUT — §1's ruling, driven. The ladder is a pure function of the weight and stays that way;
// what the plate set decides is whether a load can be BUILT, and this is where that gets answered.
// Two failures are pinned as hard as the successes, because both of them are the product making a
// false statement about the physical world: saying a load cannot be made when it can, and naming a
// decomposition for a load this rack cannot hold.

import test from 'node:test';
import assert from 'node:assert/strict';

import { finestStepKg, platesReadout } from '../../../../src/products/gym/settings/plates.js';

const FULL = { barWeightKg: 20, platesKg: [25, 20, 15, 10, 5, 2.5, 1.25] };
const NO_FINES = { barWeightKg: 20, platesKg: [25, 20, 15, 10, 5, 2.5] };

test('a load that can be built is read back as what goes on one end of the bar', () => {
  assert.deepEqual(platesReadout(105, FULL), { loadable: true, line: '20 + 25 + 15 + 2.5 per side' });
  assert.deepEqual(platesReadout(60, FULL), { loadable: true, line: '20 + 20 per side' });
  assert.deepEqual(platesReadout(140, FULL), { loadable: true, line: '20 + 25·2 + 10 per side' });
  assert.deepEqual(platesReadout(22.5, FULL), { loadable: true, line: '20 + 1.25 per side' });
});

test('the bar on its own says so, and nothing pretends a plate is on it', () => {
  assert.deepEqual(platesReadout(20, FULL), { loadable: true, line: 'just the bar' });
  assert.deepEqual(platesReadout(20, { barWeightKg: 20, platesKg: [] }), { loadable: true, line: 'just the bar' });
});

// §1's own sentence, and the one this whole module exists to be able to say. The number is NOT
// refused anywhere — a lifter may be at a different gym next Tuesday — it is answered.
test('a load these plates cannot make is named, with the loads that can', () => {
  assert.deepEqual(platesReadout(102.5, NO_FINES), {
    loadable: false,
    line: 'these plates can’t make 102.5 — 100 or 105',
  });
});

// THE GREEDY TRAP. A calculator written the usual way takes the 25 for a 30 kg side, is left with a
// 5 it cannot make, and reports a load two 15s make exactly. "You can't load that" when you can is
// the same false statement as its opposite.
test('a load only an exhaustive search finds is found', () => {
  assert.deepEqual(platesReadout(80, { barWeightKg: 20, platesKg: [25, 20, 15] }), {
    loadable: true,
    line: '20 + 15·2 per side',
  });
  assert.deepEqual(platesReadout(90, { barWeightKg: 20, platesKg: [25, 20, 15] }), {
    loadable: true,
    line: '20 + 20 + 15 per side',
  });
});

// A machine or a pair of dumbbells has no bar, and the schema allows the zero. Printing a 0 in front
// of the plates would be a weight in the sentence that is not on the equipment.
test('a bar of nothing prints no bar', () => {
  assert.deepEqual(platesReadout(40, { barWeightKg: 0, platesKg: [10, 5] }), { loadable: true, line: '10·2 per side' });
  assert.deepEqual(platesReadout(10, { barWeightKg: 0, platesKg: [10, 5] }), { loadable: true, line: '5 per side' });
});

test('a gym with no plates is told what the bar alone weighs', () => {
  assert.deepEqual(platesReadout(60, { barWeightKg: 20, platesKg: [] }), {
    loadable: false,
    line: 'no plates in your gym — the bar alone is 20 kg',
  });
});

test('a load under the bar is not a barbell load at all', () => {
  assert.deepEqual(platesReadout(15, FULL), { loadable: false, line: 'lighter than the 20 kg bar' });
});

// Bodyweight is a zero and band-assisted work is below it. Neither is a bar somebody built, and a
// plate list under either would be a sentence about equipment nobody touched.
test('bodyweight and assisted work have no plate reading', () => {
  assert.equal(platesReadout(0, FULL), null);
  assert.equal(platesReadout(-20, FULL), null);
  assert.equal(platesReadout(null, FULL), null);
  assert.equal(platesReadout(undefined, FULL), null);
});

// An odd number of hundredths cannot be halved onto two ends of a bar. No plate set fixes it, and a
// search that rounded it would name a decomposition of a load that is not the one asked for.
test('a load that cannot be halved onto two ends is unloadable, and says which loads are', () => {
  assert.deepEqual(platesReadout(20.01, FULL), {
    loadable: false,
    line: 'these plates can’t make 20.01 — 20 or 22.5',
  });
});

// The nearest below is the bar itself when nothing lighter fits, because zero per side is always
// reachable — there is never a refusal with nothing named beside it.
test('the nearest loadable below falls back to the bar', () => {
  assert.deepEqual(platesReadout(22, { barWeightKg: 20, platesKg: [5] }), {
    loadable: false,
    line: 'these plates can’t make 22 — 20 or 30',
  });
});

// SOMETHING THAT IS NOT A PLATE IS NOT A PLATE. The store's own band keeps a zero, a negative and a
// NaN off this list, and this module is the one that must not depend on that: it turns a list into a
// sentence about the physical world, and the walk keeps an INDEX into the rack it searched. Read
// against the raw list instead, one unusable entry shifted every plate after it by one and the
// readout named a decomposition of a different weight — `20 + 25 + 20 + 15 per side` is 140 kg
// printed under the numeral 105, and it looks exactly as plausible as the true line.
test('a list carrying something that is not a plate still reads the load it was asked about', () => {
  const line = { loadable: true, line: '20 + 25 + 15 + 2.5 per side' };
  assert.deepEqual(platesReadout(105, FULL), line);
  assert.deepEqual(platesReadout(105, { barWeightKg: 20, platesKg: [25, 0, 20, 15, 2.5] }), line);
  assert.deepEqual(platesReadout(105, { barWeightKg: 20, platesKg: [-5, 25, 20, 15, 2.5] }), line);
  assert.deepEqual(platesReadout(105, { barWeightKg: 20, platesKg: [25, NaN, 20, 15, 2.5] }), line);
  // And a rack of nothing but those is a gym with no plates, which it is.
  assert.deepEqual(platesReadout(60, { barWeightKg: 20, platesKg: [0, -5] }), {
    loadable: false,
    line: 'no plates in your gym — the bar alone is 20 kg',
  });
});

// A NUMBER THAT IS NOT A NUMBER HAS NO READING. Every line in here is arithmetic on the bar and the
// load, and a NaN through it prints a sentence naming a load — "these plates can't make 105 — NaN" —
// where the honest answer is that there is nothing to say.
test('a load or a bar that is not a number reads as nothing at all', () => {
  assert.equal(platesReadout(105, { barWeightKg: NaN, platesKg: [25] }), null);
  assert.equal(platesReadout(NaN, FULL), null);
  assert.equal(platesReadout(Infinity, FULL), null);
  assert.equal(platesReadout(105, { barWeightKg: Infinity, platesKg: [25] }), null);
});

// THE SMALLEST CHANGE IS TWICE THE LIGHTEST PLATE, because one goes on each end — which is the true
// sentence under §I's "the ladder's fine step comes from this". The ladder does not move; what this
// rack can make does.
test('the finest step this rack makes is twice its lightest plate', () => {
  assert.equal(finestStepKg([25, 20, 15, 10, 5, 2.5, 1.25]), 2.5);
  assert.equal(finestStepKg([25, 20, 15, 10, 5, 2.5]), 5);
  assert.equal(finestStepKg([20]), 40);
  assert.equal(finestStepKg([]), null);
  // The same rule, and the same reason: a zero plate would say this rack changes a load by nothing,
  // and a −5 that it changes one by less than nothing.
  assert.equal(finestStepKg([25, 0]), 50);
  assert.equal(finestStepKg([25, -5]), 50);
  assert.equal(finestStepKg([0]), null);
});
