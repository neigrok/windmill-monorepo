import test from 'node:test';
import assert from 'node:assert/strict';
import { RoadmapTree } from '../../../../src/products/roadmap/domain/records.js';
import { FollowGraph } from '../../../../src/products/roadmap/domain/graph.js';
import { RoadmapAccount } from '../../../../src/products/roadmap/domain/account.js';
import { BoardRead } from '../../../../src/products/roadmap/domain/reads.js';

const id = (index) => `n${String(index).padStart(5, '0')}`;

test('10,000 nodes and 20,000 raw edges use explicit stacks for graph and owed reads', (t) => {
  const nodes = Array.from({ length: 10000 }, (_, index) => ({ id: id(index) }));
  const edges = nodes.flatMap((node, index) => [1, 2].filter((gap) => index >= gap).map((gap) => ({ from: id(index - gap), to: node.id, present: true })));
  edges.push(...[3, 4, 5].map((index) => ({ from: id(0), to: id(index), present: true })));
  assert.equal(edges.length, 20000);
  const start = performance.now();
  const graph = new FollowGraph(new RoadmapTree({ id: 'T', nodes, edges }));
  assert.equal(graph.states.get(id(9999)), 'locked');
  assert.deepEqual(graph.owed(id(9999)), nodes.slice(0, -1).map((node) => node.id));
  assert.equal(graph.owedIndex().counts.get(id(9999)), 9999);
  t.diagnostic(`10k/20k construction and terminal owed read: ${(performance.now() - start).toFixed(1)} ms`);
});

test('An absent hub represents sixteen million followed pairs without per-pair objects', (t) => {
  const parents = Array.from({ length: 4000 }, (_, index) => ({ id: `a${id(index)}` }));
  const children = Array.from({ length: 4000 }, (_, index) => ({ id: `z${id(index)}` }));
  const edges = [...parents.map((node) => ({ from: node.id, to: 'hub', present: true })), ...children.map((node) => ({ from: 'hub', to: node.id, present: true }))];
  const start = performance.now();
  const graph = new FollowGraph(new RoadmapTree({ id: 'T', nodes: [...parents, { id: 'hub', present: false }, ...children], edges }));
  const board = new BoardRead(graph).result();
  assert.deepEqual(board.columns.map((column) => column.count), [4000, 4000, 0]);
  assert.equal(graph.owedIndex().counts.get(children[0].id), 4000);
  assert.equal(graph.inDegree.get(children[0].id), 4000);
  assert.equal(graph.edges.length, 8000);
  assert.equal(graph.parents.reduce((sum, entries) => sum + entries.length, 0), 8000);
  const rowBytes = [...graph.rows.values()].reduce((sum, row) => sum + row.byteLength, 0);
  assert.equal(rowBytes, 4000 * Math.ceil(8000 / 32) * 4);
  assert.ok(graph.reach.bits instanceof Uint32Array);
  assert.ok(graph.owedIndex().closure.bits instanceof Uint32Array);
  assert.equal(graph.followed(children[0].id).length, 4000);
  t.diagnostic(`16m implied pairs, Board plus one provenance read: ${(performance.now() - start).toFixed(1)} ms; ${rowBytes} bytes of rows behind the hub`);
});

test('500 trees at subtree depth eight retain standing and complete bottom-up', (t) => {
  const trees = [];
  for (let index = 0; index < 500; index++) {
    const depth = index % 9;
    const parent = depth === 0 ? null : { tree: `T${index - 1}`, step: 'step' };
    const branch = depth === 8 || index === 499 ? null : `T${index + 1}`;
    trees.push(new RoadmapTree({ id: `T${index}`, parent, meta: { title: `Root ${index}` }, nodes: [{ id: 'step', label: `Step ${index}`, branch }],
      marks: [{ node: 'step', status: 'complete', outOfOrder: false, recordedAt: index, deviceAt: index }] }));
  }
  const start = performance.now();
  const account = new RoadmapAccount(trees);
  const result = account.result();
  assert.equal(result.trees.length, 500);
  assert.ok(result.trees.every((tree) => tree.standing === 'standing' && tree.complete));
  assert.equal(account.locate('T8').place.depth, 8);
  t.diagnostic(`500 trees/depth eight: ${(performance.now() - start).toFixed(1)} ms`);
});

test('Board construction and a search keystroke match the existing 5k/1800-under-50ms gate', (t) => {
  const nodes = Array.from({ length: 5000 }, (_, index) => ({ id: id(index), label: `Step ${index}` }));
  const edges = nodes.flatMap((node, index) => [...new Set([
    ...(index > 0 ? [index - 1] : []), ...(index > 2 ? [Math.floor(index / 2)] : []), ...(index > 7 ? [index - 7] : []),
  ])].map((parent) => ({ from: id(parent), to: node.id, present: true })));
  const marks = nodes.slice(0, 3200).map((node) => ({ node: node.id, status: 'complete', outOfOrder: false, recordedAt: null, deviceAt: null }));
  const tree = new RoadmapTree({ id: 'T', nodes, edges, marks });
  new BoardRead(new FollowGraph(tree)).result();
  const timings = Array.from({ length: 5 }, (_, run) => {
    const start = performance.now();
    const board = new BoardRead(new FollowGraph(tree), { search: run % 2 ? 'step 4' : '' }).result();
    assert.deepEqual(board.overall, { done: 3200, total: 5000 });
    return performance.now() - start;
  }).sort((a, b) => a - b);
  t.diagnostic(`Board median ${timings[2].toFixed(1)} ms`);
  assert.ok(timings[2] < 50, `median ${timings[2].toFixed(1)} ms`);
});

test('Disconnected retained tombstones do not allocate reachability rows', () => {
  const nodes = [{ id: 'a' }, { id: 'z' }];
  const edges = [{ from: 'a', to: 'z', present: true }];
  const small = new FollowGraph(new RoadmapTree({ id: 'T', nodes, edges }));
  const history = new FollowGraph(new RoadmapTree({ id: 'T', nodes: [...nodes, ...Array.from({ length: 50000 }, (_, index) => ({ id: `gone${index}`, present: false }))], edges }));
  assert.deepEqual(history.result(['a', 'z']), small.result(['a', 'z']));
  assert.equal(history.tree.nodesById.size, 50002);
  assert.deepEqual({ raw: history.rawIds.length, reach: history.reach.bits.byteLength, rows: history.rows.size, debt: history.owedIndex().closure.bits.byteLength },
    { raw: small.rawIds.length, reach: small.reach.bits.byteLength, rows: small.rows.size, debt: small.owedIndex().closure.bits.byteLength });
});
