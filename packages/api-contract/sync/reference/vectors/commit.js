// commit/*.json (§7.1): one gesture on the active replica, through the client-step language.

import { freshMeta } from '../client/replica.js';
import { ZERO_DIGEST } from '../core/digest.js';
import { Cursor } from '../core/wire.js';
import { OTHER, row, st } from './fixtures.js';
import { settle, stepsVector } from './steps.js';

const REPLICA = 'rp_00000000000000000000000000000001';
const BOARD = 'b_00000001';
const TREE = `tree/${BOARD}`;
const OVERLAY = `self/overlay/${BOARD}`;

function device(replica) {
  return settle({ active: replica.meta.replica, replicas: [replica] });
}

function bound({ meta, ...rest } = {}) {
  return { meta: { ...freshMeta(REPLICA, 'bound', 'A'), ...meta }, ...rest };
}

function anon({ meta, ...rest } = {}) {
  return { meta: { ...freshMeta(REPLICA, 'anon'), ...meta }, ...rest };
}

function commitStep(scope, changes, opts, deviceNow = 5000, actor) {
  const step = { op: 'commit', scope, changes, deviceNow };
  if (opts) step.opts = opts;
  if (actor) step.actor = actor;
  return step;
}

const CARD = row({ t: 'card', id: 'card0001', life: ['alive', st(1000)], born: st(1000), f: { ord: ['a0', st(1000)], size: [2.5, st(1000)], tier: ['review', st(1000)], title: ['One', st(1000)] }, seq: 1 });
const CARD2 = row({ t: 'card', id: 'card0002', life: ['alive', st(1100)], born: st(1100), f: { title: ['Two', st(1100)] }, seq: 2 });
const RUN = row({ t: 'run', id: 'run00001', life: ['alive', st(1300, 0, 'srv')], born: st(1300, 0, 'srv'), f: { startedAt: [1300, st(1300, 0, 'srv')] }, seq: 3 });
const BOARD_ROW = row({ t: 'board', id: BOARD, life: ['alive', st(900)], born: st(900), seq: 4 });
const PROBE = { 'self/probe': [CARD, CARD2, RUN, BOARD_ROW] };
const CARD3 = row({ t: 'card', id: 'card0003', life: ['alive', st(1200)], born: st(1200), f: { title: ['Three', st(1200)] }, seq: 5 });
const FULL = { 'self/probe': [CARD, CARD2, CARD3, RUN, BOARD_ROW] };
const B62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const drawsOf = (alphabet, text) => [...text].map((char) => alphabet.indexOf(char));
const TREE_ROWS = [
  row({ t: 'link', id: ['oak', 'elm'], life: ['alive', st(1000)], seq: 1 }),
  row({ t: 'meta', id: 'meta', f: { title: ['Plan', st(1000)] }, seq: 2 }),
  row({ t: 'tag', id: 'elm', life: ['alive', st(1000)], born: st(1000), f: { label: ['Elm', st(1000)] }, seq: 3 }),
  row({ t: 'tag', id: 'oak', life: ['alive', st(1000)], born: st(1000), f: { label: ['Oak', st(1000)] }, seq: 4 }),
];
const MARK = row({ t: 'mark', id: 'oak', f: { done: [false, st(1000)] }, x: { memo: { text: 'first draft', rev: 7, merged: false } }, seq: 7 });

