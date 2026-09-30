// pull/pages.json (§7.5, client): pull responses and live frames applied to a replica: boots straight in
// or through staging, stale pages, reset, gone and not-found, replace by seq, the settling of acked
// entries, the digest check, frames, the epoch change, and pages applied in chunks and settled in slices
// with a process death between two of them. Responses come from the reference server,
// except the few edge cases no correct server produces (an older row, a wrong digest).

import { CONSTANTS } from '../core/constants.js';
import { scopeDigest } from '../core/digest.js';
import { Cursor, intentDigest } from '../core/wire.js';
import { freshMeta } from '../client/replica.js';
import { frameFor, pull } from '../server/pull.js';
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

  // Answers the last pull, served as `account` (§9.1): null for a request that arrives with no credential,
  // or, with `credential: 'unresolved'`, one whose credential resolves to no account. `chunk` applies its
  // rows pages in chunks of that many rows, `settle` resolves that many covered entries a settling
  // transaction, and `dieAfter` ends the process after that many page transactions (§7.5 step 2).
  respond({ serverNow, limits = CONSTANTS, edit = (response) => response, account = 'A', credential, chunk, settle, dieAfter }) {
    const { index, request } = this.lastRequest('pull');
    const pulled = pull({ state: this.server, registry, product, account, credential, request, serverNow, limits });
    this.server = pulled.state;
    const response = edit(pulled.response);
    const cut = { ...(chunk === undefined ? {} : { chunk }), ...(settle === undefined ? {} : { settle }), ...(dieAfter === undefined ? {} : { dieAfter }) };
    return this.add({ op: 'pullResponse', response, tSend: this.input.steps[index].deviceNow, tRecv: serverNow, deviceNow: serverNow, ...cut });
  }

  pullRound(scopes, { serverNow, limits, edit, account, credential, chunk, settle, dieAfter }) {
    return this.pull(scopes, serverNow).respond({ serverNow, limits, edit, account, credential, chunk, settle, dieAfter });
  }

  // A push the server admits whose answer never reaches the device.
  pushLost(deviceNow) {
    this.add({ op: 'push', deviceNow });
    const { request } = this.lastRequest('push');
    this.server = push({ state: this.server, registry, product, account: 'A', request, serverNow: deviceNow }).state;
    return this;
  }

  // A push whose own change frame reaches the device before the response does.
  pushFrameFirst(deviceNow) {
    this.add({ op: 'push', deviceNow });
    const { request } = this.lastRequest('push');
    const out = push({ state: this.server, registry, product, account: 'A', request, serverNow: deviceNow });
    this.server = out.state;
    return this.add(
      ...out.frames.map((event) => ({ op: 'frame', frame: frameFor(this.server, event, 'A'), deviceNow })),
      { op: 'pushResponse', response: out.response, deviceNow, tSend: deviceNow, tRecv: deviceNow },
    );
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
    const request = { replica: OTHER_REPLICA, account: 'A', ackThrough: 0, intents: intents.map((intent, k) => ({ ...intent, n: (this.otherN ?? 0) + k + 1 })) };
    this.otherN = (this.otherN ?? 0) + intents.length;
    const out = push({ state: this.server, registry, product, account: 'A', request, serverNow });
    this.server = out.state;
    this.frames.push(...out.frames.map((event) => frameFor(this.server, event, 'A')));
    return this;
  }

  vector(name) {
    return stepsVector(name, this.input);
  }
}

const bootedOnProbe = () => new PullScript({ device: device(), server: server() }).pullRound(['self/probe'], { serverNow: 5000 });

