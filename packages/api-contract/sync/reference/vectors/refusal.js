// refusal/*.json (§7.7): refusals of sent entries, with the responses the reference server gives. A
// refusal folds its dependents into one notice; clock-skew and base-unknown recover automatically.

import assert from 'node:assert/strict';
import { freshMeta } from '../client/replica.js';
import { CONSTANTS } from '../core/constants.js';
import { bodyBytes, intentDigest } from '../core/wire.js';
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

  // Answers the request of the last push step with the server's response, received at tRecv. With
  // `dieAfter`, the process dies once that many of its results are recorded.
  respond({ serverNow, budget, tRecv = serverNow, dieAfter }) {
    const out = runSteps(this.input);
    const index = this.input.steps.map((step) => step.op).lastIndexOf('push');
    const request = out.returns[index];
    const pushed = push({ state: this.server, registry, product, account: 'A', request, serverNow, budget });
    this.server = pushed.state;
    return this.add({ op: 'pushResponse', response: pushed.response, deviceNow: tRecv, tSend: this.input.steps[index].deviceNow, tRecv, ...(dieAfter === undefined ? {} : { dieAfter }) });
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

  pullRound({ deviceNow, scopes, serverNow = deviceNow, limits = CONSTANTS }) {
    this.add({ op: 'pull', scopes, deviceNow });
    const out = runSteps(this.input);
    const request = out.returns[out.returns.length - 1];
    const pulled = pull({ state: this.server, registry, product, account: 'A', request, serverNow, limits });
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
// An orphan returned to ready that has grown past a request alone (a restamp adds digits), with the
// origin's notice already written, and `later` entries behind it. PUSH_MAX_BYTES sits one byte under the
// orphan's one-intent body, which a long body text makes the largest of all.
function outgrownOrphan(name, later) {
  const rows = [row({ t: 'card', id: 'card0001', life: ['alive', st(1001)], born: st(1001), f: { title: ['Card 1', st(1001)] }, seq: 1 })];
  const entry = (k, d, extra = {}) => ({
    localId: `g${k}/0`, gestureId: `g${k}`, lineage: 'A', scope: 'self/probe', state: 'ready', commitOrder: k, releaseAt: 0, stamp: st(5000 + k),
    intent: { scope: 'self/probe', d, gestureId: `g${k}` }, ...extra,
  });
  const created = { t: 'card', id: 'card0009', born: st(5001), life: ['alive', st(5001)], f: { title: ['Thirteen char', st(5001)] } };
  const orphan = entry(2, [
    { t: 'card', id: 'card0009', born: st(5001), f: { title: ['Fixed', st(5002)] } },
    { t: 'card', id: 'card0010', born: st(5002), life: ['alive', st(5002)], f: { body: ['x'.repeat(200), st(5002)], title: ['Ten', st(5002)] } },
  ], { orphanOf: 'g1/0' });
  const notice = { id: 'notice:g1/0', scope: 'self/probe', code: 'invalid', content: { d: [created], dependents: [{ d: orphan.intent.d }] }, at: 5003 };
  const outbox = [orphan, ...later.map((d, index) => entry(3 + index, d))];
  const limit = bodyBytes({ replica: REPLICA, account: 'A', ackThrough: 0, intents: [{ ...orphan.intent, n: 1 }] }) - 1;
  const base = device({ 'self/probe': rows }, { nextN: 1 });
  Object.assign(base.replicas[0], { outbox, notices: [notice] });
  return stepsVector(name, { device: base, limits: { PUSH_MAX_BYTES: limit }, steps: [{ op: 'push', deviceNow: 5004 }] });
}

function inStep() {
  const rows = [CARDS[0], row({ t: 'board', id: BOARD, life: ['alive', st(900)], born: st(900), seq: 4 })];
  return new ServerScript({ device: device({ 'self/probe': rows }), server: serverState({ scopes: { 'acct:A/probe': productScope('A') }, rows: { 'acct:A/probe': rows } }) });
}

function folds() {
  const script = () => new ServerScript({ device: device(CLIENT_BEHIND), server: server() });
  return [
    stepsVector('predicted serials and deaths stay local through push and restore confirmed rows on refusal', {
      device: device({ 'self/probe': [
        row({ t: 'run', id: 'run00001', life: ['alive', st(1300, 0, 'srv')], born: st(1300, 0, 'srv'), f: { startedAt: [1300, st(1300, 0, 'srv')] }, seq: 3 }),
        row({ t: 'lap', id: 'lap00001', life: ['alive', st(1400)], born: st(1400), f: { runId: ['run00001', st(1400)], weight: [20, st(1400)] }, v: { no: 1 }, seq: 4 }),
        row({ t: 'lap', id: 'lap00002', life: ['alive', st(1500)], born: st(1500), f: { runId: ['run00001', st(1500)] }, v: { no: 2 }, seq: 5 }),
      ] }),
      steps: [
        commitStep('self/probe', [], { cmd: { name: 'probe.end', args: { runId: 'run00001', endedAt: 6000 } }, predict: [
          { op: 'update', t: 'lap', id: 'lap00001', v: { no: 3 } },
          { op: 'delete', t: 'lap', id: 'lap00002' },
          { op: 'create', t: 'lap', id: 'lap00003', f: { runId: 'run00001', weight: 30 }, v: { no: Number.MAX_SAFE_INTEGER } },
        ] }, 5000),
        { op: 'view', scope: 'self/probe', withHeld: true },
        { op: 'push', deviceNow: 5001 },
        { op: 'pushResponse', deviceNow: 5002, response: { status: 200, body: { as: 'A', epoch: 'ep-1', serverTime: 5002,
          lastN: 1, results: [{ n: 1, s: 'refused', code: 'invalid' }] } } },
        { op: 'view', scope: 'self/probe', withHeld: true },
      ],
    }),
    ...[false, true].map((predicted) => {
      const day = { t: 'day', id: '2026-09-01' };
      const deletion = { op: 'delete', ...day };
      const cmd = { name: 'probe.end', args: { runId: 'run00001', endedAt: 6000 } };
      return stepsVector(`refusal of ${predicted ? 'a predicted' : 'an intent'} death folds commands inheriting its life and keeps independent deltas`, {
        device: device({ 'self/probe': [row({ ...day, life: ['alive', st(1000)], f: { score: [1, st(1000)] }, seq: 1 })] }),
        steps: [
          commitStep('self/probe', predicted ? [] : [deletion], predicted ? { cmd, predict: [deletion] } : undefined, 5000),
          commitStep('self/probe', [{ op: 'put', t: 'day', id: '2026-09-02', f: { score: 9 } }], { cmd, predict: [{ op: 'put', ...day, f: { score: 2 } }] }, 5001),
          commitStep('self/probe', [], { cmd, predict: [{ op: 'put', ...day, f: { score: 3 } }] }, 5002),
          { op: 'view', scope: 'self/probe', withHeld: true },
          { op: 'push', deviceNow: 5003, limit: 1 },
          { op: 'pushResponse', deviceNow: 5004, response: { status: 200, body: { as: 'A', epoch: 'ep-1', serverTime: 5004,
            lastN: 1, results: [{ n: 1, s: 'refused', code: 'invalid' }] } } },
          { op: 'view', scope: 'self/probe', withHeld: true },
          { op: 'push', deviceNow: 5005, limit: 1 },
        ],
      });
    }),
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
    script()
      .add(commitStep('self/probe', [newCard('card0009')], undefined, 5000))
      .pushRound({ deviceNow: 5001 })
      .add({ op: 'dismiss', id: 'notice:g1/0' })
      .vector('a dismissed notice is kept, hidden'),
    inStep()
      .add(commitStep('self/probe', [newCard('card0009')], { hold: true, gestureId: 'held' }, 5000))
      .add(commitStep('self/probe', [{ op: 'update', t: 'card', id: 'card0009', f: { title: 'Renamed' } }], undefined, 5001))
      .add(commitStep('self/probe', [{ op: 'update', t: 'card', id: 'card0001', f: { title: 'Guarded' } }], { guard: [{ t: 'card', id: 'card0009', field: 'title' }] }, 5002))
      .add({ op: 'undo', gestureId: 'held' })
      .pushRound({ deviceNow: 5003 })
      .vector('a guard on a register a held-back update of a held create wrote names its stamp: the undo empties the update, and the guarding entry is refused stale'),
    inStep()
      .add(commitStep('self/probe', [tooLong('card0009')], undefined, 5000))
      .add(commitStep('self/probe', [{ op: 'update', t: 'card', id: 'card0009', f: { title: 'Fixed' } }, newCard('card0010')], { atomic: true }, 5001))
      .push(5002)
      .respond({ serverNow: 5003, budget: 1 })
      .add({ op: 'dismiss', id: 'notice:g1/0' })
      .add(commitStep('self/probe', [{ op: 'update', t: 'card', id: 'card0010', f: { title: 'Edited' } }], undefined, 5004))
      .pushRound({ deviceNow: 5005 })
      .vector('content folding into a dismissed notice shows it again: an orphan\'s refusal folds its held-back dependent there'),
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
      .vector('a skewed create that a 409 returned to ready, then a delete of it: recovery moves the delete\'s born with the create\'s life, and both land'),
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
      .vector('a clock-skew restamp gives every entry, another instance\'s included, a fresh tick of the recovering instance'),
    returnedCommand(),
    carriedLife(),
    ...unmovedPredictions(),
  ];
}

// §7.7 step 1.5: a born no unacked entry wrote and no server checked. A start whose receipt names a run
// that is gone is replayed: its `ok` writes nothing, so its map leaves the prediction's born, from a clock
// SKEW fast, in a queued write of the run. Its clock-skew recovery lowers that born to the recovered
// clock's reading, and the write lands on the server's merits. A born whose source is a sent command's
// prediction, or which is at or below admittedHigh, stays.
function unmovedPredictions() {
  const start = (id, deviceNow) => commitStep('self/probe', [], {
    cmd: { name: 'probe.start', args: { id, startedAt: deviceNow, join: true } },
    predict: [{ op: 'create', t: 'run', id, f: { startedAt: deviceNow } }],
  }, deviceNow);
  const replayed = () => new ServerScript({
    device: device(CLIENT_PROBE),
    server: serverState({
      scopes: { 'acct:A/probe': productScope('A') },
      rows: { 'acct:A/probe': CLIENT_PROBE['self/probe'] },
      productState: { receipts: { 'acct:A/probe': { run00009: 'run00009' } } },
    }),
  });
  const afterReplay = (change) => replayed()
    .add(start('run00009', skewed(5000)))
    .push(skewed(5000))
    .add(commitStep('self/probe', [change], undefined, skewed(5001)))
    .respond({ serverNow: 5000, tRecv: skewed(5002) })
    .pushRound({ deviceNow: skewed(5003), serverNow: 5010, tRecv: skewed(5004) })
    .pushRound({ deviceNow: skewed(5005), serverNow: 5020, tRecv: skewed(5006) });
  const srv = st(5003, 0, 'srv');
  const run = row({ t: 'run', id: 'run00009', life: ['alive', srv], born: srv, f: { startedAt: [5003, srv] }, seq: 5 });
  const withRun = { 'self/probe': [...CLIENT_PROBE['self/probe'], run] };
  return [
    afterReplay({ op: 'delete', t: 'run', id: 'run00009' })
      .vector('a start replayed onto a run that is gone writes nothing, leaving its skewed predicted born in a queued delete: the delete\'s clock-skew recovery lowers that born to the recovered clock, and the delete lands'),
    afterReplay({ op: 'update', t: 'run', id: 'run00009', f: { label: 'Late' } })
      .vector('an update left with a replayed start\'s skewed born recovers the same way, then is refused unknown-record with its notice'),
    new ServerScript({ device: device(CLIENT_PROBE), server: server() })
      .add(commitStep('self/probe', [{ op: 'update', t: 'card', id: 'card0001', f: { title: 'Skewed' } }], undefined, skewed(5000)))
      .add(start('run00009', skewed(5000)))
      .add(commitStep('self/probe', [{ op: 'update', t: 'run', id: 'run00009', f: { label: 'Mine' } }], undefined, skewed(5001)))
      .push(skewed(5002))
      .respond({ serverNow: 5000, tRecv: skewed(5003) })
      .pushRound({ deviceNow: skewed(5004), serverNow: 5010, tRecv: skewed(5005) })
      .vector('recovery leaves a born whose source is a sent command\'s prediction: the start\'s map then moves it to the server\'s born, and the update of the run lands'),
    new ServerScript({
      device: device(withRun, { admittedHigh: srv, hlc: { ms: 5003, counter: 0 } }),
      server: serverState({ scopes: { 'acct:A/probe': productScope('A') }, rows: { 'acct:A/probe': withRun['self/probe'] } }),
    })
      .add(commitStep('self/probe', [{ op: 'update', t: 'card', id: 'card0001', f: { title: 'Skewed' } }], undefined, skewed(5000)))
      .add(commitStep('self/probe', [{ op: 'update', t: 'run', id: 'run00009', f: { label: 'Mine' } }], undefined, skewed(5000)))
      .pushRound({ deviceNow: skewed(5001), serverNow: 5000, tRecv: skewed(5002) })
      .pushRound({ deviceNow: skewed(5003), serverNow: 5010, tRecv: skewed(5004) })
      .vector('recovery leaves a born at or below admittedHigh: the update of a confirmed run keeps the server\'s born though the recovered clock reads the same pair, and lands'),
  ];
}

// An acked start whose map set its prediction to the server's born comes back ready (an epoch change);
// a skewed entry before it is recovered: the prediction is not restamped and a later update keeps the
// server's born.
function returnedCommand() {
  const skewedIntent = { scope: 'self/probe', d: [{ t: 'card', id: 'card0001', born: st(1001), f: { title: ['Skewed', st(skewed(5000))] } }], gestureId: 'g1', n: 1 };
  const srv = st(5003, 0, 'srv');
  const entries = [
    { localId: 'g1/0', gestureId: 'g1', lineage: 'A', scope: 'self/probe', state: 'sent', commitOrder: 1, releaseAt: 0, stamp: st(skewed(5000)), intent: skewedIntent, n: 1, digest: intentDigest(skewedIntent) },
    {
      localId: 'g2/0', gestureId: 'g2', lineage: 'A', scope: 'self/probe', state: 'ready', commitOrder: 2, releaseAt: 0, stamp: st(5001),
      intent: { scope: 'self/probe', cmd: { name: 'probe.start', args: { id: 'run00009', startedAt: 5001, join: true } }, gestureId: 'g2' },
      predict: [{ t: 'run', id: 'run00009', born: srv, life: ['alive', srv], f: { startedAt: [5001, srv] } }],
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
        response: { status: 200, body: { serverTime: 5005, epoch: 'ep-1', as: 'A', lastN: 1, results: [{ n: 1, s: 'refused', code: 'clock-skew' }], retry: { n: 2, retryAfterMs: 0 } } },
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

// Transport outcomes of §7.4 and §7.5: status codes on push, offsets from every response, re-identify,
// an epoch change, and process deaths between result batches.
function restoredDeletes() {
  return ['pull', 'gap', 'success'].map((first) => {
    const empty = (epoch) => serverState({ epoch, scopes: { 'acct:A/probe': productScope('A') } });
    const script = new ServerScript({ device: device(), server: empty('ep-1') })
      .withIds(['rp_00000000000000000000000000000002', 'rp_00000000000000000000000000000003'])
      .withActors(['r_cccccccccccc', 'r_dddddddddddd', 'r_eeeeeeeeeeee'])
      .add(commitStep('self/probe', [newCard('card0001'), newCard('card0002')], undefined, 5000))
      .pushRound({ deviceNow: 5001 })
      .add(commitStep('self/probe', [{ op: 'update', t: 'card', id: 'card0001', f: { title: 'Edited' } }], undefined, 5002))
      .add(commitStep('self/probe', [{ op: 'delete', t: 'card', id: 'card0002' }], undefined, 5003))
      .add(commitStep('self/probe', [newCard('card0003')], undefined, 5004));
    script.server = new ServerState(empty('ep-2'));
    if (first === 'success') script.add({ op: 'reidentify', deviceNow: 5005 });
    if (first === 'pull') script.pullRound({ deviceNow: 5010, scopes: ['self/probe'] });
    else script.pushRound({ deviceNow: 5010 });
    const recovered = runSteps(script.input).device.replicas[0];
    assert.equal(recovered.meta.serverEpoch, 'ep-2', `${first}: learn the restore before retrying`);
    assert.deepEqual(recovered.outbox.map(({ state }) => state), Array(5).fill('ready'), `${first}: retain every owed intent`);
    script.add({ op: 'engineStart', deviceNow: 5011 }).pushRound({ deviceNow: 5020 })
      .pullRound({ deviceNow: 5030, scopes: ['self/probe'] });
    const vector = script.vector(`restore learned from ${first} replays acknowledged creates before offline edits and deletes, across restart`);
    const final = vector.expect.device.replicas[0];
    assert.deepEqual(final.outbox ?? [], []);
    assert.deepEqual(final.notices ?? [], []);
    assert.deepEqual(final.confirmed['self/probe'].map(({ id, f }) => [id, f.title[0]]), [['card0001', 'Edited'], ['card0003', 'Fourth']]);
    return vector;
  });
}

function restoredCommands() {
  return ['pull', 'gap', 'success'].map((first) => {
    const empty = (epoch) => serverState({ epoch, scopes: { 'acct:A/probe': productScope('A') } });
    const script = new ServerScript({ device: device(), server: empty('ep-1') })
      .withIds(['rp_00000000000000000000000000000002', 'rp_00000000000000000000000000000003'])
      .withActors(['r_cccccccccccc', 'r_dddddddddddd'])
      .add(commitStep('self/probe', [], {
        cmd: { name: 'probe.start', args: { id: 'run00009', startedAt: 5000, join: true } },
        predict: [{ op: 'create', t: 'run', id: 'run00009', f: { startedAt: 5000 } }],
      }, 5000))
      .pushRound({ deviceNow: 5001 })
      .add(commitStep('self/probe', [{ op: 'update', t: 'run', id: 'run00009', f: { label: 'Edited' } }], undefined, 5002))
      .add(commitStep('self/probe', [{ op: 'delete', t: 'run', id: 'run00009' }], undefined, 5003));
    script.server = new ServerState(empty('ep-2'));
    if (first === 'success') script.add({ op: 'reidentify', deviceNow: 5005 });
    if (first === 'pull') script.pullRound({ deviceNow: 5010, scopes: ['self/probe'] });
    else script.pushRound({ deviceNow: 5010 });
    script.pushRound({ deviceNow: 5020 });
    if (first !== 'success') script.pushRound({ deviceNow: 5030 });
    script.pullRound({ deviceNow: 5040, scopes: ['self/probe'] });
    const vector = script.vector(first === 'success'
      ? 'restore learned from success preserves the already admitted command delete and folds its replayed create into a notice'
      : `restore learned from ${first} maps a replayed command's new born into its pending edit and delete`);
    const final = vector.expect.device.replicas[0];
    assert.deepEqual(final.outbox ?? [], []);
    if (first === 'success') assert.equal(final.notices[0].code, 'id-spent');
    else assert.deepEqual(final.notices ?? [], []);
    assert.deepEqual(final.confirmed?.['self/probe'] ?? [], []);
    return vector;
  });
}

function restoredOtherReplica() {
  const empty = (epoch) => serverState({ epoch, scopes: { 'acct:A/probe': productScope('A') } });
  const secondId = 'rp_00000000000000000000000000000002';
  const a = new ServerScript({ device: device(), server: empty('ep-1') })
    .withIds(['rp_00000000000000000000000000000003']).withActors(['r_cccccccccccc'])
    .add(commitStep('self/probe', [newCard('card0001')], undefined, 5000))
    .pushRound({ deviceNow: 5001 });
  const b = new ServerScript({ device: settle({ active: secondId, replicas: [{ meta: freshMeta(secondId, 'bound', 'A') }] }), server: a.server.toJSON() })
    .withIds(['rp_00000000000000000000000000000004']).withActors(['r_dddddddddddd'])
    .pullRound({ deviceNow: 5002, scopes: ['self/probe'] })
    .add(commitStep('self/probe', [{ op: 'delete', t: 'card', id: 'card0001' }], undefined, 5003));
  b.server = new ServerState(empty('ep-2'));
  b.pushRound({ deviceNow: 5010 })
    .pullRound({ deviceNow: 5012, scopes: ['self/probe'] });
  a.server = b.server;
  a.pullRound({ deviceNow: 5020, scopes: ['self/probe'] }).pushRound({ deviceNow: 5021 })
    .pullRound({ deviceNow: 5022, scopes: ['self/probe'] });
  b.server = a.server;
  b.pullRound({ deviceNow: 5023, scopes: ['self/probe'] });
  return [a, b].map((script, index) => {
    const vector = script.vector(`another replica's post-restore delete precedes the replayed create: ${index === 0 ? 'creator' : 'deleter'} stays deleted`);
    const final = vector.expect.device.replicas[0];
    assert.deepEqual(final.outbox ?? [], []);
    assert.deepEqual(final.notices ?? [], []);
    assert.deepEqual(final.confirmed?.['self/probe'] ?? [], []);
    return vector;
  });
}

function restoredUnpredictedCommand() {
  const empty = (epoch) => serverState({ epoch, scopes: { 'acct:A/probe': productScope('A') } });
  const script = new ServerScript({ device: device(), server: empty('ep-1') })
    .withIds(['rp_00000000000000000000000000000002']).withActors(['r_cccccccccccc'])
    .add(commitStep('self/probe', [], { cmd: { name: 'probe.start', args: { id: 'run00009', startedAt: 5000, join: true } } }, 5000))
    .pushRound({ deviceNow: 5001 })
    .add(commitStep('self/probe', [newCard('card0001')], undefined, 5002))
    .pushRound({ deviceNow: 5003 })
    .pullRound({ deviceNow: 5004, scopes: ['self/probe'], limits: { ...CONSTANTS, PULL_PAGE_BYTES: 1 } })
    .add(commitStep('self/probe', [{ op: 'delete', t: 'run', id: 'run00009' }], undefined, 5005));
  script.server = new ServerState(empty('ep-2'));
  script.pushRound({ deviceNow: 5010 }).pushRound({ deviceNow: 5011 }).pushRound({ deviceNow: 5012 })
    .pullRound({ deviceNow: 5013, scopes: ['self/probe'] });
  const vector = script.vector('restore with an unpredicted command and a partial boot maps the retained target into its delete');
  const final = vector.expect.device.replicas[0];
  assert.deepEqual(final.outbox ?? [], []);
  assert.deepEqual(final.notices ?? [], []);
  assert.equal(final.confirmed['self/probe'].some((row) => row.t === 'run'), false);
  return [vector];
}

function conflictEnvelopes() {
  const prepared = runSteps({ device: device(), steps: [
    commitStep('self/probe', [newCard('card0001')], undefined, 5000),
    { op: 'push', deviceNow: 5001 },
    { op: 'pushResponse', deviceNow: 5001, response: { status: 200, body: { as: 'A', epoch: 'ep-1', serverTime: 5001,
      lastN: 1, results: [{ n: 1, s: 'ok', seq: 1 }] } } },
    commitStep('self/probe', [{ op: 'delete', t: 'card', id: 'card0001' }], undefined, 5002),
  ] });
  return [
    ['missing epoch', { epoch: undefined }], ['empty epoch', { epoch: '' }], ['non-string epoch', { epoch: 2 }],
    ['negative time', { serverTime: -1 }], ['missing time', { serverTime: undefined }],
    ['unknown conflict', { error: 'unknown' }],
    ['other principal', { as: 'B' }], ['account mismatch', { error: 'account-mismatch' }],
  ].map(([name, changes]) => {
    const body = { as: 'A', epoch: 'ep-2', serverTime: 5010, error: 'gap', ...changes };
    for (const key of Object.keys(body)) if (body[key] === undefined) delete body[key];
    const vector = stepsVector(`a gap with ${name} cannot reset the epoch or lose an acknowledged create and its pending delete`, {
      device: prepared.device,
      steps: [{ op: 'push', deviceNow: 5003 }, { op: 'pushResponse', deviceNow: 5010, response: { status: 409, body } }],
    });
    const replica = vector.expect.device.replicas[0];
    assert.equal(replica.meta.serverEpoch, 'ep-1');
    assert.deepEqual(replica.outbox.map(({ state }) => state), ['acked', 'sent']);
    assert.deepEqual(vector.expect.returns.at(-1), name === 'other principal' || name === 'account mismatch' ? null : { throws: true });
    return vector;
  });
}

function restoredJoinedDeletes() {
  return ['pull', 'gap'].flatMap((first) => ['predicted', 'legacy', 'unpredicted', 'retained-target'].map((mode) => {
    const scope = 'self/probe';
    const empty = (epoch) => serverState({ epoch, scopes: { 'acct:A/probe': productScope('A') } });
    const script = new ServerScript({ device: device(), server: serverState({
      scopes: { 'acct:A/probe': productScope('A') },
      rows: { 'acct:A/probe': [
        row({ t: 'run', id: 'run00001', born: st(1300, 0, 'srv'), life: ['alive', st(1300, 0, 'srv')], f: { startedAt: [1300, st(1300, 0, 'srv')] }, seq: 1 }),
        row({ t: 'card', id: 'card0001', born: st(1400), life: ['alive', st(1400)], f: { title: ['Other', st(1400)] }, seq: 2 }),
      ] },
    }) }).withIds(['rp_00000000000000000000000000000002']).withActors(['r_cccccccccccc', 'r_dddddddddddd'])
      .add(commitStep(scope, [], { cmd: { name: 'probe.start', args: { id: 'run00002', startedAt: 5000, join: true } },
        ...(mode === 'unpredicted' ? {} : { predict: [{ op: 'create', t: 'run', id: 'run00002', f: { startedAt: 5000 } }] }) }, 5000))
      .pushRound({ deviceNow: 5001 });
    const backup = script.server.toJSON();
    script.add(commitStep(scope, [], { cmd: { name: 'probe.start', args: { id: 'run00003', startedAt: 5001, join: true } },
      ...(mode === 'unpredicted' ? {} : { predict: [{ op: 'create', t: 'run', id: 'run00003', f: { startedAt: 5001 } }] }) }, 5001))
      .pushRound({ deviceNow: 5002 });
    if (mode === 'unpredicted') script.pullRound({ deviceNow: 5002, scopes: [scope], limits: { ...CONSTANTS, PULL_PAGE_BYTES: 1 } });
    script.add(commitStep(scope, [{ op: 'delete', t: 'run', id: 'run00001' }], undefined, 5003));
    if (mode === 'legacy') {
      script.input.device = runSteps(script.input).device;
      for (const entry of script.input.device.replicas[0].outbox) delete entry.writeTargets;
      script.input.steps = [];
    }
    script.server = new ServerState(mode === 'retained-target' ? { ...backup, epoch: 'ep-2' } : empty('ep-2'));
    if (first === 'pull') script.pullRound({ deviceNow: 5010, scopes: [scope] });
    else script.pushRound({ deviceNow: 5010 });
    script.add({ op: 'engineStart', deviceNow: 5011 }).pushRound({ deviceNow: 5020 }).pushRound({ deviceNow: 5030 });
    const replay = runSteps(script.input).returns.filter((result) => result?.intents).at(-1);
    assert.equal(replay.intents[0].cmd.args.id, mode === 'retained-target' ? 'run00001' : 'run00002',
      'later joined commands must reuse the first recovered target rather than recreate their own aliases');
    script.pushRound({ deviceNow: 5040 }).pullRound({ deviceNow: 5050, scopes: [scope] });
    const vector = script.vector(`${mode} joined commands share their replay target before its delete after a ${first} restore`);
    const final = vector.expect.device.replicas[0];
    assert.deepEqual(final.outbox ?? [], []);
    assert.deepEqual(final.notices ?? [], []);
    assert.deepEqual((final.confirmed?.[scope] ?? []).filter((row) => row.t === 'run'), [], 'the joined session must stay deleted after replay');
    return vector;
  }));
}

function acceptedRestoreResult() {
  const run = row({ t: 'run', id: 'run00001', born: st(1300, 0, 'srv'), life: ['alive', st(1300, 0, 'srv')], f: { startedAt: [1300, st(1300, 0, 'srv')] }, seq: 1 });
  const vector = stepsVector('a successful changed-epoch command with no old acknowledgements stays accepted across restart', {
    device: device({ 'self/probe': [run] }), ids: ['rp_00000000000000000000000000000002'], actors: ['r_cccccccccccc', 'r_dddddddddddd'],
    steps: [commitStep('self/probe', [], { cmd: { name: 'probe.end', args: { runId: 'run00001', endedAt: 5000 } },
      predict: [{ op: 'delete', t: 'run', id: 'run00001' }] }, 5000),
    { op: 'push', deviceNow: 5001 },
    { op: 'pushResponse', deviceNow: 5002, response: { status: 200, body: { as: 'A', epoch: 'ep-2', serverTime: 5002, lastN: 1, results: [{ n: 1, s: 'ok', seq: 2, write: [] }] } } },
    { op: 'engineStart', deviceNow: 5003 }, { op: 'push', deviceNow: 5004 }],
  });
  const final = vector.expect.device.replicas[0];
  assert.equal(final.outbox[0].state, 'acked', 'a known successful removal must not become a fresh command');
  assert.equal(final.outbox[0].resultEpoch, 'ep-2');
  assert.deepEqual(vector.expect.returns.at(-1), null);
  assert.deepEqual(final.notices ?? [], []);
  return [vector];
}

function transports() {
  const at = (serverTime) => ({ serverTime, epoch: 'ep-1', as: 'A' });
  const rename = (id, title, deviceNow) => commitStep('self/probe', [{ op: 'update', t: 'card', id, f: { title } }], undefined, deviceNow);
  const answer = (status, body, deviceNow) => ({ op: 'pushResponse', deviceNow, tSend: deviceNow - 10, tRecv: deviceNow, response: { status, body } });
  const base = () => device(CLIENT_PROBE);
  const reading = (wall, mono, boot = 'boot-1') => ({ wall, mono, boot });
  const hello = (deviceNow, send, recv, serverTime) => ({ op: 'hello', deviceNow, send, recv, response: { status: 200, body: { ...at(serverTime), schema: 2, minSchema: 2 } } });
  // A replica that has never heard the server's epoch pushes three creates, and dies after the first
  // result; the server is then restored from a backup taken before the push, under a new epoch.
  const empty = (epoch) => serverState({ epoch, scopes: { 'acct:A/probe': productScope('A') } });
  const unknownEpoch = new ServerScript({ device: device(), server: empty('ep-1') })
    .withIds(['rp_00000000000000000000000000000002'])
    .withActors(['r_cccccccccccc', 'r_dddddddddddd'])
    .add(...['card0001', 'card0002', 'card0003'].map((id, k) => commitStep('self/probe', [newCard(id)], undefined, 5000 + k)))
    .push(5003)
    .respond({ serverNow: 5010, dieAfter: 1 })
    .add({ op: 'engineStart', deviceNow: 5020 });
  unknownEpoch.server = new ServerState(empty('ep-2'));
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
      steps: [rename('card0001', 'One', 5000), { op: 'push', deviceNow: 5000 }, answer(401, { ...at(8020), as: null, error: 'unauthenticated' }, 5030), { op: 'push', deviceNow: 5040 }],
    }),
    stepsVector('a 409 served as another account is a 401: the sender pauses and keeps its replica id', {
      device: base(),
      steps: [rename('card0001', 'One', 5000), { op: 'push', deviceNow: 5000 }, answer(409, { ...at(8020), as: 'B', error: 'replica-foreign' }, 5030), { op: 'push', deviceNow: 5040 }],
    }),
    stepsVector('a 409 account-mismatch pauses the sender and changes nothing: the push named the replica\'s account under another\'s credential', {
      device: base(),
      steps: [rename('card0001', 'One', 5000), { op: 'push', deviceNow: 5000 }, answer(409, { ...at(8020), as: 'B', error: 'account-mismatch' }, 5030), { op: 'push', deviceNow: 5040 }],
    }),
    stepsVector('a 200 served as another account is a 401: the sender pauses and records none of its results', {
      device: base(),
      steps: [rename('card0001', 'One', 5000), { op: 'push', deviceNow: 5000 }, answer(200, { ...at(5010), as: 'B', lastN: 1, results: [{ n: 1, s: 'ok', seq: 5 }] }, 5030), { op: 'push', deviceNow: 5040 }],
    }),
    stepsVector('a hello served as anonymous pauses a bound replica and still takes an offset sample', {
      device: base(),
      steps: [{ op: 'hello', deviceNow: 5030, tSend: 5010, tRecv: 5030, response: { status: 200, body: { ...at(9020), as: null, schema: 2, minSchema: 2 } } }],
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
      steps: [{ op: 'hello', deviceNow: 5030, tSend: 5010, tRecv: 5030, response: { status: 200, body: { ...at(9020), schema: 2, minSchema: 2 } } }],
    }),
    stepsVector('re-identify mints a replica id, restarts n at 1 and returns sent entries to ready, and the instance takes a new actor', {
      device: base(),
      ids: ['rp_00000000000000000000000000000002'],
      actors: ['r_cccccccccccc'],
      steps: [rename('card0001', 'One', 5000), rename('card0002', 'Two', 5001), { op: 'push', deviceNow: 5002 }, { op: 'reidentify', deviceNow: 5003 }, { op: 'push', deviceNow: 5004 }],
    }),
    new ServerScript({ device: base(), server: server() })
      .withActors(['r_cccccccccccc'])
      .add(rename('card0001', 'One', 5000), rename('card0002', 'Two', 5001), rename('card0003', 'Three', 5002))
      .push(5003)
      .respond({ serverNow: 5010, dieAfter: 1 })
      .add({ op: 'engineStart', deviceNow: 5020 })
      .pushRound({ deviceNow: 5030 })
      .vector('a process death between result batches keeps the results recorded; the rest stay sent and ackThrough holds, and the resend is answered from the stored results'),
    unknownEpoch.pullRound({ deviceNow: 5030, scopes: ['self/probe'] })
      .pushRound({ deviceNow: 5040 })
      .vector('a replica with no epoch takes the answer\'s in its first result batch: after a death between batches, a pull from a restored server of another epoch changes epoch, and the entry acked before the restore returns to ready and is sent again'),
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
    'refusal/fold.json': [
      ...folds(),
      outgrownOrphan('an orphan that outgrew a request alone ends without a notice of its own, and its held-back dependent folds into the origin\'s notice', [
        [{ t: 'card', id: 'card0010', born: st(5002), f: { title: ['Tenth', st(5003)] } }],
      ]),
      outgrownOrphan('the refusal of an outgrown orphan frees what it held back: a partly dependent entry keeps its own part, and an entry held back behind it is numbered in the same push', [
        [{ t: 'card', id: 'card0010', born: st(5002), f: { title: ['Tenth', st(5003)] } }, { t: 'card', id: 'card0001', born: st(1001), f: { title: ['Uno', st(5003)] } }],
        [{ t: 'card', id: 'card0001', born: st(1001), f: { tier: ['done', st(5004)] } }],
      ]),
    ],
    'refusal/restamp.json': restamps(),
    'refusal/base-unknown.json': baseUnknowns(),
    'refusal/transport.json': [...transports(), ...restoredDeletes(), ...restoredCommands(), ...restoredOtherReplica(), ...restoredUnpredictedCommand(), ...conflictEnvelopes(), ...acceptedRestoreResult(), ...restoredJoinedDeletes()],
  };
}
