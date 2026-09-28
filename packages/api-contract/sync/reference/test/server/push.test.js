import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import { steadyTiming } from '../../core/clock.js';
import { CONSTANTS } from '../../core/constants.js';
import { jcs } from '../../core/jcs.js';
import { intentDigest } from '../../core/wire.js';
import { commit } from '../../client/commit.js';
import { release, releaseAll } from '../../client/hold.js';
import { signIn, signOut } from '../../client/lifecycle.js';
import { onFrame, onPullResponse, pullRequest } from '../../client/puller.js';
import { Device } from '../../client/replica.js';
import { nextPush, onHello, onPushResponse } from '../../client/sender.js';
import { reconcile } from '../../client/subscriptions.js';
import { deathFrameFor, hello, pull } from '../../server/pull.js';
import { push } from '../../server/push.js';
import { ServerState } from '../../server/state.js';
import { ACTOR, product, productScope, registry, serverState } from '../../vectors/fixtures.js';

const PROTOCOL = new URL('../../../corpus/protocol/', import.meta.url);
const transcripts = readdirSync(PROTOCOL).filter((name) => name.endsWith('.jsonl')).sort();
const linesOf = (file) => readFileSync(new URL(file, PROTOCOL), 'utf8').trim().split('\n').map((line) => JSON.parse(line));

for (const file of transcripts) {
  test(`protocol/${file} replays in the server role`, () => {
    const [header, ...lines] = linesOf(file);
    let state = new ServerState(header.server);
    for (const line of lines) {
      if (line.http === 'push') {
        const out = push({
          state,
          registry,
          product,
          account: line.account,
          request: line.request,
          serverNow: line.serverNow,
          budget: line.inject?.budget ?? Infinity,
          faultOf: (_, n) => (line.inject?.fault?.includes(n) ? 'fault' : null),
        });
        assert.equal(jcs(out.response), jcs(line.response), `step ${line.step}`);
        state = out.state;
      } else if (line.http === 'pull') {
        const out = pull({ state, registry, product, account: line.account, request: line.request, serverNow: line.serverNow });
        assert.equal(jcs(out.response), jcs(line.response), `step ${line.step}`);
        state = out.state;
      } else if (line.http === 'hello') {
        assert.equal(jcs(hello({ state, registry, account: line.account, serverTime: line.serverNow })), jcs(line.response), `step ${line.step}`);
      } else if (line.server === 'load') {
        state = new ServerState(line.state);
      } else if (line.end) {
        assert.equal(jcs(state.toJSON()), jcs(line.server));
      }
    }
  });

  test(`protocol/${file} replays in the client role`, () => {
    const [header, ...lines] = linesOf(file);
    const devices = Object.fromEntries(Object.entries(header.devices).map(([name, json]) => [name, new Device(json)]));
    const ids = structuredClone(header.ids);
    const ended = Object.fromEntries(Object.keys(devices).map((name) => [name, []]));
    let gestures = 0;
    const actors = Object.fromEntries(Object.keys(devices).map((name) => [name, [...(header.actors[name] ?? [ACTOR])]]));
    const current = Object.fromEntries(Object.entries(actors).map(([name, list]) => [name, list.shift()]));
    const unused = () => {
      throw new Error('the transcript lists none');
    };
    const ctx = (name, deviceNow) => ({
      registry,
      actor: current[name],
      deviceNow,
      ended: ended[name],
      telemetry: [],
      appVersion: '1',
      device: devices[name],
      nextGestureId: () => `g${(gestures += 1)}`,
      newReplicaId: () => ids[name].shift(),
      newActor: () => actors[name].shift(),
      newForkGuard: unused,
      draw: unused,
      limits: CONSTANTS,
    });
    for (const line of lines) {
      if (line.end) {
        assert.equal(jcs(Object.fromEntries(Object.entries(devices).map(([name, device]) => [name, device.toJSON()]))), jcs(line.devices));
        assert.equal(jcs(ended), jcs(line.ended));
        continue;
      }
      if (line.server === 'load') continue;
      const device = devices[line.device];
      const replica = device.activeReplica;
      const context = ctx(line.device, line.deviceNow);
      const timing = steadyTiming(line.deviceNow, line.deviceNow);
      if (line.http === 'hello') {
        onHello(replica, context, line.response, timing);
      } else if (line.do) {
        const { args } = line;
        let out = null;
        if (line.do === 'commit') out = commit(replica, context, args.scope, args.changes ?? [], args.opts ?? {});
        else if (line.do === 'release') out = release(replica, registry, context.ended, replica.entry(args.localId));
        else if (line.do === 'releaseAll') releaseAll(replica, registry, context.ended);
        else if (line.do === 'signIn') out = signIn(device, context, args);
        else if (line.do === 'signOut') out = signOut(device, context, args);
        else if (line.do === 'reconcile') reconcile(replica, context, args.scopes);
        else if (line.do === 'load') devices[line.device] = new Device(args.device);
        assert.equal(jcs(out), jcs(line.returns), `step ${line.step}`);
      } else if (line.http === 'push') {
        const request = nextPush(replica, context);
        assert.equal(jcs(request), jcs(line.request), `step ${line.step}`);
        if (!line.lost) onPushResponse(replica, context, request, line.response, timing);
      } else if (line.http === 'pull') {
        const request = pullRequest(replica, registry, line.request.scopes.map((entry) => entry.scope));
        assert.equal(jcs(request), jcs(line.request), `step ${line.step}`);
        assert.equal(jcs(onPullResponse(replica, context, request, line.response, timing)), jcs(line.returns), `step ${line.step}`);
      } else if (line.frame) {
        assert.equal(onFrame(replica, context, line.frame), line.returns, `step ${line.step}`);
      }
      current[line.device] = context.actor;
    }
  });
}