// A pull of a new board's tree leaves before the board is committed, and the server answers it
// not-found; the board's create is pushed and acked, and only then does that answer land.
function lateNotFound() {
  const script = bootedOnProbe().pull(['tree/b_00000002'], 5001);
  const early = pull({ state: script.server, registry, product, account: 'A', request: script.lastRequest('pull').request, serverNow: 5001 }).response;
  return script
    .add({ op: 'commit', scope: 'self/probe', changes: [{ op: 'create', t: 'board', id: 'b_00000002' }], deviceNow: 5002 })
    .pushRound(5003)
    .add({ op: 'pullResponse', response: early, tSend: 5001, tRecv: 5004, deviceNow: 5004 })
    .add({ op: 'commit', scope: 'tree/b_00000002', changes: [{ op: 'write', t: 'meta', id: 'meta', f: { title: 'Plan' } }], deviceNow: 5005 });
}

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
      .add({ op: 'pullResponse', response: pull({ state: new ServerState(server()), registry, product, account: 'A', request: { scopes: [{ scope: 'self/probe', cursor: null }] }, serverNow: 5000 }).response, tSend: 5000, tRecv: 5000, deviceNow: 5000 })
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
      response: { status: 200, body: { serverTime: 6000, epoch: 'ep-1', as: 'A', pages: [{ scope: 'self/probe', kind: 'rows', rows: [older, card2], cursor: Cursor.encode({ e: 'ep-1', m: 'live', s: 8 }), more: false, seq: 8, digest: scopeDigest([newer, card2]) }] } },
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
    bootedOnProbe()
      .add({ op: 'commit', scope: 'self/probe', changes: [{ op: 'create', t: 'board', id: 'b_00000002' }], deviceNow: 5001 })
      .pullRound(['self/probe', 'tree/b_00000002'], { serverNow: 5002 })
      .pushRound(5003)
      .pullRound(['tree/b_00000002'], { serverNow: 5004 })
      .vector('a tree whose board create is still in the outbox is not pulled; once the create has its result, the tree boots'),
    bootedOnProbe()
      .add({ op: 'commit', scope: 'self/probe', changes: [{ op: 'create', t: 'board', id: 'b_00000002' }], deviceNow: 5001 })
      .add({ op: 'frame', frame: { op: 'not-found', as: 'A', scope: 'tree/b_00000002' }, deviceNow: 5002 })
      .add({ op: 'commit', scope: 'tree/b_00000002', changes: [{ op: 'write', t: 'meta', id: 'meta', f: { title: 'Plan' } }], deviceNow: 5003 })
      .pull(['tree/b_00000002'], 5004)
      .pushRound(5005)
      .pullRound(['tree/b_00000002'], { serverNow: 5006 })
      .add({ op: 'commit', scope: 'tree/b_00000002', changes: [{ op: 'write', t: 'meta', id: 'meta', f: { title: 'Plan B' } }], deviceNow: 5007 })
      .vector('a not-found frame for a tree whose board create is still in the outbox is ignored: commits into it are accepted, a pull of it alone sends nothing, and it boots once the create has its result'),
    lateNotFound().vector('a not-found the server wrote before the board\'s create, landing after the create is acked, is ignored: commits into the tree are accepted'),
    bootedOnProbe()
      .add({ op: 'commit', scope: 'self/probe', changes: [{ op: 'create', t: 'board', id: 'b_00000002' }], deviceNow: 5001 })
      .pushRound(5002)
      .add({ op: 'frame', frame: { op: 'not-found', as: 'A', scope: 'tree/b_00000002' }, deviceNow: 5003 })
      .add({ op: 'frame', frame: { op: 'not-found', as: 'A', scope: 'self/overlay/b_00000002' }, deviceNow: 5003 })
      .add({ op: 'commit', scope: 'tree/b_00000002', changes: [{ op: 'write', t: 'meta', id: 'meta', f: { title: 'Plan' } }], deviceNow: 5004 })
      .vector('not-found frames for a tree and its overlay whose board create is acked are ignored: commits into the tree are accepted'),
    bootedOnProbe()
      .add({ op: 'frame', frame: { op: 'not-found', as: 'A', scope: TREE }, deviceNow: 5001 })
      .add({ op: 'commit', scope: TREE, changes: [{ op: 'write', t: 'meta', id: 'meta', f: { title: 'Plan' } }], deviceNow: 5002 })
      .vector('a not-found frame for a tree whose board is confirmed alive is ignored: the replica holds the board, so the answer is stale'),
    bootedOnProbe()
      .add({ op: 'commit', scope: 'self/probe', changes: [{ op: 'delete', t: 'board', id: BOARD }], opts: { hold: true }, deviceNow: 5001 })
      .add({ op: 'frame', frame: { op: 'not-found', as: 'A', scope: TREE }, deviceNow: 5002 })
      .vector('a not-found frame for a tree whose board has a held delete waiting is ignored: the board is dead in drawn but alive in stored'),
    bootedOnProbe()
      .add({ op: 'commit', scope: 'self/probe', changes: [{ op: 'update', t: 'card', id: 'card0003', f: { title: 'Mine' } }], deviceNow: 5001 })
      .pushFrameFirst(5001)
      .vector('an ok whose seq the frame before it already applied resolves in its own transaction'),
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
        response: { status: 200, body: { serverTime: 5003, epoch: 'ep-1', as: 'A', pages: [{ scope: 'self/probe', kind: 'rows', rows: [], cursor: atHead, more: false, seq: 4, digest: 'f'.repeat(64) }] } },
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
  const knownTree = new PullScript({ device: device({ meta: { serverEpoch: 'ep-1' }, known: { [TREE]: 'not-found' } }), server: server() })
    .add({ op: 'subscribe', scope: TREE })
    .add({ op: 'commit', scope: TREE, changes: [{ op: 'write', t: 'meta', id: 'meta', f: { title: 'Reopened' } }], deviceNow: 5001 })
    .pullRound([TREE], { serverNow: 5002 });
  const goneTree = new PullScript({ device: device({ meta: { serverEpoch: 'ep-1' }, known: { [TREE]: 'gone' } }), server: server({ treeState: 'dead' }) })
    .add({ op: 'subscribe', scope: TREE })
    .add({ op: 'commit', scope: TREE, changes: [{ op: 'write', t: 'meta', id: 'meta', f: { title: 'Reopened' } }], deviceNow: 5001 });
  const productEnd = (kind) => (response) => ({ ...response, body: { ...response.body, pages: response.body.pages.map((page) => ({ scope: page.scope, kind })) } });
  return [
    bootedOnProbe().pullRound([TREE], { serverNow: 5001 }).pullRound([TREE], { serverNow: 5002, account: null, credential: 'unresolved' })
      .vector('a tree pulled alone under a credential that resolves to no account is answered 401: the replica pauses and forgets nothing'),
    bootedOnProbe().pullRound(['self/probe'], { serverNow: 5001, edit: productEnd('not-found') })
      .vector('a not-found page for a product scope is ignored: its rows and cursor stay, and nothing is recorded known'),
    bootedOnProbe().add({ op: 'frame', frame: { op: 'gone', as: 'A', scope: 'self/probe' }, deviceNow: 5001 })
      .vector('a gone frame for a product scope is ignored'),
    knownTree.vector('a subscribe clears a known scope: a commit to it is accepted, and its first pull boots it'),
    goneTree.vector('a subscribe to a scope known gone answers gone and keeps the record: its death is final, so a commit to it refuses scope-dead'),
    build((frame) => frame, 'the next frame with rows applies inline and checks the digest'),
    build((frame) => ({ ...frame, seq: frame.seq + 1 }), 'a frame past the next seq asks for a pull'),
    build(({ rows, ...frame }) => frame, 'a frame without rows asks for a pull'),
    build((frame) => ({ ...frame, epoch: 'ep-2' }), 'a frame of another epoch asks for a pull'),
    build((frame) => ({ ...frame, as: null }), 'a change frame served as anonymous is a 401: sync pauses and the frame applies nothing'),
    build((frame) => ({ ...frame, as: 'B' }), 'a change frame served as another account is a 401: sync pauses and the frame applies nothing'),
    bootedOnProbe().pullRound([TREE], { serverNow: 5000 })
      .add({ op: 'frame', frame: { op: 'gone', as: 'A', scope: TREE }, deviceNow: 5002 })
      .vector('a gone frame forgets the scope'),
  ];
}

