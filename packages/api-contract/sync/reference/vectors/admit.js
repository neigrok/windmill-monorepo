// admit/*.json: §6.1 admission of one intent against a canonical server state, and admit/requests.json:
// §6.3 server-origin calls. Every vector's expect.state is the full next state; a refusal leaves it
// equal to input.state.

import assert from 'node:assert/strict';
import { CONSTANTS } from '../core/constants.js';
import { jcs } from '../core/jcs.js';
import { admit } from '../server/admit.js';
import { serverCall } from '../server/requests.js';
import { ServerState } from '../server/state.js';
import { OTHER, overlayScope, product, productScope, registry, row, serverState, st, treeScope, vector } from './fixtures.js';

const NOW = 1_000_000;
const BOUND = NOW + CONSTANTS.MAX_SKEW_MS;
const A = { kind: 'replica', account: 'A', replica: 'rp_0000000000000000000000000000000a', n: 1 };
const B = { kind: 'replica', account: 'B', replica: 'rp_0000000000000000000000000000000b', n: 1 };
const SERVER_A = { kind: 'server', account: 'A' };
const SERVER_B = { kind: 'server', account: 'B' };
const PROBE_A = 'acct:A/probe';
const PROBE_B = 'acct:B/probe';
const BOARD = 'b_00000001';
const TREE = `tree:${BOARD}`;
const OVERLAY_A = `acct:A/overlay/${BOARD}`;
const OVERLAY_B = `acct:B/overlay/${BOARD}`;
const s = (ms, counter = 0, actor) => st(ms, counter, actor);
const SRV = (ms, counter = 0) => `${ms}:${counter}:srv`;

function admitted(name, { state, origin = A, intent, serverNow = NOW, limits }) {
  const outcome = admit({ state: new ServerState(state), registry, product, origin, intent, serverNow, limits: { ...CONSTANTS, ...(limits ?? {}) } });
  const input = { state, origin, intent, serverNow };
  if (limits) input.limits = limits;
  return vector(name, input, { result: outcome.result, state: outcome.state.toJSON() });
}

function card(id, { born = s(1000), seq = 1, ...f }) {
  const fields = {};
  for (const [name, value] of Object.entries(f)) fields[name] = Array.isArray(value) ? value : [value, born];
  return row({ t: 'card', id, life: ['alive', born], born, f: fields, seq });
}

function run(id, { born = SRV(1100), seq = 2, startedAt = 1100, endedAt, label }) {
  const f = { startedAt: [startedAt, born] };
  if (endedAt !== undefined) f.endedAt = [endedAt, SRV(endedAt)];
  if (label !== undefined) f.label = [label, born];
  return row({ t: 'run', id, life: ['alive', born], born, f, seq });
}

function lap(id, { runId = 'run00001', born = s(1200), seq = 3, no = 1, at = 1200, weight = 10, life }) {
  return row({ t: 'lap', id, life: life ?? ['alive', born], born, f: { at: [at, born], runId: [runId, born], weight: [weight, born] }, v: { no }, seq });
}

function create(t, id, stamp, f = {}) {
  const delta = { t, id, born: stamp, life: ['alive', stamp] };
  const fields = Object.fromEntries(Object.entries(f).map(([name, value]) => [name, [value, stamp]]));
  if (Object.keys(fields).length) delta.f = fields;
  return delta;
}

function update(t, id, born, stamp, f) {
  return { t, id, born, f: Object.fromEntries(Object.entries(f).map(([name, value]) => [name, [value, stamp]])) };
}

const intent = (scope, d, extra = {}) => ({ scope, d, ...extra });
const probe = (d, extra) => intent('self/probe', d, extra);

// A's product scope with one card and one open run (with its start receipt), and B's with one card.
function baseState(extra = {}) {
  return serverState({
    scopes: { [PROBE_A]: productScope('A'), [PROBE_B]: productScope('B') },
    rows: {
      [PROBE_A]: [card('card0001', { title: 'Hi', tier: 'draft' }), run('run00001', {})],
      [PROBE_B]: [card('cardbbbb', { title: 'Bee', seq: 1 })],
    },
    productState: { receipts: { [PROBE_A]: { run00001: 'run00001' } } },
    ...extra,
  });
}

// A's board b_00000001 with its tree (meta, two tags, a link) and A's overlay (a mark); `visibility`
// opens the tree to other accounts.
function treeState({ visibility, dead = false } = {}) {
  const meta = { title: ['Plan', s(2000)] };
  if (visibility) meta.visibility = [visibility, SRV(2500)];
  const boardLife = dead ? ['dead', s(9000)] : ['alive', s(2000)];
  const scopeExtra = dead ? { state: 'dead', deadAt: 9000 } : {};
  return serverState({
    scopes: {
      [PROBE_A]: productScope('A'),
      [TREE]: treeScope('A', BOARD, scopeExtra),
      [OVERLAY_A]: overlayScope('A', BOARD, scopeExtra),
    },
    rows: {
      [PROBE_A]: [row({ t: 'board', id: BOARD, life: boardLife, born: s(2000), seq: dead ? 2 : 1 })],
      [TREE]: [
        row({ t: 'meta', id: 'meta', f: meta, seq: 1 }),
        row({ t: 'tag', id: 'oak', life: ['alive', s(2100)], born: s(2100), f: { label: ['Oak', s(2100)] }, seq: 2 }),
        row({ t: 'tag', id: 'ash', life: ['alive', s(2200)], born: s(2200), f: { label: ['Ash', s(2200)] }, seq: 3 }),
        row({ t: 'link', id: ['oak', 'ash'], life: ['alive', s(2300)], seq: 4 }),
      ],
      [OVERLAY_A]: [row({ t: 'mark', id: 'oak', f: { done: [true, s(2400)] }, seq: 1 })],
    },
  });
}

// Byte-exact identity (§9.1): the owner's account and one canonically equivalent to it, spelled with a
// combining ring instead of the precomposed letter.
const OWNER = '\u00c5sa';
const LOOKALIKE = 'A\u030asa';

// A private board of OWNER's, with its tree.
function lookalikeState() {
  return serverState({
    accounts: { [OWNER]: { name: 'Owner' }, [LOOKALIKE]: { name: 'Lookalike' } },
    scopes: { [`acct:${OWNER}/probe`]: productScope(OWNER), [TREE]: treeScope(OWNER, BOARD) },
    rows: {
      [`acct:${OWNER}/probe`]: [row({ t: 'board', id: BOARD, life: ['alive', s(2000)], born: s(2000), seq: 1 })],
      [TREE]: [row({ t: 'meta', id: 'meta', f: { title: ['Plan', s(2000)] }, seq: 1 })],
    },
  });
}

// §6.1 step 2 for a `wholePut` type (the probe's `fact`): a delta carries a life, and an alive one every
// client-written field, every register at the life's stamp; a newer whole put beats an older delete.
function wholePuts() {
  const day = '2027-01-15';
  const fact = (life, f) => ({ t: 'fact', id: day, life, ...(f ? { f } : {}) });
  const both = (stamp) => ({ at: [5000, stamp], value: [80, stamp] });
  const empty = serverState({ scopes: { [PROBE_A]: productScope('A') } });
  const deleted = serverState({ scopes: { [PROBE_A]: productScope('A') }, spent: { [PROBE_A]: [{ t: 'fact', id: day, lifeStamp: s(3000), seq: 1 }] } });
  return [
    admitted('a whole-put delta without a life is invalid', { state: empty, intent: probe([{ t: 'fact', id: day, f: both(s(5000)) }]) }),
    admitted('an alive whole-put delta that leaves out a client-written field is invalid', { state: empty, intent: probe([fact(['alive', s(5000)], { value: [80, s(5000)] })]) }),
    admitted('an alive whole-put delta whose registers carry another stamp than its life is invalid', { state: empty, intent: probe([fact(['alive', s(5000)], { at: [5000, s(5000)], value: [80, s(4000)] })]) }),
    admitted('a whole put writes every field and its life at one stamp', { state: empty, intent: probe([fact(['alive', s(5000)], both(s(5000)))]) }),
    admitted('a delete of a whole fact carries its life alone', { state: empty, intent: probe([fact(['dead', s(5000)])]) }),
    admitted('a dead whole-put delta that carries a field register is invalid', { state: empty, intent: probe([fact(['dead', s(5000)], { value: [99, s(6000)] })]) }),
    admitted('a whole put newer than the fact\'s delete makes it alive again (INV-2)', { state: deleted, intent: probe([fact(['alive', s(5000)], both(s(5000)))]) }),
    admitted('a whole put older than the fact\'s delete leaves it dead', { state: deleted, intent: probe([fact(['alive', s(2000)], both(s(2000)))]) }),
    admitted('a server-origin whole put carries a null stamp in every register', { state: empty, origin: SERVER_A, intent: probe([fact(['alive', null], both(null))]) }),
  ];
}

