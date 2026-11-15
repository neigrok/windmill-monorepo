import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserSyncEngine } from '../../../src/platform/sync/engine.js';
import { isStaleTurn } from '../../../src/platform/agent/turn.js';
import { environment, until } from './fakes.js';

test('two replicas with skewed clocks expose the same server age only on their actual live scope', async () => {
  const engines = [];
  try {
    for (const skew of [-900000, 900000]) {
      const env = environment();
      env.timers.time = 2_000_000;
      env.options.now = () => env.timers.time + skew;
      const request = env.transport.request.bind(env.transport);
      env.transport.request = async (...args) => {
        const value = await request(...args);
        for (const time of [value.timing.send, value.timing.recv]) time.wall += skew;
        return value;
      };
      const engine = await BrowserSyncEngine.open(env.options); engines.push(engine); engine.boot = 'test';
      engine.observe('self/probe'); await engine.start(); await until(() => engine.leader);
      env.transport.account = 'A'; await engine.signIn('A'); await until(() => engine.leader);
      await engine.pull();
      assert.deepEqual(engine.freshness('self/probe'), { syncLive: false, serverNow: null });
      engine.follow();
      const socket = env.sockets.at(-1);
      assert.ok(socket); socket.readyState = 1; socket.onopen();
      assert.deepEqual(engine.freshness('self/probe'), { syncLive: true, serverNow: 2_000_000 });
      assert.equal(isStaleTurn({ state: 'running', serverUpdatedAt: 200000 }, engine.freshness('self/probe')), true);
      assert.equal(isStaleTurn({ state: 'running', serverUpdatedAt: 200001 }, engine.freshness('self/probe')), false);
      assert.deepEqual(engine.freshness('tree/unfollowed'), { syncLive: false, serverNow: null });
      engine.signOutOpening = true;
      assert.deepEqual(engine.freshness('self/probe'), { syncLive: false, serverNow: null });
      engine.signOutOpening = false;
      engine.setOnline(false);
      assert.deepEqual(engine.freshness('self/probe'), { syncLive: false, serverNow: null });
    }
  } finally { for (const engine of engines) engine.close(); }
});

test('staleness never uses a local clock, missing server time, or a non-running state', () => {
  for (const freshness of [{ syncLive: false, serverNow: 9e12 }, { syncLive: true, serverNow: null }, { syncLive: false, serverNow: null }])
    assert.equal(isStaleTurn({ state: 'running', serverUpdatedAt: 0 }, freshness), false);
  assert.equal(isStaleTurn({ state: 'completed', serverUpdatedAt: 0 }, { syncLive: true, serverNow: 9e12 }), false);
  assert.equal(isStaleTurn({ state: 'running', serverUpdatedAt: null }, { syncLive: true, serverNow: 9e12 }), false);
});
