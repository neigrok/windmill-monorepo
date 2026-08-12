// THE READOUT, pinned at every edge. Three languages wrote this rule independently in one wave and
// had already disagreed on two of them, so the answers now live in
// packages/api-contract/gym-plate-readout.json — read from the repo rather than copied in here, and
// run as a test by Swift and Kotlin too. What that file pins is the ANSWER, which is the rule; the
// sentence under it is this surface's own, and the second half of this file is where it is checked.
//
// Two failures are pinned as hard as the successes, because both of them are the product making a
// false statement about the physical world: saying a load cannot be made when it can, and naming a
// decomposition for a load this rack cannot hold.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { finestStepKg, plateAnswer, platesReadout } from '../../../../src/products/gym/settings/plates.js';

const goldenPath = new URL('../../../../../packages/api-contract/gym-plate-readout.json', import.meta.url);
const golden = JSON.parse(readFileSync(goldenPath, 'utf8'));

const FULL = { barWeightKg: 20, platesKg: [25, 20, 15, 10, 5, 2.5, 1.25] };
const NO_FINES = { barWeightKg: 20, platesKg: [25, 20, 15, 10, 5, 2.5] };

// A loop over an empty array is a green test, so the suite below is only as honest as the fixture is
// full. Emptying it is exactly the move someone makes to turn a red build green, and it disarms all
// three languages at once from a file none of them owns.
test('the golden still carries its cases — an emptied fixture is not a passing one', () => {
  assert.ok(golden.cases.length >= 22, `cases shrank to ${golden.cases.length}`);
  assert.equal(golden.capKg, 1000);
  assert.equal(golden.grid, 0.01);
  for (const answer of ['loaded', 'bare', 'underBar', 'unloadable', 'none']) {
    assert.ok(golden.cases.some((item) => item.answer === answer), `no ${answer} case left`);
  }
  // The two ruled edges, named here because they are the first thing a pruner mistakes for a
  // duplicate: a bar of nothing answers `none`, and a load under the bar says so rather than
  // falling silent. One surface was wrong on each.
  assert.ok(golden.cases.some((item) => item.barWeightKg === 0 && item.answer === 'none'), 'the bar of nothing is gone');
  assert.ok(golden.cases.some((item) => item.answer === 'underBar'), 'the loads under the bar are gone');
  // The rack that can name a load below the target but none above it — the only case where a
  // refusal has one side, and the one an implementation forgets is nullable.
  assert.ok(
    golden.cases.some((item) => item.answer === 'unloadable' && item.aboveKg === null),
    'the open-topped refusal is gone',
  );
});

test('every case in the golden — the answer, the decomposition, and the loads a refusal names', () => {
  for (const item of golden.cases) {
    const where = `${item.totalKg} on a ${item.barWeightKg} bar with [${item.platesKg}]`;
    const readout = plateAnswer(item.totalKg, { barWeightKg: item.barWeightKg, platesKg: item.platesKg });

    assert.equal(readout.answer, item.answer, where);
    if (item.answer === 'loaded') assert.deepEqual(readout.perSide, item.perSide, `per side of ${where}`);
    if (item.answer === 'unloadable') {
      assert.equal(readout.belowKg, item.belowKg, `nearest below ${where}`);
      assert.equal(readout.aboveKg, item.aboveKg, `nearest above ${where}`);
    }
    // An answer that is not `loaded` carries no plate list: a decomposition left on a refusal is a
    // sentence about a bar nobody can build, and it would render as one.
    if (item.answer !== 'loaded') assert.equal(readout.perSide, undefined, `stray plates on ${where}`);
  }
});

