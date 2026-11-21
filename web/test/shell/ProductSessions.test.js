// The seam a product session reaches the account menu by: a row it offers while it has something to say, which the shell
// reads without naming the product, and which leaves when the session withdraws it or unmounts.

import test from 'node:test';
import assert from 'node:assert/strict';
import { loadScreen, renderHook } from '../products/gym/harness.mjs';

test('a session\'s offered row reaches the shell\'s reader, changes with it, and leaves when withdrawn or unmounted', async (t) => {
  const { useAccountRowOffer, useOfferedAccountRows } = await loadScreen('shell/ProductSessions.jsx');
  const onSelect = () => {};
  const offer = { row: { label: 'Kept here', count: 1, onSelect } };
  const shell = renderHook(t, () => useOfferedAccountRows(), { live: true });
  const session = renderHook(t, () => useAccountRowOffer(offer.row));
  assert.deepEqual(shell.tree, [{ label: 'Kept here', count: 1, onSelect }]);
  offer.row = { label: 'Kept here', count: 2, onSelect };
  session.redraw();
  assert.deepEqual(shell.tree, [{ label: 'Kept here', count: 2, onSelect }]);
  offer.row = null;
  session.redraw();
  assert.deepEqual(shell.tree, []);
  offer.row = { label: 'Kept here', count: 3, onSelect };
  session.redraw();
  assert.deepEqual(shell.tree, [{ label: 'Kept here', count: 3, onSelect }]);
  session.unmount();
  assert.deepEqual(shell.tree, []);
});
