// @ts-check
// The read abilities' own rules beyond the corpus's cases: get_tree's order around loops, list_trees' frontier in that
// order, and get_diagnostics' lists paged with their counts of what is left off on the first page alone.

import assert from 'node:assert/strict';
import test from 'node:test';
import { jcsBytes } from '../../../../../../packages/api-contract/sync/reference/core/jcs.js';
import { MAX_BYTES } from '../../../../../src/products/roadmap/domain/abilities/pages.js';
import { ReadAbilities } from '../../../../../src/products/roadmap/domain/abilities/reads.js';
import { diagnose } from '../../../../../src/products/roadmap/domain/diagnostics.js';
import { FollowGraph } from '../../../../../src/products/roadmap/domain/graph.js';
import { RoadmapTree } from '../../../../../src/products/roadmap/domain/records.js';

test('get_tree answers each step after every step it follows, the first in the room\'s order first, and a loop and what waits on it last, in id byte order', () => {
  const tree = { id: 't_0000000000000001', own: true, meta: { title: 'Sailing' }, nodes: ['x', 'z', 'p', 'y', 'Q', 'r', 's'].map((id, index) => ({ id, ord: `a${index}` })),
    edges: [['y', 'x'], ['p', 'Q'], ['Q', 'p'], ['p', 'r'], ['s', 's']].map(([from = '', to = '']) => ({ from, to, present: true })) };
  const answer = /** @type {any} */ (ReadAbilities.get_tree({ trees: [tree] }, { treeId: tree.id, fields: ['state'] }, tree.id));
  assert.deepEqual(answer.result.steps.map((/** @type {{ id: string }} */ step) => step.id), ['z', 'y', 'x', 'Q', 'p', 'r', 's']);
});

test('list_trees names each roadmap\'s frontier in get_tree\'s order, and is refused while the device has not read the person\'s list', () => {
  const tree = { id: 't_0000000000000001', own: true, meta: { title: 'Sailing' },
    nodes: [{ id: 'c', ord: 'a0', label: 'Sail across' }, { id: 'e', ord: 'a1', label: 'Read the weather' }, { id: 'd', ord: 'a5', label: 'Leave the dock' }],
    edges: [{ from: 'd', to: 'c', present: true }],
    marks: [{ node: 'd', status: 'complete', recordedAt: 1_800_000_000_000, deviceAt: 1_800_000_000_000 }] };
  assert.deepEqual(ReadAbilities.list_trees({ trees: [tree] }, {}), { result: { trees: [{ id: tree.id, title: 'Sailing',
    counts: { total: 3, done: 1, available: 2, locked: 0, unknown: 0 }, frontier: ['Read the weather', 'Sail across'], lastCompletedAt: 1_800_000_000_000 }] } });
  assert.deepEqual(ReadAbilities.list_trees({ trees: [tree], listRead: false }, {}), { refused: { code: 'roadmap-unavailable' } });
});

test('get_diagnostics answers the caller its own report: what one caller changes in its answer is in no answer after it', () => {
  const tree = { id: 't_0000000000000001', own: true, meta: { title: 'Knots' }, nodes: ['a', 'b', 'c'].map((id) => ({ id })),
    edges: [{ from: 'a', to: 'b', present: true }, { from: 'b', to: 'a', present: true }, { from: 'c', to: 'z', present: true }] };
  const standing = { trees: [tree] };
  const first = /** @type {any} */ (ReadAbilities.get_diagnostics(standing, { treeId: tree.id }, tree.id));
  const kept = structuredClone(first);
  first.result.cycles[0].count = -1;
  first.result.cycles[0].nodes.push('z');
  first.result.dangling[0].to = 'y';
  first.result.smells[0].kind = 'changed';
  first.result.smells[1].nodes.length = 0;
  assert.deepEqual(ReadAbilities.get_diagnostics(standing, { treeId: tree.id }, tree.id), kept);
});

test('get_diagnostics pages its lists, every page carrying each list and only the first the counts of what each leaves off', () => {
  const step = (/** @type {number} */ cycle, /** @type {number} */ member) => `c${String(cycle).padStart(2, '0')}-${'x'.repeat(110)}-${member}`;
  const loops = Array.from({ length: 55 }, (_, cycle) => Array.from({ length: 12 }, (__, member) => step(cycle, member)));
  const tree = { id: 't_0000000000000001', own: true, meta: { title: 'Knots' }, nodes: loops.flat().map((id) => ({ id })),
    edges: loops.flatMap((loop) => loop.map((from, index) => ({ from, to: loop[(index + 1) % loop.length] ?? '', present: true }))) };
  /** @type {any[]} */
  const pages = [];
  for (let cursor; ; ) {
    const answer = /** @type {any} */ (ReadAbilities.get_diagnostics({ trees: [tree] }, { treeId: tree.id, ...(cursor ? { cursor } : {}) }, tree.id));
    assert.ok(jcsBytes(answer.result).length <= MAX_BYTES);
    pages.push(answer.result);
    cursor = answer.result.nextCursor;
    if (cursor === undefined) break;
  }
  const found = diagnose(new FollowGraph(new RoadmapTree(tree)));
  assert.deepEqual(pages.map((page) => Object.keys(page).filter((key) => key !== 'nextCursor').sort()), pages.map((_, index) => [
    ...(index === 0 ? ['cyclesOmitted'] : []), 'cycles', 'dangling', 'danglingPointers', 'selfEdges', 'smells', 'treeLoops'].sort()));
  assert.equal(pages[0].cyclesOmitted, 5);
  assert.deepEqual(pages.flatMap((page) => page.cycles), found.cycles.entries.map(({ count, named }) => ({ count, nodes: named })));
  assert.deepEqual(pages.flatMap((page) => page.smells), [{ kind: 'empty-legend' }, { kind: 'empty-icon', count: 660, nodes: found.smells[0]?.nodes.named }]);
  assert.ok(pages.length > 1, `${pages.length} pages`);

  const reader = /** @type {any} */ (ReadAbilities.get_diagnostics({ trees: [{ ...tree, own: false, nodes: [], edges: [] }] }, { treeId: tree.id }, tree.id));
  assert.deepEqual(reader, { result: { cycles: [], dangling: [], selfEdges: [], smells: [] } }, 'a roadmap the person only reads says nothing of the roadmaps its steps open');
});
