import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { CommitError, commit } from '../../client/commit.js';
import { undo } from '../../client/hold.js';
import { onPullResponse, pullRequest } from '../../client/puller.js';
import { Replica } from '../../client/replica.js';
import { nextPush, onPushResponse } from '../../client/sender.js';
import { drawn } from '../../client/views.js';
import { steadyTiming } from '../../core/clock.js';
import { CONSTANTS } from '../../core/constants.js';
import { Registry } from '../../core/registry.js';
import { isAlive, recordKey } from '../../core/rows.js';
import { admit } from '../../server/admit.js';
import { pull } from '../../server/pull.js';
import { push } from '../../server/push.js';
import { ServerState } from '../../server/state.js';
import { ACTOR, registry, row, st } from '../../vectors/fixtures.js';
import { gymProduct, gymRegistry } from '../../vectors/gym.js';

const GYM = 'self/gym';
const PROBE = 'self/probe';
const DAY = '2026-01-01';
const COMMAND = { name: 'probe.predictDay', args: {} };
const probeJson = JSON.parse(readFileSync(new URL('../../../probe.registry.json', import.meta.url), 'utf8'));
const predictionRegistry = new Registry({ ...probeJson, commands: [...probeJson.commands,
  { name: COMMAND.name, scope: 'product:probe', origins: ['replica'], serverInternal: false, args: {}, predicts: ['day'] }] });
const gymVectors = JSON.parse(readFileSync(new URL('../../../corpus/gym/admit.json', import.meta.url), 'utf8'));

function context(registry, deviceNow = 5000) {
  let gestures = 0;
  return { registry, actor: ACTOR, deviceNow, ended: [], telemetry: [], appVersion: '1',
    limits: { ...CONSTANTS, PUSH_MAX_INTENTS: 1 }, nextGestureId: () => `g${(gestures += 1)}` };
}

function bound(confirmed = {}) {
  return new Replica({ meta: Replica.fresh({ replica: 'rp_00000000000000000000000000000001', state: 'bound', account: 'A' }).meta, confirmed });
}

function gymFixture(name) {
  const vector = structuredClone(gymVectors.find((candidate) => candidate.name === name));
  const state = new ServerState(vector.input.state);
  const replica = bound();
  const ctx = context(gymRegistry, vector.input.serverNow);
  pullGym(replica, ctx, state);
  return { vector, state, replica, ctx };
}

function pullGym(replica, ctx, state) {
  const request = pullRequest(replica, gymRegistry, [GYM]);
  const out = pull({ state, registry: gymRegistry, product: gymProduct, account: 'A', request, serverNow: ctx.deviceNow });
  assert.deepEqual(onPullResponse(replica, ctx, request, out.response, steadyTiming(ctx.deviceNow, ctx.deviceNow)),
    [{ scope: GYM, outcome: 'applied' }]);
  return out.state;
}

function pushGym(replica, ctx, state) {
  const request = nextPush(replica, ctx);
  assert.ok(request);
  assert.equal(request.intents[0].d, undefined);
  const out = push({ state, registry: gymRegistry, product: gymProduct, account: 'A', request, serverNow: ctx.deviceNow });
  onPushResponse(replica, ctx, request, out.response, steadyTiming(ctx.deviceNow, ctx.deviceNow));
  return out;
}

