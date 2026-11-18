// admit/restore.json: K-3's server side (§6.4). An engine restore command and the probe's product inverse
// command, admitted against one canonical state: each operation holds or skips on its own condition, and
// what holds is written under a fresh server stamp.

import assert from 'node:assert/strict';
import { CONSTANTS } from '../core/constants.js';
import { admit } from '../server/admit.js';
import { ServerState } from '../server/state.js';
import { EffectPlanProduct } from './effect-plan.js';
import { overlayScope, product, productScope, registry, row, serverState, st, treeScope, vector } from './fixtures.js';

const NOW = 1_000_000;
const A = { kind: 'replica', account: 'A', replica: 'rp_0000000000000000000000000000000a', n: 1 };
const BOARD = 'b_00000001';
const CHILD = 'b_00000002';
const stamp = (ms) => ({ kind: 'stamp', stamp: st(ms) });
const field = (name) => ({ kind: 'field', name });

function admitted(name, state, intent) {
  const outcome = admit({ state: new ServerState(state), registry, product, origin: A, intent, serverNow: NOW, limits: CONSTANTS });
  return vector(name, { state, origin: A, intent, serverNow: NOW }, { result: outcome.result, state: outcome.state.toJSON() });
}

// A's product scope with a card, A's tree with a tag, a dead tag, a link and a meta, and A's overlay with a
// mark, all at known stamps and sequences.
function world() {
  return serverState({
    scopes: { 'acct:A/probe': productScope('A'), [`tree:${BOARD}`]: treeScope('A', BOARD), [`acct:A/overlay/${BOARD}`]: overlayScope('A', BOARD) },
    rows: {
      'acct:A/probe': [
        row({ t: 'board', id: BOARD, born: st(1000), life: ['alive', st(1000)], seq: 1 }),
        row({ t: 'card', id: 'card0001', born: st(2000), life: ['alive', st(2000)], f: { title: ['New', st(5000)], body: ['b', st(2000)] }, seq: 3 }),
      ],
      [`tree:${BOARD}`]: [
        row({ t: 'meta', id: 'meta', f: { title: ['Grown', st(5000)] }, seq: 4 }),
        row({ t: 'tag', id: 'oak', born: st(3000), life: ['alive', st(3000)], f: { label: ['Oak', st(3000)] }, seq: 2 }),
        row({ t: 'tag', id: 'elm', born: st(3100), life: ['dead', st(5000)], f: { label: ['Elm', st(3100)] }, seq: 3 }),
        row({ t: 'link', id: ['oak', 'elm'], life: ['alive', st(5000)], f: { strength: [3, st(5000)] }, seq: 5 }),
      ],
      [`acct:A/overlay/${BOARD}`]: [row({ t: 'mark', id: 'oak', x: { memo: { text: 'mine', rev: 2, merged: false } }, seq: 2 })],
    },
  });
}

const restore = (scope, name, operations, expectedEpoch = 'ep-1') => ({ scope, cmd: { name, args: { expectedEpoch, operations } } });
const cardTitle = (expected, before = 'Old') => ({ kind: 'field', t: 'card', id: 'card0001', slot: field('title'), expected, before });

