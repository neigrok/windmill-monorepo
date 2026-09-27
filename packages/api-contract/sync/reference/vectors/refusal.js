// refusal/*.json (§7.7): refusals of sent entries, with the responses the reference server gives. A
// refusal folds its dependents into one notice; clock-skew and base-unknown recover automatically.

import { freshMeta } from '../client/replica.js';
import { intentDigest } from '../core/wire.js';
import { pull } from '../server/pull.js';
import { push } from '../server/push.js';
import { ServerState } from '../server/state.js';
import { OTHER, overlayScope, product, productScope, registry, row, serverState, st, treeScope } from './fixtures.js';
import { runSteps, settle, stepsVector } from './steps.js';

const REPLICA = 'rp_00000000000000000000000000000001';
const BOARD = 'b_00000001';
const FOREIGN_BOARD = 'b_0000000b';
const TREE = `tree/${BOARD}`;
const OVERLAY = `self/overlay/${BOARD}`;

// Client steps interleaved with the reference server: each push round answers with the server's response.
class ServerScript {
  constructor({ device, server }) {
    this.input = { device, ids: [], steps: [] };
    this.server = new ServerState(server);
  }

  add(...steps) {
    this.input.steps.push(...steps);
    return this;
  }

  push(deviceNow) {
    return this.add({ op: 'push', deviceNow });
  }

  // Answers the request of the last push step with the server's response, received at tRecv.
  respond({ serverNow, budget, tRecv = serverNow }) {
    const out = runSteps(this.input);
    const index = this.input.steps.map((step) => step.op).lastIndexOf('push');
    const request = out.returns[index];
    const pushed = push({ state: this.server, registry, product, account: 'A', request, serverNow, budget });
    this.server = pushed.state;
    return this.add({ op: 'pushResponse', response: pushed.response, deviceNow: tRecv, tSend: this.input.steps[index].deviceNow, tRecv });
  }

  pushRound({ deviceNow, serverNow = deviceNow, budget, tRecv = deviceNow }) {
    return this.push(deviceNow).respond({ serverNow, budget, tRecv });
  }

  withIds(ids) {
    this.input.ids = ids;
    return this;
  }

  withActors(actors) {
    this.input.actors = actors;
    return this;
  }

  pullRound({ deviceNow, scopes, serverNow = deviceNow }) {
    this.add({ op: 'pull', scopes, deviceNow });
    const out = runSteps(this.input);
    const request = out.returns[out.returns.length - 1];
    const pulled = pull({ state: this.server, registry, product, account: 'A', request, serverNow });
    this.server = pulled.state;
    return this.add({ op: 'pullResponse', response: pulled.response, deviceNow, tSend: deviceNow, tRecv: deviceNow });
  }

  vector(name) {
    return stepsVector(name, this.input);
  }
}

function device(confirmed = {}, meta = {}) {
  return settle({ active: REPLICA, replicas: [{ meta: { ...freshMeta(REPLICA, 'bound', 'A'), ...meta }, confirmed }] });
}

const commitStep = (scope, changes, opts, deviceNow) => ({ op: 'commit', scope, changes, ...(opts ? { opts } : {}), deviceNow });

const CARDS = [1, 2, 3].map((k) => row({ t: 'card', id: `card000${k}`, life: ['alive', st(1000 + k)], born: st(1000 + k), f: { title: [`Card ${k}`, st(1000 + k)] }, seq: k }));
const TAGS = [
  row({ t: 'tag', id: 'elm', life: ['alive', st(1000)], born: st(1000), f: { label: ['Elm', st(1000)] }, seq: 1 }),
  row({ t: 'tag', id: 'oak', life: ['alive', st(1100, 0, 'r_cccccccccccc')], born: st(1100, 0, 'r_cccccccccccc'), f: { label: ['Oak', st(1100, 0, 'r_cccccccccccc')] }, seq: 2 }),
];

function server() {
  return serverState({
    scopes: {
      'acct:A/probe': productScope('A'),
      'acct:B/probe': productScope('B'),
      [`tree:${BOARD}`]: treeScope('A', BOARD),
      [`tree:${FOREIGN_BOARD}`]: treeScope('B', FOREIGN_BOARD),
      [`acct:A/overlay/${BOARD}`]: overlayScope('A', BOARD),
    },
    rows: {
      'acct:A/probe': [...CARDS, row({ t: 'board', id: BOARD, life: ['alive', st(900)], born: st(900), seq: 4 })],
      'acct:B/probe': [
        row({ t: 'board', id: FOREIGN_BOARD, life: ['alive', st(900, 0, 'r_cccccccccccc')], born: st(900, 0, 'r_cccccccccccc'), seq: 1 }),
        row({ t: 'run', id: 'run0000b1', life: ['alive', st(950, 0, 'srv')], born: st(950, 0, 'srv'), f: { startedAt: [950, st(950, 0, 'srv')] }, seq: 2 }),
      ],
      [`tree:${BOARD}`]: TAGS,
    },
  });
}