function shape() {
  const base = baseState();
  const cardUpdate = (f) => probe([update('card', 'card0001', s(1000), s(5000), f)]);
  return [
    admitted('an unregistered type is invalid', { state: base, intent: probe([create('note', 'note0001', s(5000))]) }),
    admitted('a type of another scope kind is invalid', { state: base, intent: probe([create('tag', 'oak', s(5000))]) }),
    admitted('an id outside the type pattern is invalid', { state: base, intent: probe([create('card', 'short', s(5000))]) }),
    admitted('an unknown scope reference is invalid', { state: base, intent: intent('self/nope', [create('card', 'card0009', s(5000))]) }),
    admitted('a device scope is never sent and is invalid', { state: base, intent: intent('device/probe', [create('card', 'card0009', s(5000))]) }),
    admitted('an unknown intent key is invalid', { state: base, intent: probe([create('card', 'card0009', s(5000))], { extra: true }) }),
    admitted('an unknown delta key is invalid', { state: base, intent: probe([{ ...create('card', 'card0009', s(5000)), q: 1 }]) }),
    admitted('an unknown field is invalid', { state: base, intent: cardUpdate({ colour: 'red' }) }),
    admitted('a text field written as a register is invalid', {
      state: treeState(),
      intent: intent(`self/overlay/${BOARD}`, [{ t: 'mark', id: 'oak', f: { memo: ['hi', s(5000)] } }]),
    }),
    admitted('a lattice field written as text is invalid', {
      state: base,
      intent: probe([{ t: 'card', id: 'card0001', born: s(1000), x: { title: { text: 'Hi', base: { text: '' } } } }]),
    }),
    admitted('a replica writing a server-writer field is invalid', { state: base, intent: probe([update('run', 'run00001', SRV(1100), s(5000), { endedAt: 4000 })]) }),
    admitted('a replica writing a serial field is invalid', {
      state: base,
      intent: probe([create('lap', 'lap00009', s(5000), { runId: 'run00001', at: 5000, weight: 1, no: 7 })]),
    }),
    admitted('a delta carrying serial values is invalid', {
      state: base,
      intent: probe([{ ...create('lap', 'lap00009', s(5000), { runId: 'run00001', at: 5000, weight: 1 }), v: { no: 7 } }]),
    }),
    admitted('a value outside a ranked domain is invalid', { state: base, intent: cardUpdate({ tier: 'great' }) }),
    admitted('a number above the domain is invalid', { state: base, intent: cardUpdate({ size: 500.01 }) }),
    admitted('a number at the domain bound is admitted', { state: base, intent: cardUpdate({ size: -500 }) }),
    admitted('a number off the quantum is invalid', { state: base, intent: cardUpdate({ size: 1.005 }) }),
    admitted('a number on the quantum is admitted', { state: base, intent: cardUpdate({ size: 1.01 }) }),
    admitted('a nested number off its domain\'s quantum is invalid', { state: base, intent: cardUpdate({ attachment: { id: 'pic00001', scale: 1.2 } }) }),
    admitted('a nested number on its domain\'s quantum is admitted', { state: base, intent: cardUpdate({ attachment: { id: 'pic00001', scale: 1.5 } }) }),
    admitted('null is admitted where the domain is nullable', { state: base, intent: cardUpdate({ size: null }) }),
    admitted('null is invalid where the domain is not nullable', { state: base, intent: cardUpdate({ title: null }) }),
    admitted('a title over 12 chars is invalid', { state: base, intent: cardUpdate({ title: 'thirteen char' }) }),
    admitted('a title under its 1-char minimum is invalid', { state: base, intent: cardUpdate({ title: '' }) }),
    admitted('a 12-char title of 2-byte chars is admitted (unit chars)', { state: base, intent: cardUpdate({ title: 'éééééééééééé' }) }),
    admitted('a body of 13 two-byte chars is over 24 bytes and invalid (unit bytes)', { state: base, intent: cardUpdate({ body: 'ééééééééééééé' }) }),
    admitted('a body of 12 two-byte chars is 24 bytes and admitted', { state: base, intent: cardUpdate({ body: 'éééééééééééé' }) }),
    admitted('an object value with an unknown property is invalid', { state: base, intent: cardUpdate({ attachment: { id: 'pic00001', size: 3 } }) }),
    admitted('an object value missing a required property is invalid', { state: base, intent: cardUpdate({ attachment: { localOnly: true } }) }),
    admitted('a localOnly attachment reference is admitted', { state: base, intent: cardUpdate({ attachment: { id: 'pic00001', localOnly: true } }) }),
    admitted('a value that is not an order key is invalid', { state: base, intent: cardUpdate({ ord: 'a0!' }) }),
    admitted('a ref value outside the referenced pattern is invalid', {
      state: base,
      intent: probe([create('lap', 'lap00009', s(5000), { runId: 'r!', at: 5000, weight: 1 })]),
    }),
    admitted('a time value that is not an epoch ms is invalid', {
      state: base,
      intent: probe([create('lap', 'lap00009', s(5000), { runId: 'run00001', at: 1.5, weight: 1 })]),
    }),
    admitted('a malformed stamp is invalid', { state: base, intent: probe([{ t: 'card', id: 'card0001', born: s(1000), f: { title: ['x', '5000:0'] } }]) }),
    admitted('the unset stamp in a delta is invalid', { state: base, intent: probe([{ t: 'card', id: 'card0001', born: s(1000), f: { title: ['x', '0:0:'] } }]) }),
    admitted('a null stamp from a replica is invalid', { state: base, intent: probe([{ t: 'card', id: 'card0001', born: s(1000), f: { title: ['x', null] } }]) }),
    admitted('a minted delta without born is invalid', { state: base, intent: probe([{ t: 'card', id: 'card0001', f: { title: ['x', s(5000)] } }]) }),
    admitted('a keyed delta carrying born is invalid', {
      state: treeState(),
      intent: intent(`tree/${BOARD}`, [{ t: 'link', id: ['ash', 'oak'], born: s(5000), life: ['alive', s(5000)] }]),
    }),
    admitted('a keyed-with-life delta without life is invalid', {
      state: treeState(),
      intent: intent(`tree/${BOARD}`, [{ t: 'link', id: ['ash', 'oak'] }]),
    }),
    admitted('a singleton delta carrying life is invalid', {
      state: treeState(),
      intent: intent(`tree/${BOARD}`, [{ t: 'meta', id: 'meta', life: ['alive', s(5000)] }]),
    }),
    admitted('a singleton under another id is invalid', {
      state: treeState(),
      intent: intent(`tree/${BOARD}`, [{ t: 'meta', id: 'main', f: { title: ['x', s(5000)] } }]),
    }),
    admitted('a tuple key of the wrong length is invalid', {
      state: treeState(),
      intent: intent(`tree/${BOARD}`, [{ t: 'link', id: ['oak'], life: ['alive', s(5000)] }]),
    }),
    admitted('two deltas for one record are invalid', {
      state: base,
      intent: probe([update('card', 'card0001', s(1000), s(5000), { title: 'A' }), update('card', 'card0001', s(1000), s(5000), { body: 'B' })]),
    }),
    admitted('an intent with no delta and no command is invalid', { state: base, intent: probe([]) }),
    admitted('an unknown command is invalid', { state: base, intent: { scope: 'self/probe', cmd: { name: 'probe.fly', args: {} } } }),
    admitted('a command called in another scope kind is invalid', {
      state: treeState(),
      intent: { scope: `tree/${BOARD}`, cmd: { name: 'probe.start', args: { id: 'run00002', startedAt: 5000, join: true } } },
    }),
    admitted('a command argument it does not declare is invalid', {
      state: base,
      intent: { scope: 'self/probe', cmd: { name: 'probe.start', args: { id: 'run00002', startedAt: 5000, join: true, speed: 3 } } },
    }),
    admitted('a missing required argument is invalid', { state: base, intent: { scope: 'self/probe', cmd: { name: 'probe.start', args: { id: 'run00002', startedAt: 5000 } } } }),
    admitted('an argument outside its domain is invalid', {
      state: base,
      intent: { scope: 'self/probe', cmd: { name: 'probe.start', args: { id: 'run00002', startedAt: 5000, join: 'yes' } } },
    }),
    admitted('a ref argument outside the referenced pattern is invalid', {
      state: base,
      intent: { scope: 'self/probe', cmd: { name: 'probe.start', args: { id: 'r!', startedAt: 5000, join: true } } },
    }),
    admitted('a guard on an unknown field is invalid', {
      state: base,
      intent: probe([update('card', 'card0001', s(1000), s(5000), { title: 'A' })], { guard: [{ t: 'card', id: 'card0001', field: 'colour', stamp: null }] }),
    }),
    admitted('a guard with a malformed stamp is invalid', {
      state: base,
      intent: probe([update('card', 'card0001', s(1000), s(5000), { title: 'A' })], { guard: [{ t: 'card', id: 'card0001', field: 'title', stamp: 'x' }] }),
    }),
    admitted('a stamp one ms beyond the skew bound is clock-skew', { state: base, intent: probe([create('card', 'card0009', s(BOUND + 1), { title: 'Late' })]) }),
    admitted('a stamp exactly at the skew bound is admitted', { state: base, intent: probe([create('card', 'card0009', s(BOUND), { title: 'Edge' })]) }),
    admitted('an invalid value precedes clock-skew', { state: base, intent: probe([create('card', 'card0009', s(BOUND + 1), { title: '' })]) }),
    admitted('U+0000 in a field value is invalid', { state: base, intent: probe([create('card', 'card0009', s(5000), { title: 'A\u0000' })]) }),
    admitted('U+0000 in a text is invalid', {
      state: treeState(),
      intent: intent(`self/overlay/${BOARD}`, [{ t: 'mark', id: 'oak', x: { memo: { text: 'a\u0000', base: { text: '' } } } }]),
    }),
    admitted('U+0000 in a command argument is invalid', {
      state: base,
      intent: { scope: 'self/probe', cmd: { name: 'probe.start', args: { id: 'run00002', label: 'a\u0000', startedAt: 5000, join: true } } },
    }),
    admitted('U+0000 in a gestureId is invalid', { state: base, intent: probe([create('card', 'card0009', s(5000), { title: 'Ok' })], { gestureId: 'g\u0000' }) }),
    admitted('a tree reference whose id is outside the governing pattern is invalid', {
      state: treeState(),
      intent: intent('tree/B_00000001', [{ t: 'meta', id: 'meta', f: { title: ['x', s(5000)] } }]),
    }),
    admitted('a time value that is not an integer is invalid', {
      state: base,
      intent: probe([create('lap', 'lap00009', s(5000), { runId: 'run00001', at: 1200.5, weight: 1 })]),
    }),
    admitted('null in a ref field without a domain is invalid', {
      state: base,
      intent: probe([create('lap', 'lap00009', s(5000), { runId: null, at: 1200, weight: 1 })]),
    }),
    admitted('a time field beyond the bound is clamped to serverNow', {
      state: base,
      intent: probe([create('lap', 'lap00009', s(5000), { runId: 'run00001', at: BOUND + 1, weight: 1 })]),
    }),
    admitted('a time field at the bound is kept', {
      state: base,
      intent: probe([create('lap', 'lap00009', s(5000), { runId: 'run00001', at: BOUND, weight: 1 })]),
    }),
    admitted('a time argument beyond the bound is clamped to serverNow', {
      state: serverState({ scopes: { [PROBE_A]: productScope('A') } }),
      intent: { scope: 'self/probe', cmd: { name: 'probe.start', args: { id: 'run00002', startedAt: BOUND + 7, join: true } } },
    }),
    admitted('an instant argument beyond the bound is invalid', {
      state: base,
      intent: { scope: 'self/probe', cmd: { name: 'probe.end', args: { runId: 'run00001', endedAt: BOUND + 1 } } },
    }),
    admitted('an instant argument at the bound is admitted', {
      state: base,
      intent: { scope: 'self/probe', cmd: { name: 'probe.end', args: { runId: 'run00001', endedAt: BOUND } } },
    }),
    ...wholePuts(),
    admitted('an integer-domain value beyond the safe integers is invalid', {
      state: base,
      origin: SERVER_A,
      intent: probe([{ t: 'run', id: 'run00001', born: SRV(1100), f: { endedAt: [2 ** 53, null] } }]),
    }),
    admitted('an integer-domain value at the largest safe integer is admitted', {
      state: base,
      origin: SERVER_A,
      intent: probe([{ t: 'run', id: 'run00001', born: SRV(1100), f: { endedAt: [2 ** 53 - 1, null] } }]),
    }),
  ];
}

