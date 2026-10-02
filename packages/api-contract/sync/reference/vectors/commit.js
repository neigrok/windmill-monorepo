// commit/*.json (§7.1): one gesture on the active replica, through the client-step language.

import { freshMeta } from '../client/replica.js';
import { ZERO_DIGEST } from '../core/digest.js';
import { Cursor, widestAloneBytes } from '../core/wire.js';
import { OTHER, row, st } from './fixtures.js';
import { runSteps, settle, stepsVector } from './steps.js';

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
const CARD2_ORD = row({ t: 'card', id: 'card0002', life: ['alive', st(1100)], born: st(1100), f: { ord: ['a2', st(1100)], title: ['Two', st(1100)] }, seq: 2 });
const LISTED = { 'self/probe': [CARD, CARD2_ORD, RUN, BOARD_ROW] };
const DAY = '2026-09-01';
const DAY_ROW = row({ t: 'day', id: DAY, life: ['alive', st(1000)], f: { score: [7, st(1000)] }, seq: 6 });
const DAYS = { 'self/probe': [CARD, CARD2, RUN, BOARD_ROW, DAY_ROW] };
const FACT_ROW = row({ t: 'fact', id: DAY, life: ['alive', st(1000)], f: { at: [1000, st(1000)], value: [80, st(1000)] }, seq: 7 });
const FACTS = { 'self/probe': [CARD, CARD2, RUN, BOARD_ROW, FACT_ROW] };
const saveFact = (value, at, opts, deviceNow) => commitStep('self/probe', [{ op: 'put', t: 'fact', id: DAY, f: { value, at } }], opts, deviceNow);
const below = (id) => ({ field: 'ord', below: id });