// THE FACTOR OF TWO, checked as a property rather than trusted case by case. `platesKg` is one side
// of the bar and the load is the total, and mixing the two is the one mistake here that looks
// entirely plausible on screen — every plate present, every number a real plate, the load doubled.
test('every loaded decomposition adds up — the bar plus both ends is the load asked for', () => {
  const loaded = golden.cases.filter((item) => item.answer === 'loaded');
  assert.ok(loaded.length >= 8, `loaded cases shrank to ${loaded.length}`);
  for (const item of loaded) {
    const { perSide } = plateAnswer(item.totalKg, { barWeightKg: item.barWeightKg, platesKg: item.platesKg });
    const sideKg = perSide.reduce((sum, { kg, count }) => sum + kg * count, 0);
    assert.equal(Math.round((item.barWeightKg + sideKg * 2) * 100) / 100, item.totalKg, `${item.totalKg} adds up`);
    // Heaviest first, and nothing on the list twice — the order is the order a lifter loads in.
    const weights = perSide.map(({ kg }) => kg);
    assert.deepEqual(weights, [...new Set(weights)].sort((left, right) => right - left), `order at ${item.totalKg}`);
    for (const { kg, count } of perSide) {
      assert.ok(item.platesKg.includes(kg), `${kg} is not a plate in this gym`);
      assert.ok(count >= 1, `a count of ${count} on ${kg}`);
    }
  }
});

// THE GREEDY TRAP, and the golden carries the case: a calculator written the usual way takes the 25
// for a 30 kg side, is left with a 5 it cannot make, and reports a load two 15s make exactly. "You
// can't load that" when you can is the same false statement as its opposite.
test('a load only an exhaustive search finds is found', () => {
  assert.deepEqual(plateAnswer(80, { barWeightKg: 20, platesKg: [25, 20, 15] }), {
    answer: 'loaded',
    perSide: [{ kg: 15, count: 2 }],
  });
  assert.deepEqual(plateAnswer(90, { barWeightKg: 20, platesKg: [25, 20, 15] }), {
    answer: 'loaded',
    perSide: [{ kg: 20, count: 1 }, { kg: 15, count: 1 }],
  });
});

// SOMETHING THAT IS NOT A PLATE IS NOT A PLATE. The store's own band keeps a zero, a negative and a
// NaN off this list, and this module is the one that must not depend on that: it turns a list into a
// sentence about the physical world, and the walk keeps an INDEX into the rack it searched. Read
// against the raw list instead, one unusable entry shifted every plate after it by one and the
// readout named a decomposition of a different weight — 25 + 20 + 15 a side is 140 kg printed under
// the numeral 105, and it looks exactly as plausible as the true line.
test('a list carrying something that is not a plate still reads the load it was asked about', () => {
  const perSide = [{ kg: 25, count: 1 }, { kg: 15, count: 1 }, { kg: 2.5, count: 1 }];
  assert.deepEqual(plateAnswer(105, FULL), { answer: 'loaded', perSide });
  assert.deepEqual(plateAnswer(105, { barWeightKg: 20, platesKg: [25, 0, 20, 15, 2.5] }), { answer: 'loaded', perSide });
  assert.deepEqual(plateAnswer(105, { barWeightKg: 20, platesKg: [-5, 25, 20, 15, 2.5] }), { answer: 'loaded', perSide });
  assert.deepEqual(plateAnswer(105, { barWeightKg: 20, platesKg: [25, NaN, 20, 15, 2.5] }), { answer: 'loaded', perSide });
  // A plate past the cap is the same kind of entry, and it is the one that sizes the search: the
  // walk runs to one plate past the target, so a 5000 kg "plate" out of a rehydrated blob would ask
  // for an array of half a million cells to say nothing with.
  assert.deepEqual(plateAnswer(105, { barWeightKg: 20, platesKg: [5000, 25, 20, 15, 2.5] }), { answer: 'loaded', perSide });
  // And a rack of nothing but those is a gym with no plates, which it is.
  assert.deepEqual(plateAnswer(60, { barWeightKg: 20, platesKg: [0, -5] }), {
    answer: 'unloadable',
    belowKg: 20,
    aboveKg: null,
  });
});

