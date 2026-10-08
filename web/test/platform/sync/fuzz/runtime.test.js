import assert from 'node:assert/strict';
import test from 'node:test';
import { BrowserSyncEngine } from '../../../../src/platform/sync/engine.js';
import { isAlive, latticeOf, compareRecords } from '../../../../../packages/api-contract/sync/reference/core/rows.js';
import { Rng } from '../oracle-adapters/fixtures.js';
import { environment, until } from '../fakes.js';

for (let seed = 1; seed <= 20; seed++) {
  test(`IndexedDB runtime replay: seed ${seed}, 80 steps, request/reply loss, duplicate replies, reload, holds and auth expiry`, { timeout: 60_000 }, async (t) => {
    const coverage = { 'request lost': 0, 'reply lost': 0, 'duplicate reply': 0, 'reload': 0, 'hold undo': 0, 'auth expiry': 0 };
    const env = environment(), rng = new Rng(seed);
    const open = async () => {
      const engine = await BrowserSyncEngine.open(env.options);
      engine.observe('self/probe');
      await engine.start(); await until(() => engine.leader); return engine;
    };
    let engine = await open();
    t.after(() => engine.close());
    env.transport.account = 'A'; await engine.signIn('A'); await until(() => engine.leader);
    const request = env.transport.request.bind(env.transport);
    for (let step = 0; step < 80; step++) {
      env.timers.time += 1000;
      const result = await engine.commit('self/probe', [{ op: 'put', t: 'day', id: `2026-10-0${1 + rng.int(5)}`,
        present: true, f: { score: rng.int(11) } }], { hold: step % 9 === 0 });
      if (step % 9 === 0 && result.localIds.length) {
        coverage['hold undo']++;
        assert.equal(await engine.undo(engine.device.activeReplica.entry(result.localIds[0]).gestureId), true);
      }
      const fault = step % 13;
      env.transport.request = async (endpoint, body, options) => {
        if (endpoint !== 'push') return request(endpoint, body, options);
        if (fault === 0) { coverage['request lost']++; throw new Error('offline'); }
        const answer = await request(endpoint, body, options);
        if (fault === 1) { coverage['reply lost']++; throw new Error('lost reply'); }
        if (fault === 2) { coverage['duplicate reply']++; return request(endpoint, body, options); }
        return answer;
      };
      await engine.send();
      env.transport.request = request;
      if (step % 17 === 0) {
        coverage['auth expiry']++;
        env.transport.account = null; engine.kickPull(); await engine.pull();
        assert.equal(engine.device.activeReplica.meta.authPaused, true);
        env.transport.account = 'A'; await engine.signIn('A');
      }
      if (step % 19 === 0) { coverage.reload++; engine.close(); engine = await open(); }
      engine.kick(); await engine.send(); engine.kickPull(); await engine.pull();
    }
    for (let i = 0; i < 10 && engine.device.activeReplica.outbox.length; i++) {
      env.timers.time += 300_000; engine.kick(); await engine.send(); engine.kickPull(); await engine.pull();
    }
    assert.deepEqual(engine.device.activeReplica.outbox, [], `seed ${seed}: pending work`);
    const actual = engine.observe('self/probe').getSnapshot().drawn;
    const expected = env.state.rowsOf('acct:A/probe').filter(isAlive).sort(compareRecords)
      .map((row) => ({ t: row.t, id: row.id, ...latticeOf(row), seq: row.seq, rc: row.rc, ru: row.ru }));
    assert.deepEqual(actual, expected, `seed ${seed}: convergence`);
    assert.equal(engine.device.activeReplica.cursorOf('self/probe').digest, env.state.scope('acct:A/probe').digest);
    for (const [event, count] of Object.entries(coverage)) assert.ok(count > 0, `seed ${seed}: missing fault ${event}`);
    t.diagnostic(JSON.stringify({ seed, coverage }));
  });
}

