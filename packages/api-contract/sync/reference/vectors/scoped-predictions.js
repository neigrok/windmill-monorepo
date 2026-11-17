import assert from 'node:assert/strict';
import { freshMeta } from '../client/replica.js';
import { scopeDigest } from '../core/digest.js';
import { jcs } from '../core/jcs.js';
import { Cursor, intentDigest } from '../core/wire.js';
import { pull } from '../server/pull.js';
import { push } from '../server/push.js';
import { ServerState } from '../server/state.js';
import { product, productScope, registry, row, serverState, st, treeScope } from './fixtures.js';
import { runSteps, settle, stepsVector } from './steps.js';

export function scopedPredictions() {
  const replica = 'rp_00000000000000000000000000000001';
  const parent = 'b_00000001';
  const child = 'b_00000002';
  const origin = 'self/probe';
  const tree = `tree/${parent}`;
  const nextTree = `tree/${child}`;
  const device = settle({ active: replica, replicas: [{ meta: freshMeta(replica, 'bound', 'A'), confirmed: {
    [origin]: [row({ t: 'board', id: parent, born: st(1000), life: ['alive', st(1000)], seq: 1 })],
    [tree]: [row({ t: 'meta', id: 'meta', f: { title: ['Parent', st(1000)] }, seq: 5 })],
  } }] });
  const commit = { op: 'commit', scope: origin, changes: [], deviceNow: 5000, opts: {
    cmd: { name: 'probe.branch', args: { parent, child, title: 'Branch' } },
    scopedPredict: [
      { scope: nextTree, changes: [{ op: 'write', t: 'meta', id: 'meta', f: { title: 'Branch' } }] },
      { scope: origin, changes: [{ op: 'create', t: 'board', id: child }] },
      { scope: tree, changes: [{ op: 'write', t: 'meta', id: 'meta', f: { title: 'Branch' } }] },
    ],
  } };
  const offline = stepsVector('one offline command draws its origin and two independent tree projections', {
    device, steps: [commit, ...[origin, tree, nextTree].map((scope) => ({ op: 'view', scope, withHeld: true })), { op: 'subscriptions' }],
  });
  assert.deepEqual(offline.expect.device.replicas[0].outbox[0].predictions?.map(({ scope }) => scope), [origin, tree, nextTree]);
  assert.equal(offline.expect.returns[1].records.length, 2);
  assert.equal(offline.expect.returns[2].records[0].f.title[0], 'Branch');
  assert.equal(offline.expect.returns[3].records[0].f.title[0], 'Branch');
  const server = new ServerState(serverState({ scopes: {
    'acct:A/probe': productScope('A'), [`tree:${parent}`]: treeScope('A', parent),
  }, rows: { 'acct:A/probe': device.replicas[0].confirmed[origin], [`tree:${parent}`]: device.replicas[0].confirmed[tree] } }));
  const send = { op: 'push', deviceNow: 5000 };
  const request = runSteps({ device, steps: [commit, send] }).returns[1];
  const pushed = push({ state: server, registry, product, account: 'A', request, serverNow: 6000 });
  assert.equal(pushed.response.body.results[0].s, 'ok');
  const ack = { op: 'pushResponse', response: pushed.response, deviceNow: 6000 };
  const receive = (scope) => [
    { op: 'pull', scopes: [scope] },
    { op: 'pullResponse', response: pull({ state: pushed.state, registry, product, account: 'A', request: { scopes: [{ scope, cursor: null }] }, serverNow: 6001 }).response },
  ];
  const allOrders = [
    [origin, tree, nextTree], [origin, nextTree, tree], [tree, origin, nextTree],
    [tree, nextTree, origin], [nextTree, origin, tree], [nextTree, tree, origin],
  ].map((order) => {
    const steps = [commit, send, ack];
    for (const scope of order) {
      steps.push(...receive(scope));
      const checkpoint = runSteps({ device, steps });
      const entry = checkpoint.device.replicas[0].outbox?.[0];
      if (scope !== order[2]) {
        assert.equal(entry.state, 'acked');
        assert.equal(entry.predictions.find((projection) => projection.scope === scope).covered, true);
        // Reopening the persisted replica between every match preserves independent coverage.
        const resumed = stepsVector('restart checkpoint', { device: checkpoint.device, steps: [{ op: 'view', scope: order[2], withHeld: true }] });
        assert.ok(resumed.expect.returns[0].records.length > 0);
      } else assert.equal(entry, undefined);
      steps.push(...[origin, tree, nextTree].map((scope) => ({ op: 'view', scope, withHeld: true })), { op: 'push' });
    }
    return stepsVector(`ACK keeps projections until each target is covered: ${order.join(', ')}`, { device, steps });
  });
  const pulledFirst = stepsVector('an existing target pulled before ACK is covered immediately while the new governor waits for ACK', {
    device, steps: [commit, send, { op: 'pull', scopes: [nextTree] }, ...receive(tree), ack, { op: 'view', scope: nextTree, withHeld: true }, { op: 'push' }],
  });
  assert.equal(pulledFirst.expect.returns[2], null);
  assert.equal(pulledFirst.expect.device.replicas[0].outbox[0].predictions.find(({ scope }) => scope === tree).covered, true);
  assert.equal(pulledFirst.expect.returns.at(-1), null);
  const badReceipts = [
    ['missing target', (effects) => effects.pop()],
    ['duplicate scope', (effects) => effects.push(structuredClone(effects[0]))],
    ['row in wrong scope', (effects) => { effects[1].rows[0].t = 'card'; }],
    ['value hidden in metadata', (effects) => { effects[1].rows[0].value = 'private'; }],
    ['invalid version', (effects) => { effects[1].rows[0].slots[0].version.stamp = null; }],
    ['nonadvancing changed scope', (effects) => { effects[1].beforeSeq = effects[1].seq; }],
    ['NUL scope', (effects) => { effects[1].scope += '\u0000'; }],
  ].map(([name, change]) => {
    const broken = structuredClone(ack);
    change(broken.response.body.results[0].detail.windmillKit.effects);
    const sample = stepsVector(`a ${name} receipt changes no ACK state`, { device, steps: [commit, send, broken] });
    assert.deepEqual(sample.expect.returns[2], { throws: true });
    assert.deepEqual(sample.expect.device, runSteps({ device, steps: [commit, send] }).device);
    return sample;
  });
  const duplicate = stepsVector('a duplicate ACK preserves independently covered projections', {
    device, steps: [commit, send, ack, ...receive(origin), ack, { op: 'view', scope: tree, withHeld: true }],
  });
  assert.equal(duplicate.expect.device.replicas[0].outbox[0].predictions[0].covered, true);
  const refused = structuredClone(ack);
  refused.response.body.results = [{ n: 1, s: 'refused', code: 'invalid' }];
  const refusal = stepsVector('a refused scoped command restores every scope and keeps target-qualified notice content', {
    device, steps: [commit, send, refused, ...[origin, tree, nextTree].map((scope) => ({ op: 'view', scope, withHeld: true }))],
  });
  assert.equal(refusal.expect.device.replicas[0].outbox, undefined);
  assert.equal(refusal.expect.device.replicas[0].notices[0].content.predictions.length, 3);
  return [offline, ...allOrders, pulledFirst, ...badReceipts, duplicate, refusal];
}

