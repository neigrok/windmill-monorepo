import assert from 'node:assert/strict';
import test from 'node:test';
import { BrowserSyncEngine } from '../../../../src/platform/sync/engine.js';
import { nextPush } from '../../../../src/platform/sync/client/sender.js';
import { isVisible } from '../../../../src/platform/sync/core/rows.js';
import { registry } from '../../../../src/platform/sync/schema.js';
import { environment } from '../fakes.js';

const scope = 'self/gym';
const stamp = '1:0:srv';
const record = (t, id, fields, v) => ({ t, id, seq: 1, rc: 100, ru: 200, born: stamp,
  life: ['alive', stamp], f: Object.fromEntries(Object.entries(fields).map(([name, value]) => [name, [value, stamp]])), ...(v ? { v } : {}) });

async function seed(engine, scope, rows) {
  await engine.write(null, (device) => {
    Object.assign(device.activeReplica.meta, { state: 'bound', account: 'A', serverEpoch: 'ep-1' });
    for (const row of rows) device.activeReplica.putConfirmed(scope, row);
  }, [scope]);
}

async function reply(engine, result) {
  const handle = engine.device.activeReplica.storageHandle;
  const request = await engine.write(null, (device, context) => nextPush(device.activeReplica, context, { limit: 1 }));
  assert.equal(request.intents.length, 1);
  assert.equal(request.intents[0].predict, undefined);
  await engine.pushResults(handle, request, { status: 200, body: { as: 'A', epoch: 'ep-1', serverTime: 1000, lastN: 1,
    results: [{ n: 1, ...result }] } }, {
    send: { wall: 1000, mono: 1000, boot: 'test' }, recv: { wall: 1000, mono: 1000, boot: 'test' },
  });
}

test('persisted browser command predictions show assigned serials and deaths, and a refusal restores confirmed rows', async () => {
  const env = environment();
  const options = { ...env.options, registry };
  let engine = await BrowserSyncEngine.open(options);
  try {
    engine.observe(scope);
    const confirmed = [
      record('session', 'session0001', { startedAt: 100, finishedAt: 200 }),
      record('set', 'set00000001', { sessionId: 'session0001', exerciseId: 'bench-press', weightKg: 80, reps: 5, completedAt: 150 }, { setNumber: 1 }),
      record('set', 'set00000002', { sessionId: 'session0001', exerciseId: 'bench-press', weightKg: 85, reps: 5, completedAt: 160 }, { setNumber: 2 }),
    ];
    await engine.write(null, (device) => {
      device.activeReplica.meta.state = 'bound';
      device.activeReplica.meta.account = 'A';
      device.activeReplica.meta.serverEpoch = 'ep-1';
      for (const row of confirmed) device.activeReplica.putConfirmed(scope, row);
    }, [scope]);
    const result = await engine.commit(scope, [], { cmd: { name: 'gym.correctSession', args: {} }, predict: [
      { op: 'update', t: 'set', id: 'set00000001', v: { setNumber: 3 } },
      { op: 'delete', t: 'set', id: 'set00000002' },
      { op: 'create', t: 'set', id: 'set00000003', f: { sessionId: 'session0001', exerciseId: 'bench-press', weightKg: 90, reps: 4, completedAt: 170 }, v: { setNumber: 4 } },
    ] });
    const predicted = engine.observe(scope).getSnapshot().drawn;
    assert.equal(predicted.find((row) => row.id === 'set00000001').v.setNumber, 3);
    assert.equal(predicted.find((row) => row.id === 'set00000002').life[0], 'dead');
    assert.equal(isVisible(registry.type('set'), predicted.find((row) => row.id === 'set00000002')), false);
    assert.equal(predicted.find((row) => row.id === 'set00000003').v.setNumber, 4);
    const entry = engine.device.activeReplica.entry(result.localIds[0]);
    assert.equal(entry.intent.d, undefined);
    assert.deepEqual(entry.intent.cmd, { name: 'gym.correctSession', args: {} });
    engine.close();
    engine = await BrowserSyncEngine.open(options);
    assert.deepEqual(engine.observe(scope).getSnapshot().drawn, predicted);
    const handle = engine.device.activeReplica.storageHandle;
    const request = await engine.write(null, (device, context) => nextPush(device.activeReplica, context));
    assert.equal(request.intents[0].d, undefined);
    assert.equal(request.intents[0].predict, undefined);
    await engine.pushResults(handle, request, { status: 200, body: { as: 'A', epoch: 'ep-1', serverTime: 1000, lastN: 1,
      results: [{ n: 1, s: 'refused', code: 'invalid' }] } }, {
      send: { wall: 1000, mono: 1000, boot: 'test' }, recv: { wall: 1000, mono: 1000, boot: 'test' },
    });
    const restored = engine.observe(scope).getSnapshot().drawn;
    assert.equal(restored.find((row) => row.id === 'set00000001').v.setNumber, 1);
    assert.equal(restored.find((row) => row.id === 'set00000002').life[0], 'alive');
    assert.equal(restored.find((row) => row.id === 'set00000003'), undefined);
  } finally { engine.close(); }
});

