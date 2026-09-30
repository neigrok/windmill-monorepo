import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import { CONSTANTS } from '../../core/constants.js';
import { jcs } from '../../core/jcs.js';
import { latticeOf } from '../../core/rows.js';
import { admit } from '../../server/admit.js';
import { serverCall } from '../../server/requests.js';
import { ServerState } from '../../server/state.js';
import { Rng, overlayScope, product, productScope, registry, row, serverState, treeScope } from '../../vectors/fixtures.js';

const CORPUS = new URL('../../../corpus/admit/', import.meta.url);

for (const file of readdirSync(CORPUS).filter((name) => name.endsWith('.json') && name !== 'requests.json').sort()) {
  test(`admit/${file} replays through admit`, () => {
    for (const { name, input, expect } of JSON.parse(readFileSync(new URL(file, CORPUS), 'utf8'))) {
      const limits = { ...CONSTANTS, ...(input.limits ?? {}) };
      const outcome = admit({ state: new ServerState(input.state), registry, product, origin: input.origin, intent: input.intent, serverNow: input.serverNow, limits });
      assert.equal(jcs(outcome.result), jcs(expect.result), name);
      assert.equal(jcs(outcome.state.toJSON()), jcs(expect.state), name);
    }
  });
}

test('admit/requests.json replays through serverCall', () => {
  for (const { name, input, expect } of JSON.parse(readFileSync(new URL('requests.json', CORPUS), 'utf8'))) {
    let state = new ServerState(input.state);
    const results = input.calls.map((call) => {
      const out = serverCall({ state, registry, product, ...call });
      state = out.state;
      return out.result ?? null;
    });
    assert.equal(jcs(results), jcs(expect.results), name);
    assert.equal(jcs(state.toJSON()), jcs(expect.state), name);
  }
});

test('admission never changes the state it was given', () => {
  const state = serverState({ scopes: { 'acct:A/probe': productScope('A') } });
  const before = jcs(state);
  const input = new ServerState(state);
  admit({ state: input, registry, product, origin: { kind: 'replica', account: 'A' }, serverNow: 5000, intent: { scope: 'self/probe', d: [{ t: 'card', id: 'card0001', born: '10:0:r_a', life: ['alive', '10:0:r_a'], f: { title: ['T', '10:0:r_a'] } }] } });
  assert.equal(jcs(input.toJSON()), before);
});

// §11.2 #4: the lattice fields after admitting a set of intents of one record without a guard or a
// command, none of them refused, are the same in every order. The records exist beforehand; revives and deletes of a tag interleave freely.
test('any permutation of non-refused one-record intents without guards or commands yields equal lattice fields', () => {
  const board = 'b_00000001';
  const born = '100:0:r_seed';
  const base = serverState({
    scopes: { 'acct:A/probe': productScope('A'), [`tree:${board}`]: treeScope('A', board), [`acct:A/overlay/${board}`]: overlayScope('A', board) },
    rows: {
      'acct:A/probe': ['card0001', 'card0002'].map((id, i) => row({ t: 'card', id, life: ['alive', born], born, f: { title: ['T', born] }, seq: i + 1 })),
      [`tree:${board}`]: [
        row({ t: 'meta', id: 'meta', f: { title: ['M', born] }, seq: 1 }),
        row({ t: 'tag', id: 'oak', life: ['alive', born], born, seq: 2 }),
        row({ t: 'tag', id: 'ash', life: ['alive', born], born, seq: 3 }),
      ],
    },
  });
  const actors = ['r_aaaaaaaaaaaa', 'r_bbbbbbbbbbbb', 'srvlike'];
  const values = { title: ['a', 'b', 'c'], claim: ['x', 'y'], tier: ['draft', 'review', 'done', 'dropped'], size: [1, 2.5, null] };
  for (let seed = 1; seed <= 60; seed += 1) {
    const rng = new Rng(seed);
    const stamp = () => `${200 + rng.int(4)}:${rng.int(2)}:${rng.pick(actors)}`;
    const intents = [];
    for (let i = 0; i < 9; i += 1) {
      const kind = rng.int(5);
      if (kind === 0) {
        const field = rng.pick(Object.keys(values));
        intents.push({ scope: 'self/probe', d: [{ t: 'card', id: rng.pick(['card0001', 'card0002']), born, f: { [field]: [rng.pick(values[field]), stamp()] } }] });
      } else if (kind === 1) {
        intents.push({ scope: `tree/${board}`, d: [{ t: 'tag', id: rng.pick(['oak', 'ash']), born, life: [rng.pick(['alive', 'dead']), stamp()] }] });
      } else if (kind === 2) {
        intents.push({ scope: `tree/${board}`, d: [{ t: 'link', id: [rng.pick(['oak', 'ash']), rng.pick(['oak', 'ash'])], life: [rng.pick(['alive', 'dead']), stamp()] }] });
      } else if (kind === 3) {
        intents.push({ scope: `self/overlay/${board}`, d: [{ t: 'mark', id: rng.pick(['oak', 'ash']), f: { done: [rng.pick([true, false, null]), stamp()] } }] });
      } else {
        intents.push({ scope: `tree/${board}`, d: [{ t: 'meta', id: 'meta', f: { title: [rng.pick(values.title), stamp()] } }] });
      }
    }
    const lattice = (order) => {
      let state = new ServerState(base);
      for (const index of order) {
        const outcome = admit({ state, registry, product, origin: { kind: 'replica', account: 'A' }, intent: intents[index], serverNow: 10_000 });
        assert.equal(outcome.result.s, 'ok', `seed ${seed}: ${jcs(intents[index])} was refused ${outcome.result.code}`);
        state = outcome.state;
      }
      const out = {};
      for (const [scope, map] of Object.entries(state.rows)) {
        for (const record of Object.values(map)) out[jcs([scope, record.t, record.id])] = latticeOf(record);
      }
      return jcs(out);
    };
    const identity = intents.map((_, index) => index);
    const expected = lattice(identity);
    for (let k = 0; k < 6; k += 1) {
      const order = [...identity];
      for (let i = order.length - 1; i > 0; i -= 1) {
        const j = rng.int(i + 1);
        [order[i], order[j]] = [order[j], order[i]];
      }
      assert.equal(lattice(order), expected, `seed ${seed}, order ${order.join(',')}`);
    }
  }
});

test('§4.3: a delete onto dead = joins, so two deletes and a revive between them land alike in any order', () => {
  const board = 'b_00000001';
  const born = '100:0:r_seed';
  const base = serverState({
    scopes: { 'acct:A/probe': productScope('A'), [`tree:${board}`]: treeScope('A', board) },
    rows: { [`tree:${board}`]: [row({ t: 'tag', id: 'oak', life: ['alive', born], born, seq: 1 })] },
  });
  const tag = (life) => ({ scope: `tree/${board}`, d: [{ t: 'tag', id: 'oak', born, life }] });
  const late = tag(['dead', '202:0:r_aaaaaaaaaaaa']);
  const early = tag(['dead', '200:0:r_bbbbbbbbbbbb']);
  const revive = tag(['alive', '201:0:r_cccccccccccc']);
  const lifeAfter = (order) => {
    let state = new ServerState(base);
    for (const intent of order) state = admit({ state, registry, product, origin: { kind: 'replica', account: 'A' }, intent, serverNow: 10_000 }).state;
    return state.row(`tree:${board}`, 'tag', 'oak').life;
  };
  for (const order of [[early, late, revive], [late, early, revive], [revive, early, late], [early, revive, late]]) {
    assert.deepEqual(lifeAfter(order), ['dead', '202:0:r_aaaaaaaaaaaa']);
  }
});
