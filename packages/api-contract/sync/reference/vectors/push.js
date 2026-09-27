// push/serve.json: §6.2 push and §6.6 faults against a canonical server state, with the live events
// each request emits (§6.8). `faults` names the n's whose admission faults; `limits` shrinks a limit.

import { CONSTANTS } from '../core/constants.js';
import { push } from '../server/push.js';
import { ServerState } from '../server/state.js';
import { intentDigest } from '../core/wire.js';
import { overlayScope, product, productScope, registry, row, serverState, st, treeScope, vector } from './fixtures.js';

const NOW = 1_000_000;
const REPLICA = 'rp_0000000000000000000000000000000a';
const PROBE_A = 'acct:A/probe';
const BOARD = 'b_00000001';

function pushed(name, { state, account = 'A', request, serverNow = NOW, budget, faults, limits }) {
  const input = { state, account, request, serverNow };
  if (budget !== undefined) input.budget = budget;
  if (faults) input.faults = faults;
  if (limits) input.limits = limits;
  const faultOf = (replica, n) => faults?.find((fault) => fault.n === n)?.kind ?? null;
  const out = push({
    state: new ServerState(state), registry, product, account, request, serverNow,
    budget: budget ?? Infinity, faultOf, limits: { ...CONSTANTS, ...(limits ?? {}) },
  });
  return vector(name, input, { response: out.response, state: out.state.toJSON(), frames: out.live });
}

const cardCreate = (n, id, ms) => ({
  n,
  scope: 'self/probe',
  d: [{ t: 'card', id, born: st(ms), life: ['alive', st(ms)], f: { title: [`Card ${n}`, st(ms)] } }],
  gestureId: `g${n}`,
});

const request = (intents, ackThrough = 0, replica = REPLICA) => ({ replica, ackThrough, intents });

function base() {
  return serverState({
    scopes: { [PROBE_A]: productScope('A') },
    rows: { [PROBE_A]: [row({ t: 'card', id: 'card0001', life: ['alive', st(1000)], born: st(1000), f: { title: ['One', st(1000)] }, seq: 1 })] },
  });
}

// The state after the replica pushed intents 1 and 2.
function afterTwo() {
  const out = push({ state: new ServerState(base()), registry, product, account: 'A', request: request([cardCreate(1, 'card0002', 2000), cardCreate(2, 'card0003', 2001)]), serverNow: NOW });
  return out.state.toJSON();
}

function withReplica(state, binding, results = []) {
  const json = structuredClone(state);
  json.replicas = { [REPLICA]: binding };
  if (results.length) json.results = { [REPLICA]: results };
  return json;
}

// A public board whose tree B also overlays: its delete kills the tree and both overlays.
function boardState() {
  return serverState({
    scopes: {
      [PROBE_A]: productScope('A'),
      [`tree:${BOARD}`]: treeScope('A', BOARD),
      [`acct:A/overlay/${BOARD}`]: overlayScope('A', BOARD),
      [`acct:B/overlay/${BOARD}`]: overlayScope('B', BOARD),
    },
    rows: {
      [PROBE_A]: [row({ t: 'board', id: BOARD, life: ['alive', st(2000)], born: st(2000), seq: 1 })],
      [`tree:${BOARD}`]: [row({ t: 'meta', id: 'meta', f: { title: ['Open', st(2000)], visibility: ['public', `2500:0:srv`] }, seq: 1 })],
      [`acct:B/overlay/${BOARD}`]: [row({ t: 'mark', id: 'oak', f: { done: [true, st(2600, 0, 'r_bbbbbbbbbbbb')] }, seq: 1 })],
    },
  });
}

