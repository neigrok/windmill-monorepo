// Kept here beside every room: roadmap's notices in every scope offered as the account menu's row while the list shows a
// change, the row's count the list's count, withdrawn once the last change is discarded, and each notice told once.

import test from 'node:test';
import assert from 'node:assert/strict';
import { browserWith, gymAccount, loadScreen, renderHook, settle } from '../../gym/harness.mjs';

const stamp = '1000:0:r_aaaaaaaaaaaa';
const notice = (n, scope, d, code = 'scope-dead') => ({ id: `notice:g${n}/0`, scope, code, content: { d }, at: 1800000000000 });

test('the account menu is offered Kept here with the count of changes the list shows, the list opens from it, and the row leaves with the last change', async (t) => {
  browserWith();
  Object.assign(globalThis.window, { setTimeout: () => 0, clearTimeout: () => {} });
  const { engine } = await gymAccount(t);
  await engine.write(null, (device) => device.activeReplica.notices.push(
    notice(1, 'tree/t_0000000000000001', [{ t: 'node', id: 'a', f: { label: ['Read the wind', stamp], description: ['Spot the shifts.', stamp] } }]),
    notice(2, 'self/overlay/t_0000000000000001', [{ t: 'progress', id: 'a', f: { mark: [{ status: 'complete', outOfOrder: false }, stamp] } }]),
    notice(3, 'tree/t_0000000000000001', [{ t: 'node', id: 'b', f: { label: ['Odd', stamp] } }], 'invalid'),
    notice(4, 'self/gym', [{ t: 'routine', id: 'r1', f: { name: ['Push', stamp] } }]),
  ));
  const { useOfferedAccountRows } = await loadScreen('shell/ProductSessions.jsx');
  const { KeptHere } = await loadScreen('products/roadmap/kept/KeptHere.jsx');
  const menu = renderHook(t, () => useOfferedAccountRows(), { live: true });
  const kept = renderHook(t, () => KeptHere(), { live: true });
  await settle();
  assert.deepEqual(menu.tree.map(({ label, count }) => ({ label, count })), [{ label: 'Kept here', count: 1 }]);
  assert.deepEqual(JSON.parse(globalThis.window.localStorage.getItem('windmill:roadmap:kept-told')), ['notice:g1/0', 'notice:g2/0', 'notice:g3/0'],
    'every notice of roadmap\'s is told or reported once, a change that cannot land whether or not the list shows it');
  assert.equal(kept.tree, null);

  menu.tree[0].onSelect();
  const list = kept.tree.props.children;
  assert.equal(list.type.name, 'KeptList');
  assert.deepEqual(list.props.notices.map(({ id }) => id), ['notice:g1/0', 'notice:g2/0', 'notice:g3/0']);

  await engine.dismissNotice('notice:g1/0');
  await settle();
  assert.deepEqual(menu.tree, [], 'a list with nothing to show offers no row');
});