function fields() {
  const applied = admitted('a field holding its expected version takes back its earlier value under a fresh server stamp', world(),
    restore('self/probe', 'probe.restore', [cardTitle(stamp(5000))]));
  assert.deepEqual(applied.expect.result.detail.command, { inverse: { outcomes: [{ index: 0, s: 'applied' }] } });
  assert.equal(applied.expect.state.rows['acct:A/probe'].find((r) => r.t === 'card').f.title[0], 'Old');
  const moved = admitted('a field another write moved since skips, writing nothing', world(),
    restore('self/probe', 'probe.restore', [cardTitle(stamp(4000))]));
  assert.deepEqual(moved.expect.result.detail, { windmillKit: { v: 1, effects: [{ scope: 'self/probe', beforeSeq: 3, seq: 3, rows: [] }] },
    command: { inverse: { outcomes: [{ index: 0, s: 'skipped', code: 'version-changed' }] } } });
  const independent = admitted('each operation holds or skips by itself: an ABA on one field leaves another\'s restore', world(),
    restore('self/probe', 'probe.restore', [cardTitle(stamp(4000)),
      { kind: 'field', t: 'card', id: 'card0001', slot: field('body'), expected: stamp(2000), before: 'earlier' }]));
  assert.deepEqual(independent.expect.result.detail.command.inverse.outcomes.map(({ s }) => s), ['skipped', 'applied']);
  const epoch = admitted('another epoch skips every operation', world(),
    restore('self/probe', 'probe.restore', [cardTitle(stamp(5000))], 'ep-0'));
  assert.deepEqual(epoch.expect.result.detail.command.inverse.outcomes, [{ index: 0, s: 'skipped', code: 'epoch-changed' }]);
  const text = admitted('a text at its expected revision is replaced, its head archived', world(),
    restore(`self/overlay/${BOARD}`, 'probe.restoreOverlay', [{ kind: 'field', t: 'mark', id: 'oak', slot: { kind: 'text', name: 'memo' }, expected: { kind: 'text', revision: 2 }, before: '' }]));
  assert.equal(text.expect.result.detail.command.inverse.outcomes[0].s, 'applied');
  const lives = admitted('a revivable record and a keyed record take back their lives', world(),
    restore(`tree/${BOARD}`, 'probe.restoreTree', [
      { kind: 'field', t: 'tag', id: 'elm', slot: { kind: 'life' }, expected: stamp(5000), before: 'alive' },
      { kind: 'field', t: 'link', id: ['oak', 'elm'], slot: { kind: 'life' }, expected: stamp(5000), before: 'dead' },
      { kind: 'field', t: 'meta', id: 'meta', slot: field('title'), expected: stamp(5000), before: 'Root' },
    ]));
  assert.deepEqual(lives.expect.result.detail.command.inverse.outcomes.map(({ s }) => s), ['applied', 'applied', 'applied']);
  return [applied, moved, independent, epoch, text, lives];
}

function creations() {
  const footprint = [{ slot: { kind: 'born' }, version: stamp(2000) }, { slot: { kind: 'life' }, version: stamp(2000) },
    { slot: field('body'), version: stamp(2000) }, { slot: field('title'), version: stamp(5000) }];
  const created = (rowSeq, prints = footprint) => restore('self/probe', 'probe.restore', [{ kind: 'createdRecord', t: 'card', id: 'card0001', rowSeq, footprint: prints }]);
  const deleted = admitted('a created record whose complete footprint and row sequence hold dies', world(), created(3));
  assert.equal(deleted.expect.result.detail.command.inverse.outcomes[0].s, 'applied');
  const rowMoved = admitted('a created record at another row sequence skips', world(), created(2));
  const changed = admitted('a created record whose footprint changed skips', world(), created(3, footprint.slice(0, 3)));
  assert.deepEqual([rowMoved, changed].map((sample) => sample.expect.result.detail.command.inverse.outcomes[0].code), ['record-changed', 'record-changed']);
  const recreate = (id) => restore('self/probe', 'probe.restore', [{ kind: 'createRecord', t: 'card', id, values: { f: { title: 'Again' } } }]);
  const absent = admitted('a create restores a wholly absent record under the server stamp', world(), recreate('card0002'));
  assert.equal(absent.expect.result.detail.command.inverse.outcomes[0].s, 'applied');
  const present = admitted('a create of a record that exists skips', world(), recreate('card0001'));
  assert.equal(present.expect.result.detail.command.inverse.outcomes[0].code, 'record-present');
  const unset = (born, name = 'size') => restore('self/probe', 'probe.restore', [{ kind: 'field', t: 'card', id: 'card0001', slot: field(name), expected: { kind: 'absent', born }, before: 2.5 }]);
  const stillUnset = admitted('an absent expectation holds while the field is unset in the same incarnation', world(), unset(st(2000)));
  const otherBirth = admitted('an absent expectation of another incarnation skips', world(), unset(st(1999)));
  const nowSet = admitted('an absent expectation of a field set since skips', world(), restore('self/probe', 'probe.restore', [{ kind: 'field', t: 'card', id: 'card0001', slot: field('title'), expected: { kind: 'absent', born: st(2000) }, before: 'x' }]));
  assert.deepEqual([stillUnset, otherBirth, nowSet].map((sample) => sample.expect.result.detail.command.inverse.outcomes[0].s), ['applied', 'skipped', 'skipped']);
  return [deleted, rowMoved, changed, absent, present, stillUnset, otherBirth, nowSet];
}