const CLIENT_PROBE = { 'self/probe': [...CARDS, row({ t: 'board', id: BOARD, life: ['alive', st(900)], born: st(900), seq: 4 })] };
// A client that has not yet pulled the server's third card: its stored view allows a create the
// server's growth rule refuses `cap`.
const CLIENT_BEHIND = { 'self/probe': [...CARDS.slice(0, 2), row({ t: 'board', id: BOARD, life: ['alive', st(900)], born: st(900), seq: 4 })] };
const newCard = (id) => ({ op: 'create', t: 'card', id, f: { title: 'Fourth' } });
// A create the server refuses `invalid` at §6.1 step 2: a title one character over its 12.
const tooLong = (id) => ({ op: 'create', t: 'card', id, f: { title: 'Thirteen char' } });

// A client and a server holding the same one card and board, so two creates fit the cap.
function inStep() {
  const rows = [CARDS[0], row({ t: 'board', id: BOARD, life: ['alive', st(900)], born: st(900), seq: 4 })];
  return new ServerScript({ device: device({ 'self/probe': rows }), server: serverState({ scopes: { 'acct:A/probe': productScope('A') }, rows: { 'acct:A/probe': rows } }) });
}

function folds() {
  const script = () => new ServerScript({ device: device(CLIENT_BEHIND), server: server() });
  return [
    script()
      .add(commitStep('self/probe', [newCard('card0009')], undefined, 5000))
      .pushRound({ deviceNow: 5001 })
      .vector('a refused create writes a notice with its content and the refusal detail'),
    script()
      .add(commitStep('self/probe', [newCard('card0009')], undefined, 5000))
      .push(5000)
      .add(commitStep('self/probe', [{ op: 'update', t: 'card', id: 'card0009', f: { title: 'Renamed' } }], undefined, 5001))
      .add(commitStep('self/probe', [{ op: 'update', t: 'card', id: 'card0001', f: { title: 'Kept' } }], undefined, 5002))
      .respond({ serverNow: 5003 })
      .vector('a queued update of the refused create is folded into its notice; an unrelated entry stays'),
    script()
      .add(commitStep('self/probe', [], {
        cmd: { name: 'probe.start', args: { id: 'run0000b1', startedAt: 5000, join: true } },
        predict: [{ op: 'create', t: 'run', id: 'run0000b1', f: { startedAt: 5000 } }],
      }, 5000))
      .add(commitStep('self/probe', [{ op: 'create', t: 'lap', id: 'lap00001', f: { runId: 'run0000b1', weight: 40 } }], undefined, 5001))
      .add(commitStep('self/probe', [{ op: 'update', t: 'lap', id: 'lap00001', f: { weight: 45 } }], { guard: [{ t: 'lap', id: 'lap00001', field: 'weight' }] }, 5002))
      .add(commitStep('self/probe', [], {
        cmd: { name: 'probe.end', args: { runId: 'run0000b1', endedAt: 5003 } },
        predict: [{ op: 'update', t: 'run', id: 'run0000b1', f: { endedAt: 5003 } }],
      }, 5003))
      .add(commitStep('self/probe', [{ op: 'update', t: 'card', id: 'card0002', f: { title: 'Kept' } }], undefined, 5004))
      .pushRound({ deviceNow: 5005 })
      .vector('a refused command folds a lap naming its predicted run, that lap\'s own update, and a command naming the run'),
    script()
      .add(commitStep(TREE, [{ op: 'create', t: 'tag', id: 'oak', f: { label: 'Oak' } }], undefined, 5000))
      .push(5000)
      .add(commitStep(TREE, [{ op: 'put', t: 'link', id: ['oak', 'elm'] }], undefined, 5001))
      .add(commitStep(TREE, [{ op: 'put', t: 'link', id: ['elm', 'ash'] }], undefined, 5002))
      .add(commitStep(OVERLAY, [{ op: 'write', t: 'mark', id: 'oak', f: { done: true } }], undefined, 5003))
      .respond({ serverNow: 5004 })
      .vector('a refused tag create folds a link keyed by it and a mark in another scope keyed by it'),
    script()
      .add(commitStep('self/probe', [{ op: 'create', t: 'board', id: FOREIGN_BOARD }], { atomic: true }, 5000))
      .push(5000)
      .add(commitStep(`tree/${FOREIGN_BOARD}`, [{ op: 'write', t: 'meta', id: 'meta', f: { title: 'Mine' } }], undefined, 5001))
      .add(commitStep(`tree/${FOREIGN_BOARD}`, [{ op: 'create', t: 'tag', label: 'Ash', f: { label: 'Ash' } }], undefined, 5002))
      .add(commitStep(`self/overlay/${FOREIGN_BOARD}`, [{ op: 'write', t: 'mark', id: 'ash', f: { done: true } }], undefined, 5003))
      .respond({ serverNow: 5004 })
      .vector('a refused board create folds every write to the scopes it would govern'),
    script()
      .add(commitStep('self/probe', [newCard('card0009')], undefined, 5000))
      .push(5000)
      .add(commitStep('self/probe', [
        { op: 'update', t: 'card', id: 'card0009', f: { title: 'Renamed' } },
        { op: 'update', t: 'card', id: 'card0001', f: { title: 'Kept' } },
      ], { atomic: true, guard: [{ t: 'card', id: 'card0009', field: 'title' }, { t: 'card', id: 'card0001', field: 'title' }] }, 5001))
      .respond({ serverNow: 5002 })
      .vector('a partly dependent entry loses the dependent delta and its guards and keeps the rest'),
    script()
      .add(commitStep('self/probe', [newCard('card0009')], undefined, 5000))
      .add(commitStep('self/probe', [{ op: 'update', t: 'card', id: 'card0009', f: { title: 'Renamed' } }], { guard: [{ t: 'card', id: 'card0009', field: 'title' }] }, 5001))
      .pushRound({ deviceNow: 5002 })
      .vector('a sent dependent becomes an orphan held in the notice, and its refusal ends it without a notice of its own'),
    script()
      .add(commitStep('self/probe', [newCard('card0009')], undefined, 5000))
      .push(5000)
      .add(commitStep('self/probe', [{ op: 'delete', t: 'card', id: 'card0009' }], undefined, 5001))
      .pushRound({ deviceNow: 5002 })
      .vector('an orphan the server admits is acked like any ok, and its content stays in the notice'),
    script()
      .add(commitStep('self/probe', [newCard('card0009')], undefined, 5000))
      .push(5000)
      .add(commitStep('self/probe', [
        { op: 'update', t: 'card', id: 'card0009', f: { title: 'Newer' } },
        { op: 'update', t: 'card', id: 'card0001', f: { title: 'Keep me' } },
      ], { atomic: true }, 5001))
      .push(5001)
      .respond({ serverNow: 5002 })
      .vector('a sent entry partly dependent is an orphan: the refused create\'s notice holds its whole content, and its own refusal ends it without a notice'),
    script()
      .withIds(['rp_00000000000000000000000000000002'])
      .withActors(['r_cccccccccccc'])
      .add(commitStep('self/probe', [newCard('card0009')], undefined, 5000))
      .push(5000)
      .add(commitStep('self/probe', [{ op: 'update', t: 'card', id: 'card0009', f: { title: 'Newer' } }], undefined, 5001))
      .push(5001)
      .respond({ serverNow: 5002, budget: 1 })
      .add({ op: 'reidentify', deviceNow: 5003 })
      .add(commitStep('self/probe', [{ op: 'update', t: 'card', id: 'card0009', f: { title: 'Later edit' } }], undefined, 5004))
      .pushRound({ deviceNow: 5005 })
      .vector('an edit never joins an orphan: the orphan ends without a notice, the edit ends in its own'),
    new ServerScript({
      device: device({ ...CLIENT_BEHIND, 'tree/b_00000002': [row({ t: 'tag', id: 'oak', life: ['alive', st(1000)], born: st(1000), f: { label: ['Oak', st(1000)] }, seq: 1 })] }),
      server: server(),
    })
      .add(commitStep(TREE, [{ op: 'create', t: 'tag', id: 'oak', f: { label: 'Oak' } }], undefined, 5000))
      .push(5000)
      .add(commitStep('tree/b_00000002', [{ op: 'update', t: 'tag', id: 'oak', f: { label: 'Other oak' } }], undefined, 5001))
      .add(commitStep('self/overlay/b_00000002', [{ op: 'write', t: 'mark', id: 'oak', f: { done: true } }], undefined, 5002))
      .respond({ serverNow: 5003 })
      .vector('a refused tag create in one tree folds nothing of a same-id tag or mark in another tree'),
    inStep()
      .add(commitStep('self/probe', [tooLong('card0009')], undefined, 5000))
      .add(commitStep('self/probe', [{ op: 'update', t: 'card', id: 'card0009', f: { title: 'Fixed' } }, newCard('card0010')], { atomic: true }, 5001))
      .push(5002)
      .add(commitStep('self/probe', [{ op: 'update', t: 'card', id: 'card0010', f: { title: 'Edited' } }], undefined, 5003))
      .respond({ serverNow: 5004 })
      .push(5005)
      .vector('an orphan\'s refusal folds its held-back dependents into the origin\'s notice: an edit of the record the orphan created is never sent'),
    inStep()
      .add(commitStep('self/probe', [tooLong('card0009')], undefined, 5000))
      .add(commitStep('self/probe', [{ op: 'delete', t: 'card', id: 'card0009' }, newCard('card0010')], { atomic: true }, 5001))
      .push(5002)
      .add(commitStep('self/probe', [{ op: 'update', t: 'card', id: 'card0010', f: { title: 'Edited' } }], undefined, 5003))
      .add(commitStep('self/probe', [{ op: 'update', t: 'card', id: 'card0010', f: { tier: 'done' } }], { hold: true }, 5004))
      .respond({ serverNow: 5005 })
      .pushRound({ deviceNow: 5006 })
      .add({ op: 'releaseAll', deviceNow: 5007 })
      .pushRound({ deviceNow: 5008 })
      .vector('an orphan the server admits releases its held-back dependents: a ready and a held edit of the record it created both land'),
  ];
}

