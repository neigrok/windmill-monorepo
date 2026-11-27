// @ts-check
// A proposal's rules beyond the corpus's cases: the ops' rows and the Shape rule held to the catalog, a name of a ref's
// form, and the caps too large to hold as a case: a roadmap's steps and links, and a base past its 262,144 bytes.

import assert from 'node:assert/strict';
import test from 'node:test';
import { jcsBytes } from '../../../../../../packages/api-contract/sync/reference/core/jcs.js';
import { Catalog, JsonSchema } from '../../../../../src/platform/domain-kit/abilities.js';
import { ProposalAbilities, ProposalOps } from '../../../../../src/products/roadmap/domain/abilities/proposals.js';
import { Contract } from '../../../../platform/domain-kit/vectors.js';

/** @typedef {import('../../../../../src/products/roadmap/domain/records.js').TreeInput} TreeInput */

const T = 't_0000000000000001';
const propose = ProposalAbilities.propose_roadmap_change;

// A roadmap of the person's own: `a` done, `b` available, `c` waiting on both.
/** @param {Partial<TreeInput>} [changes] @returns {any} */
function sailing(changes = {}) {
  return { trees: [{ id: T, own: true, meta: { title: 'Learn to sail' },
    nodes: [{ id: 'a', ord: 'a0', label: 'Leave the dock' }, { id: 'b', ord: 'a1', label: 'Tie a bowline' }, { id: 'c', ord: 'a2', label: 'Sail with an instructor' }],
    edges: [{ from: 'a', to: 'c', present: true }, { from: 'b', to: 'c', present: true }],
    kinds: [{ id: 'build', hue: 'terracotta', label: 'Build', ord: 'a0' }, { id: 'learn', hue: 'olive', label: 'Learn', ord: 'a1' }],
    marks: [{ node: 'a', status: 'complete', recordedAt: 1_800_000_000_000, deviceAt: 1_800_000_000_000 }], ...changes }] };
}

/** @param {any} standing @param {any[]} changes */
function proposing(standing, changes) {
  const minted = ['Pq7Rk2Xw9Lm4Nb6T', 'k1x9q2m7p4z8w3r5', 't6v2n8c4j1b9h7d3'];
  return propose(standing, { treeId: T, changes }, T, () => /** @type {string} */ (minted.shift()));
}

const catalog = new Catalog(Contract.json('roadmap/catalog.json'));
const ability = catalog.ability('propose_roadmap_change');

test('each op takes the fields the catalog\'s line of it names, required and optional', () => {
  const lines = Object.fromEntries(String(ability?.description).split('\n').flatMap((line) => {
    const row = /^(\w+): required ([^;]+); optional ([^.]+)\./.exec(line);
    /** @param {string} list */
    const names = (list) => (list === 'none' ? [] : list.split(', '));
    return row ? [[row[1], { required: names(row[2] ?? ''), optional: names(row[3] ?? '') }]] : [];
  }));
  assert.deepEqual(JSON.parse(JSON.stringify(ProposalOps)), lines);
});

test('a change outside the catalog\'s schema is refused by the Shape rule at its index, as the gate refuses it', () => {
  const schema = new JsonSchema(/** @type {any} */ (ability?.input).properties.changes.items);
  const broken = [
    { op: 'rename_step', nodeId: 'b', label: 'Bowline' },
    { op: 'rename', nodeId: 7, label: 'Bowline' },
    { op: 'add_step', ref: 'hoist', label: 'Hoist the sail' },
    { op: 'add_step', ref: 'new:Hoist', label: 'Hoist the sail' },
    { op: 'describe', nodeId: 'b', links: [{ label: 'Knots' }] },
    { op: 'describe', nodeId: 'b', links: [{ url: 'https://example.org', title: 'Knots' }] },
    { op: 'add_kind', ref: 'new:sport', label: 'Sport', hue: 'teal' },
    { op: 'set_progress', nodeId: 'b', status: 'done' },
    { op: 'add_step', ref: 'new:hoist', label: 'Hoist the sail', prerequisites: ['a', 3] },
    { op: 'split', nodeId: 'b', parts: [{ ref: 'new:loop' }, { ref: 'new:end', label: 'Pass the end' }] },
    { op: 'split', nodeId: 'b', parts: [{ ref: 'loop', label: 'Make the loop' }, { ref: 'new:end', label: 'Pass the end' }] },
    { op: 'rename', nodeId: 'b', label: 'Bowline', color: 'sky' },
    { nodeId: 'b', label: 'Bowline' },
  ];
  for (const change of broken) {
    assert.notEqual(schema.fault(change), null, JSON.stringify(change));
    const subject = [change.nodeId, change.ref].find((name) => typeof name === 'string');
    assert.deepEqual(proposing(sailing(), [{ op: 'rename', nodeId: 'a', label: 'Cast off' }, change]),
      { refused: { code: 'invalid-input', ...(subject === undefined ? {} : { id: subject }), at: 1 } }, JSON.stringify(change));
  }
  assert.deepEqual(proposing(sailing(), [{ op: 'rename', nodeId: 'zz', label: 'Cast off' }, broken[0]]), { refused: { code: 'invalid-input', id: 'b', at: 1 } },
    'the Shape rule runs over every change before any folds');
  assert.deepEqual(propose(sailing(), { treeId: T, changes: [] }, T, () => ''), { refused: { code: 'invalid-input' } });
  assert.deepEqual(propose(sailing(), { treeId: 'Learn to sail', changes: [{ op: 'rename', nodeId: 'a', label: 'Cast off' }] }, T, () => ''), { refused: { code: 'invalid-input' } });
});