function access() {
  const tree = treeState();
  const open = treeState({ visibility: 'public' });
  const unlisted = treeState({ visibility: 'unlisted' });
  const dead = treeState({ dead: true });
  const tagWrite = (stamp) => intent(`tree/${BOARD}`, [update('tag', 'oak', s(2100), stamp, { label: 'Oak!' })]);
  const markWrite = (stamp) => intent(`self/overlay/${BOARD}`, [{ t: 'mark', id: 'oak', f: { done: [false, stamp] } }]);
  return [
    admitted('a first write inserts the absent product scope at seq 1', {
      state: serverState({}),
      intent: probe([create('card', 'card0001', s(5000), { title: 'First' })]),
    }),
    admitted('an absent tree is not-found', { state: tree, intent: intent('tree/b_0000000f', [{ t: 'meta', id: 'meta', f: { title: ['x', s(5000)] } }]) }),
    admitted('an absent overlay of an absent tree is not-found', { state: tree, intent: intent('self/overlay/b_0000000f', [{ t: 'mark', id: 'oak', f: { done: [true, s(5000)] } }]) }),
    admitted('the owner writes its private tree', { state: tree, intent: tagWrite(s(5000)) }),
    admitted('another account writing a private tree is not-found', { state: tree, origin: B, intent: tagWrite(s(5000, 0, OTHER)) }),
    admitted('another account writing an overlay of a private tree is not-found', { state: tree, origin: B, intent: markWrite(s(5000, 0, OTHER)) }),
    admitted('another account writing a public tree is forbidden', { state: open, origin: B, intent: tagWrite(s(5000, 0, OTHER)) }),
    admitted('another account writing an unlisted tree is forbidden', { state: unlisted, origin: B, intent: tagWrite(s(5000, 0, OTHER)) }),
    admitted('another account writing its overlay of a public tree inserts the overlay', { state: open, origin: B, intent: markWrite(s(5000, 0, OTHER)) }),
    admitted('another account writing its overlay of an unlisted tree inserts the overlay', { state: unlisted, origin: B, intent: markWrite(s(5000, 0, OTHER)) }),
    admitted('the owner writing a dead tree is scope-dead', { state: dead, intent: tagWrite(s(9500)) }),
    admitted('another account writing a dead tree is not-found', { state: dead, origin: B, intent: tagWrite(s(9500, 0, OTHER)) }),
    admitted('the owner writing its overlay of a dead tree is scope-dead', { state: dead, intent: markWrite(s(9500)) }),
    admitted('another account writing an overlay of a dead tree is not-found', { state: dead, origin: B, intent: markWrite(s(9500, 0, OTHER)) }),
    admitted('an account canonically equivalent to the owner, but not byte-equal, writing the private tree is not-found', {
      state: lookalikeState(),
      origin: { kind: 'replica', account: LOOKALIKE, replica: 'rp_0000000000000000000000000000000c', n: 1 },
      intent: intent(`tree/${BOARD}`, [{ t: 'meta', id: 'meta', f: { title: ['Mine', s(5000, 0, OTHER)] } }]),
    }),
    admitted('an invalid intent is invalid before access is checked', {
      state: tree,
      origin: B,
      intent: intent(`tree/${BOARD}`, [{ t: 'meta', id: 'meta', f: { title: ['this title is too long', s(5000, 0, OTHER)] } }]),
    }),
    admitted('a server-internal command from a replica is forbidden', { state: baseState(), intent: { scope: 'self/probe', cmd: { name: 'probe.tick', args: {} } } }),
    admitted('a server origin writing a type whose origins exclude it is forbidden', { state: tree, origin: SERVER_A, intent: intent(`self/overlay/${BOARD}`, [{ t: 'mark', id: 'oak', f: { done: [false, null] } }]) }),
    admitted('a server origin writes the owner tree with a minted stamp', { state: tree, origin: SERVER_A, intent: intent(`tree/${BOARD}`, [{ t: 'meta', id: 'meta', f: { visibility: ['public', null] } }]) }),
  ];
}

function deletesBeforeCreates() {
  return [
    { t: 'card', id: 'card0005', f: { title: 'Late' } },
    { t: 'board', id: 'b_00000005' },
    { t: 'tag', id: 'yew', f: { label: 'Yew' }, scope: `tree/${BOARD}`, key: TREE },
    { t: 'lap', id: 'lap00005', f: { runId: 'run00001', weight: 10 } },
  ].flatMap(({ t, id, f, scope = 'self/probe', key = PROBE_A }) => {
    const deleted = admitted(`absent ${t} delete persists its death before another replica replays the create`, {
      state: t === 'tag' ? treeState() : baseState(),
      intent: intent(scope, [{ t, id, born: s(4000), life: ['dead', s(5000)] }]),
    });
    assert.equal(deleted.expect.result.s, 'ok');
    const stored = new ServerState(deleted.expect.state).stored(key, t, id);
    assert.deepEqual(stored.life, ['dead', s(5000)]);
    assert.equal(stored.born, s(4000));
    assert.equal(stored.v, undefined, 'an absent death must not allocate a serial');
    const replayed = admitted(`a replayed ${t} create cannot revive an earlier absent delete`, {
      state: deleted.expect.state,
      origin: { ...A, replica: 'rp_0000000000000000000000000000000c' },
      intent: intent(scope, [create(t, id, s(4000), f)]),
    });
    assert.equal(replayed.expect.result.s, 'ok');
    assert.deepEqual(replayed.expect.state, deleted.expect.state);
    return [deleted, replayed];
  });
}

