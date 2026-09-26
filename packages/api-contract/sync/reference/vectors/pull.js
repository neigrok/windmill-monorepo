// pull/serve.json: §6.7 pages the server answers for a request, and §9.2 hello. A vector may shrink
// PULL_PAGE_BYTES through `input.limits` to show paging on small states.

import { CONSTANTS } from '../core/constants.js';
import { Cursor } from '../core/wire.js';
import { hello, pull } from '../server/pull.js';
import { ServerState } from '../server/state.js';
import { overlayScope, productScope, registry, row, serverState, st, treeScope, vector } from './fixtures.js';

const NOW = 1_000_000;
const PROBE_A = 'acct:A/probe';
const BOARD = 'b_00000001';
const TREE = `tree:${BOARD}`;
const OVERLAY_A = `acct:A/overlay/${BOARD}`;
const SRV = (ms) => `${ms}:0:srv`;

function pulled(name, { state, account, request, serverNow = NOW, limits }) {
  const input = { state, account, request, serverNow };
  if (limits) input.limits = limits;
  const response = pull({ state: new ServerState(state), registry, account, request, serverNow, limits: { ...CONSTANTS, ...(limits ?? {}) } });
  return vector(name, input, { response });
}

function helloed(name, { state, account, serverTime = NOW }) {
  return vector(name, { state, account, serverTime }, { response: hello({ state: new ServerState(state), registry, account, serverTime }) });
}

// A's product scope: three alive cards, a run, a spent card, and the board of A's tree. The tree holds
// its meta, an alive and a dead tag, and a dead link; A's overlay holds one mark. `visibility` opens it.
function state({ visibility, dead = false } = {}) {
  const meta = { title: ['Plan', st(2000)] };
  if (visibility) meta.visibility = [visibility, SRV(2500)];
  const deadScope = dead ? { state: 'dead', deadAt: 9000 } : {};
  return serverState({
    scopes: { [PROBE_A]: productScope('A'), [TREE]: treeScope('A', BOARD, deadScope), [OVERLAY_A]: overlayScope('A', BOARD, deadScope) },
    rows: {
      [PROBE_A]: [
        row({ t: 'card', id: 'card0001', life: ['alive', st(1000)], born: st(1000), f: { title: ['One', st(1000)] }, seq: 1 }),
        row({ t: 'board', id: BOARD, life: dead ? ['dead', st(9000)] : ['alive', st(2000)], born: st(2000), seq: dead ? 7 : 2 }),
        row({ t: 'card', id: 'card0003', life: ['alive', st(3000)], born: st(3000), f: { title: ['Three', st(3000)] }, seq: 4 }),
        row({ t: 'run', id: 'run00001', life: ['alive', SRV(3500)], born: SRV(3500), f: { startedAt: [3500, SRV(3500)] }, seq: 4 }),
        row({ t: 'card', id: 'card0002', life: ['alive', st(2500)], born: st(2500), f: { title: ['Two', st(4000)] }, seq: 5 }),
      ],
      [TREE]: [
        row({ t: 'meta', id: 'meta', f: meta, seq: 1 }),
        row({ t: 'tag', id: 'oak', life: ['alive', st(2100)], born: st(2100), f: { label: ['Oak', st(2100)] }, seq: 2 }),
        row({ t: 'tag', id: 'elm', life: ['dead', st(2700)], born: st(2200), f: { label: ['Elm', st(2200)] }, seq: 3 }),
        row({ t: 'link', id: ['oak', 'elm'], life: ['dead', st(2800)], seq: 4 }),
      ],
      [OVERLAY_A]: [row({ t: 'mark', id: 'oak', f: { done: [true, st(2400)] }, seq: 1 })],
    },
    spent: { [PROBE_A]: [{ t: 'card', id: 'card0009', born: st(1500), lifeStamp: st(2600), seq: 3 }] },
  });
}

function cursor(fields) {
  return Cursor.encode(fields);
}

