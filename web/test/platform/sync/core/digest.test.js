import assert from 'node:assert/strict';
import test from 'node:test';
import { ZERO_DIGEST, fromHex, replaceRow, rowHash, scopeDigest } from '../../../../src/platform/sync/core/digest.js';
import { recordKey } from '../../../../src/platform/sync/core/rows.js';
import { Rng, row, st } from '../oracle-adapters/fixtures.js';

function randomRow(rng, id, seq) {
  const life = rng.chance(0.2) ? ['dead', st(seq)] : ['alive', st(seq)];
  const f = rng.chance(0.8) ? { title: [`t${rng.int(50)}`, st(seq)] } : undefined;
  return row({ t: rng.pick(['card', 'tag']), id, life, born: st(1), f, seq });
}

test('§11.2 #6: a digest maintained over inserts, replacements and deletions equals the recount', () => {
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const rng = new Rng(seed);
    const rows = new Map();
    let digest = ZERO_DIGEST;
    for (let seq = 1; seq <= 300; seq += 1) {
      const id = `row${rng.int(25)}`;
      const t = rows.get(id)?.t;
      const before = rows.get(id);
      let after;
      if (before && rng.chance(0.25)) after = undefined;
      else after = { ...randomRow(rng, id, seq), ...(t ? { t } : {}) };
      digest = replaceRow(digest, before, after);
      if (after) rows.set(id, after);
      else rows.delete(id);
      assert.equal(digest, scopeDigest([...rows.values()]), `seed ${seed}, seq ${seq}`);
    }
  }
});

test('§6.12: the scope digest is a sum mod 2^256, blind to order, dead rows and absent rows', () => {
  const rng = new Rng(9);
  const rows = Array.from({ length: 40 }, (_, i) => randomRow(rng, `r${i}`, i + 1));
  const shuffled = [...rows].reverse();
  assert.equal(scopeDigest(rows), scopeDigest(shuffled));
  const sum = rows.reduce((total, r) => total + rowHash(r), 0n) % (1n << 256n);
  assert.equal(fromHex(scopeDigest(rows)), sum);
  assert.equal(scopeDigest([]), ZERO_DIGEST);
  assert.equal(replaceRow(ZERO_DIGEST, undefined, undefined), ZERO_DIGEST);
  assert.equal(rowHash(row({ t: 'card', id: 'x', life: ['dead', st(2)], born: st(1), seq: 2 })), 0n);
  assert.equal(new Set(rows.map((r) => recordKey(r.t, r.id))).size, rows.length);
});