const SKEW = 400_000;
const skewed = (deviceNow) => deviceNow + SKEW;

function restamps() {
  const script = (meta) => new ServerScript({ device: device(CLIENT_BEHIND, meta), server: server() });
  return [
    script()
      .add(commitStep('self/probe', [{ op: 'delete', t: 'card', id: 'card0001' }], { hold: true }, skewed(4999)))
      .add(commitStep('self/probe', [newCard('card0009')], undefined, skewed(5000)))
      .add(commitStep('self/probe', [{ op: 'create', t: 'board', id: 'b_00000002' }], undefined, skewed(5001)))
      .push(skewed(5001))
      .add(commitStep('self/probe', [{ op: 'update', t: 'card', id: 'card0009', f: { title: 'Renamed' } }], { guard: [{ t: 'card', id: 'card0009', field: 'title' }] }, skewed(5002)))
      .add(commitStep('self/probe', [{ op: 'delete', t: 'card', id: 'card0009' }], { hold: true }, skewed(5003)))
      .respond({ serverNow: 5000, budget: 1, tRecv: skewed(5004) })
      .vector('clock-skew returns later unprocessed entries to ready and restamps every held and ready entry in commit order'),
    script({ admittedHigh: st(250_000, 7, 'srv'), hlc: { ms: 250_000, counter: 7 } })
      .add(commitStep('self/probe', [newCard('card0009')], undefined, skewed(5000)))
      .pushRound({ deviceNow: skewed(5001), serverNow: 5000, tRecv: skewed(5002) })
      .vector('the recovered clock starts from admittedHigh when it is above physNow'),
    script()
      .add(commitStep('self/probe', [newCard('card0009')], undefined, skewed(5000)))
      .add(commitStep('self/probe', [{ op: 'create', t: 'board', id: 'b_00000002' }], undefined, skewed(5001)))
      .pushRound({ deviceNow: skewed(5002), serverNow: 5000, tRecv: skewed(5003) })
      .vector('two skewed results in one response restamp twice, each in commit order'),
    script()
      .add(commitStep('self/probe', [{ op: 'update', t: 'card', id: 'card0002', f: { title: 'On time' } }], undefined, 5000))
      .pushRound({ deviceNow: 5001, serverNow: 5005, tRecv: 5011 })
      .add(commitStep('self/probe', [newCard('card0009')], undefined, skewed(6000)))
      .pushRound({ deviceNow: skewed(6001), serverNow: 6000, tRecv: skewed(6002) })
      .vector('an acked entry keeps its stamps through a later recovery'),
    script()
      .add(commitStep('self/probe', [{ op: 'create', t: 'board', id: 'b_00000002' }], undefined, skewed(5000)))
      .push(skewed(5001))
      .add(commitStep('self/probe', [{ op: 'delete', t: 'board', id: 'b_00000002' }], undefined, skewed(5002)))
      .push(skewed(5003))
      .respond({ serverNow: 5000, tRecv: skewed(5004) })
      .pushRound({ deviceNow: skewed(5005), serverNow: 5010, tRecv: skewed(5006) })
      .vector('a sent delete answered clock-skew in the same response follows its create\'s new born, so both land'),
    script({ nextN: 2 })
      .withIds(['rp_00000000000000000000000000000002'])
      .withActors(['r_cccccccccccc'])
      .add(commitStep('self/probe', [{ op: 'create', t: 'board', id: 'b_00000002' }], undefined, skewed(5000)))
      .push(skewed(5001))
      .respond({ serverNow: 5000, tRecv: skewed(5002) })
      .add(commitStep('self/probe', [{ op: 'delete', t: 'board', id: 'b_00000002' }], undefined, skewed(5003)))
      .pushRound({ deviceNow: skewed(5004), serverNow: 5010, tRecv: skewed(5005) })
      .pushRound({ deviceNow: skewed(5006), serverNow: 5020, tRecv: skewed(5007) })
      .vector('a skewed create that a 409 returned to ready takes no join from a later delete: recovery moves the delete\'s born with the create\'s life, and both land'),
    script()
      .add(commitStep('self/probe', [newCard('card0009')], { hold: true, gestureId: 'new' }, skewed(5000)))
      .add(commitStep('self/probe', [{ op: 'update', t: 'card', id: 'card0009', f: { title: 'Renamed' } }], undefined, skewed(5001)))
      .add(commitStep('self/probe', [{ op: 'update', t: 'card', id: 'card0001', f: { title: 'Kept' } }], undefined, skewed(5002)))
      .add({ op: 'undo', gestureId: 'new' })
      .pushRound({ deviceNow: skewed(5003), serverNow: 5000, tRecv: skewed(5004) })
      .pushRound({ deviceNow: skewed(5005), serverNow: 5010, tRecv: skewed(5006) })
      .vector('undo of a skewed held create folds the update of its record silently, so no born is left that recovery cannot move, and the independent edit lands'),
    script()
      .add(commitStep(TREE, [{ op: 'create', t: 'tag', id: 'pine', f: { label: 'a label of twenty-five ch' } }], undefined, 5000))
      .add(commitStep(TREE, [{ op: 'create', t: 'tag', id: 'fir', f: { label: 'Fir' } }], undefined, skewed(5001)))
      .add(commitStep(TREE, [
        { op: 'update', t: 'tag', id: 'pine', f: { label: 'Pine' } },
        { op: 'update', t: 'tag', id: 'fir', f: { label: 'Fir tree' } },
      ], { atomic: true }, skewed(5002)))
      .pushRound({ deviceNow: skewed(5003), serverNow: 5000, tRecv: skewed(5004) })
      .vector('a notice is a snapshot: the recovery that moves the born an orphan carries leaves the notice as it was written'),
    script()
      .add({ ...commitStep(OVERLAY, [{ op: 'write', t: 'mark', id: 'oak', f: { done: true }, x: { memo: 'from tab B' } }], undefined, skewed(5000)), actor: OTHER })
      .push(skewed(5000))
      .respond({ serverNow: 5000, tRecv: skewed(5001) })
      .add(commitStep(OVERLAY, [{ op: 'write', t: 'mark', id: 'oak', x: { memo: 'from tab A' } }], undefined, skewed(5002)))
      .vector('a clock-skew restamp keeps each entry\'s author actor, so text from another instance still does not join'),
    returnedCommand(),
    carriedLife(),
  ];
}

