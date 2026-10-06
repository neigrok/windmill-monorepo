import test from 'node:test';
import assert from 'node:assert/strict';

import { FROM_ROUTINES, fromSession } from '../../../src/products/gym/log.js';
import { browserWith, confirmed, elementsOf, findByClass, gymAccount, loadScreen, renderHook, roomLog, settle, textOf } from './harness.mjs';

// Bench Press is a seed movement in one routine, with nothing logged against it yet.
const pushA = confirmed('routine', 'routinePushA', { name: 'Push A', position: 0, entries: [{ exerciseId: 'bench-press' }] });
const workout = confirmed('session', 'session09a0', {
  startedAt: 1_755_000_000_000, finishedAt: 1_755_003_600_000, plan: { routine: 'Push A', entries: [] },
});

// The back link and the head under it, as drawn: `BackTo` is the screen's own component, so it is
// rendered here to reach the shared `Back` it hands the link to.
async function recordFrom(t, from, records = [pushA]) {
  browserWith();
  await gymAccount(t, records);
  const { MovementRecord } = await loadScreen('products/gym/Record.jsx');
  const outer = renderHook(t, () => MovementRecord({ id: 'bench-press', from, log: roomLog() }));
  const drawn = elementsOf(outer.tree)[0];
  const screen = renderHook(t, () => drawn.type(drawn.props));
  await settle();
  const backTo = elementsOf(screen.tree).find((each) => typeof each.type === 'function' && each.type.name === 'BackTo');
  const back = backTo.type(backTo.props);
  return {
    back: { href: back.props.href, label: back.props.children },
    head: findByClass(screen.tree, 'gym-record-head').map((head) => elementsOf(head).slice(1).map(textOf)),
    order: elementsOf(screen.tree).map((each) => (typeof each.type === 'function' ? each.type.name : each.props.className)).slice(0, 3),
  };
}

test('a record opened from a workout names that workout’s routine and returns to it', async (t) => {
  const page = await recordFrom(t, fromSession('session09a0'), [pushA, workout]);
  assert.deepEqual(page.back, { href: '#/gym/session/session09a0', label: 'Push A' });
});

test('a workout that is no longer in the log still gets its way back, named as the workout, and never costs the record', async (t) => {
  const page = await recordFrom(t, fromSession('session09a0'));
  assert.deepEqual(page.back, { href: '#/gym/session/session09a0', label: 'The workout' });
  assert.deepEqual(page.head, [['Bench Press', 'Rename']]);
});

test('a record opened from Routines goes back to Routines', async (t) => {
  assert.deepEqual((await recordFrom(t, FROM_ROUTINES)).back, { href: '#/gym', label: 'Routines' });
});

test('the back link stands on its own line above the name, and Rename shares the name’s row', async (t) => {
  const page = await recordFrom(t, FROM_ROUTINES);
  assert.deepEqual(page.order, ['gym-record-screen', 'BackTo', 'gym-record-head']);
  assert.deepEqual(page.head, [['Bench Press', 'Rename']]);
});
