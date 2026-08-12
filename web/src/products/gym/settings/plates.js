// WHAT ACTUALLY GOES ON THE BAR — and, when nothing does, the two loads that would.
//
// §I's caption says the ladder's fine step comes from the plate set. It does not, and it must not:
// the ladder is pinned as data by packages/api-contract/gym-ladder.json and run as a golden by three
// languages, and a step that depended on one lifter's inventory could not be pinned that way. What
// the plate set feeds is the READOUT — the line under a load that says what to hang on the bar, and
// says plainly when this gym cannot make the number rather than quietly declining to offer it. A
// button that hides a weight is a product deciding what a lifter may lift; a readout that says
// "these plates can't make 102.5 — 100 or 105" is a product telling them something true.
//
// THE RULE AND THE SENTENCE ARE TWO THINGS, and this file keeps them apart because only one of them
// is shared. `plateAnswer` is the rule: it is pinned as data by
// packages/api-contract/gym-plate-readout.json and answered identically by Swift and Kotlin, because
// three languages wrote it independently in one wave and had already drifted on two edges.
// `platesReadout` is the sentence, and the sentence is ours alone — each surface spells a number its
// own way. Anything a golden case can see belongs above the line; anything with a word in it belongs
// below.
//
// THE SEARCH IS EXHAUSTIVE AND NOT GREEDY. Greedy is how a plate calculator is usually written and
// it is wrong on ordinary gyms: with 25s, 20s and 15s only, greedy takes the 25 for a 30 kg side, is
// left with 5 it cannot make, and reports a load that two 15s make exactly. "You can't load that"
// when you can is the same false statement as its opposite, so every reachable per-side amount is
// walked once — in hundredths of a kilogram, which is the grid the store rounds to — and the plate
// that reached each one is kept. That array is both the answer and the decomposition.
//
// `platesKg` IS ONE SIDE OF THE BAR AND THE LOAD IS THE TOTAL, exactly as the wire contract says.
// Anything that mixes the two is wrong by a factor of two, which is the one mistake here that looks
// plausible on screen.
//
// Kilograms throughout, whatever the account reads in: plates are objects in a rack and the settings
// row that chooses them is a kilogram instrument (units.js).

import { fmtKg } from '../log.js';

const PER_KG = 100;
// Past a tonne nobody is reading a plate list, and the keypad stops at 500 long before it — so the
// cap is the belt behind that rule rather than a second opinion on it. It is also what keeps the
// walk below sized by a number a lifter could have typed: the load and the rack both arrive
// rehydrated from a blob, and neither is allowed to ask this surface for an array of a hundred
// million cells. `capKg` in the golden.
const CAP_KG = 1000;

// THE PLATES THIS RACK CAN ACTUALLY HANG ON A BAR, which is not the same list as the one stored. The
// store has its own band — a plate weighs from 0.01 to 100 kg — but this module turns a list into a
// sentence about the physical world, so it reads what it was handed rather than trusting it: a zero,
// a negative, anything that is not a number and anything past the cap are not plates, and a search
// that carried them would name a decomposition of a load nobody asked for.
function rackOf(platesKg) {
  return (platesKg ?? []).filter(
    (plate) => Number.isFinite(plate) && Math.round(plate * PER_KG) > 0 && plate <= CAP_KG,
  );
}

// Beyond the heaviest plate there is nothing left to find: zero is always reachable, so the nearest
// loadable amount below any target exists, and adding one plate to it lands within this much of the
// target. A window bigger than that would only walk amounts nobody asked about.
//
// THE RACK AND ITS STEPS ARE ONE LIST IN TWO SPELLINGS, index for index — the decomposition reads a
// plate back out by the index this walk kept, so a step list of a different length would answer with
// the wrong plate, silently, and only on a rack holding something that is not a plate.
function reachable(sideCents, rack) {
  const steps = rack.map((plate) => Math.round(plate * PER_KG));
  const limit = sideCents + Math.max(0, ...steps);
  const from = new Int32Array(limit + 1).fill(-1);
  from[0] = -2;
  for (let amount = 1; amount <= limit; amount += 1) {
    for (let index = 0; index < steps.length; index += 1) {
      if (steps[index] <= amount && from[amount - steps[index]] !== -1) {
        from[amount] = index;
        break;
      }
    }
  }
  return { from, steps, limit };
}

