import test from 'node:test';
import assert from 'node:assert/strict';

import { API_BASE } from '../../../src/shell/apiBase.js';
import { FROM_ROUTINES, fromSession } from '../../../src/products/gym/log.js';
import { browserWith, elementsOf, findByClass, loadScreen, renderHook, roomLog, settle, textOf } from './harness.mjs';

const realFetch = global.fetch;
test.afterEach(() => { global.fetch = realFetch; });

function recordOnTheWire({ session = null } = {}) {
  const wire = [];
  const record = {
    exercise: { id: 'bench-press', name: 'Bench Press', equipment: 'barbell', custom: false },
    routineCount: 1,
    routines: ['Push A'],
    sessionCount: 0,
    recentDays: [],
  };
  global.fetch = async (url, options = {}) => {
    const at = url.slice(`${API_BASE}/v1/gym`.length);
    wire.push(`${options.method ?? 'GET'} ${at}`);
    if (at === '/exercises/bench-press/record') return { ok: true, status: 200, json: async () => record };
    if (at === '/sessions/ses_9a') {
      if (session === null) return { ok: false, status: 404, json: async () => ({}) };
      if (session === 'refused') return { ok: false, status: 500, json: async () => ({ error: 'internal error' }) };
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ session, sets: [] }) };
    }
    throw new Error(`unexpected ${options.method ?? 'GET'} ${at}`);
  };
  return wire;
}

// The back link and the head under it, as drawn: `BackTo` is the screen's own component, so it is
// rendered here to reach the shared `Back` it hands the link to.
async function recordFrom(t, from) {
  browserWith();
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
  const wire = recordOnTheWire({ session: { id: 'ses_9a', startedAt: 1_755_000_000_000, finishedAt: 1_755_003_600_000, plan: { routine: 'Push A', entries: [] } } });
  const page = await recordFrom(t, fromSession('ses_9a'));
  assert.deepEqual(page.back, { href: '#/gym/session/ses_9a', label: 'Push A' });
  assert.deepEqual(wire, ['GET /exercises/bench-press/record', 'GET /sessions/ses_9a']);
});

test('a workout that is no longer in the log still gets its way back, named as the workout', async (t) => {
  recordOnTheWire({ session: null });
  const page = await recordFrom(t, fromSession('ses_9a'));
  assert.deepEqual(page.back, { href: '#/gym/session/ses_9a', label: 'The workout' });
});

test('a record opened from Routines reads nothing but the record, and goes back to Routines', async (t) => {
  const fromHome = recordOnTheWire();
  assert.deepEqual((await recordFrom(t, FROM_ROUTINES)).back, { href: '#/gym', label: 'Routines' });
  assert.deepEqual(fromHome, ['GET /exercises/bench-press/record']);
});

test('the back link stands on its own line above the name, and Rename shares the name’s row', async (t) => {
  recordOnTheWire();
  const page = await recordFrom(t, FROM_ROUTINES);
  assert.deepEqual(page.order, ['gym-record-screen', 'BackTo', 'gym-record-head']);
  assert.deepEqual(page.head, [['Bench Press', 'Rename']]);
});

test('a session read that fails costs the back link its name, never the record', async (t) => {
  recordOnTheWire({ session: 'refused' });
  const page = await recordFrom(t, fromSession('ses_9a'));
  assert.deepEqual(page.back, { href: '#/gym/session/ses_9a', label: 'The workout' });
  assert.deepEqual(page.head, [['Bench Press', 'Rename']]);
});
