import test from 'node:test';
import assert from 'node:assert/strict';
import { RoadmapTree } from '../../../../src/products/roadmap/domain/records.js';
import { FollowGraph } from '../../../../src/products/roadmap/domain/graph.js';
import { runRead } from './vectors.js';
import { compareText } from '../../../../src/platform/domain-kit/entities.js';

function oracle(tree) {
  const nodes = tree.nodes.filter((node) => node.present);
  const present = new Set(nodes.map((node) => node.id));
  const completed = new Set([...tree.marks.values()].filter((mark) => mark.status === 'complete').map((mark) => mark.node));
  const parents = new Map();
  for (const edge of tree.edges.filter((edge) => edge.present)) {
    if (!parents.has(edge.to)) parents.set(edge.to, new Set());
    parents.get(edge.to).add(edge.from);
  }
  const followed = new Map();
  for (const node of nodes) {
    const entries = new Map();
    for (const incoming of parents.get(node.id) ?? []) {
      const stack = [incoming];
      const seen = new Set();
      while (stack.length) {
        const id = stack.pop();
        if (seen.has(id)) continue;
        seen.add(id);
        if (!present.has(id)) { stack.push(...(parents.get(id) ?? [])); continue; }
        if (!entries.has(id)) entries.set(id, { id, incoming: [], throughAbsent: false });
        const entry = entries.get(id);
        entry.incoming.push([incoming, node.id]);
        entry.throughAbsent ||= !present.has(incoming);
      }
    }
    followed.set(node.id, nodes.flatMap(({ id }) => entries.has(id) ? [{ ...entries.get(id), incoming: entries.get(id).incoming.sort((a, b) => compareText(a[0], b[0])) }] : []));
  }
  const unmet = new Map(nodes.map(({ id }) => [id, followed.get(id).map((item) => item.id).filter((id) => !completed.has(id))]));
  return { presentIds: nodes.map((node) => node.id), states: nodes.map(({ id }) => ({ id, state: completed.has(id) ? 'complete' : unmet.get(id).length ? 'locked' : 'available' })),
    steps: nodes.map(({ id }) => {
      const debt = new Set();
      const stack = [...unmet.get(id)];
      while (stack.length) {
        const parent = stack.pop();
        if (debt.has(parent)) continue;
        debt.add(parent);
        stack.push(...unmet.get(parent));
      }
      debt.delete(id);
      const owed = nodes.filter((node) => debt.has(node.id)).map((node) => node.id);
      const unlocks = nodes.filter((node) => node.id !== id && !completed.has(node.id) && unmet.get(node.id).length === 1 && unmet.get(node.id)[0] === id).map((node) => node.id);
      return { id, followed: followed.get(id), unmet: unmet.get(id), owed, owedCount: owed.length, unlocks };
    }),
  };
}

test('Raw-graph reads agree with an independent traversal across cycles, missing nodes and bitset word boundaries', () => {
  for (let seed = 1; seed <= 40; seed++) {
    let state = seed;
    const draw = (max) => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state % max; };
    const nodes = Array.from({ length: 80 }, (_, index) => ({ id: `n${index}`, present: draw(4) !== 0 }));
    const edges = new Map();
    for (let edge = 0; edge < 160; edge++) {
      const from = `n${draw(90)}`;
      const to = `n${draw(80)}`;
      edges.set(JSON.stringify([from, to]), { from, to, present: draw(6) !== 0 });
    }
    const marks = nodes.filter(() => draw(4) === 0).map((node) => ({ node: node.id, status: 'complete', outOfOrder: false, recordedAt: null, deviceAt: null }));
    const tree = new RoadmapTree({ id: 'T', nodes, edges: [...edges.values()], marks });
    const graph = new FollowGraph(tree);
    assert.deepEqual(graph.result(graph.ids), oracle(tree), `seed ${seed}`);
  }
});

test('Reads preserve supplied records and report an unread graph explicitly', () => {
  const input = { operation: 'graph', tree: { id: 'T', nodes: [{ id: 'a' }, { id: 'b', present: false }], edges: [{ from: 'b', to: 'a', present: true }] }, subjects: ['a'] };
  const before = structuredClone(input);
  assert.deepEqual(runRead(input), { presentIds: ['a'], states: [{ id: 'a', state: 'available' }], steps: [{ id: 'a', followed: [], unmet: [], owed: [], owedCount: 0, unlocks: [] }] });
  assert.deepEqual(input, before);
  assert.throws(() => new FollowGraph(new RoadmapTree({ id: 'T', read: 'unread' })), { name: 'TypeError', message: 'Roadmap graph is unread' });
});