for (const refuse of [false, true]) {
  test(`gym.applyProposal predicts its routine dead before push and ${refuse ? 'restores it on refusal' : 'keeps it dead through acceptance and pull'}`, () => {
    const fixture = gymFixture('apply of a removal kills the routine and its proposals, and writes routineId null on its sessions');
    let { state, replica } = fixture;
    const { ctx } = fixture;
    const before = drawn(replica, gymRegistry, GYM).get(recordKey('routine', 'routine0001'));
    if (refuse) {
      const routine = state.row('acct:A/gym', 'routine', 'routine0001');
      const out = admit({ state, registry: gymRegistry, product: gymProduct, origin: { kind: 'server', account: 'A' },
        intent: { scope: GYM, d: [{ t: 'routine', id: routine.id, born: routine.born, f: { name: ['Changed elsewhere', null] } }] },
        serverNow: ctx.deviceNow });
      assert.equal(out.result.s, 'ok');
      state = out.state;
    }
    const { outcome } = commit(replica, ctx, GYM, ({ drawn, now }) => {
      const proposal = drawn.get(recordKey('proposal', 'proposal001'));
      return { gesture: { changes: [], opts: { cmd: { name: 'gym.applyProposal', args: { proposalId: proposal.id } }, predict: [
        { op: 'update', t: 'proposal', id: proposal.id, f: { state: 'applied', settledAt: now } },
        { op: 'delete', t: 'routine', id: proposal.f.routineId[0] },
      ] } } };
    });
    const removed = { ...before, life: ['dead', outcome.stamp] };
    assert.deepEqual(drawn(replica, gymRegistry, GYM).get(recordKey('routine', before.id)), removed);
    assert.deepEqual([...drawn(replica, gymRegistry, GYM).values()].filter((record) => record.t === 'routine' && isAlive(record)), []);
    replica = new Replica(replica.toJSON());
    assert.deepEqual(drawn(replica, gymRegistry, GYM).get(recordKey('routine', before.id)), removed);
    const out = pushGym(replica, ctx, state);
    if (refuse) {
      assert.deepEqual(out.response.body.results.map(({ s, code, detail }) => ({ s, code, detail })),
        [{ s: 'refused', code: 'proposal-superseded', detail: { reason: 'routine-changed' } }]);
      assert.deepEqual(drawn(replica, gymRegistry, GYM).get(recordKey('routine', before.id)), before);
      assert.deepEqual(replica.notices.map((notice) => notice.content.cmd.name), ['gym.applyProposal']);
      assert.deepEqual(replica.entries(), []);
      return;
    }
    assert.equal(out.response.body.results[0].s, 'ok');
    assert.deepEqual(drawn(replica, gymRegistry, GYM).get(recordKey('routine', before.id)), removed);
    assert.equal(replica.entry(outcome.localIds[0]).state, 'acked');
    assert.equal(replica.confirmedRow(GYM, 'routine', before.id).life[0], 'alive');
    pullGym(replica, ctx, out.state);
    assert.equal(drawn(replica, gymRegistry, GYM).get(recordKey('routine', before.id)), undefined);
    assert.deepEqual(replica.entries(), []);
    assert.deepEqual(replica.notices, []);
  });

  test(`gym.correctSession predicts dropped sets dead and ${refuse ? 'restores the workout on refusal' : 'keeps them hidden through acceptance and pull'}`, () => {
    const { vector, state, ctx, replica: initial } = gymFixture('a correction replaces the workout: interval, name, kept sets rewritten, new sets working, the rest dead');
    let replica = initial;
    const before = drawn(replica, gymRegistry, GYM);
    const args = vector.input.intent.cmd.args;
    if (refuse) args.sets[0].exerciseId = 'dip';
    const { outcome } = commit(replica, ctx, GYM, ({ drawn }) => {
      const prior = [...drawn.values()].filter((record) => record.t === 'set' && record.f.sessionId[0] === args.sessionId);
      const named = new Set(args.sets.map((set) => set.id));
      const predict = [
        { op: 'update', t: 'session', id: args.sessionId, f: { startedAt: args.startedAt, finishedAt: args.finishedAt, closedBy: 'finish', displayName: args.routineName } },
        ...args.sets.map(({ id, setNumber, ...f }) => prior.some((set) => set.id === id)
          ? { op: 'update', t: 'set', id, f }
          : { op: 'create', t: 'set', id, f: { ...f, sessionId: args.sessionId, kind: 'working' } }),
        ...prior.filter((set) => !named.has(set.id)).map((set) => ({ op: 'delete', t: 'set', id: set.id })),
      ];
      return { gesture: { changes: [], opts: { cmd: { name: 'gym.correctSession', args }, predict } } };
    });
    const key = recordKey('set', 'set00000002');
    const removed = { ...before.get(key), life: ['dead', outcome.stamp] };
    assert.deepEqual(drawn(replica, gymRegistry, GYM).get(key), removed);
    assert.deepEqual([...drawn(replica, gymRegistry, GYM).values()].filter((record) => record.t === 'set' && isAlive(record)).map((record) => record.id).sort(),
      ['set00000001', 'set00000009']);
    replica = new Replica(replica.toJSON());
    assert.deepEqual(drawn(replica, gymRegistry, GYM).get(key), removed);
    const out = pushGym(replica, ctx, state);
    if (refuse) {
      assert.equal(out.response.body.results[0].code, 'invalid');
      assert.deepEqual(drawn(replica, gymRegistry, GYM), before);
      assert.deepEqual(replica.notices.map((notice) => notice.content.cmd.name), ['gym.correctSession']);
      assert.deepEqual(replica.entries(), []);
      return;
    }
    assert.equal(out.response.body.results[0].s, 'ok');
    assert.deepEqual(drawn(replica, gymRegistry, GYM).get(key), removed);
    assert.equal(replica.confirmedRow(GYM, 'set', 'set00000002').life[0], 'alive');
    pullGym(replica, ctx, out.state);
    assert.equal(drawn(replica, gymRegistry, GYM).get(key), undefined);
    assert.deepEqual([...drawn(replica, gymRegistry, GYM).values()].filter((record) => record.t === 'set').map((record) => record.id).sort(),
      ['set00000001', 'set00000009']);
    assert.deepEqual(replica.entries(), []);
    assert.deepEqual(replica.notices, []);
  });
}