// An acked start whose map set its prediction to the server's born comes back ready (an epoch change);
// a skewed entry before it is recovered: the prediction is not restamped and a later update keeps the
// server's born.
function returnedCommand() {
  const skewedIntent = { scope: 'self/probe', d: [{ t: 'card', id: 'card0001', born: st(1001), f: { title: ['Skewed', st(skewed(5000))] } }], gestureId: 'g1', n: 1 };
  const srv = st(5003, 0, 'srv');
  const entries = [
    { localId: 'g1/0', gestureId: 'g1', lineage: 'A', scope: 'self/probe', state: 'sent', commitOrder: 1, releaseAt: 0, stamp: st(skewed(5000)), intent: skewedIntent, n: 1, digest: intentDigest(skewedIntent), numbered: true },
    {
      localId: 'g2/0', gestureId: 'g2', lineage: 'A', scope: 'self/probe', state: 'ready', commitOrder: 2, releaseAt: 0, stamp: st(5001),
      intent: { scope: 'self/probe', cmd: { name: 'probe.start', args: { id: 'run00009', startedAt: 5001, join: true } }, gestureId: 'g2' },
      predict: [{ t: 'run', id: 'run00009', born: srv, life: ['alive', srv], f: { startedAt: [5001, srv] } }],
      numbered: true,
    },
    { localId: 'g3/0', gestureId: 'g3', lineage: 'A', scope: 'self/probe', state: 'ready', commitOrder: 3, releaseAt: 0, stamp: st(5002), intent: { scope: 'self/probe', d: [{ t: 'run', id: 'run00009', born: srv, f: { label: ['Renamed', st(5002)] } }], gestureId: 'g3' } },
  ];
  const base = device(CLIENT_PROBE);
  Object.assign(base.replicas[0], { outbox: entries });
  Object.assign(base.replicas[0].meta, { nextN: 2, hlc: { ms: skewed(5000), counter: 0 }, hlcHigh: st(skewed(5000)) });
  return stepsVector('clock-skew recovery restamps intents, never predictions: a later update keeps the server\'s born', {
    device: base,
    steps: [
      { op: 'push', deviceNow: skewed(5004) },
      {
        op: 'pushResponse',
        deviceNow: skewed(5005),
        tSend: skewed(5004),
        tRecv: skewed(5005),
        response: { status: 200, body: { serverTime: 5005, epoch: 'ep-1', lastN: 1, results: [{ n: 1, s: 'refused', code: 'clock-skew' }], retry: { n: 2, retryAfterMs: 0 } } },
      },
    ],
  });
}

