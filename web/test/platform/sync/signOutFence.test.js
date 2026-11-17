import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserSyncEngine } from '../../../src/platform/sync/engine.js';
import { environment } from './fakes.js';

test('sign-out without a fence preserves completion behavior', async (t) => {
  const env = environment();
  const engine = await BrowserSyncEngine.open(env.options);
  t.after(() => engine.close());
  env.transport.account = 'A';
  await engine.signIn('A');
  assert.equal((await engine.finishSignOut({ choice: 'keep' })).complete, true);
  assert.equal(engine.device.activeReplica.meta.state, 'anon');
});

test('counted mismatch and store refusal before the callback never fence', async (t) => {
  const env = environment();
  const engine = await BrowserSyncEngine.open(env.options);
  t.after(() => engine.close());
  env.transport.account = 'A';
  await engine.signIn('A');
  await engine.commit('self/probe', [{ op: 'create', t: 'card', id: 'card0001', f: { title: 'private' } }]);
  const calls = [];
  const result = await engine.finishSignOut({ choice: 'discard', counted: [], beforeSignOutCommit: () => calls.push('fence') });
  assert.equal(result.complete, false);
  assert.equal(engine.device.activeReplica.meta.account, 'A');
  const transact = engine.store.transact.bind(engine.store);
  engine.store.transact = () => Promise.reject(new Error('pre-transaction failure'));
  await assert.rejects(engine.finishSignOut({ choice: 'keep', beforeSignOutCommit: () => calls.push('fence') }));
  engine.store.transact = transact;
  assert.deepEqual(calls, []);
});

test('fence sees the published bound holder while the isolated transaction has selected anonymous; persistence failure stays fenced', async (t) => {
  const env = environment();
  const engine = await BrowserSyncEngine.open(env.options);
  t.after(() => engine.close());
  env.transport.account = 'A';
  await engine.signIn('A');
  const before = JSON.stringify(engine.device.toJSON());
  const calls = [];
  const transact = engine.store.transact.bind(engine.store);
  engine.store.transact = (change, options) => transact(change, { ...options, beforeCommit: ({ transaction }) => {
    calls.push(['persistence', engine.device.activeReplica.meta.account]);
    transaction.abort();
  } });
  await assert.rejects(engine.finishSignOut({ choice: 'keep', beforeSignOutCommit: () => {
    assert.equal(JSON.stringify(engine.device.toJSON()), before);
    calls.push(['fence', engine.device.activeReplica.meta.account]);
  } }));
  engine.store.transact = transact;
  assert.deepEqual(calls, [['fence', 'A'], ['persistence', 'A']]);
  assert.equal(engine.device.activeReplica.meta.account, 'A');
  const stored = (await engine.store.read()).device;
  assert.equal(stored.activeReplica.meta.account, 'A');
});

test('throwing or asynchronous fences abort before persistence and publication', async (t) => {
  const env = environment();
  const engine = await BrowserSyncEngine.open(env.options);
  t.after(() => engine.close());
  env.transport.account = 'A';
  await engine.signIn('A');
  for (const callback of [() => { throw new Error('fence failed'); }, () => Promise.resolve()]) {
    await assert.rejects(engine.finishSignOut({ choice: 'keep', beforeSignOutCommit: callback }));
    assert.equal(engine.device.activeReplica.meta.account, 'A');
    assert.equal((await engine.store.read()).device.activeReplica.meta.account, 'A');
  }
  assert.ok(env.failures.length >= 2);
});

test('fence precedes persistence and stays visible while committed publication is suspended', async (t) => {
  const env = environment();
  const engine = await BrowserSyncEngine.open(env.options);
  t.after(() => engine.close());
  env.transport.account = 'A';
  await engine.signIn('A');
  const transact = engine.store.transact.bind(engine.store);
  let resume;
  let stored;
  const held = new Promise((resolve) => { resume = resolve; });
  const persisted = new Promise((resolve) => { stored = resolve; });
  const sequence = [];
  engine.store.transact = async (change, options) => {
    const answer = await transact(change, { ...options, beforeCommit: () => sequence.push('persist') });
    stored();
    await held;
    return answer;
  };
  const departure = engine.finishSignOut({ choice: 'keep', beforeSignOutCommit: () => sequence.push('fence') });
  await persisted;
  assert.deepEqual(sequence, ['fence', 'persist']);
  assert.equal(engine.device.activeReplica.meta.account, 'A');
  engine.store.transact = transact;
  assert.equal((await engine.store.read()).device.activeReplica.meta.state, 'anon');
  resume();
  assert.equal((await departure).complete, true);
  assert.equal(engine.device.activeReplica.meta.state, 'anon');
});