test('keyed predictions preserve presence and born absence while removing and reviving records', () => {
  const replica = bound();
  const ctx = context(predictionRegistry);
  const predict = (change) => commit(replica, ctx, PROBE, [], { cmd: COMMAND, predict: [change] });
  const put = (present, score) => ({ op: 'put', t: 'day', id: DAY, ...(present === undefined ? {} : { present }), ...(score === undefined ? {} : { f: { score } }) });
  const creation = predict(put(true, 1));
  assert.deepEqual(replica.entry(creation.localIds[0]).predict, [{ t: 'day', id: DAY, life: ['alive', creation.stamp], f: { score: [1, creation.stamp] } }]);
  const kept = predict(put(undefined, 2));
  assert.deepEqual(replica.entry(kept.localIds[0]).predict, [{ t: 'day', id: DAY, life: ['alive', creation.stamp], f: { score: [2, kept.stamp] } }]);
  const removal = predict(put(false));
  assert.deepEqual(replica.entry(removal.localIds[0]).predict, [{ t: 'day', id: DAY, life: ['dead', removal.stamp] }]);
  const inherited = predict(put(undefined, 3));
  assert.deepEqual(replica.entry(inherited.localIds[0]).predict, [{ t: 'day', id: DAY, life: ['dead', removal.stamp], f: { score: [3, inherited.stamp] } }]);
  assert.equal(isAlive(drawn(replica, predictionRegistry, PROBE).get(recordKey('day', DAY))), false);
  const revival = predict(put(true));
  assert.deepEqual(drawn(replica, predictionRegistry, PROBE).get(recordKey('day', DAY)),
    { t: 'day', id: DAY, life: ['alive', revival.stamp], f: { score: [3, inherited.stamp] } });
});