export function files() {
  return { 'write/scoped-predictions.json': [...scopedPredictions(), ...scopedCoverage(), ...scopedReconciliation(), ...scopedReplay(), ...scopedDependencies()] };
}

export function scopedCoverage() {
  const replica = 'rp_00000000000000000000000000000001';
  const origin = 'self/overlay/b_00000001';
  const target = 'self/overlay/b_00000002';
  const mark = (text, seq) => row({ t: 'mark', id: 'oak', x: { memo: { text, rev: seq, merged: false } }, seq });
  const device = settle({ active: replica, replicas: [{ meta: freshMeta(replica, 'bound', 'A'), confirmed: {
    'self/probe': [1, 2].map((n) => row({ t: 'board', id: `b_0000000${n}`, born: st(1000), life: ['alive', st(1000)], seq: n })),
    [origin]: [mark('old origin', 7)], [target]: [mark('old target', 4)],
  } }] });
  const commit = { op: 'commit', scope: origin, deviceNow: 5000, changes: [{ op: 'write', t: 'mark', id: 'oak', x: { memo: 'mine origin' } }], opts: {
    cmd: { name: 'probe.captureOverlay', args: {} }, scopedPredict: [{ scope: target, changes: [{ op: 'write', t: 'mark', id: 'oak', x: { memo: 'mine target' } }] }],
  } };
  const effects = [[origin, 7, 8], [target, 4, 5]].map(([scope, beforeSeq, seq]) => ({ scope, beforeSeq, seq,
    rows: [{ t: 'mark', id: 'oak', beforeRowSeq: beforeSeq, rowSeq: seq, slots: [{ slot: { kind: 'text', name: 'memo' }, version: { kind: 'text', revision: seq } }] }],
  }));
  const ack = { op: 'pushResponse', deviceNow: 6000, response: { status: 200, body: { as: 'A', epoch: 'ep-1', serverTime: 6000, lastN: 1,
    results: [{ n: 1, s: 'ok', seq: 8, write: [], detail: { windmillKit: { v: 1, effects } } }],
  } } };
  const receive = (scope, text, seq, partial = false) => [
    { op: 'pull', scopes: [scope] },
    { op: 'pullResponse', response: { status: 200, body: { as: 'A', epoch: 'ep-1', serverTime: 6000, pages: [{
      scope, kind: 'rows', rows: [mark(text, seq)], seq, more: partial,
      cursor: Cursor.encode({ e: 'ep-1', m: 'live', s: seq, ...(partial ? { k: ['mark', 'oak'] } : {}) }), digest: scopeDigest([mark(text, seq)]),
    }] } } },
  ];
  const prefix = [commit, { op: 'push' }, ack];
  const partial = stepsVector('a partial target cursor does not cover its projection', { device, steps: [...prefix,
    ...receive(target, 'actual target', 5, true), { op: 'view', scope: target, withHeld: true }],
  });
  assert.equal(partial.expect.returns.at(-1).records[0].x.memo, 'mine target');
  assert.equal(partial.expect.device.replicas[0].outbox[0].predictions[1].covered, undefined);
  const resumed = stepsVector('after restart a covering newer text deactivates only that target and reset does not revive it', {
    device: partial.expect.device, steps: [...receive(target, 'newer target', 6), { op: 'view', scope: target, withHeld: true },
      { op: 'pull', scopes: [target] }, { op: 'pullResponse', response: { status: 200, body: { as: 'A', epoch: 'ep-1', serverTime: 6001, pages: [{ scope: target, kind: 'reset' }] } } },
      { op: 'view', scope: target, withHeld: true }, { op: 'view', scope: origin, withHeld: true }, { op: 'push' }],
  });
  assert.equal(resumed.expect.returns[2].records[0].x.memo, 'newer target');
  assert.equal(resumed.expect.returns[5].records[0].x.memo, 'newer target');
  assert.equal(resumed.expect.returns[6].records[0].x.memo, 'mine origin');
  assert.equal(resumed.expect.returns[7], null);
  const terminal = stepsVector('a terminal target resolves its projection while the origin remains pending', { device, steps: [...prefix,
    { op: 'pull', scopes: [target] }, { op: 'pullResponse', response: { status: 200, body: { as: 'A', epoch: 'ep-1', serverTime: 6001, pages: [{ scope: target, kind: 'gone' }] } } }],
  });
  assert.equal(terminal.expect.device.replicas[0].outbox[0].predictions[1].covered, true);
  const epoch = stepsVector('epoch recovery deliberately clears independent projection coverage for replay', {
    device: resumed.expect.device, ids: ['rp_00000000000000000000000000000002'], actors: ['r_bbbbbbbbbbbb'],
    steps: [{ op: 'epochChange', epoch: 'ep-2' }, { op: 'view', scope: target, withHeld: true }],
  });
  assert.equal(epoch.expect.returns[1].records[0].x.memo, 'mine target');
  assert.deepEqual(epoch.expect.device.replicas[0].outbox[0].predictions.map(({ covered, resultSeq }) => [covered, resultSeq]), [[undefined, undefined], [undefined, undefined]]);
  const extra = structuredClone(ack);
  extra.response.body.results[0].detail.windmillKit.effects.push({ scope: 'tree/b_00000002', beforeSeq: 4, seq: 5, rows: [] });
  const discovered = stepsVector('an additional discovered receipt target persists as an empty projection until covered', { device, steps: [commit, { op: 'push' }, extra] });
  assert.deepEqual(discovered.expect.device.replicas[0].outbox[0].predictions[2], { scope: 'tree/b_00000002', d: [], resultSeq: 5 });
  const absent = structuredClone(ack);
  const absentEffect = absent.response.body.results[0].detail.windmillKit.effects[1];
  Object.assign(absentEffect, { beforeSeq: null, seq: null, rows: [] });
  const absentDevice = structuredClone(device);
  delete absentDevice.replicas[0].confirmed[target];
  delete absentDevice.replicas[0].cursors[target];
  const uncreated = stepsVector('an absent declared target covers immediately without discarding another pending projection', { device: absentDevice, steps: [commit, { op: 'push' }, absent] });
  assert.equal(uncreated.expect.device.replicas[0].outbox[0].predictions[1].covered, true);
  const built = runSteps({ device, steps: [commit] }).device.replicas[0].outbox[0].predictions;
  const bytes = Buffer.byteLength(jcs(built));
  assert.equal(bytes, 163);
  const bounds = [bytes - 1, bytes].map((limit) => {
    const sample = stepsVector(`scoped local prediction byte limit ${limit} is atomic`, { device, limits: { EFFECT_MAX_BYTES: limit }, steps: [commit] });
    if (limit < bytes) {
      assert.deepEqual(sample.expect.returns[0], { refused: 'too-large' });
      assert.deepEqual(sample.expect.device, device);
    } else assert.ok(sample.expect.device.replicas[0].outbox);
    return sample;
  });
  const invalid = [
    { predict: [{ op: 'write', t: 'mark', id: 'oak', x: { memo: 'ambiguous' } }] },
    { scopedPredict: [{ scope: target, changes: [{ op: 'write', t: 'mark', id: 'oak', x: { memo: 'a\u0000b' } }] }] },
  ].map((opts, index) => {
    const bad = structuredClone(commit);
    Object.assign(bad.opts, opts);
    const sample = stepsVector(`invalid scoped prediction shape ${index} leaves no partial entry`, { device, steps: [bad] });
    assert.deepEqual(sample.expect.returns[0], { throws: true });
    assert.deepEqual(sample.expect.device, device);
    return sample;
  });
  return [partial, resumed, terminal, epoch, discovered, uncreated, ...bounds, ...invalid];
}