function identity() {
  const base = baseState();
  const born = s(1000);
  const spentCard = serverState({
    scopes: { [PROBE_A]: productScope('A'), [PROBE_B]: productScope('B') },
    rows: { [PROBE_A]: [card('card0001', { title: 'Hi' })], [PROBE_B]: [card('cardbbbb', { title: 'Bee' })] },
    spent: { [PROBE_A]: [{ t: 'card', id: 'card0002', born: s(1500), lifeStamp: s(1700), seq: 2 }] },
  });
  const tree = treeState();
  const deadTag = serverState({
    scopes: { [PROBE_A]: productScope('A'), [TREE]: treeScope('A', BOARD) },
    rows: {
      [PROBE_A]: [row({ t: 'board', id: BOARD, life: ['alive', s(2000)], born: s(2000), seq: 1 })],
      [TREE]: [
        row({ t: 'tag', id: 'elm', life: ['dead', s(2600)], born: s(2100), f: { label: ['Elm', s(2100)] }, seq: 2 }),
        row({ t: 'link', id: ['elm', 'yew'], life: ['dead', s(2800)], seq: 3 }),
      ],
    },
  });
  const orphanScope = serverState({ scopes: { [PROBE_A]: productScope('A'), 'tree:b_000000aa': treeScope('B', 'b_000000aa') } });
  const lapState = serverState({
    scopes: { [PROBE_A]: productScope('A') },
    rows: { [PROBE_A]: [run('run00001', {}), lap('lap00001', {})] },
  });
  const days = serverState({
    scopes: { [PROBE_A]: productScope('A') },
    rows: { [PROBE_A]: [row({ t: 'day', id: '2026-09-01', life: ['alive', s(1000)], f: { score: [7, s(1000)] }, seq: 1 })] },
    spent: { [PROBE_A]: [{ t: 'day', id: '2026-09-02', lifeStamp: s(1200), seq: 2 }] },
  });
  const cmd = (d) => probe(d);
  return [
    admitted('create onto none applies', { state: base, intent: cmd([create('card', 'card0005', s(5000), { title: 'New' })]) }),
    admitted('create onto a global id alive in another account is id-taken', { state: base, intent: cmd([create('card', 'cardbbbb', s(5000), { title: 'Mine' })]) }),
    admitted('create onto alive with equal born joins', { state: base, intent: cmd([{ ...create('card', 'card0001', born, { title: 'Hi' }), f: { title: ['Hi', born], body: ['more', s(5000)] } }]) }),
    admitted('create replayed onto alive with equal born is ok without a change', { state: base, intent: cmd([create('card', 'card0001', born, { title: 'Hi', tier: 'draft' })]) }),
    admitted('create onto alive with another born is id-taken', { state: base, intent: cmd([create('card', 'card0001', s(1001), { title: 'Hi' })]) }),
    admitted('create onto dead with equal born is ok without a change', { state: spentCard, intent: cmd([create('card', 'card0002', s(1500), { title: 'Old' })]) }),
    admitted('create onto dead with another born is id-spent', { state: spentCard, intent: cmd([create('card', 'card0002', s(5000), { title: 'Again' })]) }),
    admitted('update of none is unknown-record', { state: base, intent: cmd([update('card', 'card0005', s(1000), s(5000), { title: 'x' })]) }),
    admitted('update of a foreign id is unknown-record', { state: base, intent: cmd([update('card', 'cardbbbb', s(1000), s(5000), { title: 'x' })]) }),
    admitted('update of alive with equal born applies', { state: base, intent: cmd([update('card', 'card0001', born, s(5000), { title: 'Hey' })]) }),
    admitted('update of alive with another born is unknown-record', { state: base, intent: cmd([update('card', 'card0001', s(999), s(5000), { title: 'Hey' })]) }),
    admitted('update of dead with equal born is record-dead', { state: spentCard, intent: cmd([update('card', 'card0002', s(1500), s(5000), { title: 'x' })]) }),
    admitted('update of dead with another born is unknown-record', { state: spentCard, intent: cmd([update('card', 'card0002', s(1400), s(5000), { title: 'x' })]) }),
    admitted('delete of none persists its death and spends the id', { state: base, intent: cmd([{ t: 'card', id: 'card0005', born: s(4000), life: ['dead', s(5000)] }]) }),
    admitted('delete of a foreign id is ok without a change', { state: base, intent: cmd([{ t: 'card', id: 'cardbbbb', born: s(1000), life: ['dead', s(5000)] }]) }),
    admitted('delete of alive with equal born applies and spends the id', { state: base, intent: cmd([{ t: 'card', id: 'card0001', born, life: ['dead', s(5000)] }]) }),
    admitted('delete of alive with another born is unknown-record', { state: base, intent: cmd([{ t: 'card', id: 'card0001', born: s(999), life: ['dead', s(5000)] }]) }),
    admitted('delete of dead with equal born joins: a newer death stamp moves the spent row', { state: spentCard, intent: cmd([{ t: 'card', id: 'card0002', born: s(1500), life: ['dead', s(5000)] }]) }),
    admitted('delete of dead with equal born joins: an older death stamp leaves it, ok without a change', { state: spentCard, intent: cmd([{ t: 'card', id: 'card0002', born: s(1500), life: ['dead', s(1600)] }]) }),
    admitted('delete of a dead revivable record joins: a newer death stamp moves the kept row', { state: deadTag, intent: intent(`tree/${BOARD}`, [{ t: 'tag', id: 'elm', born: s(2100), life: ['dead', s(5000)] }]) }),
    admitted('delete of dead with another born is ok without a change', { state: spentCard, intent: cmd([{ t: 'card', id: 'card0002', born: s(1400), life: ['dead', s(5000)] }]) }),
    admitted('revive of none is unknown-record', { state: base, intent: cmd([{ t: 'card', id: 'card0005', born: s(4000), life: ['alive', s(5000)] }]) }),
    admitted('revive of a foreign id is unknown-record', { state: base, intent: cmd([{ t: 'card', id: 'cardbbbb', born: s(1000), life: ['alive', s(5000)] }]) }),
    admitted('revive of alive with equal born applies and moves the life stamp', { state: base, intent: cmd([{ t: 'card', id: 'card0001', born, life: ['alive', s(5000)] }]) }),
    admitted('revive of alive with another born is unknown-record', { state: base, intent: cmd([{ t: 'card', id: 'card0001', born: s(999), life: ['alive', s(5000)] }]) }),
    admitted('revive of a dead non-revivable type is id-spent', { state: spentCard, intent: cmd([{ t: 'card', id: 'card0002', born: s(1500), life: ['alive', s(5000)] }]) }),
    admitted('revive of dead with another born is unknown-record', { state: spentCard, intent: cmd([{ t: 'card', id: 'card0002', born: s(1400), life: ['alive', s(5000)] }]) }),
    admitted('revive of a dead revivable type brings back its kept fields', { state: deadTag, intent: intent(`tree/${BOARD}`, [{ t: 'tag', id: 'elm', born: s(2100), life: ['alive', s(5000)] }]) }),
    admitted('create onto a dead revivable record with equal born is ok without a change', { state: deadTag, intent: intent(`tree/${BOARD}`, [create('tag', 'elm', s(2100), { label: 'Elm' })]) }),
    admitted('create of a governing id whose tree another record governs is id-taken', { state: orphanScope, intent: cmd([create('board', 'b_000000aa', s(5000))]) }),
    admitted('create of a governing id alive in another account is id-taken', { state: tree, origin: B, intent: cmd([create('board', BOARD, s(5000, 0, OTHER))]) }),
    admitted('a keyed put onto none creates it', { state: tree, intent: intent(`tree/${BOARD}`, [{ t: 'link', id: ['ash', 'oak'], life: ['alive', s(5000)] }]) }),
    admitted('a keyed put older than the stored death is ok without a change', { state: deadTag, intent: intent(`tree/${BOARD}`, [{ t: 'link', id: ['elm', 'yew'], life: ['alive', s(2700)] }]) }),
    admitted('a keyed put newer than the stored death makes it alive again', { state: deadTag, intent: intent(`tree/${BOARD}`, [{ t: 'link', id: ['elm', 'yew'], life: ['alive', s(5000)] }]) }),
    admitted('a keyed put removing an alive record kills it (dead row kept thin)', { state: tree, intent: intent(`tree/${BOARD}`, [{ t: 'link', id: ['oak', 'ash'], life: ['dead', s(5000)] }]) }),
    admitted('a keyed put onto none of a spent type creates it', { state: days, intent: cmd([{ t: 'day', id: '2026-09-03', life: ['alive', s(5000)], f: { score: [4, s(5000)] } }]) }),
    admitted('a keyed put removing a record of a spent type deletes its row and spends it without a born', { state: days, intent: cmd([{ t: 'day', id: '2026-09-01', life: ['dead', s(5000)] }]) }),
    admitted('a keyed put newer than a spent death makes it alive again, drops the spent row, and sets rc', { state: days, intent: cmd([{ t: 'day', id: '2026-09-02', life: ['alive', s(5000)], f: { score: [9, s(5000)] } }]) }),
    admitted('a keyed put older than a spent death is ok without a change', { state: days, intent: cmd([{ t: 'day', id: '2026-09-02', life: ['alive', s(1100)], f: { score: [9, s(1100)] } }]) }),
    admitted('a keyed write without life creates on none', { state: tree, intent: intent(`self/overlay/${BOARD}`, [{ t: 'mark', id: 'ash', f: { done: [true, s(5000)] } }]) }),
    admitted('a singleton write applies', { state: tree, intent: intent(`tree/${BOARD}`, [{ t: 'meta', id: 'meta', f: { title: ['Plan B', s(5000)] } }]) }),
    admitted('a const field rewritten under another stamp to another value is invalid', {
      state: lapState,
      intent: cmd([update('lap', 'lap00001', s(1200), s(5000), { runId: 'run00002' })]),
    }),
    admitted('a const field rewritten under its own stamp is the same write and ok', {
      state: lapState,
      intent: cmd([{ t: 'lap', id: 'lap00001', born: s(1200), f: { runId: ['run00001', s(1200)], weight: [11, s(5000)] } }]),
    }),
    admitted('a const field rewritten under another stamp to the same value is ok and keeps the first stamp', {
      state: lapState,
      intent: cmd([update('lap', 'lap00001', s(1200), s(5000), { runId: 'run00001' })]),
    }),
    admitted('a time field rewritten under another stamp to another value is invalid', {
      state: lapState,
      intent: cmd([update('lap', 'lap00001', s(1200), s(5000), { at: 1300 })]),
    }),
    admitted('a server origin writing a time field is not refused, and fww keeps the first write', {
      state: lapState,
      origin: SERVER_A,
      intent: cmd([{ t: 'lap', id: 'lap00001', born: s(1200), f: { at: [1300, null] } }]),
    }),
  ];
}

function guards() {
  const base = baseState();
  const save = (f, guard, stamp = s(5000)) => probe([update('card', 'card0001', s(1000), stamp, f)], { guard });
  const replayed = serverState({
    scopes: { [PROBE_A]: productScope('A') },
    rows: { [PROBE_A]: [card('card0001', { title: ['Saved', s(5000)] })] },
  });
  return [
    admitted('a guard on the stored stamp holds', { state: base, intent: save({ title: 'Hey' }, [{ t: 'card', id: 'card0001', field: 'title', stamp: s(1000) }]) }),
    admitted('a guard on a moved register is stale with its current stamp', { state: base, intent: save({ title: 'Hey' }, [{ t: 'card', id: 'card0001', field: 'title', stamp: s(900) }]) }),
    admitted('a null guard on an unset register holds', { state: base, intent: save({ body: 'Text' }, [{ t: 'card', id: 'card0001', field: 'body', stamp: null }]) }),
    admitted('a null guard on a set register is stale', { state: base, intent: save({ title: 'Hey' }, [{ t: 'card', id: 'card0001', field: 'title', stamp: null }]) }),
    admitted('a stamped guard on an unset register is stale with current null', { state: base, intent: save({ body: 'Text' }, [{ t: 'card', id: 'card0001', field: 'body', stamp: s(1000) }]) }),
    admitted('a null guard on an absent record holds for its create', {
      state: base,
      intent: probe([create('card', 'card0007', s(5000), { title: 'New' })], { guard: [{ t: 'card', id: 'card0007', field: 'title', stamp: null }] }),
    }),
    admitted('a guard on a register another record holds is checked too', {
      state: base,
      intent: save({ title: 'Hey' }, [{ t: 'card', id: 'card0001', field: 'title', stamp: s(1000) }, { t: 'run', id: 'run00001', field: 'label', stamp: s(1) }]),
    }),
    admitted('a guard holds when the register already carries the stamp this intent writes (replay)', {
      state: replayed,
      intent: save({ title: 'Saved' }, [{ t: 'card', id: 'card0001', field: 'title', stamp: s(1000) }]),
    }),
    admitted('a command resolved as a replay skips its guards', {
      state: base,
      intent: { scope: 'self/probe', guard: [{ t: 'card', id: 'card0001', field: 'title', stamp: s(1) }], cmd: { name: 'probe.start', args: { id: 'run00001', startedAt: 1100, join: true } } },
    }),
    admitted('a command that is not a replay checks its guards', {
      state: base,
      intent: { scope: 'self/probe', guard: [{ t: 'card', id: 'card0001', field: 'title', stamp: s(1) }], cmd: { name: 'probe.end', args: { runId: 'run00001', endedAt: 5000 } } },
    }),
  ];
}