for (const refused of [false, true]) test(`persisted applyProposal removal hides a routine through ${refused ? 'refusal and restoration' : 'acceptance before a covering pull'}`, async () => {
  const env = environment(), options = { ...env.options, registry };
  let engine = await BrowserSyncEngine.open(options);
  try {
    await seed(engine, scope, [record('routine', 'routine0001', { name: 'Lower', position: 0, entries: [], revision: 1, createdEntries: 0 })]);
    const before = engine.observe(scope).getSnapshot().drawn;
    const result = await engine.commit(scope, [], { cmd: { name: 'gym.applyProposal', args: { proposalId: 'proposal001' } },
      predict: [{ op: 'delete', t: 'routine', id: 'routine0001' }] });
    const prediction = engine.device.activeReplica.entry(result.localIds[0]).predict[0];
    assert.deepEqual(prediction, { t: 'routine', id: 'routine0001', born: stamp, life: ['dead', result.stamp] });
    assert.deepEqual(engine.observe(scope).getSnapshot().drawn.filter((row) => isVisible(registry.type(row.t), row)), []);
    engine.close(); engine = await BrowserSyncEngine.open(options);
    assert.deepEqual(engine.observe(scope).getSnapshot().drawn[0].life, prediction.life);
    await reply(engine, refused ? { s: 'refused', code: 'proposal-superseded', detail: { reason: 'routine-changed' } } : { s: 'ok', seq: 2 });
    if (refused) {
      assert.deepEqual(engine.observe(scope).getSnapshot().drawn, before);
      assert.deepEqual(engine.device.activeReplica.notices.map((notice) => notice.code), ['proposal-superseded']);
    } else {
      assert.deepEqual(engine.observe(scope).getSnapshot().drawn[0].life, prediction.life);
      assert.equal(engine.device.activeReplica.outbox[0].state, 'acked');
      assert.equal(engine.device.activeReplica.confirmedRow(scope, 'routine', 'routine0001').life[0], 'alive');
    }
  } finally { engine.close(); }
});