// §7.1 step 4 carries a present keyed record's life register unchanged; a clock-skew restamp moves only
// what the entry wrote, so the server's newer delete of the link still wins.
function carriedLife() {
  const board = row({ t: 'board', id: BOARD, life: ['alive', st(900)], born: st(900), seq: 4 });
  const linkAt = (life, seq) => row({ t: 'link', id: ['elm', 'oak'], life, seq });
  const serverSide = serverState({
    scopes: { 'acct:A/probe': productScope('A'), [`tree:${BOARD}`]: treeScope('A', BOARD) },
    rows: { 'acct:A/probe': [board], [`tree:${BOARD}`]: [...TAGS, linkAt(['dead', st(2000, 0, 'r_cccccccccccc')], 4)] },
  });
  return new ServerScript({ device: device({ 'self/probe': [board], [TREE]: [...TAGS, linkAt(['alive', st(1000, 0, 'r_cccccccccccc')], 3)] }), server: serverSide })
    .add(commitStep(TREE, [{ op: 'put', t: 'link', id: ['elm', 'oak'], f: { strength: 5 } }], undefined, skewed(5000)))
    .push(skewed(5000))
    .respond({ serverNow: 5000, tRecv: skewed(5001) })
    .pushRound({ deviceNow: skewed(5002), serverNow: 5010, tRecv: skewed(5003) })
    .pullRound({ deviceNow: skewed(5004), scopes: [TREE], serverNow: 5020 })
    .vector('a keyed put carrying its unchanged life keeps that stamp through a clock-skew restamp: the server\'s newer delete stands');
}

