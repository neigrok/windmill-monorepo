// coalesce/*.json (§7.2): when a ready plain intent joins the last earlier entry on its record.
// A create joined with a delete cancels only when the earlier entry made the record alive (a create or
// a revive); an update joined with a delete keeps the delete.

import { freshMeta } from '../client/replica.js';
import { OTHER, row, st } from './fixtures.js';
import { settle, stepsVector } from './steps.js';

const REPLICA = 'rp_00000000000000000000000000000001';
const BOARD = 'b_00000001';
const TREE = `tree/${BOARD}`;
const OVERLAY = `self/overlay/${BOARD}`;

function device(confirmed = {}) {
  return settle({ active: REPLICA, replicas: [{ meta: freshMeta(REPLICA, 'bound', 'A'), confirmed }] });
}

function commitStep(scope, changes, opts, deviceNow, actor) {
  const step = { op: 'commit', scope, changes, deviceNow };
  if (opts) step.opts = opts;
  if (actor) step.actor = actor;
  return step;
}

const CARD = row({ t: 'card', id: 'card0001', life: ['alive', st(1000)], born: st(1000), f: { tier: ['review', st(1000)], title: ['One', st(1000)] }, seq: 1 });
const CARD2 = row({ t: 'card', id: 'card0002', life: ['alive', st(1100)], born: st(1100), f: { title: ['Two', st(1100)] }, seq: 2 });
const RUN = row({ t: 'run', id: 'run00001', life: ['alive', st(1300, 0, 'srv')], born: st(1300, 0, 'srv'), f: { startedAt: [1300, st(1300, 0, 'srv')] }, seq: 3 });
const PROBE = { 'self/probe': [CARD, CARD2, RUN] };
const MARK = row({ t: 'mark', id: 'oak', f: { done: [false, st(1000)] }, x: { memo: { text: 'first draft', rev: 7, merged: false } }, seq: 7 });
const TREE_ROWS = [row({ t: 'tag', id: 'oak', life: ['alive', st(1000)], born: st(1000), f: { label: ['Oak', st(1000)] }, seq: 4 })];

const update = (id, f) => ({ op: 'update', t: 'card', id, f });

function joins() {
  return [
    stepsVector('two ready updates of one record join into the first entry', {
      device: device(PROBE),
      steps: [commitStep('self/probe', [update('card0001', { title: 'Uno' })], undefined, 5000), commitStep('self/probe', [update('card0001', { tier: 'done' })], undefined, 5001)],
    }),
    stepsVector('a field written twice keeps the later write', {
      device: device(PROBE),
      steps: [commitStep('self/probe', [update('card0001', { title: 'Uno' })], undefined, 5000), commitStep('self/probe', [update('card0001', { title: 'Eins' })], undefined, 5001)],
    }),
    stepsVector('an update joins into the ready create of its record', {
      device: device(),
      steps: [
        commitStep('self/probe', [{ op: 'create', t: 'card', id: 'card0009', f: { title: 'New' } }], undefined, 5000),
        commitStep('self/probe', [update('card0009', { tier: 'draft' })], undefined, 5001),
      ],
    }),
    stepsVector('text from one engine instance joins; the entry keeps its base and base text and takes the new text', {
      device: device({ [OVERLAY]: [MARK] }),
      steps: [
        commitStep(OVERLAY, [{ op: 'write', t: 'mark', id: 'oak', x: { memo: 'second draft' } }], undefined, 5000),
        commitStep(OVERLAY, [{ op: 'write', t: 'mark', id: 'oak', x: { memo: 'third draft' } }], undefined, 5001),
      ],
    }),
    stepsVector('a first text joining an entry without text brings its base and base text', {
      device: device({ [OVERLAY]: [MARK] }),
      steps: [
        commitStep(OVERLAY, [{ op: 'write', t: 'mark', id: 'oak', f: { done: true } }], undefined, 5000),
        commitStep(OVERLAY, [{ op: 'write', t: 'mark', id: 'oak', x: { memo: 'second draft' } }], undefined, 5001),
      ],
    }),
    stepsVector('a keyed put that adds then a put that removes join to one dead put, kept', {
      device: device(),
      steps: [
        commitStep(TREE, [{ op: 'put', t: 'link', id: ['oak', 'elm'] }], undefined, 5000),
        commitStep(TREE, [{ op: 'put', t: 'link', id: ['oak', 'elm'], present: false }], undefined, 5001),
      ],
    }),
  ];
}