function serve() {
  const two = afterTwo();
  const pruned = push({ state: new ServerState(two), registry, product, account: 'A', request: request([], 2), serverNow: NOW }).state.toJSON();
  const first = cardCreate(1, 'card0002', 2000);
  const poisonedTwice = withReplica(base(), { account: 'A', lastN: 0 }, [{ n: 1, digest: intentDigest(first), result: null, faults: 2 }]);
  const boardDelete = { n: 1, scope: 'self/probe', d: [{ t: 'board', id: BOARD, born: st(2000), life: ['dead', st(9000)] }], gestureId: 'g1' };
  return [
    pushed('a fresh replica is bound and its intents are admitted in order, each with a change frame', {
      state: base(), request: request([cardCreate(1, 'card0002', 2000), cardCreate(2, 'card0003', 2001)]),
    }),
    pushed('a resend of admitted n\'s is answered from sync_results and changes nothing', {
      state: two, request: request([cardCreate(1, 'card0002', 2000), cardCreate(2, 'card0003', 2001)]),
    }),
    pushed('ackThrough prunes the stored results at or below it', { state: two, request: request([], 2) }),
    pushed('a resend of an n whose result was pruned answers replica-forked', { state: pruned, request: request([cardCreate(1, 'card0002', 2000)], 2) }),
    pushed('a stored n resent with another digest answers replica-forked', { state: two, request: request([cardCreate(1, 'card0009', 2000)]) }),
    pushed('an n past lastN + 1 answers gap and leaves no binding behind', { state: base(), request: request([cardCreate(2, 'card0002', 2000)]) }),
    pushed('a replica bound to another account answers replica-foreign', {
      state: withReplica(base(), { account: 'B', lastN: 3 }), request: request([cardCreate(4, 'card0002', 2000)]),
    }),
    pushed('no principal answers 401', { state: base(), account: null, request: request([cardCreate(1, 'card0002', 2000)]) }),
    pushed('the admission budget answers retry naming the first unprocessed n', {
      state: base(), budget: 1, request: request([cardCreate(1, 'card0002', 2000), cardCreate(2, 'card0003', 2001)]),
    }),
    pushed('a transient fault records nothing and answers retry with a wait', {
      state: base(), faults: [{ n: 1, kind: 'transient' }], request: request([cardCreate(1, 'card0002', 2000)]),
    }),
    pushed('a deterministic fault is counted and answers retry', {
      state: base(), faults: [{ n: 1, kind: 'fault' }], request: request([first]),
    }),
    pushed('the K_POISON-th fault stores internal, advances lastN, and the next intent proceeds', {
      state: poisonedTwice, faults: [{ n: 1, kind: 'fault' }], request: request([first, cardCreate(2, 'card0003', 2001)]),
    }),
    pushed('a body without ackThrough is 400 malformed', { state: base(), request: { replica: REPLICA, intents: [first] } }),
    pushed('an intent without an integer n is 400 malformed', { state: base(), request: request([{ ...first, n: '1' }]) }),
    pushed('more intents than PUSH_MAX_INTENTS is 413', {
      state: base(), limits: { PUSH_MAX_INTENTS: 1 }, request: request([cardCreate(1, 'card0002', 2000), cardCreate(2, 'card0003', 2001)]),
    }),
    pushed('a request over PUSH_MAX_BYTES is 413', { state: base(), limits: { PUSH_MAX_BYTES: 64 }, request: request([first]) }),
    pushed('a board delete emits its change frame, then a death event per killed scope', { state: boardState(), request: request([boardDelete]) }),
    pushed('a replica id other than rp_ and 32 lowercase hex is 400 malformed', { state: base(), request: request([first], 0, 'rp_0000000000000000000000000000000A') }),
    pushed('a body with a key beyond replica, ackThrough and intents is 400 malformed', { state: base(), request: { ...request([first]), device: 'phone' } }),
    pushed('a 409 prunes nothing: results at or below ackThrough stay', { state: two, request: request([cardCreate(4, 'card0005', 2003)], 2) }),
    pushed('an answer replayed from sync_results spends no admission budget', {
      state: two, budget: 1, request: request([cardCreate(1, 'card0002', 2000), cardCreate(2, 'card0003', 2001), cardCreate(3, 'card0004', 2002), cardCreate(4, 'card0005', 2003)]),
    }),
    pushed('a malformed body over PUSH_MAX_BYTES is 413: the size is checked before the shape', {
      state: base(), limits: { PUSH_MAX_BYTES: 64 }, request: { replica: REPLICA, intents: [first] },
    }),
    pushed('a malformed body with more intents than PUSH_MAX_INTENTS is 400: the count is checked after the shape', {
      state: base(), limits: { PUSH_MAX_INTENTS: 1 }, request: request([first, { ...cardCreate(2, 'card0003', 2001), n: 'two' }]),
    }),
    pushed('an intent n beyond the safe integers is 400 malformed', { state: base(), request: request([{ ...first, n: 2 ** 53 }]) }),
    pushed('an ackThrough beyond the safe integers is 400 malformed', { state: base(), request: request([first], 2 ** 53) }),
    pushed('ackThrough above lastN prunes nothing above lastN: the next n keeps its fault count', {
      state: withReplica(base(), { account: 'A', lastN: 0 }, [{ n: 1, digest: intentDigest(first), result: null, faults: 1 }]), request: request([], 5),
    }),
  ];
}

export function files() {
  return { 'push/serve.json': serve() };
}
