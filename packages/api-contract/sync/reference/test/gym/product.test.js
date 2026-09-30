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
