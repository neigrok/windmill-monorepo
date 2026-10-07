// view/drawn.json and view/stored.json (§7.6): a replica's confirmed rows joined with its pending
// entries. Each input replica is built by running client steps; the vector carries the replica itself.

import { ZERO_DIGEST, scopeDigest } from '../core/digest.js';
import { compareRecords, isVisible } from '../core/rows.js';
import { Cursor } from '../core/wire.js';
import { Replica, freshMeta } from '../client/replica.js';
import { capCount, view } from '../client/views.js';
import { OTHER, registry, row, st, vector } from './fixtures.js';
import { assertReachable, runSteps, settle } from './steps.js';

const REPLICA = 'rp_00000000000000000000000000000001';
const BOARD = 'b_00000001';

function bound(confirmed = {}) {
  return settle({ active: REPLICA, replicas: [{ meta: freshMeta(REPLICA, 'bound', 'A'), confirmed }] }).replicas[0];
}

// The replica after `steps` on a device holding `replica`.
function after(replica, steps) {
  const out = runSteps({ device: { active: replica.meta.replica, replicas: [replica] }, steps });
  return out.device.replicas[0];
}

function ok(n, seq) {
  return { status: 200, body: { serverTime: 5000, epoch: 'ep-1', as: 'A', lastN: n, results: [{ n, s: 'ok', seq }] } };
}

const CARDS = [
  row({ t: 'card', id: 'card0001', life: ['alive', st(1000)], born: st(1000), f: { ord: ['a0', st(1000)], tier: ['review', st(1000)], title: ['One', st(1000)] }, seq: 1 }),
  row({ t: 'card', id: 'card0002', life: ['alive', st(1100)], born: st(1100), f: { ord: ['a1', st(1100)], title: ['Two', st(1100)] }, seq: 2 }),
  row({ t: 'card', id: 'card0003', life: ['alive', st(1200)], born: st(1200), f: { ord: ['a2', st(1200)], title: ['Three', st(1200)] }, seq: 3 }),
];
const RUN = row({ t: 'run', id: 'run00001', life: ['alive', st(1300, 0, 'srv')], born: st(1300, 0, 'srv'), f: { startedAt: [1300, st(1300, 0, 'srv')] }, seq: 4 });
const LAP = row({ t: 'lap', id: 'lap00001', life: ['alive', st(1400)], born: st(1400), f: { at: [1400, st(1400)], runId: ['run00001', st(1400)], weight: [20, st(1400)] }, v: { no: 1 }, seq: 5 });

function viewVector(name, replica, scope, withStored) {
  assertReachable({ replicas: [replica] });
  const loaded = new Replica(replica);
  const records = [...view(loaded, registry, scope, { withHeld: !withStored }).values()].sort(compareRecords);
  const expect = {
    records,
    visible: records.filter((record) => isVisible(registry.type(record.t), record)).map((record) => [record.t, record.id]),
  };
  if (withStored) {
    expect.capCount = {};
    for (const type of registry.types.values()) {
      if (type.cap !== undefined && type.scope === registry.scopeKindOf(scope)) expect.capCount[type.type] = capCount(loaded, registry, scope, type.type);
    }
  }
  return vector(name, { replica, scope }, expect);
}