// THE RULE — one of five answers, and every one of them is a real state a lifter reaches:
//
//   loaded      `perSide`, heaviest first, with a count per plate
//   bare        the load is the bar
//   underBar    the load is lighter than the bar — SAY SO; it is true, and it explains the missing
//               plate list. Falling silent here leaves a lifter wondering where the list went.
//   unloadable  these plates cannot make it; `belowKg` and `aboveKg` are the nearest totals that can
//   none        there is nothing true to say
//
// A BAR OF NOTHING ANSWERS `none`, and this is the edge the three surfaces were ruled on. A zero bar
// is a machine or a pair of dumbbells: the lifter has said there is no bar, so there is no sentence
// about one, and a per-side decomposition would claim a symmetry the equipment may not have. This
// surface used to print one.
//
// The rest of `none` is the same answer for the same reason — nothing to read: no target at all; a
// load at or below zero, which is bodyweight work or a band taking weight off and never a bar
// somebody built; a load past the cap; and a load or a bar that is not a number, because every line
// below is arithmetic on the two of them and a NaN through it would print a sentence naming a load.
export function plateAnswer(totalKg, { barWeightKg, platesKg }) {
  if (!Number.isFinite(totalKg) || totalKg <= 0 || totalKg > CAP_KG) return { answer: 'none' };
  if (!Number.isFinite(barWeightKg) || barWeightKg <= 0) return { answer: 'none' };

  const spare = Math.round(totalKg * PER_KG) - Math.round(barWeightKg * PER_KG);
  if (spare < 0) return { answer: 'underBar' };
  if (spare === 0) return { answer: 'bare' };

  const rack = rackOf(platesKg);
  // An odd number of hundredths cannot be halved onto two ends of a bar, so it is unloadable for a
  // reason no plate set can fix — and the search below would round it into a lie.
  if (spare % 2 !== 0) return nearestLoadable(spare, barWeightKg, rack);

  const side = spare / 2;
  const { from, steps } = reachable(side, rack);
  if (from[side] === -1) return nearestLoadable(spare, barWeightKg, rack);

  const counts = new Map();
  for (let amount = side; amount > 0; amount -= steps[from[amount]]) {
    const plate = rack[from[amount]];
    counts.set(plate, (counts.get(plate) ?? 0) + 1);
  }
  const perSide = [...counts.entries()]
    .sort(([left], [right]) => right - left)
    .map(([kg, count]) => ({ kg, count }));
  return { answer: 'loaded', perSide };
}

// THE HONEST REFUSAL, and it names loads rather than refusing one: the nearest total these plates DO
// make below the target and the nearest above it. Zero per side is always reachable, so there is
// always something below — the bar itself, at worst. Above runs out only at the top of the search,
// which is one plate past the target and therefore only on a rack holding no plate at all.
function nearestLoadable(spare, barWeightKg, rack) {
  const side = Math.floor(spare / 2);
  const { from, limit } = reachable(side + 1, rack);
  // In hundredths to the last step: the bar plus two of everything, added as integers, so a nearest
  // load lands on the grid instead of a float a hair beside it.
  const totalOf = (amount) => (Math.round(barWeightKg * PER_KG) + amount * 2) / PER_KG;

  let under = side;
  while (under > 0 && from[under] === -1) under -= 1;
  let over = side + 1;
  while (over <= limit && from[over] === -1) over += 1;

  return { answer: 'unloadable', belowKg: totalOf(under), aboveKg: over <= limit ? totalOf(over) : null };
}

// THE SENTENCE, which is this surface's own — the rule above is shared, the wording is not. Null
// where there is nothing to read, so a caller renders no line rather than a line about nothing.
//
// `loaded` prints the bar in front of the plates and no longer has to ask whether there is one: a
// bar of nothing answers `none` a level up, so the only bars that reach this line are bars.
export function platesReadout(totalKg, preferences) {
  const { barWeightKg, platesKg } = preferences;
  const readout = plateAnswer(totalKg, preferences);
  if (readout.answer === 'none') return null;
  if (readout.answer === 'bare') return { loadable: true, line: 'just the bar' };
  if (readout.answer === 'underBar') {
    return { loadable: false, line: `lighter than the ${fmtKg(barWeightKg)} kg bar` };
  }
  if (readout.answer === 'loaded') {
    const parts = readout.perSide.map(({ kg, count }) => (count > 1 ? `${fmtKg(kg)}·${count}` : fmtKg(kg)));
    return { loadable: true, line: `${[fmtKg(barWeightKg), ...parts].join(' + ')} per side` };
  }
  // A gym with no plates is unloadable for a reason of its own, and "these plates" is the wrong
  // phrase for a rack that holds none: the true thing to say is what the bar alone weighs.
  if (rackOf(platesKg).length === 0) {
    return { loadable: false, line: `no plates in your gym — the bar alone is ${fmtKg(barWeightKg)} kg` };
  }
  const nearest = readout.aboveKg == null
    ? fmtKg(readout.belowKg)
    : `${fmtKg(readout.belowKg)} or ${fmtKg(readout.aboveKg)}`;
  return { loadable: false, line: `these plates can’t make ${fmtKg(totalKg)} — ${nearest}` };
}

// THE SMALLEST CHANGE THIS RACK CAN MAKE, which is twice the lightest plate because a plate goes on
// each end. It is what the settings row says instead of the design's "the ladder's fine step comes
// from this" — the ladder does not move, and this is the true sentence underneath that one.
export function finestStepKg(platesKg) {
  const rack = rackOf(platesKg);
  if (rack.length === 0) return null;
  return Math.min(...rack) * 2;
}
