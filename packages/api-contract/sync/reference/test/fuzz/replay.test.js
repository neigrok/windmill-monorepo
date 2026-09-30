// §11.3 replay fuzz against the reference server. FUZZ_N runs (default 60) from FUZZ_SEED (default
// 1), each FUZZ_STEPS steps (default 160) before quiescence.

import assert from 'node:assert/strict';
import test from 'node:test';
import { World } from './simulator.js';

const runs = Number(process.env.FUZZ_N ?? 60);
const firstSeed = Number(process.env.FUZZ_SEED ?? 1);
const steps = Number(process.env.FUZZ_STEPS ?? 160);

// corpus/README.md "Replay coverage": a fuzz of `seeds` runs or more, each of `steps` steps or more, from
// any first seed, has at least one seed that produces each event of the tier. Each event sits in the
// smallest tier at which ten or more of a fuzz's seeds, on average, produce it; a survey of 60 fuzzes of
// 60×160 and 30 of 500×300 (`seeds.mjs` in the R115 change list) showed that, with no miss.
const COVERAGE = [
  {
    seeds: 60,
    steps: 160,
    events: [
      'request lost', 'reply lost', 'delivered out of order',
      'process death', 'death between page chunks', 'death between settling slices', 'death between result batches',
      'page short of its head', 'frame answered pull',
      'refused clock-skew', 'device clock jumped', 'reboot',
      'retired', 'left the app', 'second tab commit',
      'sign-in complete', 'sign-out keep', 'sign-out discard', 'ended discarded by discard',
      'http 401 unauthenticated',
      'epoch change', 'server restored', 'store restored', 'store cloned',
      'activeReplicaChanged announced', 'ok with a joining write map', 'refused cap', 'http 413 request-too-large', 'retry',
    ],
  },
  {
    seeds: 500,
    steps: 300,
    events: [
      'frame lost', 'push request duplicated', 'ended undone by undo', 'sign-in incomplete',
      'pull served as anonymous', 'pull served as another account',
      'frame served as anonymous', 'frame served as another account', 'http 409 account-mismatch',
      'refused internal', 'http 409 gap', 'http 409 replica-forked', 'ended refused by target-merged', 'http 400 malformed',
    ],
  },
];

test(`replay fuzz: ${runs} runs of ${steps} steps from seed ${firstSeed} hold every invariant after quiescence`, () => {
  const failures = [];
  const producing = {};
  for (let seed = firstSeed; seed < firstSeed + runs; seed += 1) {
    const world = new World({ seed, steps }).run();
    if (world.violations.length) failures.push(`seed ${seed}:\n  ${world.violations.join('\n  ')}\n  log: ${world.log.slice(-6).join(' | ')}`);
    for (const [key, count] of Object.entries(world.coverage())) if (count > 0) producing[key] = (producing[key] ?? 0) + 1;
  }
  assert.deepEqual(failures, []);
  for (const tier of COVERAGE) {
    if (runs < tier.seeds || steps < tier.steps) continue;
    for (const exercised of tier.events) assert.ok(producing[exercised] > 0, `no seed of the fuzz produced: ${exercised}`);
  }
});

test('a run is a pure function of its seed', () => {
  const first = new World({ seed: 7, steps: 80 }).run();
  const second = new World({ seed: 7, steps: 80 }).run();
  assert.deepEqual(second.server.toJSON(), first.server.toJSON());
  assert.deepEqual(second.log, first.log);
});