// §9.1 the principal an answer is served as. A bound replica of A holds its product scope, its own
// private board's tree, B's public board, and its marks on that board. A request that arrives with no
// credential (a cleared cookie, a stripping proxy) is served as anonymous, and one carrying another
// account's credential (another tab signed in as B) is served as B: either answer is a 401 to the
// replica, so sync pauses, and nothing is applied or forgotten.
function principals() {
  const PUBLIC = 'b_0000000b';
  const MARKED = `self/overlay/${PUBLIC}`;
  const B_ACTOR = 'r_cccccccccccc';
  const shared = serverState({
    scopes: {
      'acct:A/probe': productScope('A'),
      'acct:B/probe': productScope('B'),
      [`tree:${BOARD}`]: treeScope('A', BOARD),
      [`tree:${PUBLIC}`]: treeScope('B', PUBLIC),
      [`acct:A/overlay/${PUBLIC}`]: overlayScope('A', PUBLIC),
    },
    rows: {
      'acct:A/probe': [...CARDS, BOARD_ROW],
      'acct:B/probe': [row({ t: 'board', id: PUBLIC, life: ['alive', st(900, 0, B_ACTOR)], born: st(900, 0, B_ACTOR), seq: 1 })],
      [`tree:${BOARD}`]: TREE_ROWS,
      [`tree:${PUBLIC}`]: [
        row({ t: 'meta', id: 'meta', f: { visibility: ['public', st(950, 0, 'srv')] }, seq: 1 }),
        row({ t: 'tag', id: 'ash', life: ['alive', st(960, 0, B_ACTOR)], born: st(960, 0, B_ACTOR), f: { label: ['Ash', st(960, 0, B_ACTOR)] }, seq: 2 }),
      ],
      [`acct:A/overlay/${PUBLIC}`]: [row({ t: 'mark', id: 'ash', f: { done: [true, st(1200)] }, seq: 1 })],
    },
  });
  const held = [['self/probe', 'its product scope'], [TREE, 'its own private tree'], [MARKED, 'its overlay of a public tree'], [`tree/${PUBLIC}`, 'a public tree']];
  const booted = () => held.reduce((script, [scope], k) => script.pullRound([scope], { serverNow: 5000 + k }), new PullScript({ device: device(), server: shared }));
  return [
    ...held.map(([scope, what]) => booted().pullRound([scope], { serverNow: 5010, account: null })
      .vector(`${what}, pulled alone and served as anonymous, is a 401: sync pauses, and its rows, cursor and known record stay`)),
    booted().pullRound(['self/probe'], { serverNow: 5010, account: 'B' })
      .vector('a pull served as another account is a 401: its page, a reset against that account\'s scope, applies nothing'),
    booted().add(
      { op: 'frame', frame: { op: 'not-found', as: null, scope: TREE }, deviceNow: 5010 },
      { op: 'frame', frame: { op: 'not-found', as: null, scope: MARKED }, deviceNow: 5011 },
    ).vector('not-found frames served as anonymous, as a socket without a credential answers a sub, pause sync and forget nothing'),
  ];
}