const REPLICA = 'rp_00000000000000000000000000000001';
const born = (ms) => `${ms}:0:r_aaaaaaaaaaaa`;
const createCard = (n, id, ms) => ({ n, scope: 'self/probe', d: [{ t: 'card', id, born: born(ms), life: ['alive', born(ms)], f: { title: [id.slice(-1), born(ms)] } }] });
const empty = () => new ServerState(serverState({ scopes: { 'acct:A/probe': productScope('A') } }));
const pushed = (state, request, extra = {}) => push({ state, registry, product, account: 'A', request, serverNow: 10_000, ...extra });

test('a push binds the replica, admits in n order and stores one result per n', () => {
  const out = pushed(empty(), { replica: REPLICA, ackThrough: 0, intents: [createCard(2, 'card0002', 200), createCard(1, 'card0001', 100)] });
  assert.deepEqual(out.response, { status: 200, body: { serverTime: 10_000, epoch: 'ep-1', lastN: 2, results: [{ n: 1, s: 'ok', seq: 1 }, { n: 2, s: 'ok', seq: 2 }] } });
  assert.deepEqual(out.state.replicas, { [REPLICA]: { account: 'A', lastN: 2 } });
  assert.deepEqual(Object.values(out.state.results[REPLICA]), [
    { n: 1, digest: intentDigest(createCard(1, 'card0001', 100)), result: { s: 'ok', seq: 1 }, faults: 0 },
    { n: 2, digest: intentDigest(createCard(2, 'card0002', 200)), result: { s: 'ok', seq: 2 }, faults: 0 },
  ]);
});