function baseUnknowns() {
  const mark = (text, rev) => row({ t: 'mark', id: 'oak', f: { done: [false, st(1000)] }, x: { memo: { text, rev, merged: false } }, seq: rev });
  const overlayServer = serverState({
    scopes: {
      'acct:A/probe': productScope('A'),
      [`tree:${BOARD}`]: treeScope('A', BOARD),
      [`acct:A/overlay/${BOARD}`]: overlayScope('A', BOARD),
    },
    rows: {
      'acct:A/probe': [row({ t: 'board', id: BOARD, life: ['alive', st(900)], born: st(900), seq: 1 })],
      [`tree:${BOARD}`]: TAGS,
      [`acct:A/overlay/${BOARD}`]: [mark('draft three', 5)],
    },
    revisions: { [`acct:A/overlay/${BOARD}`]: [{ t: 'mark', id: 'oak', field: 'memo', rev: 4, text: 'draft two' }] },
  });
  const stale = new ServerScript({ device: device({ [OVERLAY]: [mark('draft one', 3)] }), server: overlayServer })
    .add(commitStep(OVERLAY, [{ op: 'write', t: 'mark', id: 'oak', x: { memo: 'draft one, edited' } }], undefined, 5000))
    .pushRound({ deviceNow: 5001 });
  const again = new ServerScript({ device: device({ [OVERLAY]: [mark('draft one', 3)] }), server: overlayServer })
    .add(commitStep(OVERLAY, [{ op: 'write', t: 'mark', id: 'oak', x: { memo: 'draft one, edited' } }], undefined, 5000))
    .pushRound({ deviceNow: 5001 })
    .pushRound({ deviceNow: 5002 });
  const kept = new ServerScript({ device: device({ [OVERLAY]: [mark('draft two', 4)] }), server: overlayServer })
    .add(commitStep(OVERLAY, [{ op: 'write', t: 'mark', id: 'oak', x: { memo: 'draft two, edited' } }], undefined, 5000))
    .pushRound({ deviceNow: 5001 });
  return [
    stale.vector('base-unknown switches every text base to the text it was edited from and returns the entry to ready'),
    again.vector('the recovered entry is numbered again and merges on its text base'),
    kept.vector('a base rev the server still keeps merges without recovery'),
  ];
}