function deltas() {
  return [
    stepsVector('a create carries born = its life stamp and only the fields given, stamped once', {
      device: device(bound()),
      steps: [commitStep('self/probe', [{ op: 'create', t: 'card', id: 'card0009', f: { title: 'New', tier: 'draft' } }])],
    }),
    stepsVector('a create fills an absent client time field from physNow, device time plus the offset', {
      device: device(bound({ confirmed: PROBE, meta: { serverOffsetMs: 250 } })),
      steps: [commitStep('self/probe', [{ op: 'create', t: 'lap', id: 'lap00009', f: { runId: 'run00001', weight: 42 } }], undefined, 7000)],
    }),
    stepsVector('a time value the change supplies is kept', {
      device: device(bound({ confirmed: PROBE })),
      steps: [commitStep('self/probe', [{ op: 'create', t: 'lap', id: 'lap00009', f: { at: 4200, runId: 'run00001', weight: 42 } }])],
    }),
    stepsVector('an update emits only the fields whose value differs from drawn', {
      device: device(bound({ confirmed: PROBE })),
      steps: [commitStep('self/probe', [{ op: 'update', t: 'card', id: 'card0001', f: { title: 'One', tier: 'done', claim: 'ann' } }])],
    }),
    stepsVector('an update that changes nothing enqueues nothing, but the clock still ticks', {
      device: device(bound({ confirmed: PROBE })),
      steps: [commitStep('self/probe', [{ op: 'update', t: 'card', id: 'card0001', f: { title: 'One' } }])],
    }),
    stepsVector('a create of an id already in drawn is dropped', {
      device: device(bound({ confirmed: PROBE })),
      steps: [commitStep('self/probe', [{ op: 'create', t: 'card', id: 'card0001', f: { title: 'Again' } }])],
    }),
    stepsVector('values round to the quantum half away from zero in IEEE doubles', {
      device: device(bound()),
      steps: [commitStep('self/probe', [
        { op: 'create', t: 'card', id: 'card0011', f: { title: 'a', size: 1.005 } },
        { op: 'create', t: 'card', id: 'card0012', f: { title: 'b', size: 0.125 } },
        { op: 'create', t: 'card', id: 'card0013', f: { title: 'c', size: -0.125 } },
        { op: 'create', t: 'card', id: 'card0014', f: { title: 'd', size: -2.675 } },
      ])],
    }),
    stepsVector('the stamp ticks after observing hlcHigh', {
      device: device(bound({ meta: { hlc: { ms: 100, counter: 0 }, hlcHigh: st(9000, 4, 'srv') } })),
      steps: [commitStep('self/probe', [{ op: 'create', t: 'card', id: 'card0009', f: { title: 'New' } }])],
    }),
    stepsVector('a delete carries the drawn born and a dead life at the stamp', {
      device: device(bound({ confirmed: PROBE })),
      steps: [commitStep('self/probe', [{ op: 'delete', t: 'card', id: 'card0002' }])],
    }),
    stepsVector('a keyed put makes an absent record present with a fresh alive life', {
      device: device(bound({ confirmed: { [TREE]: TREE_ROWS } })),
      steps: [commitStep(TREE, [{ op: 'put', t: 'link', id: ['elm', 'oak'] }])],
    }),
    stepsVector('a keyed put removing a present record writes a dead life', {
      device: device(bound({ confirmed: { [TREE]: TREE_ROWS } })),
      steps: [commitStep(TREE, [{ op: 'put', t: 'link', id: ['oak', 'elm'], present: false }])],
    }),
    stepsVector('a keyed delete is a put that removes', {
      device: device(bound({ confirmed: { [TREE]: TREE_ROWS } })),
      steps: [commitStep(TREE, [{ op: 'delete', t: 'link', id: ['oak', 'elm'] }])],
    }),
    stepsVector('a keyed put of a present record that keeps it present writes nothing', {
      device: device(bound({ confirmed: { [TREE]: TREE_ROWS } })),
      steps: [commitStep(TREE, [{ op: 'put', t: 'link', id: ['oak', 'elm'] }])],
    }),
    stepsVector('a keyed put removing an absent record writes nothing', {
      device: device(bound({ confirmed: { [TREE]: TREE_ROWS } })),
      steps: [commitStep(TREE, [{ op: 'put', t: 'link', id: ['elm', 'oak'], present: false }])],
    }),
    stepsVector('a revive takes the born of a record dead in drawn', {
      device: device(bound({ confirmed: { [TREE]: TREE_ROWS } })),
      steps: [
        commitStep(TREE, [{ op: 'delete', t: 'tag', id: 'elm' }], { hold: true }),
        commitStep(TREE, [{ op: 'revive', t: 'tag', id: 'elm' }], undefined, 5001),
      ],
    }),
    stepsVector('a revive takes the born of a spent id when drawn has no row', {
      device: device(bound({ confirmed: { [TREE]: TREE_ROWS }, spentIds: { [TREE]: [{ t: 'tag', id: 'ash', born: st(800) }] } })),
      steps: [commitStep(TREE, [{ op: 'revive', t: 'tag', id: 'ash', f: { label: 'Ash' } }])],
    }),
    stepsVector('a singleton write carries fields only', {
      device: device(bound({ confirmed: { [TREE]: TREE_ROWS } })),
      steps: [commitStep(TREE, [{ op: 'write', t: 'meta', id: 'meta', f: { title: 'Plan B' } }])],
    }),
    stepsVector('a text edited from the confirmed text bases on its rev and keeps the text it was edited from', {
      device: device(bound({ confirmed: { [OVERLAY]: [MARK] } })),
      steps: [commitStep(OVERLAY, [{ op: 'write', t: 'mark', id: 'oak', x: { memo: 'first draft, revised' } }])],
    }),
    stepsVector('a text edited from another text bases on that text', {
      device: device(bound({ confirmed: { [OVERLAY]: [MARK] } })),
      steps: [commitStep(OVERLAY, [{ op: 'write', t: 'mark', id: 'oak', x: { memo: { text: 'an older draft, revised', from: 'an older draft' } } }])],
    }),
    stepsVector('a first text bases on the empty text', {
      device: device(bound()),
      steps: [commitStep(OVERLAY, [{ op: 'write', t: 'mark', id: 'elm', f: { done: true }, x: { memo: 'hello' } }])],
    }),
    stepsVector('a text equal to the drawn text writes nothing', {
      device: device(bound({ confirmed: { [OVERLAY]: [MARK] } })),
      steps: [commitStep(OVERLAY, [{ op: 'write', t: 'mark', id: 'oak', x: { memo: 'first draft' } }])],
    }),
  ];
}