function commands() {
  const empty = serverState({ scopes: { [PROBE_A]: productScope('A') } });
  const base = baseState();
  const start = (args) => ({ scope: 'self/probe', cmd: { name: 'probe.start', args } });
  const end = (args) => ({ scope: 'self/probe', cmd: { name: 'probe.end', args } });
  const joined = serverState({
    scopes: { [PROBE_A]: productScope('A') },
    rows: { [PROBE_A]: [run('run00001', {})] },
    productState: { receipts: { [PROBE_A]: { run00001: 'run00001', run00002: 'run00001' } } },
  });
  const deadRun = serverState({
    scopes: { [PROBE_A]: productScope('A') },
    spent: { [PROBE_A]: [{ t: 'run', id: 'run00001', born: SRV(1100), lifeStamp: s(3000), seq: 3 }] },
    productState: { receipts: { [PROBE_A]: { run00001: 'run00001' } } },
  });
  const ended = serverState({
    scopes: { [PROBE_A]: productScope('A') },
    rows: { [PROBE_A]: [run('run00001', { endedAt: 4000 })] },
    productState: { receipts: { [PROBE_A]: { run00001: 'run00001' } } },
  });
  const futureRun = serverState({
    clock: { ms: 2000, counter: 3 },
    scopes: { [PROBE_A]: productScope('A') },
    rows: { [PROBE_A]: [row({ t: 'run', id: 'run00001', life: ['alive', SRV(1100)], born: SRV(1100), f: { startedAt: [1100, SRV(1100)], endedAt: [null, s(1_250_000, 2)] }, seq: 2 })] },
    productState: { receipts: { [PROBE_A]: { run00001: 'run00001' } } },
  });
  const twoOpen = serverState({
    clock: { ms: 1100, counter: 0 },
    scopes: { [PROBE_A]: productScope('A') },
    rows: { [PROBE_A]: [run('run00001', {}), run('run00003', { born: SRV(NOW - 1000), startedAt: NOW - 1000, seq: 3 }), run('run00004', { born: SRV(1300), startedAt: 1300, endedAt: 1400, seq: 4 })] },
  });
  const copying = copyState();
  const copy = (src, dst) => ({ scope: 'self/probe', cmd: { name: 'probe.copy', args: { src, dst } } });
  const copied = new ServerState(copying);
  const afterCopy = admit({ state: copied, registry, product, origin: A, intent: copy(BOARD, 'b_00000002'), serverNow: NOW }).state.toJSON();
  return [
    admitted('probe.start creates the run with a receipt and a write map', { state: empty, intent: start({ id: 'run00001', label: 'Go', startedAt: 5000, join: true }) }),
    admitted('probe.start without a label writes only startedAt', { state: empty, intent: start({ id: 'run00001', startedAt: 5000, join: true }) }),
    admitted('probe.start replayed by its receipt is ok with the run and its born', { state: base, intent: start({ id: 'run00001', startedAt: 5000, join: true }) }),
    admitted('probe.start with an open run joins it: receipt, write map from the called id', { state: base, intent: start({ id: 'run00002', startedAt: 5000, join: true }) }),
    admitted('probe.start with an open run and join false is invalid', { state: base, intent: start({ id: 'run00002', startedAt: 5000, join: false }) }),
    admitted('probe.start replayed for a joined id answers the joined run with from', { state: joined, intent: start({ id: 'run00002', startedAt: 9999, join: true }) }),
    admitted('probe.start replayed after its run died writes nothing and maps nothing', { state: deadRun, intent: start({ id: 'run00001', startedAt: 5000, join: true }) }),
    admitted('probe.start onto a run id alive in another account is id-taken', {
      state: serverState({ scopes: { [PROBE_A]: productScope('A'), [PROBE_B]: productScope('B') }, rows: { [PROBE_B]: [run('run00009', {})] } }),
      intent: start({ id: 'run00009', startedAt: 5000, join: true }),
    }),
    admitted('probe.start from a server origin creates the run', { state: empty, origin: SERVER_A, intent: start({ id: 'run00001', startedAt: 5000, join: true }) }),
    admitted('probe.end writes endedAt with a server stamp', { state: base, intent: end({ runId: 'run00001', endedAt: 5000 }) }),
    admitted('probe.end server stamp observes the stored registers it overwrites', { state: futureRun, intent: end({ runId: 'run00001', endedAt: 5000 }) }),
    admitted('probe.end of an absent run is unknown-record', { state: base, intent: end({ runId: 'run00009', endedAt: 5000 }) }),
    admitted('probe.end of another account run is unknown-record', {
      state: serverState({ scopes: { [PROBE_A]: productScope('A'), [PROBE_B]: productScope('B') }, rows: { [PROBE_B]: [run('run00009', {})] } }),
      intent: end({ runId: 'run00009', endedAt: 5000 }),
    }),
    admitted('probe.end of a dead run is record-dead', { state: deadRun, intent: end({ runId: 'run00001', endedAt: 5000 }) }),
    admitted('probe.end before the run started is invalid', { state: base, intent: end({ runId: 'run00001', endedAt: 1099 }) }),
    admitted('probe.end of an ended run is ok without a change', { state: ended, intent: end({ runId: 'run00001', endedAt: 5000 }) }),
    admitted('probe.tick from a server origin ends every open run started TICK_AFTER_MS ago, with one stamp', { state: twoOpen, origin: SERVER_A, intent: { scope: 'self/probe', cmd: { name: 'probe.tick', args: {} } } }),
    admitted('probe.copy creates the board, and writes the source title, tags and links into the new tree at its own seq', { state: copying, intent: copy(BOARD, 'b_00000002') }),
    admitted('probe.copy replayed by its receipt is ok with the board and its born', { state: afterCopy, intent: copy(BOARD, 'b_00000002') }),
    admitted('probe.copy of another account\'s public tree copies its title but not its visibility', { state: copying, intent: copy('b_0000000b', 'b_00000003') }),
    admitted('probe.copy of a revived tag creates it born at its life stamp, so the copy keeps its life', {
      state: copyState([row({ t: 'tag', id: 'pine', life: ['alive', s(2800)], born: s(2050), f: { label: ['Pine', s(2900)] }, seq: 6 })]),
      intent: copy(BOARD, 'b_00000002'),
    }),
    admitted('probe.copy of an absent tree is not-found', { state: copying, intent: copy('b_0000000f', 'b_00000003') }),
    admitted('probe.copy of another account\'s private tree is not-found', { state: copying, intent: copy('b_0000000c', 'b_00000003') }),
    admitted('probe.copy of a dead tree is not-found', { state: copying, intent: copy('b_0000000d', 'b_00000003') }),
    admitted('probe.copy onto a board id alive in the scope is id-taken', { state: copying, intent: copy('b_0000000b', BOARD) }),
    admitted('probe.copy onto a board id of another account is id-taken', { state: copying, intent: copy(BOARD, 'b_0000000b') }),
    admitted('probe.copy onto a dead board id is id-taken', { state: afterCopy, intent: copy('b_0000000b', 'b_00000004') }),
    admitted('a run created by a plain delta is invalid', { state: empty, intent: probe([create('run', 'run00001', s(5000), { startedAt: 5000 })]) }),
    admitted('a run created by a server-origin delta is invalid', { state: empty, origin: SERVER_A, intent: probe([{ t: 'run', id: 'run00001', born: null, life: ['alive', null], f: { startedAt: [5000, null] } }]) }),
    admitted('a run created by a delta beside probe.start of the same run is invalid: only the command creates it', {
      state: empty,
      intent: probe([create('run', 'run00001', s(5000), { startedAt: 5000 })], { cmd: { name: 'probe.start', args: { id: 'run00001', startedAt: 5000, join: false } } }),
    }),
  ];
}

