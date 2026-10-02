import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { CONSTANTS } from '../../core/constants.js';
import { ZERO_DIGEST, replaceRow } from '../../core/digest.js';
import { jcs } from '../../core/jcs.js';
import { isAlive } from '../../core/rows.js';
import { backfill } from '../../gym/backfill.js';
import { admit } from '../../server/admit.js';
import { pull } from '../../server/pull.js';
import { ServerState } from '../../server/state.js';
import { gymProduct, gymRegistry } from '../../vectors/gym.js';

const load = (file) => JSON.parse(readFileSync(new URL(`../../../corpus/gym/${file}`, import.meta.url), 'utf8'));

test('gym/admit.json replays through admit under gym.registry.json and gym\'s binding', () => {
  for (const { name, input, expect } of load('admit.json')) {
    const outcome = admit({ state: new ServerState(input.state), registry: gymRegistry, product: gymProduct, origin: input.origin, intent: input.intent, serverNow: input.serverNow, limits: CONSTANTS });
    assert.equal(jcs(outcome.result), jcs(expect.result), name);
    assert.equal(jcs(outcome.state.toJSON()), jcs(expect.state), name);
  }
});

test('gym.start treats prototype names as ids and stores own receipts through restart', () => {
  for (const id of ['constructor', 'toString', 'hasOwnProperty', '__proto__']) {
    const input = load('admit.json').find((v) => v.input.intent.cmd?.name === 'gym.start' && v.expect.result.s === 'ok').input;
    input.intent.cmd.args.id = id;
    const first = admit({ ...input, state: new ServerState(input.state), registry: gymRegistry, product: gymProduct });
    assert.equal(first.result.s, 'ok', id);
    assert.ok(first.result.write.some((w) => w.id === id), id);
    const key = 'acct:A/gym';
    assert.equal(Object.hasOwn(first.state.product.starts[key], id), true, id);
    const again = admit({ ...input, state: new ServerState(first.state.toJSON()), registry: gymRegistry, product: gymProduct });
    assert.equal(again.result.s, 'ok', id);
    assert.deepEqual(again.state.toJSON(), first.state.toJSON(), id);
  }
});

for (const [name, arg, ledger] of [['gym.importSession', 'id', 'imports'], ['gym.correctSession', 'requestId', 'corrections']]) {
  test(`${name} __proto__ receipts survive restart and pin payloads`, () => {
    const input = load('admit.json').find((v) => v.input.intent.cmd?.name === name && v.expect.result.s === 'ok').input;
    input.intent.cmd.args[arg] = '__proto__';
    const first = admit({ ...input, state: new ServerState(input.state), registry: gymRegistry, product: gymProduct });
    assert.equal(first.result.s, 'ok', name);
    assert.equal(Object.hasOwn(first.state.product[ledger]['acct:A/gym'], '__proto__'), true, name);
    const again = admit({ ...input, state: new ServerState(first.state.toJSON()), registry: gymRegistry, product: gymProduct });
    assert.equal(again.result.s, 'ok', name);
    assert.deepEqual(again.state.toJSON(), first.state.toJSON(), name);
    input.intent.cmd.args.startedAt -= 1;
    assert.equal(admit({ ...input, state: new ServerState(first.state.toJSON()), registry: gymRegistry, product: gymProduct }).result.code, 'payload-conflict', name);
  });
}

test('gym routine revisions and proposal bases retain __proto__ ids as ordinary data', () => {
  const key = 'acct:A/gym';
  const created = load('admit.json').find((v) => v.name === 'a routine created with entries takes revision 1').input;
  created.intent.d[0].id = '__proto__';
  const first = admit({ ...created, state: new ServerState(created.state), registry: gymRegistry, product: gymProduct });
  assert.equal(first.result.s, 'ok');
  assert.equal(Object.hasOwn(first.state.product.revisions[key], '__proto__'), true);
  assert.equal(first.state.product.revisions[key].__proto__, 1);
  // The revision projection can be absent on old stores: its default is 1, not an inherited value.
  delete first.state.product.revisions[key].__proto__;
  const routine = first.state.row(key, 'routine', '__proto__');
  const renamed = admit({ ...created, origin: { kind: 'server', account: 'A' }, state: first.state,
    intent: { scope: 'self/gym', d: [{ t: 'routine', id: '__proto__', born: routine.born, f: { name: ['Renamed', null] } }] },
    registry: gymRegistry, product: gymProduct });
  assert.equal(renamed.result.s, 'ok');
  assert.equal(renamed.state.product.revisions[key].__proto__, 2);
});