// Transport outcomes of §7.4 and §7.5: status codes on push, offsets from every response, re-identify
// and an epoch change.
function transports() {
  const at = (serverTime) => ({ serverTime, epoch: 'ep-1' });
  const rename = (id, title, deviceNow) => commitStep('self/probe', [{ op: 'update', t: 'card', id, f: { title } }], undefined, deviceNow);
  const answer = (status, body, deviceNow) => ({ op: 'pushResponse', deviceNow, tSend: deviceNow - 10, tRecv: deviceNow, response: { status, body } });
  const base = () => device(CLIENT_PROBE);
  const reading = (wall, mono, boot = 'boot-1') => ({ wall, mono, boot });
  const hello = (deviceNow, send, recv, serverTime) => ({ op: 'hello', deviceNow, send, recv, response: { status: 200, body: { ...at(serverTime), schema: 1, minSchema: 1 } } });
  return [
    stepsVector('a one-intent 400 refuses the entry invalid with a notice, rewinds nextN to its n and emits sync-push-malformed', {
      device: base(),
      steps: [rename('card0001', 'Bad', 5000), { op: 'push', deviceNow: 5000 }, answer(400, { ...at(5020), error: 'malformed' }, 5030), rename('card0002', 'Next', 5040), { op: 'push', deviceNow: 5040 }],
    }),
    stepsVector('a one-intent 413 refuses the entry too-large with a notice and rewinds nextN to its n', {
      device: base(),
      steps: [rename('card0001', 'Huge', 5000), { op: 'push', deviceNow: 5000 }, answer(413, { ...at(5020), error: 'request-too-large' }, 5030)],
    }),
    stepsVector('a 413 on three intents answers limit 2, and the next push resends the first two by n', {
      device: base(),
      steps: [rename('card0001', 'One', 5000), rename('card0002', 'Two', 5001), rename('card0003', 'Three', 5002), { op: 'push', deviceNow: 5003 }, answer(413, { ...at(5020), error: 'request-too-large' }, 5030), { op: 'push', deviceNow: 5040, limit: 2 }],
    }),
    stepsVector('a one-intent 400 on a tag create returns the sent link keyed by it to ready and folds it into the one notice', {
      device: device({ ...CLIENT_PROBE, [TREE]: [TAGS[0]] }),
      steps: [
        commitStep(TREE, [{ op: 'create', t: 'tag', id: 'ash', f: { label: 'Ash' } }], undefined, 5000),
        commitStep(TREE, [{ op: 'put', t: 'link', id: ['ash', 'elm'] }], undefined, 5001),
        { op: 'push', deviceNow: 5002 },
        answer(400, { ...at(5020), error: 'malformed' }, 5030),
        { op: 'push', deviceNow: 5040, limit: 1 },
        answer(400, { ...at(5050), error: 'malformed' }, 5060),
        { op: 'push', deviceNow: 5070 },
      ],
    }),
    stepsVector('a 401 pauses the sender and still takes an offset sample', {
      device: base(),
      steps: [rename('card0001', 'One', 5000), { op: 'push', deviceNow: 5000 }, answer(401, { ...at(8020), error: 'unauthenticated' }, 5030), { op: 'push', deviceNow: 5040 }],
    }),
    stepsVector('a 409 re-identifies after taking an offset sample, and the instance takes a new actor', {
      device: base(),
      ids: ['rp_00000000000000000000000000000002'],
      actors: ['r_cccccccccccc'],
      steps: [rename('card0001', 'One', 5000), { op: 'push', deviceNow: 5000 }, answer(409, { ...at(8020), error: 'gap' }, 5030), { op: 'push', deviceNow: 5040 }],
    }),
    stepsVector('a 400 on two intents answers limit 1 and emits sync-push-malformed, with no notice', {
      device: base(),
      steps: [rename('card0001', 'One', 5000), rename('card0002', 'Two', 5001), { op: 'push', deviceNow: 5002 }, answer(400, { ...at(5020), error: 'malformed' }, 5030), { op: 'push', deviceNow: 5040, limit: 1 }],
    }),
    stepsVector('a one-intent 400 after halving refuses its entry, rewinds nextN to its n and returns the later sent entry to ready', {
      device: base(),
      steps: [
        rename('card0001', 'One', 5000), rename('card0002', 'Two', 5001),
        { op: 'push', deviceNow: 5002 },
        answer(400, { ...at(5020), error: 'malformed' }, 5030),
        { op: 'push', deviceNow: 5040, limit: 1 },
        answer(400, { ...at(5050), error: 'malformed' }, 5060),
        { op: 'push', deviceNow: 5070 },
      ],
    }),
    stepsVector('a sample after the wall clock jumps against the monotonic clock replaces every earlier sample', {
      device: base(),
      steps: [
        hello(5030, reading(5010, 80), reading(5030, 100), 9020),
        hello(6030, reading(6000, 1070), reading(6030, 1100), 10_020),
        hello(90_040, reading(90_000, 1160), reading(90_040, 1200), 11_020),
      ],
    }),
    stepsVector('a sample after a reboot replaces every earlier sample, and a steady clock keeps them', {
      device: base(),
      steps: [
        hello(5030, reading(5010, 80), reading(5030, 100), 9020),
        hello(6030, reading(6000, 1070), reading(6030, 1100), 10_020),
        hello(7040, reading(7000, 0, 'boot-2'), reading(7040, 40, 'boot-2'), 11_020),
      ],
    }),
    stepsVector('a response to a request that straddles a clock jump takes no sample, and the next sample replaces the earlier ones', {
      device: base(),
      steps: [
        hello(5030, reading(5010, 80), reading(5030, 100), 9020),
        hello(95_000, reading(6000, 1070), reading(95_000, 1100), 10_020),
        hello(95_140, reading(95_100, 1200), reading(95_140, 1240), 11_020),
      ],
    }),
    stepsVector('hello takes an offset sample', {
      device: base(),
      steps: [{ op: 'hello', deviceNow: 5030, tSend: 5010, tRecv: 5030, response: { status: 200, body: { ...at(9020), schema: 1, minSchema: 1 } } }],
    }),
    stepsVector('re-identify mints a replica id, restarts n at 1 and returns sent entries to ready, and the instance takes a new actor', {
      device: base(),
      ids: ['rp_00000000000000000000000000000002'],
      actors: ['r_cccccccccccc'],
      steps: [rename('card0001', 'One', 5000), rename('card0002', 'Two', 5001), { op: 'push', deviceNow: 5002 }, { op: 'reidentify', deviceNow: 5003 }, { op: 'push', deviceNow: 5004 }],
    }),
    stepsVector('an epoch change nulls every cursor, returns acked entries of another epoch to ready and re-identifies, and the instance takes a new actor', {
      device: base(),
      ids: ['rp_00000000000000000000000000000002'],
      actors: ['r_cccccccccccc'],
      steps: [
        rename('card0001', 'One', 5000),
        { op: 'push', deviceNow: 5000 },
        answer(200, { ...at(5010), lastN: 1, results: [{ n: 1, s: 'ok', seq: 5 }] }, 5010),
        { op: 'epochChange', epoch: 'ep-2', deviceNow: 5020 },
      ],
    }),
  ];
}

export function files() {
  return {
    'refusal/fold.json': folds(),
    'refusal/restamp.json': restamps(),
    'refusal/base-unknown.json': baseUnknowns(),
    'refusal/transport.json': transports(),
  };
}