import { Device } from '../../../../../packages/api-contract/sync/reference/client/replica.js';
import { Cursor } from '../../../../../packages/api-contract/sync/reference/core/wire.js';
import { scopeDigest } from '../../../../../packages/api-contract/sync/reference/core/digest.js';
import { registry, product } from '../oracle-adapters/fixtures.js';
import { push } from '../../../../../packages/api-contract/sync/reference/server/push.js';
import { pull, frameFor, liveFrameOf } from '../../../../../packages/api-contract/sync/reference/server/pull.js';
import { CONSTANTS } from '../../../../../packages/api-contract/sync/reference/core/constants.js';
import { admit } from '../../../../../packages/api-contract/sync/reference/server/admit.js';

const runtimeFaults = ['drop request', 'duplicate', 'delay', 'reorder', 'lost reply', 'local abort',
  'result death', 'chunk death', 'settling death', 'more with frame', 'clock ahead', 'clock behind', 'clock jump',
  'hold', 'undo', 'retire', 'supersede', 'leave', 'recreation', 'tabs', 'silent add', 'incomplete sign-in',
  'decision add', 'decision discard', 'sign-out keep', 'sign-out discard', '401', 'anonymous credential',
  'foreign credential', 'account mismatch', 'poison', 'epoch', 'snapshot restore', 'clone'];