// §7.9 an alive governing row arriving clears a not-found record of its tree and overlay: after a
// restore, a replica can learn not-found for a tree whose board another replica's re-sent create
// brings back, and the board row's arrival puts the tree back in the subscription set.
function revivals() {
  const stale = (board) => ({ [`tree/${board}`]: 'not-found', [`self/overlay/${board}`]: 'not-found' });
  const reborn = { scope: 'self/probe', d: [{ t: 'board', id: 'b_00000002', born: st(5001, 0, 'r_cccccccccccc'), life: ['alive', st(5001, 0, 'r_cccccccccccc')] }] };
  const framed = new PullScript({ device: device({ known: stale('b_00000002') }), server: server() })
    .pullRound(['self/probe'], { serverNow: 5000 })
    .elsewhere([reborn], 5001);
  return [
    new PullScript({ device: device({ known: stale(BOARD) }), server: server() })
      .pullRound(['self/probe'], { serverNow: 5000 })
      .pullRound([TREE], { serverNow: 5001 })
      .vector('an alive governing row in a page clears its tree\'s and overlay\'s not-found records, so the tree is subscribed and pulled again'),
    framed.add({ op: 'frame', frame: framed.frames[0], deviceNow: 5002 })
      .vector('an alive governing row in a frame, a create another replica re-sent, clears its tree\'s and overlay\'s not-found records'),
  ];
}

function epochs() {
  const restored = bootedOnProbe()
    .add({ op: 'commit', scope: 'self/probe', changes: [{ op: 'update', t: 'card', id: 'card0001', f: { title: 'Acked' } }], deviceNow: 5001 })
    .pushRound(5001)
    .add({ op: 'commit', scope: 'self/probe', changes: [{ op: 'update', t: 'card', id: 'card0002', f: { title: 'Waiting' } }], deviceNow: 5002 });
  restored.server = new ServerState(server({ epoch: 'ep-2' }));
  restored.input.ids = ['rp_00000000000000000000000000000002'];
  restored.input.actors = ['r_cccccccccccc'];
  return [
    restored.pullRound(['self/probe'], { serverNow: 5003 })
      .vector('a response of a new epoch changes epoch first, and its pages, requested under old cursors, are stale'),
  ];
}

