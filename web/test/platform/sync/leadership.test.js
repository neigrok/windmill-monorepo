import assert from 'node:assert/strict';
import test from 'node:test';
import { TabLeadership } from '../../../src/platform/sync/leadership.js';
import { FakeLocks, FakeChannels, until, tick } from './fakes.js';

function tabs() {
  const locks = new FakeLocks(), channels = new FakeChannels(), events = [];
  let replica = 'account-A';
  const open = (id, visible = true) => new TabLeadership({ locks, channel: channels.open, store: 3, id, visible,
    readReplica: async () => replica, onLeader: (leader) => events.push({ id, leader }), onMessage: () => {} });
  return { locks, channels, events, open, reidentify: () => { replica = 'account-B'; } };
}

test('two tabs have one exclusive sender; the follower acquires leadership when the leader closes', async () => {
  const env = tabs();
  const a = env.open('a'), b = env.open('b');
  assert.equal(await a.start('account-A'), true);
  assert.equal(await b.start('account-A'), false);
  await until(() => a.leader);
  assert.equal(b.leader, false);
  assert.equal((await env.locks.query()).held.filter(({ name }) => name === 'wm-sync@3:account-A').length, 1);
  a.close();
  await until(() => b.leader);
  b.close();
  await tick();
  assert.deepEqual((await env.locks.query()).held, []);
});

test('a hidden leader yields to a visible peer; no second tab is mistaken for first', async () => {
  const env = tabs();
  const a = env.open('a'), b = env.open('b', false);
  await a.start('account-A'); await b.start('account-A');
  await until(() => a.leader && a.peers.size === 1);
  a.setVisible(false);
  assert.equal(a.leader, true);
  b.setVisible(true);
  await until(() => b.leader && !a.leader);
  assert.equal(env.events.filter(({ id, leader }) => id === 'b' && leader).length, 1);
  a.close(); b.close();
});

test('both tabs rekey their channel and lock after an active-replica change', async () => {
  const env = tabs();
  const a = env.open('a'), b = env.open('b');
  await a.start('account-A'); await b.start('account-A');
  await until(() => a.leader);
  env.reidentify();
  a.post({ type: 'activeReplicaChanged', previous: 'account-A', replica: 'account-B' });
  a.rekey('account-B');
  await until(() => b.replica === 'account-B' && (a.leader || b.leader));
  assert.equal(env.channels.channels.size, 2);
  assert.ok([...env.channels.channels].every(({ name }) => name === 'wm-sync@3:account-B'));
  a.close(); b.close();
});

test('simultaneous tab starts designate exactly one first tab', async () => {
  const env = tabs(), a = env.open('a'), b = env.open('b');
  const first = await Promise.all([a.start('account-A'), b.start('account-A')]);
  assert.deepEqual(first.sort(), [false, true]);
  await until(() => a.leader || b.leader);
  assert.notEqual(a.leader, b.leader);
  a.close(); b.close();
});

test('closing a tab during startup does not acquire or leak a later shared lock', async () => {
  const env = tabs(); let release;
  const blocker = env.locks.request('wm-tab-start@3', () => new Promise((resolve) => { release = resolve; }));
  await until(() => Boolean(release));
  const tab = env.open('a');
  const start = tab.start('account-A');
  tab.close(); release();
  await blocker; await start; await tick();
  assert.deepEqual((await env.locks.query()).held, []);
  assert.equal(env.channels.channels.size, 0);
});

// The released bundle names its locks and channel without the store version. An upgrade closes its store, and it keeps
// holding them until its page closes.
test('a tab cut off by an upgrade, holding the released bundle\'s locks, blocks no tab of this store version', async () => {
  const env = tabs();
  const forever = () => new Promise(() => {});
  env.locks.request('wm-tab', { mode: 'shared' }, forever);
  env.locks.request('wm-sync:account-A', forever);
  const released = env.channels.open('wm-sync:account-A');
  const tab = env.open('a');
  assert.equal(await tab.start('account-A'), true);
  await until(() => tab.leader);
  released.postMessage({ type: 'hello', visible: true, tab: 'released' });
  await tick();
  assert.equal(tab.lastTab(), true);
  assert.deepEqual(env.channels.messages.filter(({ name }) => name === 'wm-sync:account-A'), [
    { name: 'wm-sync:account-A', data: { type: 'hello', visible: true, tab: 'released' } }]);
  assert.deepEqual((await env.locks.query()).held.map(({ name }) => name).sort(),
    ['wm-sync:account-A', 'wm-sync@3:account-A', 'wm-tab', 'wm-tab@3']);
  tab.close();
});