function ids() {
  return [
    stepsVector('a derived id comes from the label', {
      device: device(bound()),
      steps: [commitStep(TREE, [{ op: 'create', t: 'tag', label: 'Big Oak!', f: { label: 'Big Oak!' } }])],
    }),
    stepsVector('a derived id skips ids alive in drawn', {
      device: device(bound({ confirmed: { [TREE]: TREE_ROWS } })),
      steps: [commitStep(TREE, [{ op: 'create', t: 'tag', label: 'Oak', f: { label: 'Oak' } }])],
    }),
    stepsVector('a derived id skips spent ids', {
      device: device(bound({ spentIds: { [TREE]: [{ t: 'tag', id: 'ash', born: st(800) }] } })),
      steps: [commitStep(TREE, [{ op: 'create', t: 'tag', label: 'ash', f: { label: 'ash' } }])],
    }),
    stepsVector('a derived id skips pending ids', {
      device: device(bound()),
      steps: [
        commitStep(TREE, [{ op: 'create', t: 'tag', label: 'Yew', f: { label: 'Yew' } }]),
        commitStep(TREE, [{ op: 'create', t: 'tag', label: 'yew', f: { label: 'yew' } }], undefined, 5001),
      ],
    }),
    stepsVector('a derived id skips ids chosen earlier in the same gesture', {
      device: device(bound()),
      steps: [commitStep(TREE, [
        { op: 'create', t: 'tag', label: 'Ash', f: { label: 'Ash' } },
        { op: 'create', t: 'tag', label: 'ash', f: { label: 'ash' } },
      ])],
    }),
    stepsVector('a label without alphanumerics takes the fallback, numbered past taken ids', {
      device: device(bound({ spentIds: { [TREE]: [{ t: 'tag', id: 'tag', born: st(800) }] } })),
      steps: [commitStep(TREE, [{ op: 'create', t: 'tag', label: '!!!', f: { label: '!!!' } }])],
    }),
    stepsVector('an id given to a derived create is used as given', {
      device: device(bound()),
      steps: [commitStep(TREE, [{ op: 'create', t: 'tag', id: 'k3x9q2', f: { label: 'Random' } }])],
    }),
    stepsVector('a create without an id mints one by its type\'s mint: the prefix, then one drawn alphabet character each', {
      device: device(bound()),
      draws: drawsOf(B62, 'Qz9vK2mX7pL4cR8w'),
      steps: [commitStep('self/probe', [{ op: 'create', t: 'card', f: { title: 'Minted' } }])],
    }),
    stepsVector('a governing id mints its prefix and its own alphabet', {
      device: device(bound()),
      draws: drawsOf('0123456789abcdef', '3fa9c1e0'),
      steps: [commitStep('self/probe', [{ op: 'create', t: 'board' }])],
    }),
    stepsVector('a derived create with neither id nor label mints its id', {
      device: device(bound({ confirmed: { 'self/probe': [BOARD_ROW] } })),
      draws: drawsOf('0123456789abcdefghijklmnopqrstuvwxyz', 'k3x9q2w8e7r6'),
      steps: [commitStep(TREE, [{ op: 'create', t: 'tag', f: { label: 'Unnamed' } }])],
    }),
    stepsVector('a minted id already taken in the views is drawn again', {
      device: device(bound({ confirmed: { 'self/probe': [row({ t: 'card', id: 'aaaaaaaaaaaaaaaa', life: ['alive', st(1000)], born: st(1000), f: { title: ['Taken', st(1000)] }, seq: 1 })] } })),
      draws: [...drawsOf(B62, 'aaaaaaaaaaaaaaaa'), ...drawsOf(B62, 'bbbbbbbbbbbbbbbb')],
      steps: [commitStep('self/probe', [{ op: 'create', t: 'card', f: { title: 'Second draw' } }])],
    }),
    stepsVector('seeded ids are minted ids of the form <seed>-<n>', {
      device: device(bound({ confirmed: PROBE })),
      steps: [commitStep('self/probe', [
        { op: 'create', t: 'lap', id: 'seed0001-1', f: { runId: 'run00001', weight: 10 } },
        { op: 'create', t: 'lap', id: 'seed0001-2', f: { runId: 'run00001', weight: 12.5 } },
      ], { atomic: true })],
    }),
  ];
}

