import test from 'node:test';
import assert from 'node:assert/strict';
import { deleteLocalTree, forgetDeviceTrees } from '../../../../src/products/roadmap/sync/localTrees.js';

for (const action of [deleteLocalTree, forgetDeviceTrees]) {
  test(`${action.name} removes obsolete share history and card preferences`, async (t) => {
    const original = globalThis.window;
    const disk = new Map([
      ['windmill:shared:t_old', JSON.stringify({ completed: ['n_private'], history: [{ at: 100, delta: 1 }] })],
      ['windmill:shared:t_orphan', '{}'],
      ['windmill:card:unit', '{"t_old":"day"}'],
      ['windmill:card:ledger', '{"t_old":true}'],
      ['unrelated', 'keep'],
    ]);
    globalThis.window = { localStorage: {
      get length() { return disk.size; },
      key: (index) => [...disk.keys()][index] ?? null,
      getItem: (key) => disk.get(key) ?? null,
      setItem: (key, value) => disk.set(key, value),
      removeItem: (key) => disk.delete(key),
    } };
    t.after(() => { globalThis.window = original; });
    await action('t_old');
    assert.deepEqual([...disk.entries()].filter(([key]) => key.startsWith('windmill:shared:') || key.startsWith('windmill:card:')), []);
    assert.equal(disk.get('unrelated'), 'keep');
  });
}
