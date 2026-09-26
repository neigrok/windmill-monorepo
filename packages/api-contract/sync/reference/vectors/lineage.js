// lineage/*.json (§7.10): sign-in by the lineage rule, with the one decision kind R99 leaves (the
// signed-out decision), and sign-out. Devices are built by running client steps on their replicas.

import { freshMeta } from '../client/replica.js';
import { row, st } from './fixtures.js';
import { runSteps, settle, stepsVector } from './steps.js';

const ANON = 'rp_000000000000000000000000000000a0';
const DORMANT_A = 'rp_000000000000000000000000000000a1';
const DORMANT_B = 'rp_000000000000000000000000000000b1';
const BOUND = 'rp_000000000000000000000000000000a2';
const NEW = 'rp_000000000000000000000000000000c1';
const TREE = 'tree/b_00000001';

const commitStep = (scope, changes, opts, deviceNow) => ({ op: 'commit', scope, changes, ...(opts ? { opts } : {}), deviceNow });

// A replica after `steps`, run alone on a device of its own.
function replicaAfter(meta, steps, extra = {}) {
  const replica = { meta, ...extra };
  return runSteps({ device: settle({ active: meta.replica, replicas: [replica] }), steps }).device.replicas[0];
}

function anonWithWork() {
  return replicaAfter({ ...freshMeta(ANON, 'anon') }, [
    commitStep('self/probe', [{ op: 'create', t: 'card', id: 'card0009', f: { title: 'Offline' } }], undefined, 3000),
    commitStep('self/probe', [{ op: 'update', t: 'card', id: 'card0009', f: { tier: 'draft' } }], { guard: true }, 3001),
    commitStep('self/probe', [], {
      cmd: { name: 'probe.start', args: { id: 'run00009', startedAt: 3002, join: true } },
      predict: [{ op: 'create', t: 'run', id: 'run00009', f: { startedAt: 3002 } }],
    }, 3002),
    commitStep('self/probe', [{ op: 'create', t: 'board', id: 'b_00000001' }], undefined, 3003),
    commitStep(TREE, [{ op: 'write', t: 'meta', id: 'meta', f: { title: 'Plan' } }], { local: { rack: { plates: [10] }, 'picture:pic00001': { bytes: 12 } } }, 3004),
    commitStep('self/probe', [{ op: 'delete', t: 'card', id: 'card0009' }], { hold: true }, 3005),
  ]);
}

function dormant(id, account, extra = {}) {
  const meta = { ...freshMeta(id, 'dormant', account), ...(extra.meta ?? {}) };
  const replica = replicaAfter({ ...meta, state: 'bound' }, [
    commitStep('self/probe', [{ op: 'create', t: 'card', id: `card${account}001`.padEnd(8, '0'), f: { title: `${account}'s` } }], { gestureId: `before-${account}` }, 2000),
  ], { device: { probe: { rack: { plates: [20, 20] } } } });
  replica.meta.state = 'dormant';
  if (extra.notices) replica.notices = extra.notices;
  return replica;
}

function device(active, ...replicas) {
  return settle({ active, replicas });
}

function signIns() {
  const holds = { probe: true };
  const none = { probe: false };
  return [
    stepsVector('with no records in the product, signed-out work joins A without a decision and the anon replica is rebound', {
      device: device(ANON, anonWithWork()),
      steps: [{ op: 'signIn', account: 'A', holdsRecords: none, deviceNow: 4000 }],
    }),
    stepsVector('with records in the product and no decision, the sign-in is incomplete: holds are released and nothing else changes', {
      device: device(ANON, anonWithWork()),
      steps: [{ op: 'signIn', account: 'A', holdsRecords: holds, deviceNow: 4000 }],
    }),
    stepsVector('the signed-out decision answered add rebinds the anon replica under A', {
      device: device(ANON, anonWithWork()),
      steps: [{ op: 'signIn', account: 'A', holdsRecords: holds, decisions: { probe: 'add' }, deviceNow: 4000 }],
    }),
    stepsVector('the signed-out decision answered discard ends the product\'s entries discarded, deletes its device rows and starts a new bound replica', {
      device: device(ANON, anonWithWork()),
      ids: [NEW],
      steps: [{ op: 'signIn', account: 'A', holdsRecords: holds, decisions: { probe: 'discard' }, deviceNow: 4000 }],
    }),
    stepsVector('a dormant replica of A is rebound; the anon entries, notices and new device rows move after its own', {
      device: device(ANON, anonWithWork(), dormant(DORMANT_A, 'A', {
        meta: { authPaused: true },
        notices: [{ id: 'notice:x/0', scope: 'self/probe', code: 'stale', content: { d: [] }, at: 1500 }],
      })),
      steps: [{ op: 'signIn', account: 'A', holdsRecords: holds, decisions: { probe: 'add' }, deviceNow: 4000 }],
    }),
    stepsVector('a dormant replica of another account is left dormant', {
      device: device(ANON, anonWithWork(), dormant(DORMANT_B, 'B')),
      steps: [{ op: 'signIn', account: 'A', holdsRecords: none, deviceNow: 4000 }],
    }),
    stepsVector('an anon replica without entries stays anon beside a new bound replica', {
      device: device(ANON, { meta: freshMeta(ANON, 'anon') }),
      ids: [NEW],
      steps: [{ op: 'signIn', account: 'A', holdsRecords: holds, deviceNow: 4000 }],
    }),
    stepsVector('anonCount counts, by type, the distinct records the product\'s entries create or change', {
      device: device(ANON, anonWithWork()),
      steps: [{ op: 'anonCount', replica: ANON, product: 'probe' }],
    }),
  ];
}