function guards() {
  return [
    stepsVector('a guarded update guards every field it writes at the stored stamp', {
      device: device(bound({ confirmed: PROBE })),
      steps: [commitStep('self/probe', [{ op: 'update', t: 'card', id: 'card0001', f: { title: 'Uno', body: 'text' } }], { guard: true })],
    }),
    stepsVector('a guarded create guards its unset registers with null', {
      device: device(bound()),
      steps: [commitStep('self/probe', [{ op: 'create', t: 'card', id: 'card0009', f: { title: 'New' } }], { guard: true })],
    }),
    stepsVector('guard names registers the gesture read, from stored', {
      device: device(bound({ confirmed: PROBE })),
      steps: [commitStep('self/probe', [{ op: 'update', t: 'card', id: 'card0001', f: { title: 'Uno' } }], {
        guard: [{ t: 'card', id: 'card0001', field: 'tier' }, { t: 'card', id: 'card0002', field: 'claim' }],
      })],
    }),
    stepsVector('a guard reads stored: a ready write counts, a held one does not', {
      device: device(bound({ confirmed: PROBE })),
      steps: [
        commitStep('self/probe', [{ op: 'update', t: 'card', id: 'card0001', f: { title: 'Held' } }], { hold: true }),
        commitStep('self/probe', [{ op: 'update', t: 'card', id: 'card0002', f: { title: 'Ready' } }], undefined, 5001),
        commitStep('self/probe', [
          { op: 'update', t: 'card', id: 'card0001', f: { title: 'Uno' } },
          { op: 'update', t: 'card', id: 'card0002', f: { title: 'Dos' } },
        ], { guard: true, atomic: true }, 5002),
      ],
    }),
    stepsVector('per-record intents carry their own guards; a guard on an unwritten record joins the first', {
      device: device(bound({ confirmed: PROBE })),
      steps: [commitStep('self/probe', [
        { op: 'update', t: 'card', id: 'card0001', f: { title: 'Uno' } },
        { op: 'update', t: 'card', id: 'card0002', f: { title: 'Dos' } },
      ], { guard: [{ t: 'run', id: 'run00001', field: 'label' }] })],
    }),
  ];
}

