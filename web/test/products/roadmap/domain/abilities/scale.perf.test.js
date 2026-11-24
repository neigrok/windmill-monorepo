// @ts-check
// Roadmap Coach §5.2 at the steps cap: a roadmap of 10,000 steps read page by page through get_tree and find_nodes, no
// page past 16,384 bytes of canonical text, and the pages joined again into the whole.

import assert from 'node:assert/strict';
import test from 'node:test';
import { jcsBytes } from '../../../../../../packages/api-contract/sync/reference/core/jcs.js';
import { MAX_BYTES } from '../../../../../src/products/roadmap/domain/abilities/pages.js';
import { ReadAbilities } from '../../../../../src/products/roadmap/domain/abilities/reads.js';

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
