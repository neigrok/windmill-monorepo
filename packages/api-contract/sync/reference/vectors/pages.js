// pull/pages.json (§7.5, client): pull responses and live frames applied to a replica: boots straight in
// or through staging, stale pages, reset, gone and not-found, replace by seq, the resolution of acked
// entries, the digest check, frames and the epoch change. Responses come from the reference server,
// except the few edge cases no correct server produces (an older row, a wrong digest).

import { CONSTANTS } from '../core/constants.js';
import { scopeDigest } from '../core/digest.js';
import { Cursor, intentDigest } from '../core/wire.js';
import { freshMeta } from '../client/replica.js';
import { pull } from '../server/pull.js';
import { push } from '../server/push.js';
import { ServerState } from '../server/state.js';
import { overlayScope, product, productScope, registry, row, serverState, st, treeScope } from './fixtures.js';
import { runSteps, stepsVector } from './steps.js';

const REPLICA = 'rp_00000000000000000000000000000001';
const OTHER_REPLICA = 'rp_00000000000000000000000000000099';
const BOARD = 'b_00000001';
const TREE = `tree/${BOARD}`;
const SMALL_PAGES = { ...CONSTANTS, PULL_PAGE_BYTES: 400 };

const CARDS = [1, 2, 3].map((k) => row({ t: 'card', id: `card000${k}`, life: ['alive', st(1000 + k)], born: st(1000 + k), f: { title: [`Card ${k}`, st(1000 + k)] }, seq: k }));
const BOARD_ROW = row({ t: 'board', id: BOARD, life: ['alive', st(900)], born: st(900), seq: 4 });
const TREE_ROWS = [
  row({ t: 'meta', id: 'meta', f: { title: ['Plan', st(1000)] }, seq: 1 }),
  row({ t: 'tag', id: 'oak', life: ['alive', st(1000)], born: st(1000), f: { label: ['Oak', st(1000)] }, seq: 2 }),
  row({ t: 'tag', id: 'elm', life: ['dead', st(1500)], born: st(1100), f: { label: ['Elm', st(1100)] }, seq: 3 }),
  row({ t: 'link', id: ['oak', 'elm'], life: ['alive', st(1000)], seq: 4 }),
];

function server({ treeState = 'alive', epoch = 'ep-1' } = {}) {
  return serverState({
    epoch,
    scopes: {
      'acct:A/probe': productScope('A'),
      'acct:B/probe': productScope('B'),
      [`tree:${BOARD}`]: treeScope('A', BOARD, treeState === 'dead' ? { state: 'dead', deadAt: 4000 } : {}),
      'tree:b_0000000b': treeScope('B', 'b_0000000b'),
      [`acct:A/overlay/${BOARD}`]: overlayScope('A', BOARD, treeState === 'dead' ? { state: 'dead', deadAt: 4000 } : {}),
    },
    rows: {
      'acct:A/probe': [...CARDS, BOARD_ROW],
      'acct:B/probe': [row({ t: 'board', id: 'b_0000000b', life: ['alive', st(900, 0, 'r_cccccccccccc')], born: st(900, 0, 'r_cccccccccccc'), seq: 1 })],
      [`tree:${BOARD}`]: TREE_ROWS,
    },
  });
}

function device(extra = {}) {
  const { meta, ...rest } = extra;
  return { active: REPLICA, replicas: [{ meta: { ...freshMeta(REPLICA, 'bound', 'A'), ...meta }, ...rest }] };
}

// Client steps interleaved with the reference server. `respond` answers the last pull (or push) step.
class PullScript {
  constructor({ device: start, server: state }) {
    this.input = { device: start, ids: [], steps: [] };
    this.server = new ServerState(state);
    this.frames = [];
  }

  add(...steps) {
    this.input.steps.push(...steps);
    return this;
  }

  lastRequest(op) {
    const index = this.input.steps.map((step) => step.op).lastIndexOf(op);
    return { index, request: runSteps(this.input).returns[index] };
  }

  pull(scopes, deviceNow) {
    return this.add({ op: 'pull', scopes, deviceNow });
  }

  respond({ serverNow, limits = CONSTANTS, edit = (response) => response }) {
    const { index, request } = this.lastRequest('pull');
    const response = edit(pull({ state: this.server, registry, account: 'A', request, serverNow, limits }));
    return this.add({ op: 'pullResponse', response, tSend: this.input.steps[index].deviceNow, tRecv: serverNow, deviceNow: serverNow });
  }

  pullRound(scopes, { serverNow, limits, edit }) {
    return this.pull(scopes, serverNow).respond({ serverNow, limits, edit });
  }