function boundWith(steps) {
  const confirmed = {
    'self/probe': [row({ t: 'card', id: 'card0001', life: ['alive', st(1000)], born: st(1000), f: { title: ['One', st(1000)] }, seq: 1 })],
  };
  return replicaAfter({ ...freshMeta(BOUND, 'bound', 'A'), serverEpoch: 'ep-1' }, steps, {
    confirmed,
    spentIds: { [TREE]: [{ t: 'tag', id: 'ash', born: st(900) }, { t: 'tag', id: 'oak', born: st(1000) }] },
    cursors: { 'self/probe': { cursor: 'eyJlIjoiZXAtMSIsIm0iOiJsaXZlIiwicyI6MX0', digest: '0'.repeat(64), booted: true } },
    known: { 'tree/b_00000002': 'gone' },
    device: { probe: { rack: { plates: [5] } } },
  });
}

function signOuts() {
  const pending = [commitStep('self/probe', [{ op: 'update', t: 'card', id: 'card0001', f: { title: 'Uno' } }], undefined, 5000)];
  const held = [commitStep('self/probe', [{ op: 'delete', t: 'card', id: 'card0001' }], { hold: true }, 5000)];
  return [
    stepsVector('sign-out with an empty outbox purges the account\'s rows, cursors and device rows, leaves the replica dormant and starts an anon replica', {
      device: device(BOUND, boundWith([])),
      ids: [NEW],
      steps: [{ op: 'signOut', deviceNow: 6000 }],
    }),
    stepsVector('sign-out with unsent entries and no choice releases holds and answers their count', {
      device: device(BOUND, boundWith(held)),
      steps: [{ op: 'signOut', deviceNow: 6000 }],
    }),
    stepsVector('Keep leaves the unsent entries in the dormant replica', {
      device: device(BOUND, boundWith(pending)),
      ids: [NEW],
      steps: [{ op: 'signOut', choice: 'keep', deviceNow: 6000 }],
    }),
    stepsVector('Discard deletes the replica and ends its entries discarded', {
      device: device(BOUND, boundWith([...pending, ...held])),
      ids: [NEW],
      steps: [{ op: 'signOut', choice: 'discard', deviceNow: 6000 }],
    }),
    stepsVector('sign-out resolves acked entries, which the server admitted: they are not unsent', {
      device: device(BOUND, boundWith([
        ...pending,
        { op: 'push', deviceNow: 5001 },
        { op: 'pushResponse', deviceNow: 5002, response: { status: 200, body: { serverTime: 5002, epoch: 'ep-1', lastN: 1, results: [{ n: 1, s: 'ok', seq: 2 }] } } },
      ])),
      ids: [NEW],
      steps: [{ op: 'signOut', deviceNow: 6000 }],
    }),
    stepsVector('an existing anon replica becomes the active one', {
      device: device(BOUND, boundWith([]), { meta: freshMeta(ANON, 'anon'), device: { probe: { rack: { plates: [1] } } } }),
      steps: [{ op: 'signOut', deviceNow: 6000 }],
    }),
    stepsVector('an explicit discard deletes a dormant replica and ends its entries discarded', {
      device: device(ANON, { meta: freshMeta(ANON, 'anon') }, dormant(DORMANT_A, 'A')),
      steps: [{ op: 'discardUnsent', replica: DORMANT_A }],
    }),
  ];
}

export function files() {
  return { 'lineage/signin.json': signIns(), 'lineage/signout.json': signOuts() };
}