test('malformed predictions fail before changing the replica or clock', () => {
  const replica = bound();
  const ctx = context(registry);
  const before = replica.toJSON();
  for (const change of [
    { op: 'delete', t: 'card', id: 'card0001' },
    { op: 'delete', t: 'mark', id: 'oak' },
    { op: 'put', t: 'day', id: DAY },
    { op: 'revive', t: 'card', id: 'card0001' },
  ]) {
    assert.throws(() => commit(replica, ctx, change.t === 'mark' ? 'self/overlay/b_00000001' : PROBE, [],
      { cmd: COMMAND, predict: [change] }), CommitError);
    assert.deepEqual(replica.toJSON(), before);
    assert.deepEqual(ctx.ended, []);
  }
});

for (const refuse of [false, true]) for (const predictedDeletion of [false, true]) {
  test(`${refuse ? 'refusal' : 'Undo'} of ${predictedDeletion ? 'a predicted' : 'an intent'} keyed deletion folds commands inheriting its dead life while retaining unrelated deltas`, () => {
    const confirmed = row({ t: 'day', id: DAY, life: ['alive', st(1000)], f: { score: [1, st(1000)] }, seq: 1 });
    let replica = bound({ [PROBE]: [confirmed] });
    const ctx = context(predictionRegistry);
    const before = drawn(replica, predictionRegistry, PROBE).get(recordKey('day', DAY));
    const deletion = { op: 'delete', t: 'day', id: DAY };
    const source = commit(replica, ctx, PROBE, predictedDeletion ? [] : [deletion], { hold: !refuse,
      ...(predictedDeletion ? { cmd: COMMAND, predict: [deletion] } : {}) });
    commit(replica, ctx, PROBE, [{ op: 'put', t: 'day', id: '2026-01-02', f: { score: 9 } }], { cmd: COMMAND,
      predict: [{ op: 'put', t: 'day', id: DAY, f: { score: 2 } }] });
    commit(replica, ctx, PROBE, [], { cmd: COMMAND, predict: [{ op: 'put', t: 'day', id: DAY, f: { score: 3 } }] });
    assert.deepEqual(replica.entries().flatMap((entry) => entry.predict ?? []).filter((delta) => delta.id === DAY).map((delta) => delta.life),
      Array(predictedDeletion ? 3 : 2).fill(['dead', source.stamp]));
    assert.equal(isAlive(drawn(replica, predictionRegistry, PROBE).get(recordKey('day', DAY))), false);
    replica = new Replica(replica.toJSON());
    if (refuse) {
      const request = nextPush(replica, ctx);
      assert.deepEqual(request.intents.map((intent) => intent.n), [1]);
      onPushResponse(replica, ctx, request, { status: 200, body: { as: 'A', epoch: 'ep-1', serverTime: ctx.deviceNow, lastN: 1,
        results: [{ n: 1, s: 'refused', code: 'invalid' }] } }, steadyTiming(ctx.deviceNow, ctx.deviceNow));
      assert.deepEqual(replica.notices.map((notice) => notice.content.dependents), [[{ cmd: COMMAND }, { cmd: COMMAND }]]);
    } else {
      assert.equal(nextPush(replica, ctx), null);
      assert.equal(undo(replica, predictionRegistry, ctx.ended, 'g1'), true);
      assert.deepEqual(replica.notices, []);
    }
    assert.deepEqual(replica.entries().map((entry) => ({ localId: entry.localId, state: entry.state, intent: entry.intent, predict: entry.predict })), [{
      localId: 'g2/0', state: 'ready', intent: { scope: PROBE, gestureId: 'g2', d: [{ t: 'day', id: '2026-01-02',
        life: ['alive', '5000:1:r_aaaaaaaaaaaa'], f: { score: [9, '5000:1:r_aaaaaaaaaaaa'] } }] }, predict: undefined,
    }]);
    assert.deepEqual(drawn(replica, predictionRegistry, PROBE).get(recordKey('day', DAY)), before);
    assert.deepEqual(replica.confirmedRow(PROBE, 'day', DAY), confirmed);
  });
}
