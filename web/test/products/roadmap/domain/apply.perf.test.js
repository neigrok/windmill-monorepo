// @ts-check
// Roadmap Coach §7 at size: Apply of a proposal of 100 changes over a roadmap of 5,000 steps, beside 0, 5 and 20 other
// roadmaps of 2,000 steps the device holds, its time told. Apply reads its roadmap and the roadmaps that roadmap reaches,
// so the others leave its time about where it is.

import assert from 'node:assert/strict';
import test from 'node:test';
import { performance } from 'node:perf_hooks';
import { ActDecision } from '../../../../src/platform/domain-kit/acts.js';
import { ProposalAbilities } from '../../../../src/products/roadmap/domain/abilities/proposals.js';
import { readReached } from '../../../../src/products/roadmap/domain/abilities/standing.js';
import { RoadmapRefusals } from '../../../../src/products/roadmap/domain/roadmapRules.js';
import { RoadmapRules } from '../../../../src/products/roadmap/domain/ruleBook.js';
import { ProductCorpus } from '../../../platform/domain-kit/productCorpus.js';
import { roadmapBook, runAction } from './vectors.js';

const S0 = '1700000000000:0:r_aaaaaaaaaaaa';
const MINT = '1700000001000:0:r_aaaaaaaaaaaa';
/** @param {string} t @param {any} id @param {Record<string, any>} f */
const row = (t, id, f) => ({ t, id, seq: 1, born: S0, life: ['alive', S0], f: Object.fromEntries(Object.entries(f).map(([name, value]) => [name, [value, S0]])) });
/** @param {string} tree @param {number} count */
function roadmapRows(tree, count) {
  const id = (/** @type {number} */ index) => `s${String(index).padStart(5, '0')}`;
  return [{ t: 'meta', id: 'meta', seq: 1, f: { title: [`Roadmap ${tree}`, S0] } },
    row('kind', 'learn', { hue: 'olive', label: 'Learn', description: '', ord: 'a0' }),
    ...Array.from({ length: count }, (_, index) => row('node', id(index), { label: `Step ${index}`, ord: String(index).padStart(5, '0') })),
    ...Array.from({ length: count - 1 }, (_, index) => ({ t: 'edge', id: [id(index), id(index + 1)], seq: 1, life: ['alive', S0] }))];
}

// The device's copy: the roadmap of 5,000 steps a proposal is about, `others` roadmaps of 2,000 beside it, and the
// conversation the proposal came from, minted by the domain over that copy.
/** @param {number} others */
function copyWith(others) {
  const T = 't_00000000000000bb';
  const trees = [T, ...Array.from({ length: others }, (_, index) => `t_${String(index + 1).padStart(16, '0')}`)];
  /** @type {Record<string, { drawn: any[] }>} */
  const scopes = { 'self/roadmap': { drawn: [...trees.map((tree) => row('tree', tree, {})),
    row('coachThread', 'thread0001', { treeId: T, stepId: null, title: 'Tidy it' }),
    row('coachMessage', 'message0002', { threadId: 'thread0001', role: 'coach', text: '', at: 1700000000000, replica: 'rp_00000000000000000000000000000001',
      state: 'completed', truncated: false, refusal: null })] } };
  for (const tree of trees) {
    scopes[`tree/${tree}`] = { drawn: roadmapRows(tree, tree === T ? 5000 : 2000) };
    scopes[`self/overlay/${tree}`] = { drawn: [] };
  }
  const id = (/** @type {number} */ index) => `s${String(index).padStart(5, '0')}`;
  const changes = [
    ...Array.from({ length: 10 }, (_, index) => ({ op: 'set_progress', nodeId: id(index), status: 'complete' })),
    ...Array.from({ length: 25 }, (_, index) => ({ op: 'add_step', ref: `new:s${index}`, label: `New ${index}`, kind: 'learn', prerequisites: [id(index * 10)] })),
    ...Array.from({ length: 25 }, (_, index) => ({ op: 'rename', nodeId: id(1000 + index), label: `Renamed ${index}` })),
    ...Array.from({ length: 10 }, (_, index) => ({ op: 'describe', nodeId: id(2000 + index), description: `Described ${index}` })),
    ...Array.from({ length: 20 }, (_, index) => ({ op: 'connect', nodeId: id(2500 + index * 10), prerequisiteId: id(2495 + index * 10) })),
    ...Array.from({ length: 5 }, (_, index) => ({ op: 'merge', nodeId: id(3000 + index * 10), removeId: id(3001 + index * 10) })),
    ...Array.from({ length: 5 }, (_, index) => ({ op: 'remove_step', nodeId: id(4000 + index * 10) })),
  ];
  const corpus = new ProductCorpus(roadmapBook, RoadmapRules.spec);
  const vector = /** @type {any} */ ({ name: 'copy', input: { scopes, now: 1800000000000, offsetSeconds: 0 } });
  const standing = /** @type {any} */ (corpus.act({ refusals: RoadmapRefusals, load: (read) => readReached(read, T), decide: (copy) => ActDecision.unchanged(copy) },
    vector, (copy) => /** @type {any} */ (copy), (refusal) => /** @type {any} */ (refusal))).decision.unchanged.result;
  const ids = ['proposal0003', ...Array.from({ length: 25 }, (_, index) => `n${String(index).padStart(15, '0')}`)];
  const proposed = /** @type {any} */ (ProposalAbilities.propose_roadmap_change(standing, { treeId: T, changes }, T, () => /** @type {string} */ (ids.shift())));
  assert.ok(proposed.proposal, JSON.stringify(proposed.refused));
  const mint = /** @type {any} */ (runAction(/** @type {any} */ ({ name: 'mint', input: { action: 'MintProposal', input: { proposal: 'proposal0003', treeId: T, thread: 'thread0001',
    message: 'message0002', changes: proposed.proposal.changes, base: proposed.proposal.base }, scopes, now: 1800000000000, offsetSeconds: 0 } })));
  const created = mint.decision.write.segments[0].gesture.changes[0];
  scopes['self/roadmap']?.drawn.push({ t: 'coachProposal', id: 'proposal0003', seq: 2, born: MINT, life: ['alive', MINT],
    f: Object.fromEntries(Object.entries(created.f).map(([name, value]) => [name, [value, MINT]])) });
  return { name: 'apply', input: { action: 'ApplyProposal', input: { proposal: 'proposal0003' }, scopes, now: 1800000000000, offsetSeconds: 0 } };
}

test('Apply of 100 changes over 5,000 steps takes about as long beside 0, 5 and 20 other roadmaps of 2,000 steps', () => {
  /** @type {Record<number, number>} */
  const times = {};
  for (const others of [0, 5, 20]) {
    const vector = copyWith(others);
    const runs = [0, 1, 2].map(() => {
      const started = performance.now();
      const decided = /** @type {any} */ (runAction(/** @type {any} */ (vector)));
      const took = performance.now() - started;
      assert.equal(decided.decision.write?.result, 'applied');
      return took;
    }).sort((a, b) => a - b);
    times[others] = Math.round(runs[1] ?? 0);
  }
  console.log(`Apply of 100 changes over 5,000 steps, median of 3, beside 0, 5 and 20 other roadmaps of 2,000: ${times[0]}, ${times[5]}, ${times[20]} ms`);
  assert.ok((times[20] ?? 0) < 30_000);
});
