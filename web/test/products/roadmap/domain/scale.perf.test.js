import test from 'node:test';
import assert from 'node:assert/strict';
import { RoadmapTree } from '../../../../src/products/roadmap/domain/records.js';
import { FollowGraph } from '../../../../src/products/roadmap/domain/graph.js';
import { RoadmapAccount } from '../../../../src/products/roadmap/domain/account.js';
import { BoardRead } from '../../../../src/products/roadmap/domain/reads.js';
import { landingOf } from '../../../../src/products/roadmap/domain/landing.js';
import { ChangeStep } from '../../../../src/products/roadmap/domain/steps.js';
import { ActionRunner, EngineReplica } from '../../../../src/platform/domain-kit/runner.js';
import { FixedZone } from '../../../../src/platform/domain-kit/time.js';
import { BrowserSyncEngine } from '../../../../src/platform/sync/engine.js';
import { environment } from '../../../platform/sync/fakes.js';
import { roadmapRegistry } from './vectors.js';

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

// The kit reads a scope's confirmed rows only to look one up, so a read of the device's copy copies none it does not ask
// for: the reconciliation metadata of a 10,000-step roadmap costs what a small one does. A read, the landing read and one
// change are reported.
test('A 10,000-step roadmap on the device\'s engine: its read metadata copies no confirmed row a reader does not ask for', async (t) => {
  const engine = await BrowserSyncEngine.open({ ...environment().options, registry: roadmapRegistry });
  try {
    await engine.signIn('A');
    const tree = 't_00000000000000aa';
    const scope = `tree/${tree}`;
    const stamp = '1000:0:r_aaaaaaaaaaaa';
    await engine.write(null, (/** @type {any} */ device) => {
      const replica = device.activeReplica;
      replica.putConfirmed('self/roadmap', { t: 'tree', id: tree, seq: 1, born: stamp, life: ['alive', stamp], f: {} });
      for (let index = 0; index < 10000; index++) {
        replica.putConfirmed(scope, { t: 'node', id: id(index), seq: index + 1, born: stamp, life: ['alive', stamp],
          f: { label: [`Step ${index}`, stamp], ord: ['a0', stamp], description: [`What step ${index} is about`, stamp] } });
      }
      let seq = 10001;
      for (let index = 0; index < 10000; index++) {
        for (const gap of [1, 2]) if (index >= gap) replica.putConfirmed(scope, { t: 'edge', id: [id(index - gap), id(index)], seq: seq++, life: ['alive', stamp] });
      }
    }, ['self/roadmap', scope]);
    const hold = engine.observe(scope);
    const runner = new ActionRunner(new EngineReplica(engine), roadmapRegistry, new FixedZone(0));
    const median = async (/** @type {(run: number) => unknown} */ body) => {
      const timings = [];
      for (let run = 0; run < 7; run++) {
        const start = performance.now();
        await body(run);
        timings.push(performance.now() - start);
      }
      return timings.sort((a, b) => a - b)[3] ?? 0;
    };
    assert.equal(engine.device.activeReplica.confirmedRows(scope).length, 29997);
    assert.deepEqual(engine.readMetadata(scope).confirmed.get(JSON.stringify(['node', id(7)]))?.f?.label, ['Step 7', stamp]);
    const metadata = await median(() => engine.readMetadata(scope));
    const read = await median(() => new EngineReplica(engine).read(scope));
    const landing = await median(() => runner.read(scope, (reader) => landingOf(tree, reader)));
    const change = await median((run) => runner.runAct(new ChangeStep(tree, id(5000), { label: `Renamed ${run}` })));
    t.diagnostic(`10k steps/20k links: read metadata ${metadata.toFixed(1)} ms, a read ${read.toFixed(1)} ms, the landing read ${landing.toFixed(1)} ms, one change ${change.toFixed(1)} ms`);
    assert.ok(metadata < 5, `read metadata ${metadata.toFixed(1)} ms`);
    hold.release();
  } finally {
    engine.close();
  }
});
