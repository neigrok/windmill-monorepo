// §11.3 replay fuzz against the reference server. FUZZ_N runs (default 60) from FUZZ_SEED (default
// 1), each FUZZ_STEPS steps (default 160) before quiescence.

import assert from 'node:assert/strict';
import test from 'node:test';
import { World } from './simulator.js';

const runs = Number(process.env.FUZZ_N ?? 60);
const firstSeed = Number(process.env.FUZZ_SEED ?? 1);
const steps = Number(process.env.FUZZ_STEPS ?? 160);

test(`replay fuzz: ${runs} runs of ${steps} steps from seed ${firstSeed} hold every invariant after quiescence`, () => {
  const failures = [];
  const coverage = {};
  for (let seed = firstSeed; seed < firstSeed + runs; seed += 1) {
    const world = new World({ seed, steps }).run();
    if (world.violations.length) failures.push(`seed ${seed}:\n  ${world.violations.join('\n  ')}\n  log: ${world.log.slice(-6).join(' | ')}`);
    for (const [key, count] of Object.entries(world.coverage())) coverage[key] = (coverage[key] ?? 0) + count;
  }
  assert.deepEqual(failures, []);
  for (const exercised of ['ended coalesced by coalesce', 'ended refused by target-merged', 'ok with a joining write map', 'refused clock-skew', 'refused cap', 'refused internal', 'http 401 unauthenticated', 'http 400 malformed', 'http 413 request-too-large', 'retry', 'retired']) {
    if (runs >= 60) assert.ok(coverage[exercised] > 0, `the fuzz never exercised: ${exercised}`);
  }
});

test('a run is a pure function of its seed', () => {
  const first = new World({ seed: 7, steps: 80 }).run();
  const second = new World({ seed: 7, steps: 80 }).run();
  assert.deepEqual(second.server.toJSON(), first.server.toJSON());
  assert.deepEqual(second.log, first.log);
});
