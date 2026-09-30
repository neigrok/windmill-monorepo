import assert from 'node:assert/strict';
import test from 'node:test';
import { between, compareMembers, dropKey, isOrderKey } from '../../core/fracindex.js';
import { Rng } from '../../vectors/fixtures.js';

test('§11.2 #5: between(a, b) lies strictly between a and b, and is a valid key', () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    const rng = new Rng(seed);
    const keys = [];
    for (let i = 0; i < 400; i += 1) {
      const at = rng.chance(0.2) ? (rng.chance(0.5) ? 0 : keys.length) : rng.int(keys.length + 1);
      const a = at === 0 ? null : keys[at - 1];
      const b = at === keys.length ? null : keys[at];
      const key = between(a, b);
      assert.ok(isOrderKey(key), `${key} is a key`);
      if (a !== null) assert.ok(a < key, `${a} < ${key}`);
      if (b !== null) assert.ok(key < b, `${key} < ${b}`);
      keys.splice(at, 0, key);
    }
    assert.deepEqual([...keys].sort(), keys);
  }
});

test('between refuses equal, descending and malformed keys', () => {
  for (const [a, b] of [['a1', 'a1'], ['a2', 'a1'], ['a10', null], [null, 'a10'], ['!0', null], ['a', null], ['a0 ', null]]) {
    assert.throws(() => between(a, b), `${a}, ${b}`);
  }
});

// D-25: a drop lands where the drawn list shows it, and every other stored member keeps its order,
// held-deleted members included.
test('D-25 drop position: drawn order is the intent; the stored order of the others is kept', () => {
  const rng = new Rng(96);
  for (let run = 0; run < 3000; run += 1) {
    const count = 2 + rng.int(7);
    let key = null;
    const stored = [];
    for (let i = 0; i < count; i += 1) {
      key = rng.chance(0.15) && key !== null ? key : between(key, null);
      stored.push({ id: `m${i}`, key });
    }
    const held = new Set(stored.filter(() => rng.chance(0.3)).map((member) => member.id));
    const drawn = stored.filter((member) => !held.has(member.id));
    if (drawn.length < 2) continue;
    const moved = rng.pick(drawn).id;
    const others = drawn.filter((member) => member.id !== moved).sort(compareMembers);
    const position = rng.int(others.length + 1);
    const above = position === 0 ? null : others[position - 1].id;
    const newKey = dropKey({ stored, drawn, moved, above });
    const place = (list) => list.map((member) => (member.id === moved ? { ...member, key: newKey } : member)).sort(compareMembers).map((member) => member.id);
    const intended = others.map((member) => member.id);
    intended.splice(position, 0, moved);
    const equalKeyAbove = above !== null && others.some((member) => member.id !== above && member.key === others[position - 1].key);
    if (!equalKeyAbove) assert.deepEqual(place(drawn), intended, JSON.stringify({ stored, held: [...held], moved, above }));
    assert.deepEqual(place(stored).filter((id) => id !== moved), [...stored].sort(compareMembers).map((member) => member.id).filter((id) => id !== moved));
  }
});