test('a name of a ref\'s form is a ref, never a step\'s id, and a ref the roadmap holds as an id is no new step', () => {
  const holding = sailing({ nodes: [...sailing().trees[0].nodes, { id: 'new:tack', ord: 'a3', label: 'Tack' }] });
  assert.deepEqual(proposing(holding, [{ op: 'connect', nodeId: 'c', prerequisiteId: 'new:tack' }]), { refused: { code: 'unknown-step', id: 'new:tack', at: 0 } });
  assert.deepEqual(proposing(holding, [{ op: 'add_step', ref: 'new:tack', label: 'Tack again' }]), { refused: { code: 'invalid-input', id: 'new:tack', at: 0 } });
});

test('a roadmap whose steps or links are at the sync registry\'s cap takes no change that adds one, naming the roadmap', () => {
  const steps = Array.from({ length: 10_000 }, (_, index) => ({ id: `s${index}`, ord: `a${String(index).padStart(5, '0')}`, label: `Step ${index}` }));
  const full = sailing({ nodes: steps, edges: [], marks: [] });
  assert.deepEqual(proposing(full, [{ op: 'rename', nodeId: 's0', label: 'First' }, { op: 'add_step', ref: 'new:more', label: 'One more' }]),
    { refused: { code: 'over-limit', id: T, at: 1 } });
  assert.ok('proposal' in proposing(sailing({ nodes: steps.slice(1), edges: [], marks: [] }), [{ op: 'add_step', ref: 'new:more', label: 'One more' }]),
    'the ten thousandth step');
  assert.ok('proposal' in proposing(full, [{ op: 'remove_step', nodeId: 's1' }, { op: 'add_step', ref: 'new:more', label: 'One more' }]),
    'a step the set removes makes room for one it adds');
  // Every link from a step to each step after it among 202, the first 20,000 of them: s200 to s201 is not among them.
  const ids = Array.from({ length: 202 }, (_, index) => `s${index}`);
  const woven = sailing({ nodes: ids.map((id, index) => ({ id, ord: `a${String(index).padStart(3, '0')}`, label: id })), marks: [],
    edges: ids.flatMap((from, index) => ids.slice(index + 1).map((to) => ({ from, to, present: true }))).slice(0, 20_000) });
  assert.deepEqual(proposing(woven, [{ op: 'connect', nodeId: 's201', prerequisiteId: 's200' }]), { refused: { code: 'over-limit', id: T, at: 0 } });
});

test('a base past the 262,144 bytes the sync registry caps it at refuses the whole set, though its changes are few', () => {
  // `n` and `r` each follow 2,500 steps of their own, so folding `r` into `n` retires 2,500 links and makes 2,500.
  const sources = Array.from({ length: 2_500 }, (_, index) => `s${String(index).padStart(4, '0')}`);
  const standing = sailing({
    nodes: [{ id: 'n', ord: 'b0', label: 'Knead the dough' }, { id: 'r', ord: 'b1', label: 'Work the dough' },
      ...sources.map((id, index) => ({ id, ord: `c${String(index).padStart(4, '0')}`, label: `Weigh ${index}` }))],
    edges: sources.map((from) => ({ from, to: 'r', present: true })),
  });
  const changes = [{ op: 'merge', nodeId: 'n', removeId: 'r' }];
  assert.ok(jcsBytes(changes).length < 65_536);
  assert.deepEqual(proposing(standing, changes), { refused: { code: 'over-limit' } });
  const smaller = sailing({ ...standing.trees[0], edges: sources.slice(0, 100).map((from) => ({ from, to: 'r', present: true })) });
  const minted = proposing(smaller, changes);
  assert.ok('proposal' in minted, JSON.stringify(minted).slice(0, 200));
  assert.equal(minted.proposal.base.length, 2 + 100 + 100);
});