test('a resend answers the stored result; a pruned or different one is replica-forked', () => {
  const first = pushed(empty(), { replica: REPLICA, ackThrough: 0, intents: [createCard(1, 'card0001', 100)] });
  const again = pushed(first.state, { replica: REPLICA, ackThrough: 0, intents: [createCard(1, 'card0001', 100)] });
  assert.deepEqual(again.response.body.results, [{ n: 1, s: 'ok', seq: 1 }]);
  assert.equal(jcs(again.state.toJSON()), jcs(first.state.toJSON()));
  const other = pushed(first.state, { replica: REPLICA, ackThrough: 0, intents: [createCard(1, 'card0009', 100)] });
  assert.deepEqual(other.response, { status: 409, body: { serverTime: 10_000, epoch: 'ep-1', error: 'replica-forked' } });
  const pruned = pushed(first.state, { replica: REPLICA, ackThrough: 1, intents: [createCard(2, 'card0002', 200)] });
  assert.deepEqual(Object.keys(pruned.state.results[REPLICA]), ['2']);
  const resend = pushed(pruned.state, { replica: REPLICA, ackThrough: 1, intents: [createCard(1, 'card0001', 100)] });
  assert.deepEqual(resend.response.body, { serverTime: 10_000, epoch: 'ep-1', error: 'replica-forked' });
});

test('a gap, another account and a missing principal are refused before any admission', () => {
  const gap = pushed(empty(), { replica: REPLICA, ackThrough: 0, intents: [createCard(2, 'card0002', 200)] });
  assert.deepEqual(gap.response, { status: 409, body: { serverTime: 10_000, epoch: 'ep-1', error: 'gap' } });
  const first = pushed(empty(), { replica: REPLICA, ackThrough: 0, intents: [createCard(1, 'card0001', 100)] });
  const foreign = push({ state: first.state, registry, product, account: 'B', request: { replica: REPLICA, ackThrough: 0, intents: [createCard(1, 'card0001', 100)] }, serverNow: 10_000 });
  assert.deepEqual(foreign.response, { status: 409, body: { serverTime: 10_000, epoch: 'ep-1', error: 'replica-foreign' } });
  assert.equal(foreign.state, first.state);
  const anonymous = push({ state: first.state, registry, product, account: null, request: { replica: REPLICA, ackThrough: 0, intents: [] }, serverNow: 10_000 });
  assert.deepEqual(anonymous.response, { status: 401, body: { serverTime: 10_000, epoch: 'ep-1', error: 'unauthenticated' } });
});

test('a spent budget answers retry naming the first unprocessed intent', () => {
  const out = pushed(empty(), { replica: REPLICA, ackThrough: 0, intents: [createCard(1, 'card0001', 100), createCard(2, 'card0002', 200)] }, { budget: 1 });
  assert.deepEqual(out.response.body, { serverTime: 10_000, epoch: 'ep-1', lastN: 1, results: [{ n: 1, s: 'ok', seq: 1 }], retry: { n: 2, retryAfterMs: 0 } });
});

test('a deterministic fault is counted per attempt and becomes internal at K_POISON', () => {
  const faultOf = (_, n) => (n === 1 ? 'fault' : null);
  const request = { replica: REPLICA, ackThrough: 0, intents: [createCard(1, 'card0001', 100), createCard(2, 'card0002', 200)] };
  let state = empty();
  const bodies = [];
  for (let attempt = 1; attempt <= CONSTANTS.K_POISON; attempt += 1) {
    const out = pushed(state, request, { faultOf });
    state = out.state;
    bodies.push(out.response.body);
  }
  assert.deepEqual(bodies.map((body) => ({ lastN: body.lastN, results: body.results, retry: body.retry })), [
    { lastN: 0, results: [], retry: { n: 1, retryAfterMs: 0 } },
    { lastN: 0, results: [], retry: { n: 1, retryAfterMs: 0 } },
    { lastN: 2, results: [{ n: 1, s: 'refused', code: 'internal' }, { n: 2, s: 'ok', seq: 1 }], retry: undefined },
  ]);
  assert.deepEqual(state.results[REPLICA]['1'], { n: 1, digest: intentDigest(request.intents[0]), result: { s: 'refused', code: 'internal' }, faults: 3 });
});