// The cap is on the LOAD, not on what the plates carry: 1000 kg is the last readout, and the bar
// under it does not buy another 20 kg of readout above it.
test('past the cap there is no readout, and the bar does not move the cap', () => {
  assert.equal(plateAnswer(1000, FULL).answer, 'loaded');
  assert.equal(plateAnswer(1000.01, FULL).answer, 'none');
  assert.equal(plateAnswer(1005, FULL).answer, 'none');
});

// A bar of less than nothing is not a bar either, and the ruling that sends a zero bar to `none`
// says why: the lifter has told us there is nothing to hang plates on.
test('a bar that is not a bar has no reading', () => {
  assert.equal(plateAnswer(40, { barWeightKg: 0, platesKg: [10, 5] }).answer, 'none');
  assert.equal(plateAnswer(40, { barWeightKg: -20, platesKg: [10, 5] }).answer, 'none');
  assert.equal(plateAnswer(105, { barWeightKg: NaN, platesKg: [25] }).answer, 'none');
  assert.equal(plateAnswer(105, { barWeightKg: Infinity, platesKg: [25] }).answer, 'none');
});

// Bodyweight is a zero and band-assisted work is below it. Neither is a bar somebody built, and a
// plate list under either would be a sentence about equipment nobody touched.
test('bodyweight, assisted work and a load that is not a number have no reading', () => {
  for (const totalKg of [0, -20, null, undefined, NaN, Infinity]) {
    assert.equal(plateAnswer(totalKg, FULL).answer, 'none', `a load of ${totalKg}`);
  }
});

// From here down the sentence is what is on trial, not the rule. It is this surface's own — the
// golden pins which of the five answers comes back, and every language spells the numbers under it
// differently.
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
  // An odd number of hundredths cannot be halved onto two ends of a bar. No plate set fixes it, and
  // a search that rounded it would name a decomposition of a load that is not the one asked for.
  assert.deepEqual(platesReadout(20.01, FULL), {
    loadable: false,
    line: 'these plates can’t make 20.01 — 20 or 22.5',
  });
  // The nearest below is the bar itself when nothing lighter fits, because zero per side is always
  // reachable — there is never a refusal with nothing named beside it.
  assert.deepEqual(platesReadout(22, { barWeightKg: 20, platesKg: [5] }), {
    loadable: false,
    line: 'these plates can’t make 22 — 20 or 30',
  });
});

// A rack with no plates in it is unloadable like any other, but "these plates" is the wrong phrase
// for plates that do not exist: what is true is what the bar alone weighs.
test('a gym with no plates is told what the bar alone weighs', () => {
  assert.deepEqual(platesReadout(60, { barWeightKg: 20, platesKg: [] }), {
    loadable: false,
    line: 'no plates in your gym — the bar alone is 20 kg',
  });
});

// The line is the whole point of the ruling: silence would leave a lifter wondering where the plate
// list went, and this says why it is missing.
test('a load under the bar is not a barbell load at all, and says so', () => {
  assert.deepEqual(platesReadout(15, FULL), { loadable: false, line: 'lighter than the 20 kg bar' });
  assert.deepEqual(platesReadout(0.5, FULL), { loadable: false, line: 'lighter than the 20 kg bar' });
});

// The other ruling, from the caller's side: no answer means no line, so the sheet renders nothing
// rather than a decomposition of a bar the lifter has said is not there.
test('nothing to say is rendered as nothing at all', () => {
  assert.equal(platesReadout(40, { barWeightKg: 0, platesKg: [10, 5] }), null);
  assert.equal(platesReadout(0, FULL), null);
  assert.equal(platesReadout(-20, FULL), null);
  assert.equal(platesReadout(null, FULL), null);
  assert.equal(platesReadout(undefined, FULL), null);
  assert.equal(platesReadout(NaN, FULL), null);
  assert.equal(platesReadout(105, { barWeightKg: NaN, platesKg: [25] }), null);
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
