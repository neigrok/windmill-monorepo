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
    commitStep('self/probe', [{ op: 'update', t: 'card', id: 'card0009', f: { tier: 'draft' } }], { guard: [{ t: 'card', id: 'card0009', field: 'tier' }] }, 3001),
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
    stepsVector('an incomplete sign-in records pendingSignIn; the sign-in that completes clears it', {
      device: device(ANON, anonWithWork()),
      steps: [
        { op: 'signIn', account: 'A', holdsRecords: holds, deviceNow: 4000 },
        { op: 'signIn', account: 'A', holdsRecords: holds, decisions: { probe: 'add' }, deviceNow: 4100 },
      ],
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
        notices: [{
          id: 'notice:x/0',
          scope: 'self/probe',
          code: 'stale',
          detail: { t: 'card', id: 'card0001', field: 'title', current: st(1450, 0, 'r_cccccccccccc') },
          content: { d: [{ t: 'card', id: 'card0001', born: st(1000), f: { title: ['Mine', st(1400)] } }] },
          at: 1500,
        }],
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
    stepsVector('a decision pinned to entries that changed since its question is due again with the new count', {
      device: device(ANON, anonWithWork()),
      steps: [
        { op: 'signIn', account: 'A', holdsRecords: holds, deviceNow: 4000 },
        commitStep('self/probe', [{ op: 'create', t: 'card', id: 'card0008', f: { title: 'Later' } }], { gestureId: 'late' }, 4001),
        { op: 'signIn', account: 'A', holdsRecords: holds, decisions: { probe: 'add' }, counted: { probe: ['g1/0', 'g2/0', 'g3/0', 'g4/0', 'g5/0', 'g6/0'] }, deviceNow: 4002 },
        { op: 'signIn', account: 'A', holdsRecords: holds, decisions: { probe: 'add' }, counted: { probe: ['g1/0', 'g2/0', 'g3/0', 'g4/0', 'g5/0', 'g6/0', 'late/0'] }, deviceNow: 4003 },
      ],
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
  const acked = [
    ...pending,
    { op: 'push', deviceNow: 5001 },
    { op: 'pushResponse', deviceNow: 5002, response: { status: 200, body: { serverTime: 5002, epoch: 'ep-1', as: 'A', lastN: 1, results: [{ n: 1, s: 'ok', seq: 2 }] } } },
  ];
  return [
    stepsVector('sign-out with an empty outbox still waits for a finish; Keep purges account rows and cursors, retains device work, leaves the replica dormant and starts an anon replica', {
      device: device(BOUND, boundWith([])),
      ids: [NEW],
      steps: [{ op: 'signOut', deviceNow: 6000 }, { op: 'signOut', choice: 'keep', deviceNow: 6001 }],
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
    stepsVector('acked entries are not unsent, and a question left unanswered resolves nothing: they stay acked', {
      device: device(BOUND, boundWith(acked)),
      steps: [{ op: 'signOut', deviceNow: 6000 }],
    }),
    stepsVector('the finish resolves acked entries: the server holds them', {
      device: device(BOUND, boundWith(acked)),
      ids: [NEW],
      steps: [{ op: 'signOut', deviceNow: 6000 }, { op: 'signOut', choice: 'keep', deviceNow: 6001 }],
    }),
    stepsVector('a Discard pinned to entries that changed since the question is asked again with the new count', {
      device: device(BOUND, boundWith(pending)),
      ids: [NEW],
      steps: [
        { op: 'signOut', deviceNow: 6000 },
        commitStep('self/probe', [{ op: 'update', t: 'card', id: 'card0001', f: { tier: 'done' } }], { gestureId: 'late' }, 6001),
        { op: 'signOut', choice: 'discard', counted: ['g1/0'], deviceNow: 6002 },
        { op: 'signOut', choice: 'discard', counted: ['g1/0', 'late/0'], deviceNow: 6003 },
      ],
    }),
    stepsVector('Keep covers every entry: an autosave between the question and the Keep does not ask again, and the dormant replica keeps both', {
      device: device(BOUND, boundWith(pending)),
      ids: [NEW],
      steps: [
        { op: 'signOut', deviceNow: 6000 },
        commitStep('self/probe', [{ op: 'update', t: 'card', id: 'card0001', f: { tier: 'done' } }], { gestureId: 'autosave' }, 6001),
        { op: 'signOut', choice: 'keep', counted: ['g1/0'], deviceNow: 6002 },
      ],
    }),
    stepsVector('an existing anon replica becomes the active one', {
      device: device(BOUND, boundWith([]), { meta: freshMeta(ANON, 'anon'), device: { probe: { rack: { plates: [1] } } } }),
      steps: [{ op: 'signOut', choice: 'keep', deviceNow: 6000 }],
    }),
    stepsVector('an explicit discard deletes a dormant replica and ends its entries discarded', {
      device: device(ANON, { meta: freshMeta(ANON, 'anon') }, dormant(DORMANT_A, 'A')),
      steps: [{ op: 'discardUnsent', replica: DORMANT_A }],
    }),
  ];
}

const FORK_GUARD = 'fg_00000001';

// A bound replica with one sent entry and one ready one, under A.
function boundBusy() {
  return replicaAfter({ ...freshMeta(BOUND, 'bound', 'A') }, [
    commitStep('self/probe', [{ op: 'create', t: 'card', id: 'card0009', f: { title: 'Sent' } }], undefined, 3000),
    { op: 'push', deviceNow: 3001 },
    commitStep('self/probe', [{ op: 'update', t: 'card', id: 'card0009', f: { tier: 'draft' } }], undefined, 3002),
  ]);
}

// §7.3, §7.11 and D-2 at engine start.
function starts() {
  return [
    stepsVector('engine start releases every held entry, and the instance takes a fresh actor that its next commit uses (web: no fork guard)', {
      device: device(ANON, anonWithWork()),
      actors: ['r_cccccccccccc'],
      steps: [{ op: 'engineStart', deviceNow: 4000 }, commitStep('self/probe', [{ op: 'create', t: 'card', id: 'card0010', f: { title: 'After start' } }], { gestureId: 'after-start' }, 4001)],
    }),
    stepsVector('a forkGuard equal to its backup-excluded copy keeps every replica id', {
      device: { ...device(BOUND, boundBusy()), meta: { forkGuard: FORK_GUARD } },
      actors: ['r_cccccccccccc'],
      steps: [{ op: 'engineStart', backupGuard: FORK_GUARD, deviceNow: 4000 }],
    }),
    stepsVector('a missing backup-excluded copy re-identifies every replica under a new forkGuard', {
      device: { ...device(BOUND, boundBusy(), dormant(DORMANT_B, 'B')), meta: { forkGuard: FORK_GUARD } },
      ids: [NEW, 'rp_000000000000000000000000000000c2'],
      actors: ['r_cccccccccccc'],
      forkGuards: ['fg_00000002'],
      steps: [{ op: 'engineStart', backupGuard: null, deviceNow: 4000 }, { op: 'push', deviceNow: 4001 }],
    }),
    stepsVector('a backup-excluded copy that differs re-identifies every replica too', {
      device: { ...device(BOUND, boundBusy()), meta: { forkGuard: FORK_GUARD } },
      ids: [NEW],
      actors: ['r_cccccccccccc'],
      forkGuards: ['fg_00000002'],
      steps: [{ op: 'engineStart', backupGuard: 'fg_00000009', deviceNow: 4000 }],
    }),
    stepsVector('a store without a forkGuard mints its first and re-identifies nothing', {
      device: device(ANON, anonWithWork()),
      actors: ['r_cccccccccccc'],
      forkGuards: ['fg_00000001'],
      steps: [{ op: 'engineStart', backupGuard: null, deviceNow: 4000 }],
    }),
    stepsVector('engine start answers a pending sign-in for the caller to resume', {
      device: device(ANON, anonWithWork()),
      actors: ['r_cccccccccccc'],
      steps: [{ op: 'signIn', account: 'A', holdsRecords: { probe: true }, deviceNow: 4000 }, { op: 'engineStart', deviceNow: 5000 }],
    }),
  ];
}

export function files() {
  return { 'lineage/signin.json': signIns(), 'lineage/signout.json': signOuts(), 'lineage/start.json': starts() };
}