// A's board b_00000001 (its tree: title, two tags, a link, a dead tag, then `ownRows`) and A's spent
// board b_00000004; B's public b_0000000b (a revived tag), private b_0000000c and dead b_0000000d.
function copyState(ownRows = []) {
  const bTree = (id) => `tree:${id}`;
  return serverState({
    clock: { ms: 3000, counter: 0 },
    scopes: {
      [PROBE_A]: productScope('A'),
      [PROBE_B]: productScope('B'),
      [TREE]: treeScope('A', BOARD),
      [bTree('b_0000000b')]: treeScope('B', 'b_0000000b'),
      [bTree('b_0000000c')]: treeScope('B', 'b_0000000c'),
      [bTree('b_0000000d')]: treeScope('B', 'b_0000000d', { state: 'dead', deadAt: 2900 }),
      'tree:b_00000004': treeScope('A', 'b_00000004', { state: 'dead', deadAt: 2950 }),
    },
    rows: {
      [PROBE_A]: [
        row({ t: 'board', id: BOARD, life: ['alive', s(2000)], born: s(2000), seq: 1 }),
        row({ t: 'board', id: 'b_00000004', life: ['dead', s(2950)], born: s(2040), seq: 2 }),
      ],
      [PROBE_B]: [
        row({ t: 'board', id: 'b_0000000b', life: ['alive', s(2000, 0, OTHER)], born: s(2000, 0, OTHER), seq: 1 }),
        row({ t: 'board', id: 'b_0000000c', life: ['alive', s(2010, 0, OTHER)], born: s(2010, 0, OTHER), seq: 2 }),
        row({ t: 'board', id: 'b_0000000d', life: ['dead', s(2900, 0, OTHER)], born: s(2020, 0, OTHER), seq: 3 }),
      ],
      [TREE]: [
        row({ t: 'meta', id: 'meta', f: { title: ['Plan', s(2000)] }, seq: 1 }),
        row({ t: 'tag', id: 'oak', life: ['alive', s(2100)], born: s(2100), f: { label: ['Oak', s(2100)] }, seq: 2 }),
        row({ t: 'tag', id: 'ash', life: ['alive', s(2200)], born: s(2200), f: { label: ['Ash', s(2200)] }, seq: 3 }),
        row({ t: 'link', id: ['oak', 'ash'], life: ['alive', s(2300)], f: { strength: [3, s(2300)] }, seq: 4 }),
        row({ t: 'tag', id: 'elm', life: ['dead', s(2600)], born: s(2150), f: { label: ['Elm', s(2150)] }, seq: 5 }),
        ...ownRows,
      ],
      [bTree('b_0000000b')]: [
        row({ t: 'meta', id: 'meta', f: { title: ['Theirs', s(2000, 0, OTHER)], visibility: ['public', SRV(2500)] }, seq: 1 }),
        row({ t: 'tag', id: 'fir', life: ['alive', s(2700, 0, OTHER)], born: s(2100, 0, OTHER), f: { label: ['Fir', s(2100, 0, OTHER)] }, seq: 2 }),
      ],
      [bTree('b_0000000c')]: [row({ t: 'tag', id: 'yew', life: ['alive', s(2100, 0, OTHER)], born: s(2100, 0, OTHER), seq: 1 })],
    },
    spent: { [PROBE_A]: [] },
  });
}

function check() {
  const base = baseState();
  const deadRun = serverState({
    scopes: { [PROBE_A]: productScope('A') },
    spent: { [PROBE_A]: [{ t: 'run', id: 'run00001', born: SRV(1100), lifeStamp: s(3000), seq: 3 }] },
  });
  const strandedLap = serverState({
    scopes: { [PROBE_A]: productScope('A') },
    rows: { [PROBE_A]: [lap('lap00001', { seq: 2 })] },
    spent: { [PROBE_A]: [{ t: 'run', id: 'run00001', born: SRV(1100), lifeStamp: s(3000), seq: 3 }] },
  });
  const withLaps = serverState({
    clock: { ms: 1100, counter: 0 },
    scopes: { [PROBE_A]: productScope('A') },
    rows: {
      [PROBE_A]: [
        run('run00001', {}),
        lap('lap00001', { seq: 3, no: 1 }),
        lap('lap00002', { born: s(1_200_000, 4), seq: 4, no: 2, at: 1200 }),
        lap('lap00003', { runId: 'run00002', seq: 5, no: 1 }),
        run('run00002', { born: SRV(1150), startedAt: 1150, seq: 5 }),
      ],
    },
    spent: { [PROBE_A]: [{ t: 'lap', id: 'lap00004', born: s(1300), lifeStamp: s(1400), seq: 6 }] },
    productState: { receipts: { [PROBE_A]: { run00001: 'run00001', run00002: 'run00002' } } },
  });
  const empty = serverState({ scopes: { [PROBE_A]: productScope('A') } });
  return [
    admitted('a lap created under a dead run is parent-dead', { state: deadRun, intent: probe([create('lap', 'lap00009', s(5000), { runId: 'run00001', at: 5000, weight: 1 })]) }),
    admitted('a lap created under an absent run is parent-dead', { state: base, intent: probe([create('lap', 'lap00009', s(5000), { runId: 'run00077', at: 5000, weight: 1 })]) }),
    admitted('a lap updated under a dead run is parent-dead', { state: strandedLap, intent: probe([update('lap', 'lap00001', s(1200), s(5000), { weight: 12 })]) }),
    admitted('a lap deleted under a dead run is admitted', { state: strandedLap, intent: probe([{ t: 'lap', id: 'lap00001', born: s(1200), life: ['dead', s(5000)] }]) }),
    admitted('a lap under a run the same intent creates is admitted', {
      state: empty,
      intent: {
        scope: 'self/probe',
        d: [create('lap', 'lap00009', s(5000), { runId: 'run00001', at: 5000, weight: 1 })],
        cmd: { name: 'probe.start', args: { id: 'run00001', startedAt: 5000, join: true } },
      },
    }),
    admitted('a lap under a run the same intent deletes is parent-dead', {
      state: base,
      intent: probe([{ t: 'run', id: 'run00001', born: SRV(1100), life: ['dead', s(5000)] }, create('lap', 'lap00009', s(5000), { runId: 'run00001', at: 5000, weight: 1 })]),
    }),
    admitted('a run delete kills its alive laps in the same seq with one server stamp', {
      state: withLaps,
      intent: probe([{ t: 'run', id: 'run00001', born: SRV(1100), life: ['dead', s(5000)] }]),
    }),
    admitted('a run delete stamped below the run\'s life leaves the run alive and kills no lap', {
      state: withLaps,
      intent: probe([{ t: 'run', id: 'run00001', born: SRV(1100), life: ['dead', s(1000)] }]),
    }),
    admitted('a run delete that also deletes one of its laps: the consequence writes that lap too, and its server stamp wins', {
      state: withLaps,
      intent: probe([{ t: 'run', id: 'run00001', born: SRV(1100), life: ['dead', s(5000)] }, { t: 'lap', id: 'lap00001', born: s(1200), life: ['dead', s(5000)] }]),
    }),
  ];
}

function serial() {
  const withLaps = serverState({
    scopes: { [PROBE_A]: productScope('A') },
    rows: {
      [PROBE_A]: [
        run('run00001', {}),
        run('run00002', { born: SRV(1150), startedAt: 1150, seq: 2 }),
        lap('lap00001', { seq: 3, no: 1 }),
        lap('lap00002', { seq: 4, no: 2 }),
        lap('lap00005', { runId: 'run00002', seq: 5, no: 1 }),
      ],
    },
    spent: { [PROBE_A]: [{ t: 'lap', id: 'lap00003', born: s(1300), lifeStamp: s(1400), seq: 6 }] },
    productState: { receipts: { [PROBE_A]: { run00001: 'run00001', run00002: 'run00002' } } },
  });
  const deadTop = serverState({
    scopes: { [PROBE_A]: productScope('A') },
    rows: { [PROBE_A]: [run('run00001', {}), lap('lap00001', { seq: 3, no: 1 })] },
    spent: { [PROBE_A]: [{ t: 'lap', id: 'lap00002', born: s(1300), lifeStamp: s(1400), seq: 4 }] },
  });
  const newLap = (id, runId, stamp = s(5000)) => create('lap', id, stamp, { runId, at: 5000, weight: 1 });
  return [
    admitted('a new lap takes 1 + the highest number of its run', { state: withLaps, intent: probe([newLap('lap00009', 'run00001')]) }),
    admitted('two new laps of one run number in admission order', { state: withLaps, intent: probe([newLap('lap00009', 'run00001'), newLap('lap00008', 'run00001')]) }),
    admitted('laps of different runs number independently', { state: withLaps, intent: probe([newLap('lap00009', 'run00002'), newLap('lap00008', 'run00001')]) }),
    admitted('the first lap of a run is 1', {
      state: serverState({ scopes: { [PROBE_A]: productScope('A') }, rows: { [PROBE_A]: [run('run00001', {})] } }),
      intent: probe([newLap('lap00009', 'run00001')]),
    }),
    admitted('a dead lap no longer counts toward the maximum', { state: deadTop, intent: probe([newLap('lap00009', 'run00001')]) }),
    admitted('a replayed create of a numbered lap keeps its number', { state: withLaps, intent: probe([{ ...newLap('lap00002', 'run00001', s(1200)), f: { runId: ['run00001', s(1200)], at: [1200, s(1200)], weight: [10, s(1200)] } }]) }),
  ];
}

function caps() {
  const cards = (count, extra = []) => serverState({
    scopes: { [PROBE_A]: productScope('A') },
    rows: { [PROBE_A]: [...Array.from({ length: count }, (_, i) => card(`card000${i + 1}`, { born: s(1000 + i), title: `C${i + 1}`, seq: i + 1 })), ...extra] },
  });
  const kill = (i) => ({ t: 'card', id: `card000${i}`, born: s(999 + i), life: ['dead', s(5000)] });
  return [
    admitted('a create at the cap is refused cap', { state: cards(3), intent: probe([create('card', 'card0009', s(5000), { title: 'Four' })]) }),
    admitted('a create below the cap is admitted and counted', { state: cards(2), intent: probe([create('card', 'card0009', s(5000), { title: 'Three' })]) }),
    admitted('a create and a delete in one intent at the cap are admitted', { state: cards(3), intent: probe([kill(1), create('card', 'card0009', s(5000), { title: 'Swap' })]) }),
    admitted('an update over the cap is admitted (it does not raise the count)', { state: cards(4), intent: probe([update('card', 'card0001', s(1000), s(5000), { title: 'Edit' })]) }),
    admitted('a create over the cap is refused cap', { state: cards(4), intent: probe([create('card', 'card0009', s(5000), { title: 'Five' })]) }),
    admitted('a create and a delete over the cap keep the count and are admitted', { state: cards(4), intent: probe([kill(1), create('card', 'card0009', s(5000), { title: 'Swap' })]) }),
    admitted('a delete over the cap is admitted', { state: cards(4), intent: probe([kill(2)]) }),
    admitted('a replayed create at the cap does not grow the count', { state: cards(3), intent: probe([create('card', 'card0001', s(1000), { title: 'C1' })]) }),
  ];
}