// §7.5 step 2 a rows page in chunks: only the last stores the cursor and does what it decides, so a
// process death between two chunks leaves their rows applied under the cursor as it was, and the page
// pulled again applies to the same end.
function chunks() {
  const edits = [
    titleOf('card0002', 'Two, edited', st(5002, 0, 'r_cccccccccccc')),
    { scope: 'self/probe', d: [{ t: 'card', id: 'card0003', born: CARDS[2].born, life: ['dead', st(5003, 0, 'r_cccccccccccc')] }] },
    { scope: 'self/probe', d: [{ t: 'card', id: 'card0004', born: st(5004, 0, 'r_cccccccccccc'), life: ['alive', st(5004, 0, 'r_cccccccccccc')], f: { title: ['Four', st(5004, 0, 'r_cccccccccccc')] } }] },
  ];
  const mineThenEdits = () => {
    const script = bootedOnProbe()
      .add({ op: 'commit', scope: 'self/probe', changes: [{ op: 'update', t: 'card', id: 'card0001', f: { title: 'Mine' } }], deviceNow: 5001 })
      .pushRound(5001)
      .elsewhere(edits, 5004);
    script.input.actors = ['r_dddddddddddd'];
    return script;
  };
  const view = { op: 'view', scope: 'self/probe', withHeld: true, deviceNow: 5006 };
  const reboot = () => {
    const staleRows = [
      row({ t: 'card', id: 'card0001', life: ['alive', st(1001)], born: st(1001), f: { title: ['Old title', st(900)] }, seq: 1 }),
      row({ t: 'card', id: 'card0009', life: ['alive', st(950)], born: st(950), f: { title: ['Gone since', st(950)] }, seq: 2 }),
    ];
    const script = new PullScript({
      device: device({ confirmed: { 'self/probe': staleRows }, cursors: { 'self/probe': { cursor: null, digest: scopeDigest(staleRows), booted: true } } }),
      server: server(),
    });
    script.input.actors = ['r_dddddddddddd'];
    return script;
  };
  const fresh = () => {
    const script = new PullScript({ device: device(), server: server() });
    script.input.actors = ['r_dddddddddddd'];
    return script;
  };
  const deleteCard1 = [{ scope: 'self/probe', d: [{ t: 'card', id: 'card0001', born: CARDS[0].born, life: ['dead', st(5002, 0, 'r_cccccccccccc')] }] }];
  const relayedLate = bootedOnProbe().elsewhere(edits, 5003);
  relayedLate.input.actors = ['r_dddddddddddd'];
  const late = relayedLate.frames.find((frame) => frame.seq === 5);
  const C = 'r_cccccccccccc';
  const day = (id, score, ms) => ({ scope: 'self/probe', d: [{ t: 'day', id, life: ['alive', st(ms, 0, C)], f: { score: [score, st(ms, 0, C)] } }] });
  const shortOfHead = bootedOnProbe().elsewhere([day('2026-01-01', 1, 5001), day('2026-01-02', 2, 5002), day('2026-01-03', 3, 5003), day('2026-01-01', 4, 5004)], 5004);
  const next = shortOfHead.frames.find((frame) => frame.seq === 7);
  return [
    shortOfHead.pullRound(['self/probe'], { serverNow: 5005, limits: { ...CONSTANTS, PULL_PAGE_BYTES: 1 } })
      .add({ op: 'frame', frame: next, deviceNow: 5006 })
      .pullRound(['self/probe'], { serverNow: 5007 })
      .vector('a live page short of its head leaves the scope behind: the next frame asks for a pull, since a row changed twice is not yet in its state at the cursor, and the pull to the head clears it'),
    relayedLate.pull(['self/probe'], 5005).respond({ serverNow: 5005, chunk: 1, dieAfter: 2 })
      .add({ op: 'engineStart', deviceNow: 5006 })
      .add({ op: 'frame', frame: late, deviceNow: 5007 })
      .pullRound(['self/probe'], { serverNow: 5008 })
      .vector('after a death between chunks the scope is behind: a frame of the next seq, relayed late to a new socket, asks for a pull instead of applying over rows past the cursor'),
    bootedOnProbe().elsewhere(edits, 5003).pullRound(['self/probe'], { serverNow: 5005, chunk: 1 })
      .vector('a live page applied one row a chunk leaves what the page applied whole leaves, and its last chunk checks the digest'),
    mineThenEdits().pull(['self/probe'], 5005).respond({ serverNow: 5005, chunk: 1, dieAfter: 2 }).add(view)
      .vector('a process death between chunks of a live page keeps the rows applied, digest with them, and the cursor where it was; the acked entry the page covers stays acked, and a reader sees the page as if it ended at the last row applied'),
    mineThenEdits().pull(['self/probe'], 5005).respond({ serverNow: 5005, chunk: 1, dieAfter: 2 })
      .add({ op: 'engineStart', deviceNow: 5006 })
      .pullRound(['self/probe'], { serverNow: 5007 })
      .vector('the live page a death cut short, pulled again under the unmoved cursor, applies to the same end: the acked entry resolves and the check matches'),
    fresh().pullRound(['self/probe'], { serverNow: 5000, limits: SMALL_PAGES, chunk: 1, dieAfter: 1 })
      .add({ op: 'engineStart', deviceNow: 5001 })
      .elsewhere(deleteCard1, 5002)
      .pullRound(['self/probe'], { serverNow: 5003, limits: SMALL_PAGES })
      .pullRound(['self/probe'], { serverNow: 5004, limits: SMALL_PAGES })
      .vector('a death in the first page of a boot straight in leaves its rows under a null cursor; the boot pulled again goes into staging, and its swap drops a row deleted since'),
    reboot().pullRound(['self/probe'], { serverNow: 5000, limits: SMALL_PAGES, chunk: 1, dieAfter: 1 })
      .add({ op: 'engineStart', deviceNow: 5001 })
      .elsewhere(deleteCard1, 5002)
      .pullRound(['self/probe'], { serverNow: 5003, limits: SMALL_PAGES })
      .pullRound(['self/probe'], { serverNow: 5004, limits: SMALL_PAGES })
      .vector('a death between chunks of a boot into staging leaves confirmed as it was; the boot pulled again from null starts its staging afresh, so a row deleted since is not swapped in'),
    fresh().pullRound(['self/probe'], { serverNow: 5000, limits: SMALL_PAGES })
      .pullRound(['self/probe'], { serverNow: 5001, limits: SMALL_PAGES, chunk: 1, dieAfter: 1 })
      .add({ op: 'engineStart', deviceNow: 5002 })
      .elsewhere([titleOf('card0003', 'Three, new', st(5003, 0, 'r_cccccccccccc'))], 5003)
      .pullRound(['self/probe'], { serverNow: 5004, limits: SMALL_PAGES })
      .pullRound(['self/probe'], { serverNow: 5005, limits: SMALL_PAGES })
      .vector('a death between chunks of a later boot page keeps the boot cursor; the boot goes on at its asOf, and a row changed since arrives live'),
    fresh().pullRound(['self/probe', TREE], { serverNow: 5000, chunk: 2, dieAfter: 1 })
      .vector('a death that cuts a page short applies none of the pages after it'),
  ];
}

