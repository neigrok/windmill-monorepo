// @ts-check
// Roadmap Coach §5.2 at the steps cap: a roadmap of 10,000 steps read page by page through get_tree and find_nodes, no
// page past 16,384 bytes of canonical text, and the pages joined again into the whole; and told as the context (§5).

import assert from 'node:assert/strict';
import test from 'node:test';
import { jcsBytes } from '../../../../../../packages/api-contract/sync/reference/core/jcs.js';
import { ContextBounds, readContext } from '../../../../../src/products/roadmap/domain/abilities/context.js';
import { MAX_BYTES } from '../../../../../src/products/roadmap/domain/abilities/pages.js';
import { ReadAbilities } from '../../../../../src/products/roadmap/domain/abilities/reads.js';
import { STEP_LINE } from '../../../../../src/products/roadmap/domain/abilities/standing.js';

// A roadmap of 10,000 steps, each following the two before it so get_tree's order is the room's, the first 3,000
// complete. Every thousandth step carries a description at its cap, in scalars of one to four bytes, and every five
// hundredth its 32 web links with addresses near their cap. `line` is a step as §5.1 answers it, read from the fixture.
function tenThousandSteps() {
  const treeId = 't_00000000000000aa';
  const done = 3_000;
  const id = (/** @type {number} */ index) => `s${String(index).padStart(5, '0')}`;
  const nodes = Array.from({ length: 10_000 }, (_, index) => ({
    id: id(index), present: true, born: null, rc: null, ru: null, label: `Step ${index} · étape ${index} 🪢`, icon: '', color: 'terracotta',
    ord: String(index).padStart(5, '0'), status: 'none', branch: null,
    description: index % 1000 === 999 ? [...'Knot é 結 🪢 '.repeat(2000)].slice(0, 16_000).join('') : `Practise step ${index} until it holds.`,
    links: index % 500 === 499 ? Array.from({ length: 32 }, (__, link) => ({ url: `https://example.org/${'a'.repeat(2000)}/${index}/${link}`, label: `Link ${link}` })) : [],
  }));
  const standing = { trees: [{ id: treeId, present: true, read: /** @type {const} */ ('loaded'), own: true, updatedAt: null, parent: null,
    meta: { title: 'Ten thousand steps', guide: '', guideInherited: false, root: treeId, depth: 0, visibility: 'private', reach: 'private' },
    nodes, kinds: [], pointers: [],
    edges: nodes.flatMap((node, index) => [1, 2].filter((gap) => index >= gap).map((gap) => ({ from: id(index - gap), to: node.id, present: true }))),
    marks: nodes.slice(0, done).map((node) => ({ node: node.id, status: 'complete', outOfOrder: false, recordedAt: 1_800_000_000_000, deviceAt: 1_800_000_000_000 })) }] };
  /** @param {number} index @param {readonly string[]} fields */
  const line = (index, fields) => {
    const node = /** @type {(typeof nodes)[number]} */ (nodes[index]);
    const scalars = [...node.description];
    /** @type {Record<string, unknown>} */
    const all = { label: node.label, kind: null, state: index < done ? 'complete' : index === done ? 'available' : 'locked',
      prerequisites: [index - 2, index - 1].filter((at) => at >= 0).map(id), unlockCount: index === done ? 1 : 0,
      summary: scalars.length > 160 ? `${scalars.slice(0, 160).join('')}…` : node.description, description: node.description, links: node.links };
    return { id: node.id, ...Object.fromEntries(fields.map((field) => [field, all[field]])) };
  };
  return { treeId, nodes, standing, line };
}

// Every page of a read from its first, each within the cap, and their steps joined again: a part's texts and lists
// carried on from the part before it.
/** @param {(cursor?: string) => any} read */
function readAll(read) {
  /** @type {any[]} */
  const steps = [];
  let pages = 0;
  let largest = 0;
  for (let cursor; ; ) {
    const answer = read(cursor);
    assert.ok('result' in answer, JSON.stringify(answer));
    const bytes = jcsBytes(answer.result).length;
    assert.ok(bytes <= MAX_BYTES, `page ${pages + 1} holds ${bytes} bytes`);
    largest = Math.max(largest, bytes);
    pages++;
    for (const { part, parts, ...step } of answer.result.steps) {
      const joined = part > 1 ? steps[steps.length - 1] : null;
      if (joined === null) steps.push(step);
      else for (const [field, value] of Object.entries(step)) if (field !== 'id') joined[field] = Array.isArray(value) ? [...joined[field], ...value] : joined[field] + value;
    }
    if (answer.result.nextCursor === undefined) return { steps, pages, largest };
    cursor = answer.result.nextCursor;
  }
}

test('get_tree pages a roadmap of 10,000 steps within the cap, and its pages join into the whole roadmap', (t) => {
  const { treeId, nodes, standing, line } = tenThousandSteps();
  const fields = ['label', 'state', 'prerequisites', 'unlockCount', 'description', 'links'];
  const start = performance.now();
  const { steps, pages, largest } = readAll((cursor) => ReadAbilities.get_tree(standing, { treeId, fields, ...(cursor ? { cursor } : {}) }, treeId));
  const elapsed = performance.now() - start;
  assert.deepEqual(steps, nodes.map((_, index) => line(index, fields)));
  t.diagnostic(`get_tree: ${steps.length} steps in ${pages} pages, the largest ${largest} bytes, in ${elapsed.toFixed(0)} ms (${(elapsed / pages).toFixed(1)} ms a page)`);
});