  pushRound(deviceNow) {
    this.add({ op: 'push', deviceNow });
    const { request } = this.lastRequest('push');
    const out = push({ state: this.server, registry, product, account: 'A', request, serverNow: deviceNow });
    this.server = out.state;
    return this.add({ op: 'pushResponse', response: out.response, deviceNow, tSend: deviceNow, tRecv: deviceNow });
  }

  // A write by another replica of A; its live frames are kept for `frame` steps.
  elsewhere(intents, serverNow) {
    const request = { replica: OTHER_REPLICA, ackThrough: 0, intents: intents.map((intent, k) => ({ ...intent, n: (this.otherN ?? 0) + k + 1 })) };
    this.otherN = (this.otherN ?? 0) + intents.length;
    const out = push({ state: this.server, registry, product, account: 'A', request, serverNow });
    this.server = out.state;
    this.frames.push(...out.frames.map((entry) => entry.frame));
    return this;
  }

  vector(name) {
    return stepsVector(name, this.input);
  }
}

const bootedOnProbe = () => new PullScript({ device: device(), server: server() }).pullRound(['self/probe'], { serverNow: 5000 });

// An acked entry as a sender leaves it: numbered, digested, with its result's seq and epoch.
function acked(n, id, resultSeq) {
  const intent = { scope: 'self/probe', d: [{ t: 'card', id, born: CARDS.find((card) => card.id === id).born, f: { title: ['Acked', st(4000 + n)] } }], gestureId: `sent${n}`, n };
  return { localId: `sent${n}/0`, gestureId: `sent${n}`, lineage: 'A', scope: 'self/probe', state: 'acked', commitOrder: n, releaseAt: 0, stamp: st(4000 + n), intent, n, digest: intentDigest(intent), resultSeq, resultEpoch: 'ep-1' };
}

const titleOf = (id, title, stamp) => ({ scope: 'self/probe', d: [{ t: 'card', id, born: CARDS.find((card) => card.id === id).born, f: { title: [title, stamp] } }] });

function boots() {
  const staleRows = [
    row({ t: 'card', id: 'card0001', life: ['alive', st(1001)], born: st(1001), f: { title: ['Old title', st(900)] }, seq: 1 }),
    row({ t: 'card', id: 'card0009', life: ['alive', st(950)], born: st(950), f: { title: ['Gone since', st(950)] }, seq: 2 }),
  ];
  const reboot = () => new PullScript({
    device: device({ confirmed: { 'self/probe': staleRows }, cursors: { 'self/probe': { cursor: null, digest: scopeDigest(staleRows), booted: true } } }),
    server: server(),
  });
  return [
    bootedOnProbe().vector('a first boot goes straight into confirmed, turns the cursor live and checks the digest'),
    new PullScript({ device: device(), server: server() })
      .pullRound([TREE], { serverNow: 5000 })
      .vector('a boot records a thin dead derived row as a spent id and keeps it out of confirmed'),
    reboot()
      .pullRound(['self/probe'], { serverNow: 5000, limits: SMALL_PAGES })
      .vector('a boot over confirmed rows fills staging and leaves confirmed as it was'),
    reboot()
      .pullRound(['self/probe'], { serverNow: 5000, limits: SMALL_PAGES })
      .pullRound(['self/probe'], { serverNow: 5001, limits: SMALL_PAGES })
      .vector('staging replaces the confirmed rows and their digest when the boot cursor turns live'),
    new PullScript({ device: device({ outbox: [] }), server: server() })
      .pull(['self/probe'], 5000)
      .respond({ serverNow: 5000 })
      .add({ op: 'pullResponse', response: pull({ state: new ServerState(server()), registry, account: 'A', request: { scopes: [{ scope: 'self/probe', cursor: null }] }, serverNow: 5000 }), tSend: 5000, tRecv: 5000, deviceNow: 5000 })
      .vector('a page requested under an older cursor is dropped as stale'),
  ];
}