function lifecycle() {
  const empty = serverState({ scopes: { [PROBE_A]: productScope('A') } });
  const tree = treeState();
  const withOverlays = serverState({
    scopes: {
      [PROBE_A]: productScope('A'),
      [TREE]: treeScope('A', BOARD),
      [OVERLAY_A]: overlayScope('A', BOARD),
      [OVERLAY_B]: overlayScope('B', BOARD),
      'tree:b_00000002': treeScope('A', 'b_00000002'),
      'acct:A/overlay/b_00000002': overlayScope('A', 'b_00000002'),
    },
    rows: {
      [PROBE_A]: [row({ t: 'board', id: BOARD, life: ['alive', s(2000)], born: s(2000), seq: 1 }), row({ t: 'board', id: 'b_00000002', life: ['alive', s(2050)], born: s(2050), seq: 2 })],
      [TREE]: [row({ t: 'meta', id: 'meta', f: { title: ['Plan', s(2000)], visibility: ['public', SRV(2500)] }, seq: 1 })],
      [OVERLAY_B]: [row({ t: 'mark', id: 'oak', f: { done: [true, s(2400, 0, OTHER)] }, seq: 1 })],
    },
  });
  const deadBoard = treeState({ dead: true });
  return [
    admitted('a governing create inserts its tree scope at seq 0 with digest 0', { state: empty, intent: probe([create('board', 'b_00000009', s(5000))]) }),
    admitted('a replayed governing create inserts nothing', { state: tree, intent: probe([create('board', BOARD, s(2000))]) }),
    admitted('a governing delete kills its tree and every overlay of it, and no other', {
      state: withOverlays,
      intent: probe([{ t: 'board', id: BOARD, born: s(2000), life: ['dead', s(5000)] }]),
    }),
    admitted('a write to the dead tree is scope-dead for its owner', { state: deadBoard, intent: intent(`tree/${BOARD}`, [{ t: 'meta', id: 'meta', f: { title: ['x', s(9500)] } }]) }),
    admitted('a governing create onto its dead id is ok without a change', { state: deadBoard, intent: probe([create('board', BOARD, s(2000))]) }),
    admitted('a revive of a dead governing record is id-spent', { state: deadBoard, intent: probe([{ t: 'board', id: BOARD, born: s(2000), life: ['alive', s(9500)] }]) }),
    admitted('a new governing id after a death creates a new scope', { state: deadBoard, intent: probe([create('board', 'b_00000003', s(9500))]) }),
    admitted('a command writing into a scope it creates (a copy of an empty tree) leaves the new scope at seq 0 with digest 0', {
      state: serverState({ scopes: { [PROBE_A]: productScope('A'), 'tree:b_00000005': treeScope('A', 'b_00000005') }, rows: { [PROBE_A]: [row({ t: 'board', id: 'b_00000005', life: ['alive', s(2000)], born: s(2000), seq: 1 })] } }),
      intent: { scope: 'self/probe', cmd: { name: 'probe.copy', args: { src: 'b_00000005', dst: 'b_00000006' } } },
    }),
  ];
}

function text() {
  const ov = (rows, extra = {}) => serverState({
    scopes: { [PROBE_A]: productScope('A'), [TREE]: treeScope('A', BOARD), [OVERLAY_A]: overlayScope('A', BOARD) },
    rows: {
      [PROBE_A]: [row({ t: 'board', id: BOARD, life: ['alive', s(2000)], born: s(2000), seq: 1 })],
      [TREE]: [row({ t: 'tag', id: 'oak', life: ['alive', s(2100)], born: s(2100), seq: 1 })],
      [OVERLAY_A]: rows,
    },
    ...extra,
  });
  const memo = (text, rev, merged = false, seq = rev) => row({ t: 'mark', id: 'oak', x: { memo: { text, rev, merged } }, seq });
  const write = (text, base) => intent(`self/overlay/${BOARD}`, [{ t: 'mark', id: 'oak', x: { memo: { text, base } } }]);
  const withRevision = ov([memo('red green blue', 4)], { revisions: { [OVERLAY_A]: [{ t: 'mark', id: 'oak', field: 'memo', rev: 2, text: 'red blue' }] } });
  return [
    admitted('a first write with an empty base stores mine at this seq', { state: ov([]), intent: write('red blue', { text: '' }) }),
    admitted('a base naming the head rev takes mine and keeps the old head as a revision', { state: ov([memo('red blue', 1)]), intent: write('red blue green', { rev: 1 }) }),
    admitted('a base naming a kept older rev merges with diff3', { state: withRevision, intent: write('pink red blue', { rev: 2 }) }),
    admitted('a base naming a pruned rev is base-unknown', { state: withRevision, intent: write('pink red blue', { rev: 1 }) }),
    admitted('a base naming a future rev is base-unknown', { state: ov([memo('red blue', 1)]), intent: write('red', { rev: 9 }) }),
    admitted('a base rev beyond the safe integers is invalid', { state: ov([memo('red blue', 1)]), intent: write('red', { rev: 2 ** 53 }) }),
    admitted('a base text other than the head merges with diff3', { state: ov([memo('red green blue', 3)]), intent: write('red blue gold', { text: 'red blue' }) }),
    admitted('changes on both sides of one region conflict and set merged', { state: ov([memo('red green blue', 3)]), intent: write('red gold blue', { text: 'red blue' }) }),
    admitted('a write based on the head clears merged', { state: ov([memo('red green\n\ngold blue', 3, true)]), intent: write('red gold blue', { rev: 3 }) }),
    admitted('a clean merge over a merged head keeps merged', {
      state: ov([memo('red green\n\ngold blue', 3, true)], { revisions: { [OVERLAY_A]: [{ t: 'mark', id: 'oak', field: 'memo', rev: 2, text: 'red green blue' }] } }),
      intent: write('red green blue pink', { rev: 2 }),
    }),
    admitted('mine equal to the head changes nothing and takes no seq', { state: ov([memo('red blue', 1)]), intent: write('red blue', { text: 'red' }) }),
    admitted('an empty base with mine extending the head takes mine', { state: ov([memo('red blue', 1)]), intent: write('red blue green', { text: '' }) }),
    admitted('an empty base with the head extending mine keeps the head', { state: ov([memo('red blue green', 1)]), intent: write('red blue', { text: '' }) }),
    admitted('an empty base extending neither side merges from empty', { state: ov([memo('red blue', 1)]), intent: write('gold', { text: '' }) }),
    admitted('a merge result over 40 bytes is too-large', { state: ov([memo('aaaaaaaaaa bbbbbbbbbb', 3)]), intent: write('cccccccccc dddddddddd', { text: 'aaaaaaaaaa' }) }),
    admitted('mine over 40 bytes is too-large', { state: ov([]), intent: write('x'.repeat(41), { text: '' }) }),
    admitted('a text write and a register write on one record apply together', {
      state: ov([memo('red', 1)]),
      intent: intent(`self/overlay/${BOARD}`, [{ t: 'mark', id: 'oak', f: { done: [true, s(5000)] }, x: { memo: { text: 'red blue', base: { rev: 1 } } } }]),
    }),
  ];
}

function serverStamps() {
  const future = serverState({
    clock: { ms: 900_000, counter: 7 },
    scopes: { [PROBE_A]: productScope('A') },
    rows: { [PROBE_A]: [card('card0001', { title: ['Hi', s(1_200_000, 5)], body: ['Body', s(1000)] }), card('card0002', { born: s(1001), title: 'Two', seq: 2 })] },
  });
  const ahead = serverState({
    clock: { ms: 2_000_000, counter: 3 },
    scopes: { [PROBE_A]: productScope('A') },
    rows: { [PROBE_A]: [card('card0001', { title: 'Hi' })] },
  });
  return [
    admitted('a server delta takes one tick after the stored registers it overwrites', {
      state: future,
      origin: SERVER_A,
      intent: probe([{ t: 'card', id: 'card0001', born: s(1000), f: { title: [ 'Srv', null ] } }]),
    }),
    admitted('two server deltas of one intent share one stamp', {
      state: future,
      origin: SERVER_A,
      intent: probe([{ t: 'card', id: 'card0001', born: s(1000), f: { body: ['B', null] } }, { t: 'card', id: 'card0002', born: s(1001), f: { title: ['T', null] } }]),
    }),
    admitted('a server clock ahead of serverNow ticks its counter', { state: ahead, origin: SERVER_A, intent: probe([{ t: 'card', id: 'card0001', born: s(1000), f: { title: ['Srv', null] } }]) }),
    admitted('a server create takes the stamp for born, life and fields', {
      state: serverState({ scopes: { [PROBE_A]: productScope('A') } }),
      origin: SERVER_A,
      intent: probe([{ t: 'card', id: 'card0009', born: null, life: ['alive', null], f: { title: ['Srv', null], tier: ['draft', null] } }]),
    }),
    admitted('a server delta observes a same-intent client delta on its register, so the server delta wins', {
      state: serverState({ clock: { ms: 1300, counter: 0 }, scopes: { [PROBE_A]: productScope('A') }, rows: { [PROBE_A]: [run('run00001', {}), lap('lap00001', {})] } }),
      intent: probe([
        { t: 'run', id: 'run00001', born: SRV(1100), life: ['dead', s(NOW)] },
        { t: 'lap', id: 'lap00001', born: s(1200), life: ['dead', s(NOW + 200_000, 4)] },
      ]),
    }),
    admitted('a consequence stamped after the join observes a stored future (admissible) stamp it overwrites, so the server write wins', {
      state: serverState({ clock: { ms: 1300, counter: 0 }, scopes: { [PROBE_A]: productScope('A') }, rows: { [PROBE_A]: [run('run00001', {}), lap('lap00001', { born: s(1200), life: ['alive', s(NOW + 250_000, 3)] })] } }),
      intent: probe([{ t: 'run', id: 'run00001', born: SRV(1100), life: ['dead', s(NOW)] }]),
    }),
    admitted('a server write refused at identity mints nothing', {
      state: future,
      origin: SERVER_A,
      intent: probe([{ t: 'card', id: 'card0003', born: s(1), f: { title: ['Srv', null] } }]),
    }),
  ];
}