function grouping() {
  const start = {
    cmd: { name: 'probe.start', args: { id: 'run00009', label: 'Go', startedAt: 5000, join: true } },
    predict: [{ op: 'create', t: 'run', id: 'run00009', f: { label: 'Go', startedAt: 5000 } }],
  };
  return [
    stepsVector('an intent over PUSH_MAX_BYTES is not enqueued: the commit answers too-large and writes one notice and no clock (limits shrink PUSH_MAX_BYTES)', {
      device: device(bound({ confirmed: PROBE })),
      limits: { PUSH_MAX_BYTES: 150 },
      steps: [commitStep('self/probe', [
        { op: 'update', t: 'card', id: 'card0001', f: { title: 'Uno', body: 'a longer body text' } },
        { op: 'update', t: 'card', id: 'card0002', f: { title: 'Dos' } },
      ], { atomic: true })],
    }),
    stepsVector('a create beyond a cap is refused at commit: cap, with nothing written, no notice and no tick', {
      device: device(bound({ confirmed: FULL })),
      steps: [commitStep('self/probe', [{ op: 'create', t: 'card', id: 'card0009', f: { title: 'Fourth' } }])],
    }),
    stepsVector('a held delete still occupies its slot: a create while it waits is refused cap', {
      device: device(bound({ confirmed: FULL })),
      steps: [
        commitStep('self/probe', [{ op: 'delete', t: 'card', id: 'card0001' }], { hold: true }, 5000),
        commitStep('self/probe', [{ op: 'create', t: 'card', id: 'card0009', f: { title: 'Fourth' } }], undefined, 5001),
      ],
    }),
    stepsVector('once the delete is released and acked its slot is free: the create fits', {
      device: device(bound({ confirmed: FULL })),
      steps: [
        commitStep('self/probe', [{ op: 'delete', t: 'card', id: 'card0001' }], { hold: true }, 5000),
        { op: 'releaseAll', deviceNow: 5001 },
        { op: 'push', deviceNow: 5002 },
        { op: 'pushResponse', deviceNow: 5003, response: { status: 200, body: { serverTime: 5003, epoch: 'ep-1', lastN: 1, results: [{ n: 1, s: 'ok', seq: 6 }] } } },
        commitStep('self/probe', [{ op: 'create', t: 'card', id: 'card0009', f: { title: 'Fourth' } }], undefined, 5004),
      ],
    }),
    stepsVector('a gesture creating one card and deleting another at the cap passes the growth rule', {
      device: device(bound({ confirmed: FULL })),
      steps: [commitStep('self/probe', [
        { op: 'create', t: 'card', id: 'card0009', f: { title: 'Fourth' } },
        { op: 'delete', t: 'card', id: 'card0001' },
      ], { atomic: true })],
    }),
    stepsVector('a plain gesture over two records is two intents with one stamp and one gesture id', {
      device: device(bound({ confirmed: PROBE })),
      steps: [commitStep('self/probe', [
        { op: 'update', t: 'card', id: 'card0001', f: { title: 'Uno' } },
        { op: 'update', t: 'card', id: 'card0002', f: { title: 'Dos' } },
      ], { gestureId: 'rename' })],
    }),
    stepsVector('an atomic gesture is one intent', {
      device: device(bound({ confirmed: PROBE })),
      steps: [commitStep('self/probe', [
        { op: 'update', t: 'card', id: 'card0001', f: { title: 'Uno' } },
        { op: 'update', t: 'card', id: 'card0002', f: { title: 'Dos' } },
      ], { atomic: true })],
    }),
    stepsVector('a held gesture is one held intent released HOLD_MS after the device time', {
      device: device(bound({ confirmed: PROBE })),
      steps: [commitStep('self/probe', [{ op: 'delete', t: 'card', id: 'card0001' }, { op: 'delete', t: 'card', id: 'card0002' }], { hold: true }, 12345)],
    }),
    stepsVector('a command is one intent carrying its prediction on the entry', {
      device: device(bound({ confirmed: PROBE })),
      steps: [commitStep('self/probe', [], start)],
    }),
    stepsVector('a command with deltas is one intent', {
      device: device(bound({ confirmed: PROBE })),
      steps: [commitStep('self/probe', [{ op: 'update', t: 'card', id: 'card0001', f: { title: 'Uno' } }], start)],
    }),
    stepsVector('a signed-out replica commits under lineage anon', {
      device: device(anon()),
      steps: [commitStep('self/probe', [{ op: 'create', t: 'card', id: 'card0009', f: { title: 'Offline' } }])],
    }),
    stepsVector('device rows commit with the gesture, a localOnly picture among them', {
      device: device(bound({ device: { probe: { rack: { plates: [20, 10] } } } })),
      steps: [commitStep('self/probe', [{ op: 'create', t: 'card', id: 'card0009', f: { title: 'Snap', attachment: { id: 'pic00001', localOnly: true } } }], {
        local: { 'picture:pic00001': { bytes: 1024, mediaType: 'image/jpeg' }, rack: { plates: [25] } },
      })],
    }),
    stepsVector('a commit with only device rows enqueues nothing; null deletes a row', {
      device: device(bound({ device: { probe: { rack: { plates: [20] }, 'picture:pic00001': { bytes: 1 } } } })),
      steps: [commitStep('self/probe', [], { local: { rack: { plates: [20, 5] }, 'picture:pic00001': null } })],
    }),
    stepsVector('a board death pulled from the product scope makes its tree and overlay known gone: commits refuse scope-dead and write nothing', {
      device: device(bound({ confirmed: { 'self/probe': [BOARD_ROW] } })),
      steps: [
        { op: 'pull', scopes: ['self/probe'], deviceNow: 4990 },
        {
          op: 'pullResponse',
          deviceNow: 4990,
          response: {
            status: 200,
            body: {
              serverTime: 4990,
              epoch: 'ep-1',
              pages: [{
                scope: 'self/probe',
                kind: 'rows',
                rows: [{ t: 'board', id: BOARD, life: ['dead', st(950)], born: st(900), seq: 5 }],
                cursor: Cursor.encode({ e: 'ep-1', m: 'live', s: 5 }),
                more: false,
                seq: 5,
                digest: ZERO_DIGEST,
              }],
            },
          },
        },
        commitStep(TREE, [{ op: 'write', t: 'meta', id: 'meta', f: { title: 'Late' } }]),
        commitStep(`self/overlay/${BOARD}`, [{ op: 'write', t: 'mark', id: 'oak', f: { done: true } }]),
      ],
    }),
    stepsVector('a board delete still held leaves its tree writable', {
      device: device(bound({ confirmed: PROBE })),
      steps: [
        commitStep('self/probe', [{ op: 'delete', t: 'board', id: BOARD }], { hold: true }),
        commitStep(TREE, [{ op: 'write', t: 'meta', id: 'meta', f: { title: 'Still' } }], undefined, 5001),
      ],
    }),
    stepsVector('an overlay of a tree known not-found refuses scope-dead', {
      device: device(bound({ known: { [TREE]: 'not-found' } })),
      steps: [commitStep(OVERLAY, [{ op: 'write', t: 'mark', id: 'oak', f: { done: true } }])],
    }),
    stepsVector('a released board delete makes its tree refuse scope-dead', {
      device: device(bound({ confirmed: PROBE })),
      steps: [
        commitStep('self/probe', [{ op: 'delete', t: 'board', id: BOARD }], { hold: true }),
        { op: 'releaseAll' },
        commitStep(TREE, [{ op: 'write', t: 'meta', id: 'meta', f: { title: 'Late' } }], undefined, 5001),
      ],
    }),
  ];
}