function malformed() {
  return [
    ['born, which nothing restores', [{ kind: 'field', t: 'card', id: 'card0001', slot: { kind: 'born' }, expected: stamp(2000), before: 'alive' }]],
    ['a governing record', [{ kind: 'createdRecord', t: 'board', id: BOARD, rowSeq: 1, footprint: [{ slot: { kind: 'born' }, version: stamp(1000) }] }]],
    ['the life of a record no write brings back', [{ kind: 'field', t: 'card', id: 'card0001', slot: { kind: 'life' }, expected: stamp(2000), before: 'alive' }]],
    ['a value off its field\'s domain', [cardTitle(stamp(5000), 'far longer than twelve')]],
    ['an unknown member', [{ ...cardTitle(stamp(5000)), extra: true }]],
    ['no operation', []],
    ['one slot twice', [cardTitle(stamp(5000)), cardTitle(stamp(5000), 'Other')]],
    ['a footprint out of slot order', [{ kind: 'createdRecord', t: 'card', id: 'card0001', rowSeq: 3, footprint: [{ slot: { kind: 'life' }, version: stamp(2000) }, { slot: { kind: 'born' }, version: stamp(2000) }] }]],
  ].map(([what, operations]) => {
    const sample = admitted(`a restore naming ${what} is invalid`, world(), restore('self/probe', 'probe.restore', operations));
    assert.deepEqual(sample.expect.result, { s: 'refused', code: 'invalid' }, what);
    return sample;
  });
}

// The probe's product inverse: a branch created CHILD and its tree and titled the parent.
function unbranch() {
  const branched = serverState({
    scopes: { 'acct:A/probe': productScope('A'), [`tree:${BOARD}`]: treeScope('A', BOARD), [`tree:${CHILD}`]: treeScope('A', CHILD) },
    rows: {
      'acct:A/probe': [row({ t: 'board', id: BOARD, born: st(1000), life: ['alive', st(1000)], seq: 1 }),
        row({ t: 'board', id: CHILD, born: '5000:0:srv', life: ['alive', '5000:0:srv'], seq: 2 })],
      [`tree:${BOARD}`]: [row({ t: 'meta', id: 'meta', f: { title: ['Branch', '5000:0:srv'] }, seq: 2 })],
      [`tree:${CHILD}`]: [row({ t: 'meta', id: 'meta', f: { title: ['Branch', '5000:0:srv'] }, seq: 1 })],
    },
  });
  const evidence = (seq = 1) => ({
    expectedEpoch: 'ep-1',
    ownedFields: [{ target: { scope: `tree/${BOARD}`, t: 'meta', id: 'meta', slot: field('title') }, version: { kind: 'stamp', stamp: '5000:0:srv' } }],
    unchangedCreatedRecords: [{ record: { scope: 'self/probe', t: 'board', id: CHILD }, rowSeq: 2,
      footprint: [{ slot: { kind: 'born' }, version: { kind: 'stamp', stamp: '5000:0:srv' } }, { slot: { kind: 'life' }, version: { kind: 'stamp', stamp: '5000:0:srv' } }] }],
    unchangedCreatedScopes: [{ scope: `tree/${CHILD}`, seq }],
  });
  const call = (proof) => ({ scope: 'self/probe', cmd: { name: 'probe.unbranch', args: { input: { parent: BOARD, child: CHILD, title: 'Root' }, evidence: proof } } });
  const undone = admitted('an unbranch whose evidence holds kills the created board and its tree and takes back the parent title', branched, call(evidence()));
  assert.equal(undone.expect.state.scopes[`tree:${CHILD}`].state, 'dead');
  assert.deepEqual(undone.expect.result.detail.command, { inverse: { outcomes: [{ index: 0, s: 'applied' }] } });
  const grown = admitted('an unbranch whose created tree changed since skips whole', branched, call(evidence(0)));
  assert.deepEqual(grown.expect.result.detail.command, { inverse: { outcomes: [{ index: 0, s: 'skipped', code: 'scope-changed' }] } });
  const unproved = admitted('an unbranch without proof of the created tree is invalid', branched, call({ ...evidence(), unchangedCreatedScopes: [] }));
  assert.equal(unproved.expect.result.code, 'invalid');
  const effectPlan = { detail: { created: true }, fault: true };
  assert.throws(() => admit({ state: new ServerState(branched), registry, product: new EffectPlanProduct(effectPlan), origin: A, intent: call(evidence()), serverNow: NOW, limits: CONSTANTS }),
    /an inverse command reports no outcome/);
  const silent = vector('an inverse command whose detail reports no outcome is a technical contract fault, and commits nothing',
    { state: branched, origin: A, intent: call(evidence()), serverNow: NOW, effectPlan }, { fault: true, state: branched });
  return [undone, grown, unproved, silent];
}

export function files() {
  return { 'admit/restore.json': [...fields(), ...creations(), ...malformed(), ...unbranch()] };
}