export function scopedReconciliation() {
  const replica = 'rp_00000000000000000000000000000001';
  const origin = 'self/probe', parent = 'b_00000001', child = 'b_00000002', actual = 'b_00000003', other = 'b_00000004';
  const device = settle({ active: replica, replicas: [{ meta: freshMeta(replica, 'bound', 'A'), confirmed: {
    [origin]: [parent, other].map((id) => row({ t: 'board', id, born: st(1000), life: ['alive', st(1000)], seq: 1 })),
    ...Object.fromEntries([parent, other].map((id) => [`tree/${id}`, [row({ t: 'meta', id: 'meta', f: { title: ['Before', st(1000)] }, seq: 5 })]])),
  } }] });
  const commit = { op: 'commit', scope: origin, deviceNow: 2000, changes: [], opts: {
    cmd: { name: 'probe.branch', args: { parent, child, title: 'Branch' } }, scopedPredict: [
      { scope: origin, changes: [{ op: 'create', t: 'board', id: child }] },
      ...[parent, child].map((id) => ({ scope: `tree/${id}`, changes: [{ op: 'write', t: 'meta', id: 'meta', f: { title: 'Branch' } }] })),
    ],
  } };
  const later = (id, now) => ({ op: 'commit', scope: `tree/${id}`, deviceNow: now,
    changes: [{ op: 'write', t: 'meta', id: 'meta', f: { title: 'Later' } }] });
  const ack = (id, time) => ({ op: 'pushResponse', deviceNow: time, response: { status: 200, body: {
    as: 'A', epoch: 'ep-1', serverTime: time, lastN: 1, results: [{ n: 1, s: 'ok', seq: 2,
      write: [{ t: 'board', from: child, id, born: st(time) }], detail: { windmillKit: { v: 1, effects: [
        { scope: origin, beforeSeq: 1, seq: 2, rows: [{ t: 'board', id, beforeRowSeq: null, rowSeq: 2,
          slots: ['born', 'life'].map((kind) => ({ slot: { kind }, version: { kind: 'stamp', stamp: st(time) } })) }] },
        ...[parent, id].sort().map((tree) => ({ scope: `tree/${tree}`, beforeSeq: tree === parent ? 5 : null, seq: tree === parent ? 6 : 1,
          rows: [{ t: 'meta', id: 'meta', beforeRowSeq: tree === parent ? 5 : null, rowSeq: tree === parent ? 6 : 1,
            slots: [{ slot: { kind: 'field', name: 'title' }, version: { kind: 'stamp', stamp: st(time) } }] }] })),
      ] } } }],
  } } });
  const steps = [commit, { op: 'push' }, later(parent, 3000), later(child, 3001), later(other, 3002)];
  const before = runSteps({ device, steps });
  const mapped = stepsVector('global governor remaps preserve per-tree singleton versions and later owned writes', { device, steps: [...steps, ack(actual, 9000)] });
  const entries = mapped.expect.device.replicas[0].outbox;
  assert.deepEqual(entries.map(({ scope }) => scope), [origin, `tree/${parent}`, `tree/${actual}`, `tree/${other}`]);
  assert.deepEqual(entries[0].intent, before.device.replicas[0].outbox[0].intent);
  assert.deepEqual(entries[0].predictions.map(({ scope }) => scope), [origin, `tree/${parent}`, `tree/${actual}`]);
  assert.equal(entries[0].predictions[1].d[0].f.title[1], st(9000));
  assert.equal(entries[0].predictions[2].d[0].f.title[1], st(9000));
  assert.notEqual(entries[1].intent.d[0].f.title[1], before.device.replicas[0].outbox[1].intent.d[0].f.title[1]);
  assert.notEqual(entries[2].intent.d[0].f.title[1], before.device.replicas[0].outbox[2].intent.d[0].f.title[1]);
  assert.deepEqual(entries[3], before.device.replicas[0].outbox[3]);
  const nextId = 'b_00000005';
  const replayAck = ack(nextId, 12000); replayAck.response.body.epoch = 'ep-2';
  const replay = stepsVector('epoch replay remaps prior governor targets again without touching another tree singleton', {
    device: mapped.expect.device, ids: ['rp_00000000000000000000000000000002'], actors: ['r_bbbbbbbbbbbb'],
    steps: [{ op: 'epochChange', epoch: 'ep-2' }, { op: 'push' }, replayAck],
  });
  assert.deepEqual(replay.expect.device.replicas[0].outbox.map(({ scope }) => scope), [origin, `tree/${parent}`, `tree/${nextId}`, `tree/${other}`]);
  assert.equal(replay.expect.device.replicas[0].outbox[0].writeTargets[0].id, nextId);
  assert.deepEqual(replay.expect.device.replicas[0].outbox[3].intent.d, entries[3].intent.d);
  const deletion = stepsVector('a merged scoped create refuses a queued deletion of its predicted identity', { device, steps: [commit, { op: 'push' },
    { op: 'commit', scope: origin, deviceNow: 3000, changes: [{ op: 'delete', t: 'board', id: child }] }, ack(actual, 9000)],
  });
  assert.deepEqual(deletion.expect.device.replicas[0].notices.map(({ code }) => code), ['target-merged']);
  assert.equal(deletion.expect.device.replicas[0].outbox.length, 1);
  return [mapped, replay, deletion];
}

