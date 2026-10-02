import assert from 'node:assert/strict';
import test from 'node:test';
import { CONSTANTS } from '../../core/constants.js';
import { jcs } from '../../core/jcs.js';
import { serverCall } from '../../server/requests.js';
import { ServerState } from '../../server/state.js';
import { product, productScope, registry, serverState } from '../../vectors/fixtures.js';

const card = (id, title) => ({ scope: 'self/probe', d: [{ t: 'card', id, born: null, life: ['alive', null], f: { title: [title, null] } }] });
const base = () => new ServerState(serverState({ scopes: { 'acct:A/probe': productScope('A') } }));
const call = (state, extra) => serverCall({ state, registry, product, account: 'A', requestId: 'req-1', tool: 'cards.add', args: { n: 2 }, intents: [card('card0001', 'One'), card('card0002', 'Two')], serverNow: 1_000_000, ...extra });

test('a call stores each admit as a part, stamps its intents with the requestId as gestureId, and ends done', () => {
  const out = call(base());
  assert.deepEqual(out.result, { s: 'ok', seq: 2 });
  const row = out.state.requests.A['req-1'];
  assert.deepEqual({ ...row, digest: undefined }, {
    requestId: 'req-1',
    digest: undefined,
    state: 'done',
    startedAt: 1_000_000,
    parts: [{ k: 1, result: { s: 'ok', seq: 1 } }, { k: 2, result: { s: 'ok', seq: 2 } }],
    result: { s: 'ok', seq: 2 },
  });
  assert.deepEqual(out.frames.map(({ key, frame }) => [key, frame.seq]), [['acct:A/probe', 1], ['acct:A/probe', 2]]);
});

test('a replay of a done call answers its result and changes nothing', () => {
  const first = call(base());
  const again = call(first.state, { serverNow: 2_000_000 });
  assert.deepEqual(again.result, { s: 'ok', seq: 2 });
  assert.equal(jcs(again.state.toJSON()), jcs(first.state.toJSON()));
  assert.deepEqual(again.frames, []);
});

test('a crashed call is running within its lease and is taken over after it', () => {
  const crashed = call(base(), { crashAfter: 1 });
  assert.equal(crashed.result, null);
  assert.equal(crashed.state.requests.A['req-1'].state, 'running');
  const early = call(crashed.state, { serverNow: 1_000_000 + CONSTANTS.REQUEST_LEASE_MS - 1 });
  assert.deepEqual(early.result, { s: 'refused', code: 'request-running' });
  assert.equal(jcs(early.state.toJSON()), jcs(crashed.state.toJSON()));
  const late = call(crashed.state, { serverNow: 1_000_000 + CONSTANTS.REQUEST_LEASE_MS });
  assert.deepEqual(late.result, { s: 'ok', seq: 2 });
  assert.deepEqual(late.state.requests.A['req-1'].parts.map((part) => part.k), [1, 2]);
  assert.deepEqual(late.state.rowsOf('acct:A/probe').map((row) => [row.id, row.born]).sort(), [['card0001', '1000000:0:srv'], ['card0002', '1060000:0:srv']]);
});

test('other arguments under one requestId are request-conflict, whatever the call state', () => {
  const crashed = call(base(), { crashAfter: 1 });
  assert.deepEqual(call(crashed.state, { args: { n: 3 } }).result, { s: 'refused', code: 'request-conflict' });
  const done = call(base());
  assert.deepEqual(call(done.state, { args: { n: 3 } }).result, { s: 'refused', code: 'request-conflict' });
});

test('requestIds are per account', () => {
  const first = call(base());
  const other = serverCall({ state: first.state, registry, product, account: 'B', requestId: 'req-1', tool: 'cards.add', args: { n: 2 }, intents: [card('card000b', 'Bee')], serverNow: 1_000_000 });
  assert.deepEqual(other.result, { s: 'ok', seq: 1 });
});

test('prototype names are ordinary request ids with stored parts and exact replay', () => {
  for (const requestId of ['constructor', 'toString', 'hasOwnProperty', '__proto__']) {
    const first = call(base(), { requestId });
    assert.deepEqual(first.result, { s: 'ok', seq: 2 }, requestId);
    assert.equal(Object.hasOwn(first.state.requests.A, requestId), true, requestId);
    const restarted = new ServerState(first.state.toJSON());
    const again = call(restarted, { requestId, serverNow: 2_000_000 });
    assert.deepEqual(again.result, first.result, requestId);
    assert.deepEqual(again.state.toJSON(), first.state.toJSON(), requestId);
    assert.equal(call(restarted, { requestId, args: { n: 3 } }).result.code, 'request-conflict', requestId);
  }
});