for (const refused of [false, true]) for (const predictedDeletion of [false, true]) {
  test(`persisted ${predictedDeletion ? 'predicted' : 'intent'} death folds commands inheriting its life on ${refused ? 'refusal' : 'Undo'}`, async () => {
    const env = environment(), options = env.options, scope = 'self/probe';
    let engine = await BrowserSyncEngine.open(options);
    const cmd = { name: 'probe.predictDay', args: {} };
    try {
      const row = record('day', '2026-01-01', { score: 1 }); delete row.born;
      await seed(engine, scope, [row]);
      const before = engine.observe(scope).getSnapshot().drawn;
      const deletion = { op: 'delete', t: 'day', id: row.id };
      const source = await engine.commit(scope, predictedDeletion ? [] : [deletion], { gestureId: 'delete', hold: !refused,
        ...(predictedDeletion ? { cmd, predict: [deletion] } : {}) });
      await engine.commit(scope, [{ op: 'put', t: 'day', id: '2026-01-02', present: true, f: { score: 9 } }], { gestureId: 'later', cmd,
        predict: [{ op: 'put', t: 'day', id: row.id, f: { score: 2 } }] });
      await engine.commit(scope, [], { gestureId: 'last', cmd,
        predict: [{ op: 'put', t: 'day', id: row.id, f: { score: 3 } }] });
      const entries = engine.device.activeReplica.entries();
      assert.deepEqual(entries.map((entry) => entry.localId), ['delete/0', 'later/0', 'last/0']);
      assert.deepEqual(entries.slice(1).map((entry) => entry.predict[0].life), Array(2).fill(['dead', source.stamp]));
      assert.equal(isVisible(options.registry.type('day'), engine.observe(scope).getSnapshot().drawn.find((record) => record.id === row.id)), false);
      engine.close(); engine = await BrowserSyncEngine.open(options);
      if (refused) await reply(engine, { s: 'refused', code: 'invalid' });
      else {
        assert.equal(await engine.write(null, (device, context) => nextPush(device.activeReplica, context)), null);
        assert.equal(await engine.undo('delete'), true);
      }
      const remaining = engine.device.activeReplica.outbox;
      assert.equal(remaining.length, 1);
      assert.equal(remaining[0].localId, 'later/0');
      assert.equal(remaining[0].state, 'ready');
      assert.equal(remaining[0].intent.cmd, undefined);
      assert.equal(remaining[0].predict, undefined);
      assert.deepEqual(remaining[0].intent.d.map(({ t, id }) => ({ t, id })), [{ t: 'day', id: '2026-01-02' }]);
      assert.deepEqual(engine.observe(scope).getSnapshot().drawn.find((record) => record.id === row.id), before[0]);
      assert.equal(engine.device.activeReplica.notices.length, Number(refused));
      if (refused) assert.deepEqual(engine.device.activeReplica.notices[0].content.dependents, [{ cmd }, { cmd }]);
      const restored = engine.observe(scope).getSnapshot();
      engine.close(); engine = await BrowserSyncEngine.open(options);
      assert.deepEqual(engine.observe(scope).getSnapshot(), restored);
    } finally { engine.close(); }
  });
}

test('keyed predictions preserve, remove and restore presence; malformed predictions roll back durably', async () => {
  const env = environment(), engine = await BrowserSyncEngine.open(env.options), scope = 'self/probe';
  const cmd = { name: 'probe.predictDay', args: {} };
  const drawnDay = () => engine.observe(scope).getSnapshot().drawn.find((row) => row.id === '2026-01-01');
  const predict = (change) => engine.commit(scope, [], { cmd, predict: [{ t: 'day', id: '2026-01-01', ...change }] });
  try {
    await predict({ op: 'put', present: true, f: { score: 1 } });
    const original = drawnDay().life;
    await predict({ op: 'put', f: { score: 2 } });
    assert.deepEqual(drawnDay().life, original);
    const removal = await predict({ op: 'put', present: false });
    assert.deepEqual(drawnDay().life, ['dead', removal.stamp]);
    await predict({ op: 'put', f: { score: 3 } });
    assert.deepEqual(drawnDay().life, ['dead', removal.stamp]);
    const revival = await predict({ op: 'put', present: true });
    assert.deepEqual(drawnDay().life, ['alive', revival.stamp]);
    assert.equal(drawnDay().born, undefined);
    assert.equal(drawnDay().f.score[0], 3);
    const before = (await engine.store.read()).device.toJSON();
    for (const change of [{ op: 'put', t: 'day', id: '2026-01-02' }, { op: 'delete', t: 'card', id: 'missing1' }, { op: 'move', t: 'day', id: '2026-01-01' }]) {
      await assert.rejects(engine.commit(scope, [], { cmd, predict: [change] }));
      assert.deepEqual((await engine.store.read()).device.toJSON(), before);
    }
  } finally { engine.close(); }
});

test('invalid prediction serials reject before persisting any work', async () => {
  const env = environment();
  const engine = await BrowserSyncEngine.open({ ...env.options, registry });
  try {
    const before = (await engine.store.read()).device.toJSON();
    for (const v of [{ unknown: 1 }, { setNumber: 0 }, { setNumber: 1.5 }, { setNumber: Number.MAX_SAFE_INTEGER + 1 }]) {
      await assert.rejects(engine.commit(scope, [], { cmd: { name: 'gym.importSession', args: {} },
        predict: [{ op: 'create', t: 'set', id: 'set00000001', v }] }));
      assert.deepEqual((await engine.store.read()).device.toJSON(), before);
    }
  } finally { engine.close(); }
});