export function scopedReplay() {
  const replica = 'rp_00000000000000000000000000000001', scope = 'self/probe';
  const initial = settle({ active: replica, replicas: [{ meta: freshMeta(replica, 'bound', 'A'), confirmed: {
    [scope]: [row({ t: 'card', id: 'card0001', born: st(1000), life: ['alive', st(1000)], f: { title: ['Before', st(1000)] }, seq: 1 })],
  } }] });
  const queued = runSteps({ device: initial, steps: [
    { op: 'commit', scope, deviceNow: 2000, changes: [{ op: 'update', t: 'card', id: 'card0001', f: { title: 'Invalid' } }] },
    ...[2001, 2002].map((deviceNow) => ({ op: 'commit', scope, deviceNow, changes: [], opts: { cmd: { name: 'probe.capture', args: {} } } })),
  ] }).device;
  // A retained replay checkpoint can contain several already-numbered saved commands.
  for (const [index, entry] of queued.replicas[0].outbox.entries()) {
    entry.state = 'sent'; entry.n = entry.intent.n = index + 1; entry.digest = intentDigest(entry.intent);
  }
  queued.replicas[0].meta.nextN = 4;
  const receipt = (n) => ({ n, s: 'ok', seq: 1, write: [], detail: { windmillKit: { v: 1,
    effects: [{ scope, beforeSeq: 1, seq: 1, rows: [] }] } } });
  const response = (result, next) => ({ op: 'pushResponse', deviceNow: 3000, response: { status: 200, body: {
    as: 'A', epoch: 'ep-1', serverTime: 3000, lastN: 3, results: [result], ...(next !== undefined ? { retry: { n: next, retryAfterMs: 0 } } : {}),
  } } });
  const ordinary = stepsVector('mixed replay stops acknowledgement pruning before the first saved scoped receipt', {
    device: queued, steps: [{ op: 'push' }, response({ n: 1, s: 'refused', code: 'invalid' }, 2)],
  });
  assert.equal(ordinary.expect.device.replicas[0].meta.ackThrough, 1);
  const first = stepsVector('after restart an already-covered first scoped receipt cannot prune the next unreturned receipt', {
    device: ordinary.expect.device, steps: [{ op: 'push' }, response(receipt(2), 3)],
  });
  assert.equal(first.expect.returns[0].ackThrough, 1);
  assert.deepEqual(first.expect.returns[0].intents.map(({ n }) => n), [2, 3]);
  assert.equal(first.expect.device.replicas[0].meta.ackThrough, 2);
  assert.deepEqual(first.expect.device.replicas[0].outbox.map(({ n }) => n), [3]);
  const last = stepsVector('restart between exclusive replay batches fetches the remaining exact saved receipt', {
    device: first.expect.device, steps: [{ op: 'push' }, response(receipt(3)), { op: 'push' }],
  });
  assert.equal(last.expect.returns[0].ackThrough, 2);
  assert.deepEqual(last.expect.returns[0].intents.map(({ n }) => n), [3]);
  assert.equal(last.expect.device.replicas[0].meta.ackThrough, 3);
  assert.equal(last.expect.device.replicas[0].outbox, undefined);
  assert.equal(last.expect.returns[2], null);
  const malformed = [0, 5, 2].map((next) => {
    const sample = stepsVector(`invalid continuation ${next} changes neither offset nor ACK state`, {
      device: ordinary.expect.device, steps: [{ op: 'push' }, response(receipt(2), next)],
    });
    assert.deepEqual(sample.expect.returns[1], { throws: true });
    assert.deepEqual(sample.expect.device, ordinary.expect.device);
    return sample;
  });
  return [ordinary, first, last, ...malformed];
}

