import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { ZERO_DIGEST, replaceRow } from '../../core/digest.js';
import { audit, backfill } from '../../gym/backfill.js';
import { ServerState } from '../../server/state.js';
import { gymRegistry } from '../../vectors/gym.js';

const vectors = JSON.parse(readFileSync(new URL('../../../corpus/gym/backfill.json', import.meta.url), 'utf8'));
const key = 'acct:A/gym';
const adopt = (input) => backfill({ ...input, state: new ServerState(input.state), registry: gymRegistry });
const auditInput = (input, state) => ({ ...input, state, registry: gymRegistry, seeds: input.state.product.seeds });
const redigest = (state) => {
  state.scope(key).digest = state.rowsOf(key).reduce((digest, row) => replaceRow(digest, undefined, row), ZERO_DIGEST);
};

test('gym adoption audit checks the frozen roster, receipts and M for every account shape', () => {
  for (const { name, input } of vectors) assert.equal(audit(auditInput(input, adopt(input))), true, name);
});

test('gym adoption audit rejects corrupted envelope stamps even with a recomputed digest and no-op rerun', () => {
  const input = vectors[0].input;
  const future = `${input.M + 10000000}:0:srv`;
  const cases = [
    ['envelope', (state) => { Object.values(state.rowsOf(key)[0].f)[0][1] = future; }],
    ['register identities', (state) => { delete state.row(key, 'routine', 'routine0001').f.entries; }],
    ['born', (state) => { state.row(key, 'routine', 'routine0001').born = future; }],
    ['life', (state) => { state.row(key, 'routine', 'routine0001').life[1] = future; }],
    ['spent born', (state) => { state.spentOf(key)[0].born = future; }],
    ['spent life', (state) => { state.spentOf(key)[0].lifeStamp = future; }],
    ['rc', (state) => { state.row(key, 'routine', 'routine0001').rc += 1; }],
    ['ru', (state) => { state.row(key, 'routine', 'routine0001').ru += 1; }],
  ];
  for (const [label, corrupt] of cases) {
    const state = adopt(input);
    corrupt(state);
    redigest(state);
    assert.deepEqual(backfill({ ...input, state, registry: gymRegistry }).toJSON(), state.toJSON());
    assert.throws(() => audit(auditInput(input, state)), new RegExp(label), label);
  }
});
