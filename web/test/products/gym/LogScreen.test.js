import test from 'node:test';
import assert from 'node:assert/strict';

import { API_BASE } from '../../../src/shell/apiBase.js';
import { UNDO_MS } from '../../../src/products/gym/fix.js';
import { browserWith, elementsOf, findByClass, loadScreen, renderHook, settle, textOf } from './harness.mjs';

const realFetch = global.fetch;
test.afterEach(() => { global.fetch = realFetch; });

function sessionOnTheWire({ deleteStatus = 204 } = {}) {
  const wire = [];
  const session = { id: 'ses_1', startedAt: 1_755_000_000_000, finishedAt: 1_755_003_600_000 };
  const set = { id: 'set_1', exerciseId: 'back-squat', setNumber: 1, weightKg: 100, reps: 5, kind: 'working', completedAt: 1_755_000_600_000 };
  global.fetch = async (url, options = {}) => {
    const path = url.slice(`${API_BASE}/v1/gym`.length);
    wire.push(`${options.method ?? 'GET'} ${path}`);
    if (path === '/exercises') return { ok: true, status: 200, json: async () => ({ exercises: [{ id: 'back-squat', name: 'Back Squat' }] }) };
    if (path === '/sessions/ses_1') return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ session, sets: [set] }) };
    if (path === '/sessions/ses_1/sets/set_1' && options.method === 'DELETE') {
      return { ok: deleteStatus < 300, status: deleteStatus, json: async () => ({ error: 'internal error' }) };
    }
    throw new Error(`unexpected ${options.method ?? 'GET'} ${path}`);
  };
  return { wire, set };
}

function voice() {
  const spoken = [];
  return {
    spoken,
    log: {
      say: (text, action = null) => spoken.push({ text, action }),
      reloadLog: () => spoken.push({ reloaded: true }),
      catalog: [],
      session: null,
      preferences: {},
    },
  };
}

test('a withheld delete sent on the way out says so again, with no Undo left on the toast', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  browserWith();
  const { wire, set } = sessionOnTheWire();
  const { spoken, log } = voice();
  const { SessionDetail } = await loadScreen('products/gym/Log.jsx');

  const screen = renderHook(t, () => SessionDetail({ id: 'ses_1', log }));
  await settle();
  assert.deepEqual(wire, ['GET /sessions/ses_1', 'GET /exercises']);

  const row = findByClass(screen.tree, 'gym-set')[0];
  assert.notEqual(row, undefined, 'the set row is the door onto the fix');
  row.props.onClick();
  const sheet = elementsOf(screen.tree).find((each) => typeof each.type === 'function' && each.type.name === 'FixSheet');
  assert.notEqual(sheet, undefined);
  sheet.props.onDelete();

  assert.deepEqual(wire, ['GET /sessions/ses_1', 'GET /exercises']);
  assert.equal(spoken.length, 1);
  assert.equal(spoken[0].text, '100 × 5 is out of the log.');
  assert.equal(spoken[0].action.label, 'Undo');
  assert.equal(findByClass(screen.tree, 'gym-set').length, 0);

  t.mock.timers.tick(UNDO_MS - 3000);
  screen.unmount();
  await settle();
  assert.deepEqual(wire, ['GET /sessions/ses_1', 'GET /exercises', 'DELETE /sessions/ses_1/sets/set_1']);
  assert.deepEqual(spoken.slice(1), [
    { text: '100 × 5 is out of the log.', action: null },
    { reloaded: true },
  ]);
  t.mock.timers.tick(UNDO_MS);
  await settle();
  assert.equal(wire.filter((line) => line.startsWith('DELETE')).length, 1);
  assert.equal(set.id, 'set_1');
});

test('a delete refused on the way out says the set is still in the log, after the sentence that said it was out', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  browserWith();
  const { wire } = sessionOnTheWire({ deleteStatus: 500 });
  const { spoken, log } = voice();
  const { SessionDetail } = await loadScreen('products/gym/Log.jsx');

  const screen = renderHook(t, () => SessionDetail({ id: 'ses_1', log }));
  await settle();
  findByClass(screen.tree, 'gym-set')[0].props.onClick();
  elementsOf(screen.tree).find((each) => typeof each.type === 'function' && each.type.name === 'FixSheet').props.onDelete();
  screen.unmount();
  await settle();

  assert.deepEqual(wire.slice(2), ['DELETE /sessions/ses_1/sets/set_1']);
  assert.deepEqual(spoken.map((each) => each.text ?? 'reloaded'), [
    '100 × 5 is out of the log.',
    '100 × 5 is out of the log.',
    'That set is still in the log — the log didn’t answer. Try again when you have signal.',
  ]);
  assert.equal(spoken[2].action, null);
});

test('the log that did not open names its reason, and offers the repair for it', async () => {
  const { LogNotOpen } = await loadScreen('products/gym/Log.jsx');
  const pressed = [];
  const log = (failure) => ({ phase: 'failed', failure, retryBoot: () => pressed.push('retry') });
  const onSignIn = () => pressed.push('sign-in');

  const signedOut = LogNotOpen({ log: log('signed-out'), onSignIn });
  assert.equal(textOf(signedOut), 'Your sign-in lapsed.Sign in');
  findByClass(signedOut, 'gym-retry')[0].props.onClick();
  assert.deepEqual(pressed, ['sign-in']);

  const server = LogNotOpen({ log: log('server'), onSignIn });
  assert.equal(textOf(server), 'The log didn’t answer.Retry');
  assert.equal(/signal/.test(textOf(server)), false);
  findByClass(server, 'gym-retry')[0].props.onClick();
  assert.deepEqual(pressed, ['sign-in', 'retry']);

  const signal = LogNotOpen({ log: log('signal'), onSignIn });
  assert.equal(textOf(signal), 'The log didn’t load. Open it again when you have signal.Retry');
  findByClass(signal, 'gym-retry')[0].props.onClick();
  assert.deepEqual(pressed, ['sign-in', 'retry', 'retry']);
});