function blocked() {
  return [
    stepsVector('an entry already sent takes no join', {
      device: device(PROBE),
      steps: [
        commitStep('self/probe', [update('card0001', { title: 'Uno' })], undefined, 5000),
        { op: 'push', deviceNow: 5000 },
        commitStep('self/probe', [update('card0001', { tier: 'done' })], undefined, 5001),
      ],
    }),
    stepsVector('a command entry of the scope between the two blocks the join', {
      device: device(PROBE),
      steps: [
        commitStep('self/probe', [update('card0001', { title: 'Uno' })], undefined, 5000),
        commitStep('self/probe', [], { cmd: { name: 'probe.end', args: { runId: 'run00001', endedAt: 4000 } }, predict: [{ op: 'update', t: 'run', id: 'run00001', f: { endedAt: 4000 } }] }, 5001),
        commitStep('self/probe', [update('card0001', { tier: 'done' })], undefined, 5002),
      ],
    }),
    stepsVector('text from two engine instances does not join', {
      device: device({ [OVERLAY]: [MARK] }),
      steps: [
        commitStep(OVERLAY, [{ op: 'write', t: 'mark', id: 'oak', x: { memo: 'second draft' } }], undefined, 5000),
        commitStep(OVERLAY, [{ op: 'write', t: 'mark', id: 'oak', x: { memo: 'third draft' } }], undefined, 5001, OTHER),
      ],
    }),
    stepsVector('non-text writes from two engine instances join', {
      device: device(PROBE),
      steps: [
        commitStep('self/probe', [update('card0001', { title: 'Uno' })], undefined, 5000),
        commitStep('self/probe', [update('card0001', { tier: 'done' })], undefined, 5001, OTHER),
      ],
    }),
    stepsVector('a guarded intent is not plain and does not join', {
      device: device(PROBE),
      steps: [
        commitStep('self/probe', [update('card0001', { title: 'Uno' })], undefined, 5000),
        commitStep('self/probe', [update('card0001', { tier: 'done' })], { guard: [{ t: 'card', id: 'card0001', field: 'tier' }] }, 5001),
      ],
    }),
    stepsVector('a guarded earlier entry is not plain and takes no join', {
      device: device(PROBE),
      steps: [
        commitStep('self/probe', [update('card0001', { title: 'Uno' })], { guard: [{ t: 'card', id: 'card0001', field: 'title' }] }, 5000),
        commitStep('self/probe', [update('card0001', { tier: 'done' })], undefined, 5001),
      ],
    }),
    stepsVector('an atomic entry over two records is not plain and takes no join', {
      device: device(PROBE),
      steps: [
        commitStep('self/probe', [update('card0001', { title: 'Uno' }), update('card0002', { title: 'Dos' })], { atomic: true }, 5000),
        commitStep('self/probe', [update('card0001', { tier: 'done' })], undefined, 5001),
      ],
    }),
    stepsVector('a held earlier entry takes no join', {
      device: device(PROBE),
      steps: [
        commitStep('self/probe', [update('card0001', { title: 'Uno' })], { hold: true }, 5000),
        commitStep('self/probe', [update('card0001', { tier: 'done' })], undefined, 5001),
      ],
    }),
    stepsVector('a command entry predicting the record is the last entry touching it and takes no join', {
      device: device(PROBE),
      steps: [
        commitStep('self/probe', [], {
          cmd: { name: 'probe.start', args: { id: 'run00009', startedAt: 5000, join: true } },
          predict: [{ op: 'create', t: 'run', id: 'run00009', f: { startedAt: 5000 } }],
        }, 5000),
        commitStep('self/probe', [{ op: 'update', t: 'run', id: 'run00009', f: { label: 'Late' } }], undefined, 5001),
      ],
    }),
  ];
}

const BOARD_ROW = row({ t: 'board', id: BOARD, life: ['alive', st(900)], born: st(900), seq: 1 });
const ELM = row({ t: 'tag', id: 'elm', life: ['alive', st(950)], born: st(950), f: { label: ['Elm', st(950)] }, seq: 1 });

