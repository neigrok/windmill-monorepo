import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { ZERO_DIGEST, replaceRow } from '../../core/digest.js';
import { audit, auditMetadata, backfill, upgradeMetadata } from '../../gym/backfill.js';
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

const metadata = JSON.parse(readFileSync(new URL('../../../corpus/gym/metadata.json', import.meta.url), 'utf8'))[0].input;
const upgrade = (input = metadata) => upgradeMetadata({ ...input, state: new ServerState(input.state), registry: gymRegistry });
const auditUpgrade = (state, input = metadata) => auditMetadata({ ...input, state, frozen: new ServerState(input.state), registry: gymRegistry });

test('R118 independent audit rejects values, stamps, snapshots and retained receipts with recomputed digests', () => {
  const cases = [
    (state) => { state.row(key, 'routine', 'routine0001').f.revision[0] += 1; },
    (state) => { state.row(key, 'routine', 'routine0001').f.createdEntries[0] += 1; },
    (state) => { state.row(key, 'proposal', 'proposal001').f.baseRevision[0] += 1; },
    (state) => { state.row(key, 'proposal', 'proposal001').f.baseName[0] = 'Current instead of frozen'; },
    (state) => { state.row(key, 'proposal', 'proposal001').f.changeCount[0] = 1; },
    (state) => { state.row(key, 'note', 'note0000001').f.updatedAt[0] = metadata.M; },
    (state) => { state.row(key, 'note', 'note0000001').f.updatedAt[1] = `${metadata.M + 1}:0:srv`; },
    (state) => { state.row(key, 'routineCreation', 'routine0002').f.snapshot[0].name = 'Invented'; },
    (state) => { state.row(key, 'routine', 'routine0001').f.entries[1] = `${metadata.M}:0:srv`; },
    (state) => { state.row(key, 'note', 'note0000001').ru += 1; },
    (state) => { state.row(key, 'routine', 'routine0001').seq += 1; },
    (state) => { state.spentOf(key)[0].seq += 1; },
    (state) => { state.product.starts[key].session0001 = 'Other'; },
    (state) => { state.scope(key).counters.note += 1; },
    (state) => { state.product.gymMetadataUpgrades[key].M += 1; },
  ];
  for (const corrupt of cases) {
    const state = upgrade();
    corrupt(state);
    redigest(state);
    assert.throws(() => auditUpgrade(state), /gym metadata audit/);
  }
});

test('R118 source failure is atomic and a committed marker refuses a changed manifest or clock', () => {
  const frozen = new ServerState(metadata.state);
  const before = frozen.toJSON();
  const incomplete = structuredClone(metadata.source);
  incomplete.proposals[0].baseRevision = null;
  assert.throws(() => upgradeMetadata({ ...metadata, state: frozen, source: incomplete, registry: gymRegistry }), /missing value/);
  assert.deepEqual(frozen.toJSON(), before);
  const state = upgrade();
  assert.throws(() => upgradeMetadata({ ...metadata, state, M: metadata.M + 1, registry: gymRegistry }), /manifest mismatch/);
  assert.throws(() => upgradeMetadata({ ...metadata, state, source: incomplete, registry: gymRegistry }), /manifest mismatch/);
  assert.deepEqual(upgradeMetadata({ ...metadata, state, registry: gymRegistry }).toJSON(), state.toJSON());
});

test('R118 independent audit refuses incomplete and duplicate source rosters', () => {
  const candidates = [
    (source) => { source.routines[0].revision = null; },
    (source) => { delete source.proposals[0].baseName; },
    (source) => { source.notes.push(source.notes[0]); },
    (source) => { source.routineCreations.push(source.routineCreations[0]); },
    (source) => { source.routineCreations[0].snapshot = null; },
  ];
  for (const corrupt of candidates) {
    const input = structuredClone(metadata);
    corrupt(input.source);
    assert.throws(() => auditUpgrade(upgrade(), input), /gym metadata audit/);
  }
});