// Each page of a paged pull, requested with the cursor the previous page answered.
function chain(name, { state: at, account, scope, start, limits }) {
  const vectors = [];
  let current = start;
  for (let page = 1; page <= 8; page += 1) {
    const out = pulled(`${name}, page ${page}`, { state: at, account, request: { scopes: [{ scope, cursor: current }] }, limits });
    vectors.push(out);
    const answered = out.expect.response.body.pages[0];
    if (!answered.more) break;
    current = answered.cursor;
  }
  return vectors;
}

function serve() {
  const plain = state();
  const open = state({ visibility: 'public' });
  const dead = state({ dead: true });
  const deadOpen = state({ visibility: 'public', dead: true });
  const request = (scope, at = null) => ({ scopes: [{ scope, cursor: at }] });
  return [
    pulled('a boot answers every alive row up to asOf with total and ends live at the head', { state: plain, account: 'A', request: request('self/probe') }),
    ...chain('a paged boot keeps its asOf and pages by (seq, type, id)', { state: plain, account: 'A', scope: 'self/probe', start: null, limits: { PULL_PAGE_BYTES: 400 } }),
    pulled('a boot cursor below the head ends live at its asOf with more', {
      state: plain,
      account: 'A',
      request: request('self/probe', cursor({ e: 'ep-1', m: 'boot', s: 1, k: ['card', 'card0001'], a: 2 })),
    }),
    pulled('a live page answers rows above the cursor, dead ones thin, spent ids included', { state: plain, account: 'A', request: request('self/probe', cursor({ e: 'ep-1', m: 'live', s: 2 })) }),
    ...chain('a paged live pull ends a page inside a seq with a key', { state: plain, account: 'A', scope: 'self/probe', start: cursor({ e: 'ep-1', m: 'live', s: 3 }), limits: { PULL_PAGE_BYTES: 150 } }),
    pulled('a live pull at the head answers no rows and no more', { state: plain, account: 'A', request: request('self/probe', cursor({ e: 'ep-1', m: 'live', s: 5 })) }),
    pulled('a tree boot sends a dead derived row thin and leaves out a dead keyed row, with the header', { state: plain, account: 'A', request: request(`tree/${BOARD}`) }),
    pulled('a tree live pull sends the dead keyed row thin', { state: plain, account: 'A', request: request(`tree/${BOARD}`, cursor({ e: 'ep-1', m: 'live', s: 1 })) }),
    pulled('an overlay boot answers its rows', { state: plain, account: 'A', request: request(`self/overlay/${BOARD}`) }),
    pulled('one request pulls several scopes, each from its own cursor', {
      state: plain,
      account: 'A',
      request: { scopes: [{ scope: 'self/probe', cursor: cursor({ e: 'ep-1', m: 'live', s: 4 }) }, { scope: `tree/${BOARD}`, cursor: null }] },
    }),
    pulled('a cursor of another epoch is reset', { state: plain, account: 'A', request: request('self/probe', cursor({ e: 'ep-0', m: 'live', s: 2 })) }),
    pulled('a cursor ahead of the scope seq is reset', { state: plain, account: 'A', request: request('self/probe', cursor({ e: 'ep-1', m: 'live', s: 6 })) }),
    pulled('an undecodable cursor is reset', { state: plain, account: 'A', request: request('self/probe', 'not-a-cursor') }),
    pulled('a boot cursor without asOf is reset', { state: plain, account: 'A', request: request('self/probe', cursor({ e: 'ep-1', m: 'boot', s: 1, k: ['card', 'card0001'] })) }),
    pulled('a boot cursor whose asOf is below its seq is reset', { state: plain, account: 'A', request: request('self/probe', cursor({ e: 'ep-1', m: 'boot', s: 2, k: ['board', BOARD], a: 1 })) }),
    pulled('a live cursor carrying asOf is reset', { state: plain, account: 'A', request: request('self/probe', cursor({ e: 'ep-1', m: 'live', s: 2, a: 2 })) }),
    pulled('a cursor whose key is not [type, id] is reset', { state: plain, account: 'A', request: request('self/probe', cursor({ e: 'ep-1', m: 'live', s: 1, k: 'zz' })) }),
    pulled('a cursor with a negative seq is reset', { state: plain, account: 'A', request: request('self/probe', cursor({ e: 'ep-1', m: 'live', s: -3 })) }),
    pulled('a cursor with an unknown field is reset', { state: plain, account: 'A', request: request('self/probe', cursor({ e: 'ep-1', m: 'live', s: 2, x: 1 })) }),
    pulled('a padded encoding of a valid cursor is reset', { state: plain, account: 'A', request: request('self/probe', `${Buffer.from('{"e":"ep-1","m":"live","s":2}').toString('base64')}`) }),
    pulled('an absent tree is not-found', { state: plain, account: 'A', request: request('tree/b_0000000f') }),
    pulled('a private tree of another account is not-found', { state: plain, account: 'B', request: request(`tree/${BOARD}`) }),
    pulled('an overlay of another account private tree is not-found', { state: plain, account: 'B', request: request(`self/overlay/${BOARD}`) }),
    pulled('a public tree is readable by another account, with the header', { state: open, account: 'B', request: request(`tree/${BOARD}`) }),
    pulled('an absent overlay of a readable alive tree is an empty live page at seq 0', { state: open, account: 'B', request: request(`self/overlay/${BOARD}`) }),
    pulled('a dead tree is gone to its owner', { state: dead, account: 'A', request: request(`tree/${BOARD}`) }),
    pulled('a dead tree is not-found to another account', { state: dead, account: 'B', request: request(`tree/${BOARD}`) }),
    pulled('an overlay of a dead tree is gone to its owner', { state: dead, account: 'A', request: request(`self/overlay/${BOARD}`) }),
    pulled('another account\'s overlay of a dead public tree answers as the tree does to it: not-found', { state: deadOpen, account: 'B', request: request(`self/overlay/${BOARD}`) }),
    pulled('an absent product scope is an empty live page at seq 0 with digest 0', { state: plain, account: 'B', request: request('self/probe') }),
    pulled('an absent product scope with a cursor past seq 0 is reset', { state: plain, account: 'B', request: request('self/probe', cursor({ e: 'ep-1', m: 'live', s: 3 })) }),
    pulled('a signed-out principal reads a public tree and nothing of its own', {
      state: open,
      account: null,
      request: { scopes: [{ scope: `tree/${BOARD}`, cursor: null }, { scope: 'self/probe', cursor: null }] },
    }),
  ];
}