function cancels() {
  return [
    stepsVector('a cancelled board takes its tree and overlay writes with it, silently: each ends coalesced by cancel', {
      device: device({ 'self/probe': [CARD] }),
      steps: [
        commitStep('self/probe', [{ op: 'create', t: 'board', id: 'b_00000002' }], undefined, 5000),
        commitStep('tree/b_00000002', [{ op: 'write', t: 'meta', id: 'meta', f: { title: 'Plan' } }], undefined, 5001),
        commitStep('tree/b_00000002', [{ op: 'create', t: 'tag', label: 'First step' }], undefined, 5002),
        commitStep('self/overlay/b_00000002', [{ op: 'write', t: 'mark', id: 'first-step', f: { done: true } }], undefined, 5003),
        commitStep('self/probe', [{ op: 'delete', t: 'board', id: 'b_00000002' }], { hold: true }, 5004),
        { op: 'releaseAll', deviceNow: 14004 },
      ],
    }),
    stepsVector('a cancelled tag takes the link keyed by it and the mark on it with it, silently', {
      device: device({ 'self/probe': [BOARD_ROW], [TREE]: [ELM] }),
      steps: [
        commitStep(TREE, [{ op: 'create', t: 'tag', id: 'oak', f: { label: 'Oak' } }], undefined, 5000),
        commitStep(TREE, [{ op: 'put', t: 'link', id: ['oak', 'elm'], f: { strength: 3 } }], undefined, 5001),
        commitStep(OVERLAY, [{ op: 'write', t: 'mark', id: 'oak', x: { memo: 'look here' } }], undefined, 5002),
        commitStep(TREE, [{ op: 'delete', t: 'tag', id: 'oak' }], { hold: true }, 5003),
        { op: 'releaseAll', deviceNow: 14003 },
      ],
    }),
    stepsVector('a cancel removes only the dependent part of an entry: its independent deltas stay ready', {
      device: device({ 'self/probe': [BOARD_ROW], [TREE]: [ELM] }),
      steps: [
        commitStep(TREE, [{ op: 'create', t: 'tag', id: 'oak', f: { label: 'Oak' } }], undefined, 5000),
        commitStep(TREE, [{ op: 'put', t: 'link', id: ['oak', 'elm'] }, { op: 'update', t: 'tag', id: 'elm', f: { label: 'Elm tree' } }], { atomic: true }, 5001),
        commitStep(TREE, [{ op: 'delete', t: 'tag', id: 'oak' }], { hold: true }, 5002),
        { op: 'releaseAll', deviceNow: 14002 },
      ],
    }),
    stepsVector('a cancel leaves a sent dependent as it is', {
      device: device({ 'self/probe': [BOARD_ROW], [TREE]: [ELM] }),
      steps: [
        commitStep(TREE, [{ op: 'create', t: 'tag', id: 'oak', f: { label: 'Oak' } }], { hold: true }, 5000),
        commitStep(TREE, [{ op: 'put', t: 'link', id: ['oak', 'elm'] }], undefined, 5001),
        { op: 'push', deviceNow: 5002 },
        { op: 'release', localId: 'g1/0', deviceNow: 5003 },
        commitStep(TREE, [{ op: 'delete', t: 'tag', id: 'oak' }], undefined, 5004),
      ],
    }),
    stepsVector('a create and a delete of the same record, both unsent, cancel', {
      device: device(),
      steps: [
        commitStep('self/probe', [{ op: 'create', t: 'card', id: 'card0009', f: { title: 'Brief' } }], undefined, 5000),
        commitStep('self/probe', [{ op: 'delete', t: 'card', id: 'card0009' }], undefined, 5001),
      ],
    }),
    stepsVector('a create returned to ready by an epoch change is never cancelled: a later delete joins it and is still sent', {
      device: device(),
      ids: ['rp_00000000000000000000000000000002'],
      actors: ['r_cccccccccccc'],
      steps: [
        commitStep('self/probe', [{ op: 'create', t: 'card', id: 'card0009', f: { title: 'Kept' } }], undefined, 5000),
        { op: 'push', deviceNow: 5000 },
        { op: 'pushResponse', deviceNow: 5001, response: { status: 200, body: { serverTime: 5001, epoch: 'ep-1', lastN: 1, results: [{ n: 1, s: 'ok', seq: 4 }] } } },
        { op: 'epochChange', epoch: 'ep-2', deviceNow: 5002 },
        commitStep('self/probe', [{ op: 'delete', t: 'card', id: 'card0009' }], undefined, 5003),
        { op: 'push', deviceNow: 5004 },
      ],
    }),
    stepsVector('a held delete released onto its ready create cancels both', {
      device: device(),
      steps: [
        commitStep('self/probe', [{ op: 'create', t: 'card', id: 'card0009', f: { title: 'Brief' } }], undefined, 5000),
        commitStep('self/probe', [update('card0009', { tier: 'draft' })], undefined, 5001),
        commitStep('self/probe', [{ op: 'delete', t: 'card', id: 'card0009' }], { hold: true }, 5002),
        { op: 'releaseAll', deviceNow: 14002 },
      ],
    }),
    stepsVector('an update and a delete of an existing record join and keep the delete', {
      device: device(PROBE),
      steps: [
        commitStep('self/probe', [update('card0001', { title: 'Uno' })], undefined, 5000),
        commitStep('self/probe', [{ op: 'delete', t: 'card', id: 'card0001' }], { hold: true }, 5001),
        { op: 'releaseAll', deviceNow: 14001 },
      ],
    }),
    stepsVector('a revive and a delete of a spent record, both unsent, cancel', {
      device: settle({
        active: REPLICA,
        replicas: [{ meta: freshMeta(REPLICA, 'bound', 'A'), confirmed: { [TREE]: TREE_ROWS }, spentIds: { [TREE]: [{ t: 'tag', id: 'elm', born: st(1000) }] } }],
      }),
      steps: [
        commitStep(TREE, [{ op: 'revive', t: 'tag', id: 'elm' }], undefined, 5000),
        commitStep(TREE, [{ op: 'delete', t: 'tag', id: 'elm' }], undefined, 5001),
      ],
    }),
  ];
}

export function files() {
  return {
    'coalesce/join.json': joins(),
    'coalesce/blocked.json': blocked(),
    'coalesce/cancel.json': cancels(),
  };
}
