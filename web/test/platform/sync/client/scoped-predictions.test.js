import assert from 'node:assert/strict';
import test from 'node:test';
import { BrowserSyncEngine } from '../../../../src/platform/sync/engine.js';
import { nextPush } from '../../../../../packages/api-contract/sync/reference/client/sender.js';
import { row, st } from '../oracle-adapters/fixtures.js';
import { environment, until } from '../fakes.js';
import { Device } from '../../../../../packages/api-contract/sync/reference/client/replica.js';

for (const act of [false, true]) test(`${act ? 'act segment' : 'raw commit'} runs once when scoped predictions require later target hydration`, async () => {
  const env = environment();
  const origin = 'self/probe', target = 'tree/b_00000001';
  let engine = await BrowserSyncEngine.open(env.options);
  await engine.write(null, (device) => {
    device.activeReplica.putConfirmed(origin, row({ t: 'board', id: 'b_00000001', born: st(1000), life: ['alive', st(1000)], seq: 1 }));
    device.activeReplica.putConfirmed(target, row({ t: 'meta', id: 'meta', f: { title: ['Before', st(1000)] }, seq: 2 }));
  }, [origin, target]);
  engine.close(); engine = await BrowserSyncEngine.open(env.options);
  try {
    let decisions = 0, segments = 0, identities = 0;
    const gesture = () => {
      segments++;
      return { changes: [], opts: { hold: true, cmd: { name: 'probe.branch', args: { parent: 'b_00000001', child: 'b_00000002', title: 'Next' } },
        scopedPredict: [{ scope: target, changes: [{ op: 'write', t: 'meta', id: 'meta', f: { title: 'Next' } }] }] } };
    };
    const result = act ? await engine.commitAct((context) => {
      context.inScope(origin, () => {}); context.finishLoad(); decisions++;
      const id = context.opaqueID(); identities++;
      return { request: { scopes: [origin], hold: true }, value: id };
    }, () => gesture()) : await engine.commit(origin, () => { decisions++; return { gesture: gesture(), value: ++identities }; });
    assert.deepEqual([decisions, segments, identities], [1, 1, 1]);
    const snapshot = engine.observe(target).getSnapshot();
    assert.equal(snapshot.drawn[0].f.title[0], 'Next');
    assert.equal(snapshot.stored[0].f.title[0], 'Before');
    const gestureId = act ? result.outcome.gestureId : engine.device.activeReplica.outbox[0].gestureId;
    assert.deepEqual(snapshot.undoOffers, [{ id: gestureId, releaseAt: env.timers.time + engine.limits.HOLD_MS, records: [{ t: 'meta', id: 'meta' }] }]);
    assert.deepEqual(engine.readMetadata(target).commands, []);
    engine.close(); engine = await BrowserSyncEngine.open(env.options);
    assert.equal(engine.observe(target).getSnapshot().drawn[0].f.title[0], 'Next');
    assert.equal(await engine.undo(gestureId), true);
    assert.equal(engine.observe(target).getSnapshot().drawn[0].f.title[0], 'Before');
    assert.deepEqual(env.failures, []);
  } finally { engine.close(); }
});

test('target observers receive scoped failures while retained notice content keeps origin and every projection', async () => {
  const env = environment(), origin = 'self/probe';
  const engine = await BrowserSyncEngine.open(env.options);
  const trees = ['tree/b_00000001', 'tree/b_00000002'];
  try {
    await engine.write(null, (device) => {
      Object.assign(device.activeReplica.meta, { state: 'bound', account: 'A', serverEpoch: 'ep-1' });
      for (const scope of trees) {
        device.activeReplica.putConfirmed(origin, row({ t: 'board', id: scope.split('/')[1], born: st(1000), life: ['alive', st(1000)], seq: 1 }));
        device.activeReplica.putConfirmed(scope, row({ t: 'meta', id: 'meta', f: { title: ['Before', st(1000)] }, seq: 1 }));
      }
    }, [origin, ...trees]);
    const observed = trees.map((scope) => engine.observe(scope));
    const changes = [0, 0];
    observed.forEach((view, index) => view.subscribe(() => changes[index]++));
    await engine.commit(origin, [], { gestureId: 'branch', cmd: { name: 'probe.branch', args: { parent: 'b_00000001', child: 'b_00000002', title: 'Next' } },
      scopedPredict: trees.map((scope, index) => ({ scope, changes: [{ op: 'write', t: 'meta', id: 'meta', f: { title: `Target ${index}` } }] })) });
    const request = await engine.write(null, (device, ctx) => nextPush(device.activeReplica, ctx));
    const before = changes.slice();
    await engine.pushResults(engine.device.activeReplica.storageHandle, request, { status: 200, body: { as: 'A', epoch: 'ep-1', serverTime: 1000, lastN: 1,
      results: [{ n: 1, s: 'refused', code: 'invalid' }] } }, { send: { wall: 1000, mono: 1000, boot: 'test' }, recv: { wall: 1000, mono: 1000, boot: 'test' } });
    const retained = engine.device.activeReplica.notices[0];
    assert.equal(retained.scope, origin);
    assert.deepEqual(retained.content.predictions.map(({ scope }) => scope), [origin, ...trees]);
    for (const [index, view] of observed.entries()) {
      assert.ok(changes[index] > before[index]);
      const notice = view.getSnapshot().notices[0];
      assert.deepEqual([notice.id, notice.scope], ['notice:branch/0', origin]);
      assert.equal(notice.content.cmd, undefined);
      assert.deepEqual(notice.content.d.map(({ t, id, f }) => [t, id, f.title[0]]), [['meta', 'meta', `Target ${index}`]]);
      assert.equal(view.getSnapshot().drawn[0].f.title[0], 'Before');
    }
    assert.deepEqual((await engine.store.read()).device.activeReplica.notices[0], retained);
    assert.deepEqual(env.failures, []);
  } finally { engine.close(); }
});

test('a malformed private scoped receipt reports one static transport failure before any ACK-side mutation', async () => {
  const env = environment(), engine = await BrowserSyncEngine.open(env.options);
  try {
    await engine.start(); await until(() => engine.leader);
    env.transport.account = 'A'; await engine.signIn('A'); await until(() => engine.leader);
    await engine.commit('self/probe', [], { cmd: { name: 'probe.capture', args: {} } });
    await engine.write(null, (device, ctx) => nextPush(device.activeReplica, ctx));
    const expected = new Device(engine.device.toJSON());
    const reading = { wall: 1000, mono: 1000, boot: 'test' };
    const hello = { response: { status: 200, body: { as: 'A', epoch: 'ep-1', serverTime: 1000,
      schema: 3, minSchema: 2 } }, timing: { send: reading, recv: reading } };
    expected.activeReplica.takeOffsetSample(1000, hello.timing);
    env.transport.response = (endpoint) => endpoint === 'hello' ? hello : ({ response: { status: 200, body: {
      as: 'A', epoch: 'ep-1', serverTime: 9000, lastN: 1, results: [{ n: 1, s: 'ok', seq: 0, write: [],
        detail: { windmillKit: { v: 1, effects: [{ scope: 'tree/private-record-name', beforeSeq: null, seq: null, rows: [] }] } } }],
    } }, timing: { send: reading, recv: reading } });
    await engine.send();
    assert.deepEqual(engine.device.toJSON(), expected.toJSON());
    assert.deepEqual((await engine.store.read()).device.toJSON(), expected.toJSON());
    assert.deepEqual(env.failures, ['transport']);
    assert.equal(JSON.stringify(env.events).includes('private-record-name'), false);
  } finally { engine.close(); }
});