export function scopedDependencies() {
  const replica = 'rp_00000000000000000000000000000001';
  const origin = 'tree/b_00000001', target = 'tree/b_00000002';
  const device = settle({ active: replica, replicas: [{ meta: freshMeta(replica, 'bound', 'A'), confirmed: {
    'self/probe': [1, 2].map((n) => row({ t: 'board', id: `b_0000000${n}`, born: st(1000), life: ['alive', st(1000)], seq: 1 })),
  } }] });
  const create = { op: 'commit', scope: target, deviceNow: 2000, changes: [{ op: 'create', t: 'tag', id: 'oak', f: { label: 'Oak' } }], opts: { hold: true } };
  const command = { op: 'commit', scope: origin, deviceNow: 3000, changes: [], opts: { cmd: { name: 'probe.captureTree', args: {} },
    scopedPredict: [{ scope: target, changes: [{ op: 'update', t: 'tag', id: 'oak', f: { label: 'Later' } }] }] } };
  const held = stepsVector('a target update without life carries the held target-record dependency across command scopes', {
    device, steps: [create, command, { op: 'push' }, { op: 'undo', gestureId: 'g1' }],
  });
  const pending = runSteps({ device, steps: [create, command] }).device.replicas[0].outbox;
  assert.equal(pending[1].predictions[1].d[0].life, undefined);
  assert.equal(held.expect.returns[2], null);
  assert.equal(held.expect.device.replicas[0].outbox, undefined);
  const unheld = structuredClone(create); delete unheld.opts;
  const refused = stepsVector('refusing a target create folds a later cross-scope command and retains every target delta', {
    device, steps: [unheld, command, { op: 'push' }, { op: 'pushResponse', deviceNow: 4000, response: { status: 200, body: {
      as: 'A', epoch: 'ep-1', serverTime: 4000, lastN: 1, results: [{ n: 1, s: 'refused', code: 'invalid' }], retry: { n: 2, retryAfterMs: 0 },
    } } }],
  });
  // The command may already be numbered; its complete scoped content remains in its source's notice.
  assert.equal(refused.expect.device.replicas[0].notices[0].content.dependents[0].scope, origin);
  assert.equal(refused.expect.device.replicas[0].notices[0].content.dependents[0].predictions[1].scope, target);
  return [held, refused];
}
