import assert from 'node:assert/strict';
import test from 'node:test';
import { Clock } from '../../../../src/platform/sync/core/clock.js';
import { Stamp } from '../../../../src/platform/sync/core/stamp.js';
import { Rng } from '../oracle-adapters/fixtures.js';

// INV-1's clock half: a tick is above every earlier tick and every stamp observed before it.
test('§10.2: ticks rise strictly and out-stamp everything observed, whatever physNow does', () => {
  for (const seed of [1, 2, 3]) {
    const rng = new Rng(seed);
    let now = 100_000;
    const clock = new Clock({ ms: 0, counter: 0 }, 'r_a', () => now);
    let high = Stamp.UNSET;
    for (let i = 0; i < 5000; i += 1) {
      now += rng.int(5) - 2;
      if (rng.chance(0.3)) {
        const seen = `${now + rng.int(200) - 100}:${rng.int(4)}:srv`;
        clock.observe(seen);
        high = Stamp.max(high, seen);
        continue;
      }
      const stamp = clock.tick();
      assert.ok(Stamp.compare(stamp, high) > 0, `${stamp} > ${high}`);
      high = stamp;
    }
  }
});

test('D-1: encode and parse round-trip every valid stamp', () => {
  const rng = new Rng(4);
  for (let i = 0; i < 2000; i += 1) {
    const stamp = { ms: rng.int(2 ** 30) * rng.int(2 ** 22), counter: rng.int(2 ** 32), actor: `r_${rng.int(1e6)}` };
    assert.deepEqual(Stamp.parse(Stamp.encode(stamp)), stamp);
  }
});