function scenarios() {
  const base = bound({ 'self/probe': [...CARDS, RUN, LAP] });
  const withUnknown = bound({
    'self/probe': [
      row({ t: 'card', id: 'card0001', life: ['alive', st(1000)], born: st(1000), f: { title: ['One', st(1000)], zzz: [7, st(1000)] }, seq: 1 }),
      row({ t: 'ghost', id: 'g1', f: { any: [true, st(1000)] }, seq: 2 }),
    ],
  });
  const pendingUpdate = after(base, [
    { op: 'commit', scope: 'self/probe', changes: [{ op: 'update', t: 'card', id: 'card0001', f: { title: 'Uno' } }], deviceNow: 5000 },
  ]);
  const edited = structuredClone(pendingUpdate);
  edited.confirmed['self/probe'][0] = row({ t: 'card', id: 'card0001', life: ['alive', st(1000)], born: st(1000), f: { ord: ['a0', st(1000)], tier: ['review', st(1000)], title: ['Edited elsewhere', st(6000, 0, OTHER)] }, seq: 7 });
  delete edited.cursors['self/probe'];
  const staleEntry = settle({ active: REPLICA, replicas: [edited] }).replicas[0];
  const remaining = base.confirmed['self/probe'].filter((kept) => kept.id !== 'card0001');
  const deletedUnderEdit = after(pendingUpdate, [
    { op: 'pull', scopes: ['self/probe'], deviceNow: 5001 },
    {
      op: 'pullResponse',
      deviceNow: 5001,
      response: {
        status: 200,
        body: {
          serverTime: 5001,
          epoch: 'ep-1',
          as: 'A',
          pages: [{
            scope: 'self/probe',
            kind: 'rows',
            rows: [{ t: 'card', id: 'card0001', life: ['dead', st(2000, 0, OTHER)], born: st(1000), seq: 6 }],
            cursor: Cursor.encode({ e: 'ep-1', m: 'live', s: 6 }),
            more: false,
            seq: 6,
            digest: remaining.length ? scopeDigest(remaining) : ZERO_DIGEST,
          }],
        },
      },
    },
  ]);
  const ranked = after(base, [
    { op: 'commit', scope: 'self/probe', changes: [{ op: 'update', t: 'card', id: 'card0001', f: { tier: 'draft' } }], deviceNow: 5000 },
  ]);
  const heldDelete = after(base, [
    { op: 'commit', scope: 'self/probe', changes: [{ op: 'delete', t: 'card', id: 'card0002' }], opts: { hold: true }, deviceNow: 5000 },
  ]);
  const acked = after(base, [
    { op: 'commit', scope: 'self/probe', changes: [{ op: 'update', t: 'card', id: 'card0003', f: { title: 'Tres' } }], deviceNow: 5000 },
    { op: 'push', deviceNow: 5000 },
    { op: 'pushResponse', response: ok(1, 8), deviceNow: 5000 },
  ]);
  const command = after(base, [
    {
      op: 'commit',
      scope: 'self/probe',
      opts: {
        cmd: { name: 'probe.start', args: { id: 'run00002', label: 'Morning', startedAt: 5000, join: true } },
        predict: [{ op: 'create', t: 'run', id: 'run00002', f: { label: 'Morning', startedAt: 5000 } }],
      },
      deviceNow: 5000,
    },
    { op: 'commit', scope: 'self/probe', changes: [{ op: 'create', t: 'lap', id: 'lap00002', f: { runId: 'run00002', weight: 30 } }], deviceNow: 5001 },
  ]);
  const serials = after(base, [
    { op: 'commit', scope: 'self/probe', deviceNow: 5000, opts: {
      cmd: { name: 'probe.end', args: { runId: 'run00001', endedAt: 5000 } },
      predict: [{ op: 'update', t: 'lap', id: LAP.id, v: { no: 3 } },
        { op: 'create', t: 'lap', id: 'lap00002', f: { runId: RUN.id, weight: 30 }, v: { no: 2 } }],
    } },
    { op: 'commit', scope: 'self/probe', changes: [{ op: 'update', t: 'lap', id: LAP.id, f: { weight: 25 } }], deviceNow: 5001 },
  ]);
  const heldSerials = after(serials, [
    { op: 'commit', scope: 'self/probe', deviceNow: 5002, opts: {
      hold: true, cmd: { name: 'probe.end', args: { runId: 'run00001', endedAt: 5002 } },
      predict: [{ op: 'update', t: 'lap', id: LAP.id, v: { no: 4 } }, { op: 'delete', t: 'lap', id: 'lap00002' }],
    } },
  ]);
  const overlay = `self/overlay/${BOARD}`;
  const marks = bound({
    [overlay]: [
      row({ t: 'mark', id: 'oak', f: { done: [true, st(1000)] }, x: { memo: { text: 'first draft', rev: 3, merged: false } }, seq: 3 }),
      row({ t: 'mark', id: 'elm', f: { done: [null, st(1000)] }, seq: 4 }),
    ],
  });
  const texts = after(marks, [
    { op: 'commit', scope: overlay, changes: [{ op: 'write', t: 'mark', id: 'oak', x: { memo: 'second draft' } }], deviceNow: 5000 },
    { op: 'commit', scope: overlay, changes: [{ op: 'write', t: 'mark', id: 'oak', x: { memo: 'third draft' } }], actor: OTHER, deviceNow: 5001 },
    { op: 'commit', scope: overlay, changes: [{ op: 'write', t: 'mark', id: 'ash', f: { done: null }, x: { memo: '' } }], deviceNow: 5002 },
    { op: 'commit', scope: overlay, changes: [{ op: 'write', t: 'mark', id: 'yew', f: { done: false } }], deviceNow: 5003 },
  ]);
  const tree = `tree/${BOARD}`;
  const links = after(bound({
    [tree]: [
      row({ t: 'link', id: ['oak', 'elm'], life: ['alive', st(1000)], seq: 1 }),
      row({ t: 'meta', id: 'meta', f: { title: ['Plan', st(1000)] }, seq: 2 }),
      row({ t: 'tag', id: 'elm', life: ['alive', st(1000)], born: st(1000), f: { label: ['Elm', st(1000)] }, seq: 3 }),
      row({ t: 'tag', id: 'oak', life: ['alive', st(1000)], born: st(1000), f: { label: ['Oak', st(1000)] }, seq: 4 }),
    ],
  }), [
    { op: 'commit', scope: tree, changes: [{ op: 'put', t: 'link', id: ['oak', 'elm'], present: false }], deviceNow: 5000 },
    { op: 'commit', scope: tree, changes: [{ op: 'put', t: 'link', id: ['elm', 'oak'] }], deviceNow: 5001 },
    { op: 'commit', scope: tree, changes: [{ op: 'delete', t: 'tag', id: 'elm' }], opts: { hold: true }, deviceNow: 5002 },
  ]);
  return { base, withUnknown, pendingUpdate, staleEntry, deletedUnderEdit, ranked, heldDelete, acked, command, serials, heldSerials, texts, links, overlay, tree };
}