// §7.5 step 2 settling: the entries a stored cursor covers resolve, in commit order, in the transaction
// that stores it and in settling slices after it, so a process death between two slices leaves the rest
// acked and drawn until the scope's next page settles them; an `ok` the cursor covers settles its own
// entry alone. Three puts are acked, and another device deletes the last one's day.
function settling() {
  const C = 'r_cccccccccccc';
  const put = (id, score, deviceNow) => ({ op: 'commit', scope: 'self/probe', changes: [{ op: 'put', t: 'day', id, f: { score } }], deviceNow });
  const deleted = { scope: 'self/probe', d: [{ t: 'day', id: '2026-01-01', life: ['dead', st(5003, 0, C)] }] };
  const view = (deviceNow) => ({ op: 'view', scope: 'self/probe', withHeld: true, deviceNow });
  const threeAcked = () => {
    const script = bootedOnProbe()
      .add(put('2026-01-02', 2, 5001), put('2026-01-03', 3, 5001), put('2026-01-01', 1, 5001))
      .pushRound(5002)
      .elsewhere([deleted], 5003);
    script.input.actors = ['r_dddddddddddd'];
    return script;
  };
  const resentAfterDeath = bootedOnProbe()
    .add(put('2026-01-02', 2, 5001), put('2026-01-03', 3, 5001))
    .pushRound(5002)
    .add(put('2026-01-01', 1, 5003))
    .pushLost(5003);
  resentAfterDeath.input.actors = ['r_dddddddddddd'];
  return [
    threeAcked().pullRound(['self/probe'], { serverNow: 5004, settle: 1 }).add(view(5005))
      .vector('a page that settles one covered entry a transaction resolves them in commit order and ends as a page settled whole'),
    threeAcked().pull(['self/probe'], 5004).respond({ serverNow: 5004, settle: 1, dieAfter: 1 }).add(view(5005))
      .vector('a process death between settling slices keeps the page and the first resolution; the covered entries left stay acked and pending, so the day another device deleted is drawn as the acked put wrote it'),
    threeAcked().pull(['self/probe'], 5004).respond({ serverNow: 5004, settle: 1, dieAfter: 1 })
      .add({ op: 'engineStart', deviceNow: 5005 })
      .pullRound(['self/probe'], { serverNow: 5006 })
      .add(view(5007))
      .vector('the covered entries a death left acked settle in the scope\'s next page, empty at its head, and the deleted day is gone'),
    resentAfterDeath.pull(['self/probe'], 5004).respond({ serverNow: 5004, settle: 1, dieAfter: 1 })
      .add({ op: 'engineStart', deviceNow: 5005 })
      .pushRound(5006)
      .vector('after a death between settling slices, a resent entry\'s ok that the cursor covers resolves its own entry and no other: the entry the death left stays acked for the next page'),
  ];
}