function throws() {
  return [
    stepsVector('an update of a record absent from drawn throws', {
      device: device(bound()),
      steps: [commitStep('self/probe', [{ op: 'update', t: 'card', id: 'card0001', f: { title: 'Uno' } }])],
    }),
    stepsVector('a delete of a record absent from drawn throws', {
      device: device(bound()),
      steps: [commitStep('self/probe', [{ op: 'delete', t: 'card', id: 'card0001' }])],
    }),
    stepsVector('a dormant replica does not commit', {
      device: device({ meta: freshMeta(REPLICA, 'dormant', 'A') }),
      steps: [commitStep('self/probe', [{ op: 'create', t: 'card', id: 'card0009', f: { title: 'x' } }])],
    }),
    stepsVector('a client change to a server-written field throws', {
      device: device(bound({ confirmed: PROBE })),
      steps: [commitStep('self/probe', [{ op: 'update', t: 'run', id: 'run00001', f: { endedAt: 9000 } }])],
    }),
    stepsVector('a client change to a serial field throws', {
      device: device(bound({ confirmed: PROBE })),
      steps: [commitStep('self/probe', [{ op: 'create', t: 'lap', id: 'lap00009', f: { no: 3, runId: 'run00001', weight: 1 } }])],
    }),
    stepsVector('a revive with neither a drawn row nor a spent id throws', {
      device: device(bound()),
      steps: [commitStep(TREE, [{ op: 'revive', t: 'tag', id: 'ash' }])],
    }),
    stepsVector('a throwing change leaves the gesture\'s earlier changes and the clock unwritten', {
      device: device(bound({ confirmed: PROBE })),
      steps: [
        commitStep('self/probe', [{ op: 'update', t: 'card', id: 'card0001', f: { title: 'Kept' } }], undefined, 4000, OTHER),
        commitStep('self/probe', [
          { op: 'update', t: 'card', id: 'card0002', f: { title: 'Lost' } },
          { op: 'update', t: 'card', id: 'card0404', f: { title: 'Absent' } },
        ]),
      ],
    }),
  ];
}

export function files() {
  return {
    'commit/deltas.json': deltas(),
    'commit/ids.json': ids(),
    'commit/guards.json': guards(),
    'commit/grouping.json': grouping(),
    'commit/throws.json': throws(),
  };
}