function deltas() {
  return [
    stepsVector('a whole put writes every field, changed or not, and asserts presence with a fresh life, all at the gesture\'s stamp', {
      device: device(bound({ confirmed: FACTS })),
      steps: [saveFact(80, 5000)],
    }),
    stepsVector('a whole put of a fact absent from drawn creates it alike', {
      device: device(bound()),
      steps: [saveFact(80.04, 5000)],
    }),
    stepsVector('a delete of a whole fact writes only its life', {
      device: device(bound({ confirmed: FACTS })),
      steps: [commitStep('self/probe', [{ op: 'delete', t: 'fact', id: DAY }])],
    }),
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
    stepsVector('a nested number rounds to its domain\'s quantum half away from zero', {
      device: device(bound({ confirmed: PROBE })),
      steps: [commitStep('self/probe', [{ op: 'update', t: 'card', id: 'card0001', f: { attachment: { id: 'pic00001', scale: 1.25 } } }])],
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
    stepsVector('an anchored create takes the drop position below a drawn member', {
      device: device(bound({ confirmed: LISTED })),
      steps: [commitStep('self/probe', [{ op: 'create', t: 'card', id: 'card0009', f: { title: 'Mid' }, anchor: below('card0001') }])],
    }),
    stepsVector('an anchored create at the top goes before the first stored member', {
      device: device(bound({ confirmed: LISTED })),
      steps: [commitStep('self/probe', [{ op: 'create', t: 'card', id: 'card0009', f: { title: 'Top' }, anchor: below(null) }])],
    }),
    stepsVector('an anchored create below a member inside its delete window, which only stored holds, takes the key after its stored place', {
      device: device(bound({ confirmed: LISTED })),
      steps: [
        commitStep('self/probe', [{ op: 'delete', t: 'card', id: 'card0001' }], { hold: true }),
        commitStep('self/probe', [{ op: 'create', t: 'card', id: 'card0009', f: { title: 'Kept' }, anchor: below('card0001') }], undefined, 5001),
      ],
    }),
    stepsVector('a move writes only the order field, stamped s', {
      device: device(bound({ confirmed: LISTED })),
      steps: [commitStep('self/probe', [{ op: 'move', t: 'card', id: 'card0002', anchor: below(null) }])],
    }),
    stepsVector('a move whose drop key is the key the member holds writes nothing', {
      device: device(bound({ confirmed: { 'self/probe': [CARD, { ...CARD2_ORD, f: { ...CARD2_ORD.f, ord: ['a1', st(1100)] } }, RUN, BOARD_ROW] } })),
      steps: [commitStep('self/probe', [{ op: 'move', t: 'card', id: 'card0002', anchor: below('card0001') }])],
    }),
    stepsVector('an anchored create and a move in one gesture take the same key below the same anchor', {
      device: device(bound({ confirmed: LISTED })),
      steps: [commitStep('self/probe', [
        { op: 'move', t: 'card', id: 'card0001', anchor: below('card0002') },
        { op: 'create', t: 'card', id: 'card0009', f: { title: 'Last' }, anchor: below('card0002') },
      ], { atomic: true })],
    }),
    stepsVector('a move and a rename of one record in one gesture fold into one delta', {
      device: device(bound({ confirmed: LISTED })),
      steps: [commitStep('self/probe', [
        { op: 'move', t: 'card', id: 'card0002', anchor: below(null) },
        { op: 'update', t: 'card', id: 'card0002', f: { title: 'First' } },
      ])],
    }),
    stepsVector('a move below itself is its own anchor: a key between its drawn key and the next greater stored key keeps its place', {
      device: device(bound({ confirmed: LISTED })),
      steps: [commitStep('self/probe', [{ op: 'move', t: 'card', id: 'card0001', anchor: below('card0001') }])],
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
  const register = (id, field, t = 'card') => ({ t, id, field });
  return [
    stepsVector('a guard lists registers and guards each at its stored stamp', {
      device: device(bound({ confirmed: PROBE })),
      steps: [commitStep('self/probe', [{ op: 'update', t: 'card', id: 'card0001', f: { title: 'Uno', body: 'text' } }], { guard: [register('card0001', 'title'), register('card0001', 'body')] })],
    }),
    stepsVector('a written field left unlisted gets no guard', {
      device: device(bound({ confirmed: PROBE })),
      steps: [commitStep('self/probe', [{ op: 'update', t: 'card', id: 'card0001', f: { title: 'Uno', tier: 'done' } }], { guard: [register('card0001', 'tier')] })],
    }),
    stepsVector('a listed register that is unset guards with a null stamp', {
      device: device(bound({ confirmed: PROBE })),
      steps: [commitStep('self/probe', [{ op: 'update', t: 'card', id: 'card0002', f: { title: 'Dos' } }], { guard: [register('card0002', 'tier')] })],
    }),
    stepsVector('a guard on a created record\'s register is null', {
      device: device(bound()),
      steps: [commitStep('self/probe', [{ op: 'create', t: 'card', id: 'card0009', f: { title: 'New' } }], { guard: [register('card0009', 'title')] })],
    }),
    stepsVector('guards may name registers the gesture only read, from stored', {
      device: device(bound({ confirmed: PROBE })),
      steps: [commitStep('self/probe', [{ op: 'update', t: 'card', id: 'card0001', f: { title: 'Uno' } }], {
        guard: [register('card0001', 'tier'), register('card0002', 'claim')],
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
        ], { guard: [register('card0001', 'title'), register('card0002', 'title')], atomic: true }, 5002),
      ],
    }),
    stepsVector('per-record intents carry their own records\' guards; a guard on a record no delta writes goes with the first intent', {
      device: device(bound({ confirmed: PROBE })),
      steps: [commitStep('self/probe', [
        { op: 'update', t: 'card', id: 'card0001', f: { title: 'Uno' } },
        { op: 'update', t: 'card', id: 'card0002', f: { title: 'Dos' } },
      ], { guard: [register('card0002', 'title'), register('run00001', 'label', 'run')] })],
    }),
    stepsVector('a guarded update that changes nothing enqueues nothing, held or not, and writes no notice: its guards go with no intent', {
      device: device(bound({ confirmed: PROBE })),
      steps: [
        commitStep('self/probe', [{ op: 'update', t: 'card', id: 'card0001', f: { title: 'One' } }], { guard: [register('card0001', 'title')] }),
        commitStep('self/probe', [{ op: 'update', t: 'card', id: 'card0001', f: { title: 'One' } }], { guard: [register('card0001', 'title')], hold: true }, 5001),
      ],
    }),
    stepsVector('an unguarded update beside a guarded register of another record, in one intent', {
      device: device(bound({ confirmed: PROBE })),
      steps: [commitStep('self/probe', [
        { op: 'update', t: 'card', id: 'card0001', f: { title: 'Note' } },
        { op: 'update', t: 'card', id: 'card0002', f: { title: 'Plan' } },
      ], { guard: [register('card0002', 'title')], atomic: true })],
    }),
  ];
}

// The widest one-intent push body of an update of card0001: its request at n = ackThrough = 2^53 − 1.
function widestUpdate() {
  const step = commitStep('self/probe', [{ op: 'update', t: 'card', id: 'card0001', f: { title: 'Uno', body: 'a body of some length' } }]);
  const out = runSteps({ device: device(bound({ confirmed: PROBE })), steps: [step] });
  const [entry] = out.device.replicas.find((replica) => replica.meta.replica === REPLICA).outbox;
  return { step, bytes: widestAloneBytes({ replica: REPLICA, account: 'A' }, entry.intent) };
}

function grouping() {
  const alone = widestUpdate();
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
    stepsVector('an intent whose widest one-intent push body is one byte over PUSH_MAX_BYTES is refused too-large, though the intent alone fits', {
      device: device(bound({ confirmed: PROBE })),
      limits: { PUSH_MAX_BYTES: alone.bytes - 1 },
      steps: [alone.step],
    }),
    stepsVector('an intent whose widest one-intent push body is exactly PUSH_MAX_BYTES is enqueued', {
      device: device(bound({ confirmed: PROBE })),
      limits: { PUSH_MAX_BYTES: alone.bytes },
      steps: [alone.step],
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
        { op: 'pushResponse', deviceNow: 5003, response: { status: 200, body: { serverTime: 5003, epoch: 'ep-1', as: 'A', lastN: 1, results: [{ n: 1, s: 'ok', seq: 6 }] } } },
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
    stepsVector('a read-and-commit that decides no gesture writes nothing, keeps meta.hlc and hlcHigh, and returns null', {
      device: device(bound({ confirmed: PROBE, meta: { hlc: { ms: 4000, counter: 2 }, hlcHigh: st(4000, 2) } })),
      steps: [commitStep('self/probe', null)],
    }),
    stepsVector('a read-and-commit that decides no gesture takes no gesture id: the next commit is g1', {
      device: device(bound({ confirmed: PROBE })),
      steps: [
        commitStep('self/probe', null),
        commitStep('self/probe', [{ op: 'update', t: 'card', id: 'card0001', f: { title: 'Uno' } }], undefined, 5001),
      ],
    }),
    stepsVector('a read-and-commit that decides no gesture on a known-gone scope returns null, not scope-dead', {
      device: device(bound({ known: { [TREE]: 'gone' } })),
      steps: [commitStep(TREE, null)],
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
              as: 'A',
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
    stepsVector('an anchor absent from both views throws', {
      device: device(bound({ confirmed: LISTED })),
      steps: [commitStep('self/probe', [{ op: 'create', t: 'card', id: 'card0009', f: { title: 'Lost' }, anchor: below('card0404') }])],
    }),
    stepsVector('an anchored create of an id already in drawn checks its anchor before it is dropped: an absent anchor throws', {
      device: device(bound({ confirmed: LISTED })),
      steps: [commitStep('self/probe', [{ op: 'create', t: 'card', id: 'card0001', f: { title: 'Again' }, anchor: below('card0404') }])],
    }),
    stepsVector('a value for the anchored field beside the anchor throws', {
      device: device(bound({ confirmed: LISTED })),
      steps: [commitStep('self/probe', [{ op: 'create', t: 'card', id: 'card0009', f: { title: 'Both', ord: 'a5' }, anchor: below('card0001') }])],
    }),
    stepsVector('a listed text field throws: a text merges and is never guarded', {
      device: device(bound({ confirmed: { 'self/probe': [BOARD_ROW], [OVERLAY]: [MARK] } })),
      steps: [commitStep(OVERLAY, [{ op: 'write', t: 'mark', id: 'oak', f: { done: true } }], { guard: [{ t: 'mark', id: 'oak', field: 'memo' }] })],
    }),
    stepsVector('a listed life throws', {
      device: device(bound({ confirmed: PROBE })),
      steps: [commitStep('self/probe', [{ op: 'update', t: 'card', id: 'card0001', f: { title: 'Uno' } }], { guard: [{ t: 'card', id: 'card0001', field: 'life' }] })],
    }),
    stepsVector('a guard on a type another scope holds throws', {
      device: device(bound({ confirmed: { ...PROBE, [TREE]: TREE_ROWS } })),
      steps: [commitStep('self/probe', [{ op: 'update', t: 'card', id: 'card0001', f: { title: 'Uno' } }], { guard: [{ t: 'tag', id: 'oak', field: 'label' }] })],
    }),
    stepsVector('a listed field the type does not declare throws', {
      device: device(bound({ confirmed: PROBE })),
      steps: [commitStep('self/probe', [{ op: 'update', t: 'card', id: 'card0001', f: { title: 'Uno' } }], { guard: [{ t: 'card', id: 'card0001', field: 'colour' }] })],
    }),
    stepsVector('two changes that give one record two deltas throw: an intent changes a record at most once', {
      device: device(bound({ confirmed: PROBE })),
      steps: [commitStep('self/probe', [{ op: 'update', t: 'card', id: 'card0001', f: { title: 'Uno' } }, { op: 'update', t: 'card', id: 'card0001', f: { tier: 'done' } }], { atomic: true })],
    }),
    stepsVector('an update writing the field a move of the same record places throws', {
      device: device(bound({ confirmed: LISTED })),
      steps: [commitStep('self/probe', [
        { op: 'move', t: 'card', id: 'card0002', anchor: below(null) },
        { op: 'update', t: 'card', id: 'card0002', f: { ord: 'a5' } },
      ])],
    }),
    stepsVector('a gestureId an outbox entry already carries throws', {
      device: device(bound({ confirmed: PROBE })),
      steps: [
        commitStep('self/probe', [{ op: 'update', t: 'card', id: 'card0001', f: { title: 'Uno' } }], { gestureId: 'edit' }),
        commitStep('self/probe', [{ op: 'update', t: 'card', id: 'card0002', f: { title: 'Dos' } }], { gestureId: 'edit' }, 5001),
      ],
    }),
    stepsVector('a gestureId a notice already carries throws: a too-large gesture\'s id is not reused', {
      device: device(bound({ confirmed: PROBE })),
      limits: { PUSH_MAX_BYTES: 150 },
      steps: [
        commitStep('self/probe', [{ op: 'update', t: 'card', id: 'card0001', f: { title: 'Uno', body: 'a longer body text' } }], { gestureId: 'big' }),
        commitStep('self/probe', [{ op: 'update', t: 'card', id: 'card0002', f: { title: 'Dos' } }], { gestureId: 'big' }, 5001),
      ],
    }),
    stepsVector('a gestureId a dormant replica\'s outbox entry carries throws: gesture ids are unique on the device', {
      device: device(bound({ confirmed: PROBE })),
      ids: ['rp_00000000000000000000000000000002'],
      steps: [
        commitStep('self/probe', [{ op: 'update', t: 'card', id: 'card0001', f: { title: 'Uno' } }], { gestureId: 'edit' }),
        { op: 'signOut', choice: 'keep', deviceNow: 5001 },
        commitStep('self/probe', [{ op: 'create', t: 'card', id: 'card0009', f: { title: 'Nine' } }], { gestureId: 'edit' }, 5002),
      ],
    }),
    stepsVector('a change holding U+0000 throws, as the server would refuse it', {
      device: device(bound({ confirmed: PROBE })),
      steps: [commitStep('self/probe', [{ op: 'update', t: 'card', id: 'card0001', f: { title: 'Un\u0000o' } }])],
    }),
    stepsVector('a command argument holding U+0000 throws', {
      device: device(bound({ confirmed: PROBE })),
      steps: [commitStep('self/probe', [], { cmd: { name: 'probe.start', args: { id: 'run00009', startedAt: 5000, label: 'Ru\u0000n', join: true } } })],
    }),
    stepsVector('an opts.gestureId holding U+0000 throws', {
      device: device(bound({ confirmed: PROBE })),
      steps: [commitStep('self/probe', [{ op: 'update', t: 'card', id: 'card0001', f: { title: 'Uno' } }], { gestureId: 'g\u0000' })],
    }),
    stepsVector('U+0000 throws before the cap check: a gesture over the cap holding it throws rather than answering cap', {
      device: device(bound({ confirmed: FULL })),
      steps: [commitStep('self/probe', [{ op: 'create', t: 'card', id: 'card0009', f: { title: 'Fo\u0000r' } }])],
    }),
    stepsVector('a whole put that leaves out a client-written field throws', {
      device: device(bound({ confirmed: FACTS })),
      steps: [commitStep('self/probe', [{ op: 'put', t: 'fact', id: DAY, f: { value: 81 } }])],
    }),
    stepsVector('a removing put of a whole fact that names a field value throws: a removal carries its life alone', {
      device: device(bound({ confirmed: FACTS })),
      steps: [commitStep('self/probe', [{ op: 'put', t: 'fact', id: DAY, present: false, f: { value: 81 } }])],
    }),
    stepsVector('a delete of a whole fact that names a field value throws', {
      device: device(bound({ confirmed: FACTS })),
      steps: [commitStep('self/probe', [{ op: 'delete', t: 'fact', id: DAY, f: { value: 81 } }])],
    }),
    stepsVector('a whole put carrying a text edit throws: a wholePut type has no text field', {
      device: device(bound({ confirmed: FACTS })),
      steps: [commitStep('self/probe', [{ op: 'put', t: 'fact', id: DAY, f: { value: 81, at: 5000 }, x: { note: 'kept?' } }])],
    }),
    stepsVector('a device row whose key matches none of its product\'s rows throws', {
      device: device(bound({ confirmed: PROBE })),
      steps: [commitStep('self/probe', [], { local: { plates: [10] } })],
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

function retire() {
  const deleteFact = commitStep('self/probe', [{ op: 'delete', t: 'fact', id: DAY }], { hold: true, gestureId: 'forget' }, 5000);
  const deleteDay = (deviceNow = 5000) => commitStep('self/probe', [{ op: 'delete', t: 'day', id: DAY }], { hold: true }, deviceNow);
  const putDay = (retired, deviceNow = 5001) => commitStep('self/probe', [{ op: 'put', t: 'day', id: DAY, f: { score: 9 } }], { retire: retired }, deviceNow);
  const theDay = [{ t: 'day', id: DAY }];
  return [
    stepsVector('a put with retire ends the held delete of its keyed record undone, writes only the touched field onto the record, and returns the gesture as retired', {
      device: device(bound({ confirmed: DAYS })),
      steps: [deleteDay(), putDay(theDay)],
    }),
    stepsVector('writing a fact again inside its delete window is the Undo: the retire ends the held delete, and the whole put writes every field with a fresh life', {
      device: device(bound({ confirmed: FACTS })),
      steps: [deleteFact, saveFact(81, 5001, { retire: [{ t: 'fact', id: DAY }] }, 5001), { op: 'view', scope: 'self/probe', withHeld: true, deviceNow: 5002 }],
    }),
    stepsVector('a whole put after a held delete of its fact, without a retire, out-stamps it: the fact is drawn alive, and both are sent', {
      device: device(bound({ confirmed: FACTS })),
      steps: [deleteFact, saveFact(81, 5001, undefined, 5001), { op: 'view', scope: 'self/probe', withHeld: true, deviceNow: 5002 }, { op: 'releaseAll', deviceNow: 5003 }, { op: 'push', deviceNow: 5004 }],
    }),
    stepsVector('a retire whose diff is empty still retires the held delete, and the clock ticks', {
      device: device(bound({ confirmed: DAYS })),
      steps: [deleteDay(), commitStep('self/probe', [{ op: 'put', t: 'day', id: DAY, f: { score: 7 } }], { retire: theDay }, 5001)],
    }),
    stepsVector('with a minted record the retire returns it to drawn, and an update writes only the touched field', {
      device: device(bound({ confirmed: PROBE })),
      steps: [
        commitStep('self/probe', [{ op: 'delete', t: 'card', id: 'card0001' }], { hold: true }),
        commitStep('self/probe', [{ op: 'update', t: 'card', id: 'card0001', f: { title: 'One', tier: 'done' } }], { retire: [{ t: 'card', id: 'card0001' }] }, 5001),
      ],
    }),
    stepsVector('a commit retiring two held gestures returns their gesture ids in commit order', {
      device: device(bound({ confirmed: DAYS })),
      steps: [
        deleteDay(),
        commitStep('self/probe', [{ op: 'delete', t: 'card', id: 'card0001' }], { hold: true }, 5001),
        commitStep('self/probe', [
          { op: 'update', t: 'card', id: 'card0001', f: { title: 'Back' } },
          { op: 'put', t: 'day', id: DAY, f: { score: 9 } },
        ], { retire: [{ t: 'card', id: 'card0001' }, ...theDay] }, 5002),
      ],
    }),
    stepsVector('a retire folds a put that carries the retired delete\'s life, silently, and the retiring put writes over the record as it was', {
      device: device(bound({ confirmed: DAYS })),
      steps: [
        deleteDay(),
        commitStep('self/probe', [{ op: 'put', t: 'day', id: DAY, present: false, f: { score: 5 } }], undefined, 5001),
        commitStep('self/probe', [{ op: 'put', t: 'day', id: DAY, f: { score: 5 } }], { retire: theDay }, 5002),
      ],
    }),
    stepsVector('a held gesture carrying a command is not retired: the put makes the record anew', {
      device: device(bound({ confirmed: DAYS })),
      steps: [
        commitStep('self/probe', [{ op: 'delete', t: 'day', id: DAY }], {
          hold: true,
          cmd: { name: 'probe.end', args: { runId: 'run00001', endedAt: 5000 } },
          predict: [{ op: 'update', t: 'run', id: 'run00001', f: { endedAt: 5000 } }],
        }),
        putDay(theDay),
      ],
    }),
    stepsVector('a held gesture with a delta that does not remove is not retired', {
      device: device(bound({ confirmed: DAYS })),
      steps: [
        commitStep('self/probe', [{ op: 'delete', t: 'day', id: DAY }, { op: 'put', t: 'day', id: '2026-09-02', f: { score: 4 } }], { hold: true }),
        putDay(theDay),
      ],
    }),
    stepsVector('a held removal of a record the commit does not list is not retired', {
      device: device(bound({ confirmed: DAYS })),
      steps: [deleteDay(), putDay([{ t: 'day', id: '2026-09-02' }])],
    }),
    stepsVector('a released delete, ready, is not retired', {
      device: device(bound({ confirmed: DAYS })),
      steps: [deleteDay(), { op: 'releaseAll', deviceNow: 5000 }, putDay(theDay)],
    }),
    stepsVector('a held removal in another scope is not retired', {
      device: device(bound({ confirmed: { ...PROBE, [TREE]: TREE_ROWS } })),
      steps: [
        commitStep(TREE, [{ op: 'delete', t: 'tag', id: 'oak' }], { hold: true }),
        commitStep('self/probe', [{ op: 'update', t: 'card', id: 'card0001', f: { title: 'Uno' } }], { retire: [{ t: 'tag', id: 'oak' }] }, 5001),
      ],
    }),
    stepsVector('a retiring commit refused cap retires nothing', {
      device: device(bound({ confirmed: FULL })),
      steps: [
        commitStep('self/probe', [{ op: 'delete', t: 'card', id: 'card0001' }], { hold: true }),
        commitStep('self/probe', [
          { op: 'update', t: 'card', id: 'card0001', f: { tier: 'done' } },
          { op: 'create', t: 'card', id: 'card0009', f: { title: 'Fourth' } },
        ], { retire: [{ t: 'card', id: 'card0001' }] }, 5001),
      ],
    }),
  ];
}

function supersede() {
  const create = commitStep('self/probe', [{ op: 'create', t: 'card', id: 'card0010', f: { title: 'First' } }]);
  const replace = commitStep('self/probe', [{ op: 'create', t: 'card', id: 'card0010', f: { title: 'Latest' } }], { supersede: ['g1'] }, 5001);
  return [
    stepsVector('anonymous ready whole gesture superseded before numbering', { device: device(anon()), steps: [create, replace] }),
    stepsVector('anonymous held gesture superseded without waiting', { device: device(anon()), steps: [{ ...create, opts: { hold: true } }, replace] }),
    stepsVector('supersede folds later minted-record updates and commands silently', {
      device: device(anon()),
      steps: [create,
        commitStep('self/probe', [{ op: 'update', t: 'card', id: 'card0010', f: { title: 'Dependent' } }]),
        replace],
    }),
    stepsVector('superseding multiple gestures follows commit order', {
      device: device(anon()),
      steps: [create,
        commitStep('self/probe', [{ op: 'create', t: 'card', id: 'card0011', f: { title: 'Second' } }]),
        commitStep('self/probe', [{ op: 'create', t: 'card', id: 'card0012', f: { title: 'Full replacement' } }], { supersede: ['g2', 'g1'] })],
    }),
    stepsVector('supersede a gesture from another scope throws atomically', {
      device: device(anon()),
      steps: [create, commitStep(TREE, [{ op: 'write', t: 'meta', id: 'meta', f: { title: 'Other' } }], { supersede: ['g1'] })],
    }),
    stepsVector('supersede fails before a malformed replacement can remove source', {
      device: device(anon()),
      steps: [create, commitStep('self/probe', [{ op: 'create', t: 'card', id: 'card0010', f: { unknown: 'bad' } }], { supersede: ['g1'] })],
    }),
    stepsVector('supersede too-large replacement leaves source and clock unchanged', {
      device: device(anon()), limits: { PUSH_MAX_BYTES: 500 },
      steps: [create, commitStep('self/probe', [{ op: 'create', t: 'card', id: 'card0010', f: { title: 'x'.repeat(800) } }], { supersede: ['g1'] })],
    }),
    stepsVector('bound-ready supersede is refused as a programming error', { device: device(bound()), steps: [create, replace] }),
    stepsVector('unknown anonymous supersede gesture throws atomically', { device: device(anon()), steps: [replace] }),
  ];
}

export function files() {
  return {
    'commit/retire.json': retire(),
    'commit/supersede.json': supersede(),
    'commit/deltas.json': deltas(),
    'commit/ids.json': ids(),
    'commit/guards.json': guards(),
    'commit/grouping.json': grouping(),
    'commit/throws.json': throws(),
  };
}