function hellos() {
  const withRun = serverState({
    scopes: { 'acct:B/probe': productScope('B') },
    rows: { 'acct:B/probe': [row({ t: 'run', id: 'run00002', life: ['alive', SRV(3500)], born: SRV(3500), f: { startedAt: [3500, SRV(3500)] }, seq: 1 })] },
  });
  const deadBoard = serverState({
    scopes: { 'acct:B/probe': productScope('B') },
    rows: { 'acct:B/probe': [row({ t: 'board', id: 'b_0000000b', life: ['dead', st(2600)], born: st(1500), seq: 2 })] },
  });
  const aliveBoard = serverState({
    scopes: { 'acct:B/probe': productScope('B') },
    rows: { 'acct:B/probe': [row({ t: 'board', id: 'b_0000000b', life: ['alive', st(1500)], born: st(1500), seq: 1 })] },
  });
  const deadCard = serverState({
    scopes: { 'acct:B/probe': productScope('B') },
    rows: { 'acct:B/probe': [] },
    spent: { 'acct:B/probe': [{ t: 'card', id: 'card0008', born: st(1500), lifeStamp: st(2600), seq: 1 }] },
  });
  return [
    helloed('an account holding an alive primary record holds records', { state: state(), account: 'A' }),
    helloed('an account holding only a non-primary record holds none', { state: withRun, account: 'B' }),
    helloed('an account whose primary records are dead holds none', { state: deadCard, account: 'B' }),
    helloed('a kept dead row of a primary type is not visible, so the account holds none', { state: deadBoard, account: 'B' }),
    helloed('an alive row of the governing primary type holds records', { state: aliveBoard, account: 'B' }),
    helloed('an account without a product scope holds none', { state: state(), account: 'B' }),
    helloed('a signed-out caller gets no holdsRecords', { state: state(), account: null }),
  ];
}

export function files() {
  return { 'pull/serve.json': serve(), 'pull/hello.json': hellos() };
}
