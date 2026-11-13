import test from 'node:test';
import assert from 'node:assert/strict';
import { renderHook } from '../../gym/harness.mjs';
import { useRoomHolder } from '../../../../src/products/roadmap/room/useRoomAuthority.js';
import { LocalTreeRegistry } from '../../../../src/products/roadmap/persistence/LocalTreeRegistry.js';

test('whoever is at the device holds a tree that lives only here, signed in or not, until a claim takes it to the account', (t) => {
  const disk = new Map([['windmill:device-trees', JSON.stringify({
    t_draft: { title: 'A draft', updatedAt: 2, claimed: false, owner: null },
    t_year: { title: 'My year', updatedAt: 1, claimed: true, owner: 'u_olya' },
  })]]);
  const registry = new LocalTreeRegistry({ getItem: (key) => disk.get(key) ?? null, setItem: (key, value) => disk.set(key, value) });
  const olya = { id: 'u_olya' };
  const room = { owner: true, treeId: 't_draft', account: null, confirmed: false, lapsed: false, claims: 0 };
  const hook = renderHook(t, () => useRoomHolder({ ...room, registry }));
  const holderAt = (changes) => {
    Object.assign(room, changes);
    hook.redraw();
    return hook.tree;
  };

  assert.deepEqual(hook.tree, { place: 'device' });
  const signedIn = holderAt({ account: olya, confirmed: true });
  assert.deepEqual(signedIn, { place: 'device' });
  assert.equal(holderAt({ lapsed: true }), signedIn, 'the device holds it through a lapse, and the answer stands as it was');

  registry.attribute(['t_draft'], 'u_olya');
  assert.equal(holderAt({ lapsed: false }), signedIn, 'nothing asks again until a claim lands');
  assert.deepEqual(holderAt({ claims: 1 }), { place: 'account', account: 'u_olya' });

  assert.deepEqual(holderAt({ treeId: 't_year' }), { place: 'account', account: 'u_olya' });
  assert.equal(holderAt({ lapsed: true }), null);
  assert.equal(holderAt({ lapsed: false, confirmed: false }), null);
  assert.equal(holderAt({ confirmed: true, owner: false }), null);
  assert.equal(holderAt({ treeId: 't_draft' }), null, 'a reader holds nothing, wherever the tree lives');
});