test('a transient fault stores nothing and answers retry', () => {
  const out = pushed(empty(), { replica: REPLICA, ackThrough: 0, intents: [createCard(1, 'card0001', 100)] }, { faultOf: () => 'transient' });
  assert.deepEqual(out.response.body, { serverTime: 10_000, epoch: 'ep-1', lastN: 0, results: [], retry: { n: 1, retryAfterMs: 1000 } });
  assert.deepEqual(out.state.results, {});
});

test('push/serve.json replays through push, frames and death events included', () => {
  const vectors = JSON.parse(readFileSync(new URL('../../../corpus/push/serve.json', import.meta.url), 'utf8'));
  for (const { name, input, expect } of vectors) {
    const faultOf = (replica, n) => input.faults?.find((fault) => fault.n === n)?.kind ?? null;
    const out = push({
      state: new ServerState(input.state), registry, product, account: input.account, request: input.request, serverNow: input.serverNow,
      budget: input.budget ?? Infinity, faultOf, limits: { ...CONSTANTS, ...(input.limits ?? {}) },
    });
    assert.equal(jcs(out.response), jcs(expect.response), name);
    assert.equal(jcs(out.state.toJSON()), jcs(expect.state), name);
    assert.equal(jcs(out.live), jcs(expect.frames), name);
  }
});

test('a dying tree answers each subscriber as a pull would: gone to the tree owner, not-found to everyone else', () => {
  const [vector] = JSON.parse(readFileSync(new URL('../../../corpus/push/serve.json', import.meta.url), 'utf8')).filter((v) => /board delete/.test(v.name));
  const after = new ServerState(vector.expect.state);
  const deaths = vector.expect.frames.filter((event) => event.dead);
  assert.deepEqual(deaths.map((event) => event.key), ['acct:A/overlay/b_00000001', 'acct:B/overlay/b_00000001', 'tree:b_00000001']);
  assert.deepEqual([
    deathFrameFor(after, 'acct:A/overlay/b_00000001', 'A'),
    deathFrameFor(after, 'acct:B/overlay/b_00000001', 'B'),
    deathFrameFor(after, 'tree:b_00000001', 'A'),
    deathFrameFor(after, 'tree:b_00000001', 'B'),
  ], [
    { op: 'gone', scope: 'self/overlay/b_00000001' },
    { op: 'not-found', scope: 'self/overlay/b_00000001' },
    { op: 'gone', scope: 'tree/b_00000001' },
    { op: 'not-found', scope: 'tree/b_00000001' },
  ]);
});

test('a 409 before any admission leaves no binding; 400 and 413 leave the state untouched', () => {
  const state = empty();
  const gap = pushed(state, { replica: REPLICA, ackThrough: 0, intents: [createCard(2, 'card0002', 200)] });
  assert.deepEqual(gap.state.replicas, {});
  const malformed = pushed(state, { replica: REPLICA, intents: [] });
  assert.deepEqual([malformed.response.status, malformed.response.body.error, malformed.state], [400, 'malformed', state]);
  const tooMany = pushed(state, { replica: REPLICA, ackThrough: 0, intents: [createCard(1, 'card0001', 100), createCard(2, 'card0002', 200)] }, { limits: { ...CONSTANTS, PUSH_MAX_INTENTS: 1 } });
  assert.deepEqual([tooMany.response.status, tooMany.response.body.error, tooMany.state], [413, 'request-too-large', state]);
});

test('a committed change sends one frame with the scope digest and the changed rows', () => {
  const out = pushed(empty(), { replica: REPLICA, ackThrough: 0, intents: [createCard(1, 'card0001', 100)] });
  assert.deepEqual(out.frames, [{
    key: 'acct:A/probe',
    frame: { op: 'change', scope: 'self/probe', epoch: 'ep-1', seq: 1, digest: out.state.scope('acct:A/probe').digest, rows: [out.state.row('acct:A/probe', 'card', 'card0001')] },
  }]);
});