function answers() {
  const ahead = Cursor.encode({ e: 'ep-1', m: 'live', s: 99 });
  const gone = new PullScript({ device: device(), server: server() })
    .pullRound(['self/probe', TREE], { serverNow: 5000 })
    .add({ op: 'commit', scope: TREE, changes: [{ op: 'write', t: 'meta', id: 'meta', f: { title: 'Plan B' } }], deviceNow: 5001 })
    .pushRound(5002)
    .add({ op: 'commit', scope: TREE, changes: [{ op: 'write', t: 'meta', id: 'meta', f: { title: 'Plan C' } }], deviceNow: 5003 })
    .elsewhere([{ scope: 'self/probe', d: [{ t: 'board', id: BOARD, born: BOARD_ROW.born, life: ['dead', st(5004, 0, 'r_cccccccccccc')] }] }], 5004)
    .pullRound([TREE], { serverNow: 5005 });
  return [
    new PullScript({ device: device({ confirmed: { 'self/probe': CARDS }, cursors: { 'self/probe': { cursor: ahead, digest: scopeDigest(CARDS), booted: true } } }), server: server() })
      .pullRound(['self/probe'], { serverNow: 5000 })
      .vector('reset sets the cursor to null and keeps the confirmed rows for the next boot'),
    gone.vector('gone forgets the scope and resolves its acked entries; its pending entries stay'),
    new PullScript({ device: device(), server: server() })
      .pullRound(['tree/b_0000000b'], { serverNow: 5000 })
      .vector('not-found marks the scope known not-found'),
  ];
}

function lives() {
  const changed = bootedOnProbe()
    .elsewhere([
      titleOf('card0002', 'Two, edited', st(5001, 0, 'r_cccccccccccc')),
      { scope: 'self/probe', d: [{ t: 'card', id: 'card0003', born: CARDS[2].born, life: ['dead', st(5002, 0, 'r_cccccccccccc')] }] },
      { scope: 'self/probe', d: [{ t: 'card', id: 'card0004', born: st(5003, 0, 'r_cccccccccccc'), life: ['alive', st(5003, 0, 'r_cccccccccccc')], f: { title: ['Four', st(5003, 0, 'r_cccccccccccc')] } }] },
    ], 5003)
    .pullRound(['self/probe'], { serverNow: 5004 });

  const newer = row({ t: 'card', id: 'card0001', life: ['alive', st(1001)], born: st(1001), f: { title: ['Newer', st(4000)] }, seq: 7 });
  const older = row({ t: 'card', id: 'card0001', life: ['alive', st(1001)], born: st(1001), f: { title: ['Older', st(3000)] }, seq: 6 });
  const card2 = row({ t: 'card', id: 'card0002', life: ['alive', st(1002)], born: st(1002), f: { title: ['Two at 8', st(4100)] }, seq: 8 });
  const held = [newer];
  const ignored = new PullScript({
    device: device({ meta: { serverEpoch: 'ep-1' }, confirmed: { 'self/probe': held }, cursors: { 'self/probe': { cursor: Cursor.encode({ e: 'ep-1', m: 'live', s: 7 }), digest: scopeDigest(held), booted: true } } }),
    server: server(),
  })
    .pull(['self/probe'], 6000)
    .add({
      op: 'pullResponse',
      tSend: 6000,
      tRecv: 6000,
      deviceNow: 6000,
      response: { status: 200, body: { serverTime: 6000, epoch: 'ep-1', pages: [{ scope: 'self/probe', kind: 'rows', rows: [older, card2], cursor: Cursor.encode({ e: 'ep-1', m: 'live', s: 8 }), more: false, seq: 8, digest: scopeDigest([newer, card2]) }] } },
    });

  const clean = () => bootedOnProbe()
    .add({ op: 'commit', scope: 'self/probe', changes: [{ op: 'update', t: 'card', id: 'card0003', f: { title: 'Mine' } }], deviceNow: 5001 })
    .pushRound(5001)
    .add({ op: 'commit', scope: 'self/probe', changes: [
      { op: 'update', t: 'card', id: 'card0001', f: { title: 'One, both' } },
      { op: 'update', t: 'card', id: 'card0002', f: { title: 'Two, both' } },
    ], opts: { atomic: true }, deviceNow: 5002 })
    .pushRound(5002)
    .pullRound(['self/probe'], { serverNow: 5003, limits: { ...CONSTANTS, PULL_PAGE_BYTES: 150 } })
    .pullRound(['self/probe'], { serverNow: 5004, limits: { ...CONSTANTS, PULL_PAGE_BYTES: 150 } });
  return [
    changed.vector('live rows replace confirmed rows, a dead row deletes and a new row enters'),
    ignored.vector('a live row older than the confirmed row is ignored; a newer one replaces'),
    clean().vector('a page ending inside a seq resolves acked entries only through the seq before it'),
    clean().pullRound(['self/probe'], { serverNow: 5005, limits: { ...CONSTANTS, PULL_PAGE_BYTES: 150 } })
      .vector('the page that finishes the seq resolves the rest'),
    new PullScript({ device: device({ meta: { serverEpoch: 'ep-1', nextN: 3, ackThrough: 2 }, outbox: [acked(1, 'card0001', 3), acked(2, 'card0002', 5)] }), server: server() })
      .pullRound(['self/probe'], { serverNow: 5000 })
      .vector('a boot that ends resolves acked entries through its asOf'),
  ];
}