for (let seed = 1; seed <= 20; seed++) {
  test(`persisted runtime fault replay: seed ${seed} exercises every §11.3 fault, with per-reply isolation and durable restart checks`, { timeout: 60_000 }, async (t) => {
    const env = environment(), rng = new Rng(seed), observed = new Set(), ended = new Set(), committed = new Set();
    let engine, peer;
    const hit = (fault) => observed.add(fault);
    const open = async () => {
      const next = await BrowserSyncEngine.open(env.options);
      next.observe('self/probe');
      let announced = next.activeReplica();
      next.onEvent((event) => { assert.equal(event.previous, announced, `seed ${seed}: duplicate or skipped active event`); announced = event.replica; });
      const original = next.write.bind(next);
      next.write = async (operation, change, scopes) => {
        let context;
        const result = await original(operation, (device, ctx) => { context = ctx; return change(device, ctx); }, scopes);
        for (const entry of context.ended) { assert.ok(!ended.has(entry.localId), `seed ${seed}: gesture ended twice`); ended.add(entry.localId); }
        assert.equal(announced, next.activeReplica(), `seed ${seed}: missing active event`);
        return result;
      };
      const commit = next.commit.bind(next);
      next.commit = async (...args) => { const result = await commit(...args); result.localIds.forEach((id) => committed.add(id)); return result; };
      await next.start(); await until(() => next.leader); return next;
    };
    const restart = async () => { engine.close(); engine = await open(); hit('recreation'); };
    const put = async (score = rng.int(11), opts = {}) => {
      if (engine.observe('self/probe').getSnapshot().drawn.find((row) => row.t === 'day' && row.id === '2026-10-04')?.f?.score?.[0] === score) score = (score + 1) % 11;
      const result = await engine.commit('self/probe', [{ op: 'put', t: 'day', id: '2026-10-04', present: true, f: { score } }], opts);
      result.localIds.forEach((id) => committed.add(id)); return result;
    };
    const drain = async () => {
      await until(() => engine.leader);
      for (let i = 0; i < 50; i++) {
        env.timers.time += 300_000; engine.kick(); await engine.send(); engine.kickPull(); await engine.pull();
        if (!engine.device.activeReplica.outbox.length && !engine.pullDirty.size) break;
        if (!engine.leader) await until(() => engine.leader);
      }
      assert.deepEqual(engine.device.activeReplica.outbox, [], `seed ${seed}: pending intents`);
      assert.equal(engine.device.activeReplica.meta.authPaused, false);
      const actual = engine.observe('self/probe').getSnapshot().drawn;
      const expected = env.state.rowsOf('acct:A/probe').filter(isAlive).sort(compareRecords).map((row) => ({ t: row.t, id: row.id, ...latticeOf(row), seq: row.seq, rc: row.rc, ru: row.ru }));
      assert.deepEqual(actual, expected, `seed ${seed}: convergence`);
      assert.equal(engine.device.activeReplica.cursorOf('self/probe').digest, env.state.scope('acct:A/probe').digest);
      const device = (await engine.store.read()).device;
      for (const replica of device.replicas) assert.deepEqual(replica.outbox, []);
      for (const scope of engine.scopes()) {
        const key = scope.startsWith('tree/') ? `tree:${scope.slice(5)}` : scope.startsWith('self/overlay/') ? `acct:A/overlay/${scope.split('/').at(-1)}` : `acct:A/${scope.slice(5)}`;
        assert.deepEqual(device.activeReplica.confirmedRows(scope).sort(compareRecords), env.state.rowsOf(key).filter(isAlive).sort(compareRecords), `seed ${seed}: ${scope}`);
      }
      for (const [key, state] of Object.entries(env.state.scopes)) {
        const cards = env.state.rowsOf(key).filter((row) => row.t === 'card' && isAlive(row)).length;
        assert.equal(state.counters.card ?? 0, cards); assert.ok(cards <= 3);
      }
      for (const [scope, kind] of Object.entries(device.activeReplica.known)) {
        const tree = env.state.scope(`tree:${scope.split('/').at(-1)}`);
        assert.ok(kind !== 'not-found' || tree?.state !== 'alive' || tree.owner !== 'A');
      }
      assert.ok(!env.events.some((event) => event.name === 'sync-digest-mismatch'));
    };
    const pulled = async () => {
      const replica = (await engine.store.read()).device.activeReplica;
      return { confirmed: replica.confirmed, cursors: replica.cursors, known: replica.known };
    };
    try {
      engine = await open();
      await put(0);
      const old = await put(6, { hold: true });
      await put(5, { supersede: [engine.device.activeReplica.entry(old.localIds[0]).gestureId] }); hit('supersede');
      env.transport.account = 'A';
      assert.equal((await engine.signIn('A')).complete, true); hit('silent add');
      await until(() => engine.leader); await drain();
      const request = env.transport.request.bind(env.transport);
      await put();
      env.transport.request = async (endpoint, body, options) => {
        if (endpoint === 'push') { hit('drop request'); throw new Error('dropped'); }
        return request(endpoint, body, options);
      };
      await engine.send(); assert.ok(engine.device.activeReplica.outbox.some((entry) => entry.state === 'sent'));
      env.transport.request = async (endpoint, body, options) => {
        const answer = await request(endpoint, body, options);
        if (endpoint === 'push') { hit('lost reply'); throw new Error('reply lost'); }
        return answer;
      };
      env.timers.time += 60_000; engine.kick(); await engine.send();
      env.transport.request = async (endpoint, body, options) => {
        const answer = await request(endpoint, body, options);
        if (endpoint === 'push') { hit('duplicate'); return request(endpoint, body, options); }
        return answer;
      };
      env.timers.time += 60_000; engine.kick(); await engine.send(); env.transport.request = request;
      await drain();
      const stale = await request('pull', { scopes: [{ scope: 'self/probe', cursor: null }] });
      const staleCursor = engine.device.activeReplica.cursorOf('self/probe').cursor;
      await put(); await drain();
      assert.equal(await engine.storePage(engine.device.activeReplica.storageHandle, staleCursor, stale.response.body.pages[0]), 'stale'); hit('reorder'); hit('delay');
      const transact = engine.store.transact.bind(engine.store);
      engine.store.transact = (change, options) => transact(change, { ...options, beforeCommit: ({ transaction }) => transaction.abort() });
      const beforeAbort = (await transact((device) => device, { readonly: true, scopes: 'all' })).device.toJSON();
      await assert.rejects(put()); hit('local abort'); engine.store.transact = transact;
      assert.deepEqual((await engine.store.read()).device.toJSON(), beforeAbort);
      const held = await put(8, { hold: true }); hit('hold');
      assert.equal(await engine.undo(engine.device.activeReplica.entry(held.localIds[0]).gestureId), true); hit('undo');
      await engine.commit('self/probe', [{ op: 'put', t: 'day', id: '2026-10-04', present: false }], { hold: true });
      const retired = await put(7, { retire: [{ t: 'day', id: '2026-10-04' }] }); assert.ok(retired.retired.length); hit('retire');
      await engine.leave(); hit('leave'); await drain();
      peer = await BrowserSyncEngine.open(env.options); peer.observe('self/probe'); await peer.start();
      const second = await peer.commit('self/probe', [{ op: 'put', t: 'day', id: '2026-10-05', present: true, f: { score: rng.int(11) } }]);
      second.localIds.forEach((id) => committed.add(id));
      await until(() => engine.device.activeReplica.entry(second.localIds[0])); hit('tabs'); peer.close(); peer = null; await drain();
      for (const [fault, account] of [['401', null], ['foreign credential', 'B'], ['anonymous credential', null]]) {
        const before = await pulled();
        env.transport.account = account;
        if (fault === '401') env.transport.response = async () => ({ response: { status: 401, body: null }, timing: { send: engine.reading(), recv: engine.reading() } });
        engine.kickPull(); await engine.pull();
        assert.equal(engine.device.activeReplica.meta.authPaused, true); assert.deepEqual(await pulled(), before); hit(fault);
        env.transport.response = null; env.transport.account = 'A'; await engine.signIn('A');
      }
      await put(); env.transport.account = 'B';
      const beforeMismatch = await pulled(); await engine.send();
      assert.equal(engine.device.activeReplica.meta.authPaused, true); assert.deepEqual(await pulled(), beforeMismatch); hit('account mismatch');
      env.transport.account = 'A'; await engine.signIn('A'); await drain();
      for (const [fault, delta] of [['clock ahead', 600_000], ['clock behind', -600_000]]) {
        const realNow = engine.now;
        engine.now = () => env.timers.time + delta;
        await put(); hit(fault); engine.now = realNow;
        await drain();
      }
      env.timers.time += 1_200_000; await put(); hit('clock jump'); await drain();
      await put();
      env.transport.request = async (endpoint, body, options) => {
        if (endpoint !== 'push') return request(endpoint, body, options);
        const out = push({ state: env.state, registry, product, account: 'A', request: body, serverNow: env.timers.time, faultOf: () => 'fault' });
        env.state = out.state;
        return { response: out.response, timing: { send: engine.reading(), recv: engine.reading() } };
      };
      for (let i = 0; i < 4 && engine.device.activeReplica.outbox.length; i++) { env.timers.time += 60_000; engine.kick(); await engine.send(); }
      assert.ok(engine.device.activeReplica.notices.some((notice) => notice.code === 'internal')); hit('poison');
      env.transport.request = request; await drain();
      env.state.epoch = `ep-${seed + 1}`;
      const previous = engine.activeReplica(); engine.kickPull(); await engine.pull(); assert.notEqual(engine.activeReplica(), previous); hit('epoch'); await until(() => engine.leader); await drain();
      // Admission results and settling slices are interrupted only after a durable commit.
      for (let i = 0; i < 66; i++) {
        const result = await engine.commit('self/probe', [{ op: 'put', t: 'day', id: `2026-11-${String(i).padStart(2, '0')}`, present: true, f: { score: rng.int(11) } }]);
        result.localIds.forEach((id) => committed.add(id));
      }
      const write = engine.write.bind(engine); let died = false;
      engine.write = async (...args) => {
        const result = await write(...args);
        if (!died && engine.device.activeReplica.outbox.some((entry) => entry.state === 'acked')) { died = true; engine.close(); hit('result death'); }
        return result;
      };
      await engine.send(); await restart();
      for (let i = 0; i < 3; i++) { env.timers.time += 60_000; engine.kick(); await engine.send(); }
      assert.equal(engine.device.activeReplica.outbox.filter((entry) => entry.state === 'acked').length, 66);
      const currentWrite = engine.write.bind(engine); died = false;
      engine.write = async (...args) => {
        const result = await currentWrite(...args);
        if (!died && engine.device.activeReplica.outbox.length === 2) { died = true; engine.close(); hit('settling death'); }
        return result;
      };
      engine.kickPull(); await engine.pull(); await restart(); await drain();
      await engine.write(null, (device) => { for (const cursor of Object.values(device.activeReplica.cursors)) cursor.cursor = null; });
      const handle = engine.device.activeReplica.storageHandle;
      const longPage = (await request('pull', { scopes: [{ scope: 'self/probe', cursor: null }] })).response.body.pages[0];
      assert.ok(longPage.rows.length > 64);
      const chunkWrite = engine.write.bind(engine); died = false;
      engine.write = async (...args) => { const result = await chunkWrite(...args); if (!died) { died = true; engine.close(); hit('chunk death'); } return result; };
      await assert.rejects(engine.storePage(handle, null, longPage)); await restart(); await drain();
      await engine.write(null, (device) => { device.activeReplica.cursors['self/probe'].cursor = null; });
      env.transport.request = async (endpoint, body, options) => {
        if (endpoint !== 'pull') return request(endpoint, body, options);
        const out = pull({ state: env.state, registry, product, account: 'A', request: body, serverNow: env.timers.time, limits: { ...CONSTANTS, PULL_PAGE_BYTES: 600 } });
        env.state = out.state;
        if (out.response.body?.pages.some((page) => page.more)) hit('more with frame');
        return { response: out.response, timing: { send: engine.reading(), recv: engine.reading() } };
      };
      engine.kickPull(); await engine.pull();
      const scope = env.state.scope('acct:A/probe');
      const frame = frameFor(env.state, { key: 'acct:A/probe', frame: liveFrameOf(env.state, 'acct:A/probe', env.state.rowsOf('acct:A/probe')) }, 'A');
      assert.equal(frame.op, 'change'); await engine.receiveFrame(frame);
      env.transport.request = request; await drain();
      const beforeForeign = await pulled();
      await engine.receiveFrame({ op: 'change', scope: 'self/probe', as: 'B', epoch: env.state.epoch, seq: scope.seq + 1, rows: [] });
      assert.deepEqual(await pulled(), beforeForeign); await engine.signIn('A');
      const snapshot = (await engine.store.read()).device.toJSON();
      await put(); await drain();
      await engine.write(null, (device) => { const restored = new Device(snapshot); device.replicas = restored.replicas; device.activeReplica = restored.activeReplica; device.meta = restored.meta; });
      hit('snapshot restore'); await restart(); await drain();
      const clonedEnvironment = environment();
      const cloneOptions = { ...clonedEnvironment.options, transport: env.transport, timers: env.timers, now: () => env.timers.time, monotonic: () => env.timers.time, name: 'clone', newReplicaId: env.options.newReplicaId };
      const clone = await BrowserSyncEngine.open(cloneOptions);
      await clone.store.transact((device) => { const restored = new Device(snapshot); device.replicas = restored.replicas; device.activeReplica = restored.activeReplica; device.meta = restored.meta; });
      await clone.refresh(true); clone.observe('self/probe'); await clone.start(); await until(() => clone.leader);
      await clone.commit('self/probe', [{ op: 'put', t: 'day', id: '2026-12-31', present: true, f: { score: 10 } }]);
      for (let i = 0; i < 10 && clone.device.activeReplica.outbox.length; i++) {
        env.timers.time += 60_000; clone.kick(); await clone.send(); clone.kickPull(); await clone.pull();
        if (!clone.leader) await until(() => clone.leader);
      }
      assert.deepEqual(clone.device.activeReplica.outbox, []);
      clone.close(); hit('clone'); await drain();
      await engine.commit('self/probe', [{ op: 'create', t: 'card', id: 'carddecision', f: { title: 'fixture' } }]); await drain();
      await engine.commit('self/probe', [{ op: 'update', t: 'card', id: 'carddecision', f: { title: 'guarded' } }], { guard: [{ t: 'card', id: 'carddecision', field: 'title' }] });
      const competing = admit({ state: env.state, registry, product, origin: { kind: 'server', account: 'A' }, serverNow: env.timers.time + 1,
        intent: { scope: 'self/probe', d: [{ t: 'card', id: 'carddecision', born: env.state.rowsOf('acct:A/probe').find((row) => row.id === 'carddecision').born,
          f: { title: ['competing', `${env.timers.time + 1}:0:srv`] } }] } });
      env.state = competing.state; await drain();
      assert.ok(engine.device.activeReplica.notices.some((notice) => notice.code === 'stale'));
      await engine.commit('self/probe', [{ op: 'create', t: 'card', id: 'cardterminal', f: { title: 'terminal' } }]); await drain();
      await engine.commit('self/probe', [{ op: 'delete', t: 'card', id: 'cardterminal' }]); await drain();
      await engine.commit('self/probe', [{ op: 'create', t: 'card', id: 'cardterminal', f: { title: 'resurrection' } }]); await drain();
      assert.ok(!env.state.rowsOf('acct:A/probe').some((row) => row.id === 'cardterminal' && isAlive(row)));
      const run = 'run00001';
      await engine.commit('self/probe', [], { cmd: { name: 'probe.start', args: { id: run, label: 'fixture', startedAt: env.timers.time, join: true } },
        predict: [{ op: 'create', t: 'run', id: run, f: { startedAt: env.timers.time, label: 'fixture' } }] }); await drain();
      await engine.commit('self/probe', [], { cmd: { name: 'probe.start', args: { id: 'run00002', label: 'joined', startedAt: env.timers.time, join: true } },
        predict: [{ op: 'create', t: 'run', id: 'run00002', f: { startedAt: env.timers.time, label: 'joined' } }] }); await drain();
      await engine.commit('self/probe', [{ op: 'create', t: 'board', id: 'b_00000001' }]); await drain();
      const existence = ['tree/b_00000001', 'tree/b_99999999'].map((scope) => pull({ state: env.state, registry, product, account: 'B',
        request: { scopes: [{ scope, cursor: null }] }, serverNow: env.timers.time }).response.body.pages[0].kind);
      assert.deepEqual(existence, ['not-found', 'not-found']);
      for (const choice of ['add', 'discard']) {
        await engine.finishSignOut({ choice: 'discard' }); hit('sign-out discard');
        await put();
        const question = await engine.signIn('A'); assert.equal(question.complete, false); hit('incomplete sign-in');
        assert.equal((await engine.signIn('A', { decisions: { probe: choice }, counted: { probe: question.due[0].counted } })).complete, true);
        hit(`decision ${choice}`); await until(() => engine.leader); await drain();
      }
      await engine.finishSignOut({ choice: 'keep' }); hit('sign-out keep');
      await engine.signIn('A'); await until(() => engine.leader); await drain();
      const local = (await engine.store.read()).device.activeReplica;
      assert.equal(scopeDigest(local.confirmedRows('self/probe')), env.state.scope('acct:A/probe').digest);
      assert.ok(!local.known['self/probe']);
      assert.ok([...committed].every((id) => ended.has(id)), `seed ${seed}: every recorded gesture ended`);
      for (const fault of runtimeFaults) assert.ok(observed.has(fault), `seed ${seed}: missing ${fault}`);
      t.diagnostic(JSON.stringify({ seed, faults: observed.size }));
    } finally { peer?.close(); engine?.close(); }
  });
}
