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

// THE PLATES THIS RACK CAN ACTUALLY HANG ON A BAR, which is not the same list as the one stored. The
// store has its own band — a plate weighs from 0.01 to 100 kg — but this module turns a list into a
// sentence about the physical world, so it reads what it was handed rather than trusting it: a zero,
// a negative and anything that is not a number are not plates, and a search that carried them would
// name a decomposition of a load nobody asked for.
function rackOf(platesKg) {
  return (platesKg ?? []).filter((plate) => Number.isFinite(plate) && Math.round(plate * PER_KG) > 0);
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

// A LOAD, READ AS PLATES — or the plainest true thing that can be said about it instead. Null where
// there is nothing to read: no target at all; a load at or below zero, which is bodyweight work or a
// band taking weight off and never a bar somebody built; and a load or a bar that is not a number,
// because every sentence below is arithmetic on the two of them.
export function platesReadout(totalKg, { barWeightKg, platesKg }) {
  if (totalKg == null || !Number.isFinite(totalKg) || totalKg <= 0) return null;
  // A bar that is not a number is not a bar. Every line below is arithmetic on it, and the walk
  // would run on a NaN and print one — a sentence naming a load in place of the reason there is no
  // sentence. Nothing to read is the honest answer, and it is the same one bodyweight work gets.
  if (!Number.isFinite(barWeightKg)) return null;

  const rack = rackOf(platesKg);
  const spare = Math.round(totalKg * PER_KG) - Math.round(barWeightKg * PER_KG);
  // Past a tonne on the bar nobody is reading a plate list, and the walk below is sized by the load:
  // a number that arrived from somewhere other than a keypad must not be able to ask this surface
  // for an array of a hundred million cells.
  if (spare > 100_000) return null;
  if (spare < 0) return { loadable: false, line: `lighter than the ${fmtKg(barWeightKg)} kg bar` };
  if (spare === 0) return { loadable: true, line: 'just the bar' };
  if (rack.length === 0) {
    return { loadable: false, line: `no plates in your gym — the bar alone is ${fmtKg(barWeightKg)} kg` };
  }
  // An odd number of hundredths cannot be halved onto two sides of a bar, so it is unloadable for a
  // reason no plate set can fix — and the search below would round it into a lie.
  if (spare % 2 !== 0) return refusal(totalKg, barWeightKg, rack);

  const side = spare / 2;
  const { from, steps } = reachable(side, rack);
  if (from[side] === -1) return refusal(totalKg, barWeightKg, rack);

  const counts = new Map();
  for (let amount = side; amount > 0; amount -= steps[from[amount]]) {
    const plate = rack[from[amount]];
    counts.set(plate, (counts.get(plate) ?? 0) + 1);
  }
  const parts = [...counts.entries()]
    .sort(([left], [right]) => right - left)
    .map(([plate, count]) => (count > 1 ? `${fmtKg(plate)}·${count}` : fmtKg(plate)));
  // A bar of nothing is a pair of dumbbells or a machine, and printing a 0 in front of the plates
  // would be a weight in the sentence that is not on the equipment.
  const bar = barWeightKg > 0 ? [fmtKg(barWeightKg)] : [];
  return { loadable: true, line: `${[...bar, ...parts].join(' + ')} per side` };
}

// THE HONEST ANSWER, and it names loads rather than refusing one: the nearest total these plates DO
// make below the target and the nearest above it. Zero per side is always reachable, so there is
// always something below — the bar itself, at worst. Above can run out only at the top of the
// search, which is one plate past the target and therefore never on a set that holds any plate.
function refusal(totalKg, barWeightKg, rack) {
  const spare = Math.round(totalKg * PER_KG) - Math.round(barWeightKg * PER_KG);
  const side = Math.floor(spare / 2);
  const { from, limit } = reachable(side + 1, rack);
  const totalOf = (amount) => fmtKg(barWeightKg + (amount * 2) / PER_KG);

  let under = side;
  while (under > 0 && from[under] === -1) under -= 1;
  let over = side + 1;
  while (over <= limit && from[over] === -1) over += 1;

  const nearest = over <= limit ? `${totalOf(under)} or ${totalOf(over)}` : totalOf(under);
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