function digests() {
  const tampered = [row({ t: 'card', id: 'card0001', life: ['alive', st(1001)], born: st(1001), f: { title: ['Tampered', st(1001)] }, seq: 1 }), CARDS[1], CARDS[2], BOARD_ROW];
  const atHead = Cursor.encode({ e: 'ep-1', m: 'live', s: 4 });
  const drifted = () => new PullScript({
    device: device({ meta: { serverEpoch: 'ep-1' }, confirmed: { 'self/probe': tampered }, cursors: { 'self/probe': { cursor: atHead, digest: scopeDigest(tampered), booted: true } } }),
    server: server(),
  });
  const wrong = (response) => ({ ...response, body: { ...response.body, pages: response.body.pages.map((page) => ({ ...page, digest: 'f'.repeat(64) })) } });
  return [
    drifted().pullRound(['self/probe'], { serverNow: 5000 })
      .vector('a digest mismatch at the head emits telemetry and resets the scope'),
    drifted().pullRound(['self/probe'], { serverNow: 5000 }).pullRound(['self/probe'], { serverNow: 5001 })
      .vector('the boot after a mismatch reset restores the rows and its check matches'),
    drifted().pullRound(['self/probe'], { serverNow: 5000 }).pullRound(['self/probe'], { serverNow: 5001, edit: wrong })
      .vector('a mismatch on the first check after a mismatch reset stops checks at this app version'),
    drifted().pullRound(['self/probe'], { serverNow: 5000 }).pullRound(['self/probe'], { serverNow: 5001, edit: wrong })
      .pullRound(['self/probe'], { serverNow: 5002, edit: wrong })
      .add({ op: 'pull', scopes: ['self/probe'], deviceNow: 5003, appVersion: '2' })
      .add({
        op: 'pullResponse',
        appVersion: '2',
        tSend: 5003,
        tRecv: 5003,
        deviceNow: 5003,
        response: { status: 200, body: { serverTime: 5003, epoch: 'ep-1', pages: [{ scope: 'self/probe', kind: 'rows', rows: [], cursor: atHead, more: false, seq: 4, digest: 'f'.repeat(64) }] } },
      })
      .vector('stopped checks skip at the same app version and resume at a new one'),
  ];
}

function frames() {
  const framed = () => bootedOnProbe().elsewhere([titleOf('card0002', 'Two, live', st(5001, 0, 'r_cccccccccccc'))], 5001);
  const next = (script) => script.frames[0];
  const build = (edit, name) => {
    const script = framed();
    return script.add({ op: 'frame', frame: edit(next(script)), deviceNow: 5002 }).vector(name);
  };
  return [
    build((frame) => frame, 'the next frame with rows applies inline and checks the digest'),
    build((frame) => ({ ...frame, seq: frame.seq + 1 }), 'a frame past the next seq asks for a pull'),
    build(({ rows, ...frame }) => frame, 'a frame without rows asks for a pull'),
    build((frame) => ({ ...frame, epoch: 'ep-2' }), 'a frame of another epoch asks for a pull'),
    bootedOnProbe().pullRound([TREE], { serverNow: 5000 })
      .add({ op: 'frame', frame: { op: 'gone', scope: TREE }, deviceNow: 5002 })
      .vector('a gone frame forgets the scope'),
  ];
}

function epochs() {
  const restored = bootedOnProbe()
    .add({ op: 'commit', scope: 'self/probe', changes: [{ op: 'update', t: 'card', id: 'card0001', f: { title: 'Acked' } }], deviceNow: 5001 })
    .pushRound(5001)
    .add({ op: 'commit', scope: 'self/probe', changes: [{ op: 'update', t: 'card', id: 'card0002', f: { title: 'Waiting' } }], deviceNow: 5002 });
  restored.server = new ServerState(server({ epoch: 'ep-2' }));
  restored.input.ids = ['rp_00000000000000000000000000000002'];
  return [
    restored.pullRound(['self/probe'], { serverNow: 5003 })
      .vector('a response of a new epoch changes epoch first, and its pages, requested under old cursors, are stale'),
  ];
}

export function files() {
  return { 'pull/pages.json': [...boots(), ...answers(), ...lives(), ...digests(), ...frames(), ...epochs()] };
}