export function files() {
  const s = scenarios();
  const drawn = [
    viewVector('confirmed rows alone are drawn as they are, serials included', s.base, 'self/probe', false),
    viewVector('an unknown field and a row of an unknown type are kept; the unknown type is never visible', s.withUnknown, 'self/probe', false),
    viewVector('a pending update over a record the server deleted draws a record without life, which is not visible', s.deletedUnderEdit, 'self/probe', false),
    viewVector('a ready update joins over the confirmed row', s.pendingUpdate, 'self/probe', false),
    viewVector('a pending register older than the confirmed one loses the join', s.staleEntry, 'self/probe', false),
    viewVector('a newer pending value of lower rank loses to the confirmed higher rank', s.ranked, 'self/probe', false),
    viewVector('a held delete is drawn dead', s.heldDelete, 'self/probe', false),
    viewVector('an acked entry stays in the view until its result resolves', s.acked, 'self/probe', false),
    viewVector('a command entry draws its prediction, and a later create draws without a serial', s.command, 'self/probe', false),
    viewVector('predicted serials overlay confirmed and created rows and survive a later field delta', s.serials, 'self/probe', false),
    viewVector('held predictions overlay serials in commit order and hide predicted deaths', s.heldSerials, 'self/probe', false),
    viewVector('the newest pending text replaces the confirmed text; visibleWhen decides mark visibility', s.texts, s.overlay, false),
    viewVector('keyed puts draw link presence; a singleton is always visible', s.links, s.tree, false),
  ];
  const stored = [
    viewVector('stored without holds equals drawn', s.pendingUpdate, 'self/probe', true),
    viewVector('a held delete leaves the record alive in stored and in the cap count', s.heldDelete, 'self/probe', true),
    viewVector('stored keeps the prediction of a ready command entry', s.command, 'self/probe', true),
    viewVector('stored keeps ready predicted serials and excludes held serials and deaths', s.heldSerials, 'self/probe', true),
    viewVector('a held tag delete is alive in stored', s.links, s.tree, true),
    viewVector('stored of confirmed rows alone', s.base, 'self/probe', true),
    viewVector('a lifeless record left by a pending update over a server delete is not counted against the cap', s.deletedUnderEdit, 'self/probe', true),
  ];
  return { 'view/drawn.json': drawn, 'view/stored.json': stored };
}