test('find_nodes pages the steps a text matches within the cap, in the search\'s order', (t) => {
  const { treeId, nodes, standing, line } = tenThousandSteps();
  const start = performance.now();
  const { steps, pages, largest } = readAll((cursor) => ReadAbilities.find_nodes(standing, { treeId, query: 'STEP 1', ...(cursor ? { cursor } : {}) }, treeId));
  const elapsed = performance.now() - start;
  const matched = nodes.flatMap((node, index) => (node.label.toLowerCase().includes('step 1') ? [index] : []));
  assert.equal(matched.length, 1111);
  assert.deepEqual(steps, matched.map((index) => line(index, ['label', 'kind', 'state', 'prerequisites', 'unlockCount', 'summary'])));
  t.diagnostic(`find_nodes: ${steps.length} steps in ${pages} pages, the largest ${largest} bytes, in ${elapsed.toFixed(0)} ms (${(elapsed / pages).toFixed(1)} ms a page)`);
});

test('a roadmap of 10,000 steps is told around its one available step: its counts, and the steps within two links of it either way', (t) => {
  const { treeId, nodes, standing, line } = tenThousandSteps();
  const start = performance.now();
  const answer = /** @type {any} */ (readContext(standing, { about: treeId }));
  const elapsed = performance.now() - start;
  const near = [2996, 2997, 2998, 2999, 3000, 3001, 3002, 3003, 3004];
  assert.deepEqual(Object.keys(answer.result).sort(), ['counts', 'diagnostics', 'recent', 'steps', 'tree']);
  assert.deepEqual(answer.result.tree, { id: treeId, title: 'Ten thousand steps', kinds: [] });
  assert.deepEqual(answer.result.counts, { total: 10_000, done: 3_000, available: 1, locked: 6_999, unknown: 0,
    byKind: [{ kind: null, total: 10_000, done: 3_000, available: 1, locked: 6_999, unknown: 0 }] });
  assert.deepEqual(answer.result.steps, near.map((index) => line(index, STEP_LINE.filter((field) => field !== 'id'))));
  assert.deepEqual(answer.result.recent, nodes.slice(0, 10).map((node) => ({ id: node.id, label: node.label, at: 1_800_000_000_000 })));
  const bytes = jcsBytes(answer.result).length;
  assert.ok(bytes <= ContextBounds.bytes, `${bytes} bytes`);
  t.diagnostic(`context: 10,000 steps told in ${bytes} bytes, ${answer.result.steps.length} lines, in ${elapsed.toFixed(0)} ms`);
});

test('a step that follows 9,999 others with ids at their cap pages its prerequisites in parts, each part costing what it holds', (t) => {
  const treeId = 't_00000000000000aa';
  const id = (/** @type {number} */ index) => `s${String(index).padStart(127, '0')}`;
  const nodes = [...Array.from({ length: 9_999 }, (_, index) => ({ id: id(index), label: `Step ${index}`, ord: String(index).padStart(5, '0') })),
    { id: 'final', label: 'Cross', ord: '99999' }];
  const standing = { trees: [{ id: treeId, own: true, meta: { title: 'Ten thousand steps' }, nodes,
    edges: nodes.slice(0, -1).map((node) => ({ from: node.id, to: 'final', present: true })) }] };
  const start = performance.now();
  const { steps, pages, largest } = readAll((cursor) => ReadAbilities.get_nodes(standing, { treeId, nodeIds: ['final'], fields: ['prerequisites'],
    ...(cursor ? { cursor } : {}) }, treeId));
  const elapsed = performance.now() - start;
  assert.deepEqual(steps, [{ id: 'final', prerequisites: nodes.slice(0, -1).map((node) => node.id) }]);
  t.diagnostic(`get_nodes: one step's 9,999 prerequisites of 128 characters in ${pages} parts, the largest ${largest} bytes, in ${elapsed.toFixed(0)} ms `
    + `(${(elapsed / pages).toFixed(1)} ms a page)`);
});

test('the device\'s roadmaps are read once a standing roadmap: 50 roadmaps of 2,000 steps cost their reading on the first call alone', (t) => {
  const roadmap = (/** @type {number} */ index) => {
    const treeId = `t_${index.toString(16).padStart(16, '0')}`;
    const id = (/** @type {number} */ step) => `s${String(step).padStart(5, '0')}`;
    const nodes = Array.from({ length: 2_000 }, (_, step) => ({ id: id(step), label: `Step ${step}`, ord: String(step).padStart(5, '0') }));
    return { id: treeId, own: true, meta: { title: `Roadmap ${index}` }, nodes,
      edges: nodes.slice(1).map((node, step) => ({ from: id(step), to: node.id, present: true })),
      marks: nodes.slice(0, 600).map((node) => ({ node: node.id, status: 'complete', recordedAt: 1_800_000_000_000, deviceAt: 1_800_000_000_000 })) };
  };
  const standing = { trees: Array.from({ length: 50 }, (_, index) => roadmap(index + 1)) };
  const treeId = standing.trees[0]?.id ?? '';
  /** @param {() => unknown} read */
  const timed = (read) => {
    const start = performance.now();
    const answer = read();
    return { answer, ms: performance.now() - start };
  };
  const first = timed(() => ReadAbilities.get_tree(standing, { treeId }, treeId));
  const list = timed(() => ReadAbilities.list_trees(standing, {}));
  const again = timed(() => ReadAbilities.get_tree(standing, { treeId }, treeId));
  const listAgain = timed(() => ReadAbilities.list_trees(standing, {}));
  assert.deepEqual(again.answer, first.answer);
  assert.deepEqual(listAgain.answer, list.answer);
  t.diagnostic(`50 roadmaps of 2,000 steps: get_tree page 1 ${first.ms.toFixed(1)} ms, then list_trees page 1 ${list.ms.toFixed(1)} ms; `
    + `read again, ${again.ms.toFixed(1)} ms and ${listAgain.ms.toFixed(1)} ms`);
});