function requests() {
  const base = serverState({ scopes: { [PROBE_A]: productScope('A') } });
  const createCard = (id, title) => probe([{ t: 'card', id, born: null, life: ['alive', null], f: { title: [title, null] } }]);
  const call = (extra) => ({ account: 'A', requestId: 'req-1', tool: 'cards.add', args: { titles: ['One', 'Two'] }, intents: [createCard('card0001', 'One'), createCard('card0002', 'Two')], serverNow: NOW, ...extra });
  const sequence = (name, state, calls) => {
    let current = new ServerState(state);
    const results = [];
    for (const input of calls) {
      const out = serverCall({ state: current, registry, product, ...input });
      current = out.state;
      results.push(out.result ?? null);
    }
    return vector(name, { state, calls }, { results, state: current.toJSON() });
  };
  return [
    sequence('a call without a requestId is not deduplicated', base, [
      { account: 'A', tool: 'cards.add', args: { titles: ['One'] }, intents: [createCard('card0001', 'One')], serverNow: NOW },
      { account: 'A', tool: 'cards.add', args: { titles: ['One'] }, intents: [createCard('card0001', 'One')], serverNow: NOW + 1 },
    ]),
    sequence('a fresh call runs every admit and stores its final result', base, [call({})]),
    sequence('a replay with the same digest answers the stored result', base, [call({}), call({ serverNow: NOW + 5000 })]),
    sequence('a replay with other arguments is request-conflict', base, [call({}), call({ args: { titles: ['One', 'Three'] }, intents: [createCard('card0001', 'One'), createCard('card0003', 'Three')] })]),
    sequence('a call running within its lease answers request-running', base, [call({ crashAfter: 1 }), call({ serverNow: NOW + CONSTANTS.REQUEST_LEASE_MS - 1 })]),
    sequence('a call running past its lease is taken over and resumes after its stored parts', base, [call({ crashAfter: 1 }), call({ serverNow: NOW + CONSTANTS.REQUEST_LEASE_MS })]),
    sequence('a transient failure of admit 2 leaves the row running, so a retry within the lease is request-running', base, [call({ transientAt: 2 }), call({ serverNow: NOW + 1 })]),
    sequence('after a transient failure the lease lapses, and the call resumes after its stored part', base, [call({ transientAt: 2 }), call({ serverNow: NOW + CONSTANTS.REQUEST_LEASE_MS })]),
    sequence('a takeover whose first admit fails transiently leaves the lease as it was, so the next retry takes over at once', base, [
      call({ crashAfter: 1 }),
      call({ serverNow: NOW + CONSTANTS.REQUEST_LEASE_MS, transientAt: 2 }),
      call({ serverNow: NOW + CONSTANTS.REQUEST_LEASE_MS + 1 }),
    ]),
    sequence('an admit that faults ends the call refused internal, stored as done, and a replay answers it', base, [call({ faultAt: 2 }), call({ serverNow: NOW + 1 })]),
    sequence('an empty requestId is invalid, and nothing is stored', base, [call({ requestId: '' })]),
    sequence('a requestId holding # is invalid', base, [call({ requestId: 'req#1' })]),
    sequence('a requestId holding U+0000 is invalid', base, [call({ requestId: 'req\u00001' })]),
    sequence('a crash right after the last part leaves the row running; a retry after the lease replays both parts and writes the result', base, [
      call({ crashAfter: 2 }),
      call({ serverNow: NOW + 1 }),
      call({ serverNow: NOW + CONSTANTS.REQUEST_LEASE_MS }),
    ]),
    sequence('a resumed call stops at a stored refused part, which is its result, and runs no later admit', base, [
      { ...call({ crashAfter: 2 }), intents: [createCard('card0001', 'One'), createCard('card0002', ''), createCard('card0003', 'Three')] },
      { ...call({ serverNow: NOW + CONSTANTS.REQUEST_LEASE_MS }), intents: [createCard('card0001', 'One'), createCard('card0002', ''), createCard('card0003', 'Three')] },
    ]),
    sequence('a refused admit ends the call with that result', base, [
      { ...call({}), intents: [createCard('card0001', 'One'), createCard('card0002', '')] },
      { ...call({}), intents: [createCard('card0001', 'One'), createCard('card0002', '')], serverNow: NOW + 1 },
    ]),
  ];
}

// §6.1 step 9's bound, shrunk through `input.limits`: the joined row as it will be stored, at the next
// seq with rc, ru and text revs, and never a text base.
function recordBound() {
  const empty = serverState({ scopes: { [PROBE_A]: productScope('A') } });
  const cardIntent = probe([create('card', 'card0009', s(5000), { title: 'Bounded', body: 'twelve bytes' })]);
  const storedBytes = (state, intent) => {
    const out = admit({ state: new ServerState(state), registry, product, origin: A, intent, serverNow: NOW });
    const key = intent.scope === 'self/probe' ? PROBE_A : OVERLAY_A;
    const [t, id] = [intent.d[0].t, intent.d[0].id];
    return Buffer.byteLength(jcs(out.state.toJSON().rows[key].find((r) => r.t === t && r.id === id)), 'utf8');
  };
  const cardBytes = storedBytes(empty, cardIntent);
  const trees = treeState();
  const longBase = intent(`self/overlay/${BOARD}`, [{ t: 'mark', id: 'ash', x: { memo: { text: 'short', base: { text: 'a long draft '.repeat(40) } } } }]);
  const markBytes = storedBytes(trees, longBase);
  const runs = serverState({ scopes: { [PROBE_A]: productScope('A') }, rows: { [PROBE_A]: [run('run00001', {})] } });
  const lapIntent = probe([create('lap', 'lap00009', s(5000), { runId: 'run00001', at: 5000, weight: 1 })]);
  const lapRow = admit({ state: new ServerState(runs), registry, product, origin: A, intent: lapIntent, serverNow: NOW }).state.toJSON().rows[PROBE_A].find((r) => r.id === 'lap00009');
  const { v, ...lapWithoutSerial } = lapRow;
  const lapBytes = Buffer.byteLength(jcs(lapWithoutSerial), 'utf8');
  const cards = baseState();
  const unchanged = probe([update('card', 'card0001', s(1000), s(1000), { title: 'Hi' })]);
  const copying = serverState({
    scopes: { [PROBE_A]: productScope('A'), [TREE]: treeScope('A', BOARD) },
    rows: {
      [PROBE_A]: [row({ t: 'board', id: BOARD, life: ['alive', s(2000)], born: s(2000), seq: 1 })],
      [TREE]: [row({ t: 'meta', id: 'meta', f: { title: ['Plan', s(2000)] }, seq: 1 }), row({ t: 'tag', id: 'oak', life: ['alive', s(2100)], born: s(2100), f: { label: ['Oak', s(2100)] }, seq: 2 })],
    },
  });
  const copy = { scope: 'self/probe', cmd: { name: 'probe.copy', args: { src: BOARD, dst: 'b_00000002' } } };
  const copied = admit({ state: new ServerState(copying), registry, product, origin: A, intent: copy, serverNow: NOW }).state.toJSON();
  const boardBytes = Buffer.byteLength(jcs(copied.rows[PROBE_A].find((r) => r.id === 'b_00000002')), 'utf8');
  return [
    admitted('a joined row exactly at MAX_RECORD_BYTES as stored is admitted', { state: empty, intent: cardIntent, limits: { MAX_RECORD_BYTES: cardBytes } }),
    admitted('a joined row one byte over MAX_RECORD_BYTES as stored is too-large', { state: empty, intent: cardIntent, limits: { MAX_RECORD_BYTES: cardBytes - 1 } }),
    admitted('a text base longer than the bound does not count toward it', { state: trees, intent: longBase, limits: { MAX_RECORD_BYTES: markBytes } }),
    admitted('a new record is measured before step 11 numbers it: its serial does not count', { state: runs, intent: lapIntent, limits: { MAX_RECORD_BYTES: lapBytes } }),
    admitted('a new record one byte over the bound before its serial is too-large', { state: runs, intent: lapIntent, limits: { MAX_RECORD_BYTES: lapBytes - 1 } }),
    admitted('a write that changes nothing is not measured', { state: cards, intent: unchanged, limits: { MAX_RECORD_BYTES: 16 } }),
    admitted('a row a command writes into a scope the intent creates is measured too', { state: copying, intent: copy, limits: { MAX_RECORD_BYTES: boardBytes } }),
  ];
}

export function files() {
  return {
    'admit/shape.json': shape(),
    'admit/access.json': access(),
    'admit/identity.json': [...identity(), ...deletesBeforeCreates()],
    'admit/guards.json': guards(),
    'admit/commands.json': commands(),
    'admit/check.json': check(),
    'admit/serial.json': serial(),
    'admit/caps.json': caps(),
    'admit/lifecycle.json': lifecycle(),
    'admit/text.json': text(),
    'admit/server-stamps.json': serverStamps(),
    'admit/requests.json': requests(),
    'admit/record-bound.json': recordBound(),
  };
}