// §7.5 step 2 a page for a scope outside the subscription set applies nothing and pulls nothing again:
// the tree's board dies in a frame while the tree's first pull is in flight, so the tree is known gone
// when its rows page lands, requested with a null cursor that the forgotten scope still matches.
function outside() {
  const script = bootedOnProbe().pull([TREE], 5001);
  const early = pull({ state: script.server, registry, product, account: 'A', request: script.lastRequest('pull').request, serverNow: 5001 }).response;
  script.elsewhere([{ scope: 'self/probe', d: [{ t: 'board', id: BOARD, born: BOARD_ROW.born, life: ['dead', st(5002, 0, 'r_cccccccccccc')] }] }], 5002);
  const death = script.frames.find((frame) => frame.op === 'change' && frame.scope === 'self/probe');
  return [
    script.add({ op: 'frame', frame: death, deviceNow: 5003 })
      .add({ op: 'pullResponse', response: early, tSend: 5001, tRecv: 5004, deviceNow: 5004 })
      .vector('a rows page for a tree whose board died while it was in flight is outside the subscription set: it applies nothing, and the tree stays known gone with no rows and no cursor'),
  ];
}

// §7.9 the subscription set holds a tree per governing record alive in drawn or in stored: inside a held
// delete's window the board is alive in stored, so a not-found for its tree is ignored and a reconcile
// against the replica's own set keeps the tree's rows for an undo to find.
function heldWindow() {
  return [
    bootedOnProbe().pullRound([TREE], { serverNow: 5001 })
      .add({ op: 'commit', scope: 'self/probe', changes: [{ op: 'delete', t: 'board', id: BOARD }], opts: { hold: true }, deviceNow: 5002 })
      .add({ op: 'frame', frame: { op: 'not-found', as: 'A', scope: TREE }, deviceNow: 5003 })
      .add({ op: 'reconcile', deviceNow: 5004 })
      .vector('inside a held delete\'s window the board\'s tree stays in the subscription set: a not-found for it is ignored, and a reconcile keeps its rows'),
  ];
}

// §7.12 a page that arrives for a replica no longer active applies nothing: a boot answered after a
// sign-out would otherwise fill the dormant replica's purged cache, or the anon replica's.
function seats() {
  const script = new PullScript({ device: device(), server: server() });
  script.input.ids = ['rp_00000000000000000000000000000002'];
  script.pull(['self/probe'], 5000)
    .add({ op: 'signOut', choice: 'keep', deviceNow: 5001 })
    .respond({ serverNow: 5002 });
  return [script.vector('a boot answered after a sign-out applies nothing: the dormant replica stays purged, and the anon replica takes no rows')];
}

export function files() {
  return { 'pull/pages.json': [...boots(), ...answers(), ...lives(), ...digests(), ...frames(), ...principals(), ...revivals(), ...epochs(), ...chunks(), ...settling(), ...outside(), ...heldWindow(), ...seats()] };
}
