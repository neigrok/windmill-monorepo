import assert from 'node:assert/strict';
import test from 'node:test';
import { jcs } from '../../../../src/platform/sync/core/jcs.js';
import { joinBorn, joinFww, joinLife, joinLww, joinRanked, joinRecord } from '../../../../src/platform/sync/core/merge.js';
import { Stamp } from '../../../../src/platform/sync/core/stamp.js';
import { Rng, registry } from '../oracle-adapters/fixtures.js';

const TRIALS = 3000;
const TIER = registry.type('card').field('tier').rank;
const VALUES = [null, false, true, 0, 9, 10, -1.5, '', 'a', 'b', 'דּ', '\u{1f600}', { a: 1 }, { a: 2 }, [1]];

// Few stamps, so ties on ms, counter and actor are frequent.
function stampOf(rng) {
  return `${rng.int(3)}:${rng.int(2)}:${rng.pick(['r_a', 'r_b', 'srv'])}`;
}

function registerOf(rng, values) {
  return rng.chance(0.15) ? undefined : [rng.pick(values), stampOf(rng)];
}

const KINDS = {
  lww: { join: joinLww, gen: (rng) => registerOf(rng, VALUES) },
  fww: { join: joinFww, gen: (rng) => registerOf(rng, VALUES) },
  ranked: { join: (a, b) => joinRanked(a, b, TIER), gen: (rng) => registerOf(rng, Object.keys(TIER)) },
  life: { join: joinLife, gen: (rng) => registerOf(rng, ['alive', 'dead']) },
  born: { join: joinBorn, gen: (rng) => (rng.chance(0.15) ? undefined : stampOf(rng)) },
};

const same = (a, b) => jcs(a ?? null) === jcs(b ?? null);

for (const [kind, { join, gen }] of Object.entries(KINDS)) {
  test(`§3.3 laws for ${kind}: idempotent, commutative, associative, absent is the identity`, () => {
    const rng = new Rng(kind.length * 7919);
    for (let i = 0; i < TRIALS; i += 1) {
      const [a, b, c] = [gen(rng), gen(rng), gen(rng)];
      assert.ok(same(join(a, a), a), `idempotent ${jcs(a ?? null)}`);
      assert.ok(same(join(a, b), join(b, a)), `commutative ${jcs([a ?? null, b ?? null])}`);
      assert.ok(same(join(join(a, b), c), join(a, join(b, c))), `associative ${jcs([a ?? null, b ?? null, c ?? null])}`);
      assert.ok(same(join(a, undefined), a) && same(join(undefined, a), a), 'absent is the identity');
      const joined = join(a, b);
      assert.ok(joined === a || joined === b, 'a join returns one of its arguments');
    }
  });
}

test('§3.2 ranked: the join never falls to a lower rank, whatever the stamps', () => {
  const rng = new Rng(86);
  for (let i = 0; i < TRIALS; i += 1) {
    const a = [rng.pick(Object.keys(TIER)), stampOf(rng)];
    const b = [rng.pick(Object.keys(TIER)), stampOf(rng)];
    assert.equal(TIER[joinRanked(a, b, TIER)[0]], Math.max(TIER[a[0]], TIER[b[0]]));
  }
});

test('§3.2 lww and fww pick the greater and the smaller stamp', () => {
  const rng = new Rng(5);
  for (let i = 0; i < TRIALS; i += 1) {
    const a = [rng.pick(VALUES), stampOf(rng)];
    const b = [rng.pick(VALUES), stampOf(rng)];
    if (a[1] === b[1]) continue;
    assert.equal(joinLww(a, b)[1], Stamp.max(a[1], b[1]));
    assert.equal(joinFww(a, b)[1], Stamp.min(a[1], b[1]));
  }
});

test('§3.3 joinRecord is the pointwise product of the register joins', () => {
  const rng = new Rng(11);
  const type = registry.type('card');
  const recordOf = () => {
    const record = {};
    const life = KINDS.life.gen(rng);
    const born = KINDS.born.gen(rng);
    if (life) record.life = life;
    if (born) record.born = born;
    const f = {};
    for (const [name, generator] of [['title', KINDS.lww.gen], ['claim', KINDS.fww.gen], ['tier', KINDS.ranked.gen]]) {
      const register = generator(rng);
      if (register) f[name] = register;
    }
    if (Object.keys(f).length) record.f = f;
    return record;
  };
  for (let i = 0; i < TRIALS; i += 1) {
    const [a, b, c] = [recordOf(), recordOf(), recordOf()];
    const join = (x, y) => joinRecord(type, x, y);
    assert.equal(jcs(join(a, a)), jcs(a));
    assert.equal(jcs(join(a, b)), jcs(join(b, a)));
    assert.equal(jcs(join(join(a, b), c)), jcs(join(a, join(b, c))));
    assert.equal(jcs(join(a, {})), jcs(a));
  }
});