test('gym proposal bases store __proto__ ids and default a missing prototype-named routine revision', () => {
  const key = 'acct:A/gym';
  const proposal = load('admit.json').find((v) => v.input.intent.d?.some((d) => d.t === 'proposal') && v.expect.result.s === 'ok').input;
  const delta = proposal.intent.d.find((d) => d.t === 'proposal');
  delta.id = '__proto__';
  delta.f.routineId[0] = '__proto__';
  const state = new ServerState(proposal.state);
  const routine = state.row(key, 'routine', 'routine0001');
  state.deleteRow(key, 'routine', 'routine0001');
  state.putRow(key, { ...routine, id: '__proto__' });
  state.scope(key).digest = state.rowsOf(key).reduce((sum, row) => replaceRow(sum, undefined, row), ZERO_DIGEST);
  const next = admit({ ...proposal, state, registry: gymRegistry, product: gymProduct });
  assert.equal(next.result.s, 'ok');
  assert.equal(Object.hasOwn(next.state.product.bases[key], '__proto__'), true);
  assert.deepEqual(new ServerState(next.state.toJSON()).product.bases[key].__proto__, { revision: 1, name: 'Lower A' });
});

test('gym seed overrides require an own seed and support __proto__ seed ids', () => {
  const input = load('admit.json').find((v) => v.name === "renaming a seed writes its exerciseName, whose aliases take the seed's own name").input;
  input.intent.d[0].id = 'constructor';
  assert.equal(admit({ ...input, state: new ServerState(input.state), registry: gymRegistry, product: gymProduct }).result.code, 'invalid');
  input.intent.d[0].id = '__proto__';
  Object.defineProperty(input.state.product.seeds, '__proto__', { value: { name: 'Original' }, enumerable: true });
  const out = admit({ ...input, state: new ServerState(input.state), registry: gymRegistry, product: gymProduct });
  assert.equal(out.result.s, 'ok');
  assert.deepEqual(out.state.row('acct:A/gym', 'exerciseName', '__proto__').f.aliases[0], ['Original']);
});

test('gym/backfill.json replays through the backfill', () => {
  for (const { name, input, expect } of load('backfill.json')) {
    const next = backfill({ state: new ServerState(input.state), registry: gymRegistry, account: input.account, legacy: input.legacy, M: input.M });
    assert.equal(jcs(next.toJSON()), jcs(expect.state), name);
  }
});

// Appendix C's rehearsal gates, on every backfilled scope of the corpus: the stored digest equals the sum recomputed
// from its rows, a second run changes nothing, and a boot from a null cursor, after the beforePull close of a legacy
// open session gone stale, serves every alive row at the scope's seq with that seq's digest (INV-15's base case).
test('a backfilled scope: its digest is the sum over the rows a pull serves, a rerun is a no-op, a boot reaches it', () => {
  for (const { name, input, expect } of load('backfill.json')) {
    const state = new ServerState(expect.state);
    const key = `acct:${input.account}/gym`;
    const scope = state.scope(key);
    if (!scope) continue;
    const alive = state.rowsOf(key).filter(isAlive);
    assert.equal(alive.reduce((digest, row) => replaceRow(digest, undefined, row), ZERO_DIGEST), scope.digest, name);
    const rerun = backfill({ state, registry: gymRegistry, account: input.account, legacy: input.legacy, M: input.M });
    assert.equal(jcs(rerun.toJSON()), jcs(expect.state), name);
    const served = pull({ state, registry: gymRegistry, product: gymProduct, account: input.account, request: { scopes: [{ scope: 'self/gym', cursor: null }] }, serverNow: input.M + 1, limits: { ...CONSTANTS, PULL_PAGE_BYTES: 1 << 30 } });
    const [page] = served.response.body.pages;
    const after = served.state.scope(key);
    assert.equal(page.more, false, name);
    assert.equal(page.seq, after.seq, name);
    assert.equal(page.digest, after.digest, name);
    assert.equal(page.rows.filter(isAlive).reduce((digest, row) => replaceRow(digest, undefined, row), ZERO_DIGEST), after.digest, name);
  }
});

// Every register the backfill writes carries the one stamp M:0:srv, so every stored stamp is at most the server
// time of the run plus MAX_SKEW_MS (INV-14's base case).
test('the backfill writes one stamp, M:0:srv, in every born, life and register', () => {
  for (const { name, input, expect } of load('backfill.json')) {
    const state = new ServerState(expect.state);
    const stamp = `${input.M}:0:srv`;
    for (const row of state.rowsOf(`acct:${input.account}/gym`)) {
      if (input.state.scopes?.[`acct:${input.account}/gym`]) continue;
      const stamps = [row.born, row.life?.[1], ...Object.values(row.f ?? {}).map((register) => register[1])].filter((value) => value !== undefined);
      assert.ok(stamps.every((value) => value === stamp), `${name}: ${row.t} ${row.id}`);
    }
    for (const entry of state.spentOf(`acct:${input.account}/gym`)) assert.equal(entry.lifeStamp, stamp, name);
  }
});

// C.6 numbers adopted records in the registry's type order, which lists each gym type after the types its ref fields
// and key name, so a boot's rows arrive after the records they reference.
test('gym.registry.json lists each type after the types its references name', () => {
  const order = [...gymRegistry.types.keys()];
  for (const type of gymRegistry.types.values()) {
    const named = [type.key?.ref, ...Object.values(type.fields).map((field) => field.ref)].filter((ref) => ref !== undefined && ref !== type.type);
    for (const ref of named) assert.ok(order.indexOf(ref) < order.indexOf(type.type), `${type.type} names ${ref}`);
  }
});
