import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';

import { RingsLayoutEngine } from '../../../../src/products/roadmap/layout/RingsLayoutEngine.js';
import { LayoutEngine } from '../../../../src/products/roadmap/model/ports.js';
import { SkillTree } from '../../../../src/products/roadmap/model/SkillTree.js';
import { footprintOf, footprintRect } from '../../../../src/products/roadmap/model/footprint.js';
import { loadDogfoodTree } from '../fixtures/dogfoodTree.js';
import { largeRoadmap } from '../fixtures/largeRoadmap.js';
import {
  countAround, fitBodyPx, footprintOverlaps, nearestNeighboursPx, px, quantile, serialise, trunkLinksPx,
} from '../fixtures/readability.js';

const FULL_CIRCLE = 2 * Math.PI;

function treeOf(nodes) {
  return new SkillTree({ id: 't_test', title: 'Test', nodes });
}

function chain(length) {
  return treeOf(Array.from({ length }, (_, i) => ({ id: `c${i}`, label: `Step ${i} of the chain`, prerequisites: i === 0 ? [] : [`c${i - 1}`] })));
}

function fan(leafCount) {
  const nodes = [{ id: 'root', label: 'Fan root', prerequisites: [] }];
  for (let i = 0; i < leafCount; i++) nodes.push({ id: `leaf${String(i).padStart(3, '0')}`, label: `Leaf ${i} · a reasonably long caption`, prerequisites: ['root'] });
  return treeOf(nodes);
}

function shapeOf(count, shape) {
  const data = largeRoadmap(count, shape);
  return new SkillTree({ id: data.id, title: data.title, nodes: data.nodes.map(({ status, ...node }) => node) });
}

const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const wrap = (angle) => ((angle % FULL_CIRCLE) + FULL_CIRCLE) % FULL_CIRCLE;

// The island each root's trunk subtree makes: its crown, its nodes, and the rim its footprints reach from the crown.
function islandsOf(tree, positions) {
  return tree.roots().map((root) => {
    const ids = [];
    const stack = [root.id];
    while (stack.length > 0) {
      const id = stack.pop();
      ids.push(id);
      stack.push(...tree.trunk.trunkChildrenOf(id));
    }
    const crown = positions.get(root.id);
    const rim = Math.max(...ids.map((id) => {
      const node = tree.nodesById.get(id);
      const rect = footprintRect(0, 0, footprintOf(node.label, { root: node.prerequisites.length === 0 }));
      return distance(crown, positions.get(id)) + Math.hypot((rect.maxX - rect.minX) / 2, Math.max(-rect.minY, rect.maxY));
    }));
    return { root, ids, crown, rim };
  });
}

// Every trunk child sits farther from its island's crown than its parent, and siblings run around the ring in cmpOrder.
function assertRingsGrowOutwardInOrder(tree, positions, centreOf) {
  for (const node of tree.nodes) {
    const centre = centreOf(node.id);
    const children = tree.trunk.trunkChildrenOf(node.id);
    for (const childId of children) {
      assert.ok(distance(centre, positions.get(childId)) > distance(centre, positions.get(node.id)), `${childId} is not outside its parent ${node.id}`);
    }
    if (children.length < 2) continue;
    const angleOf = (id) => Math.atan2(positions.get(id).y - centre.y, positions.get(id).x - centre.x);
    const first = angleOf(children[0]);
    const turned = children.map((childId) => wrap(angleOf(childId) - first));
    for (let i = 1; i < turned.length; i++) assert.ok(turned[i] > turned[i - 1], `${children[i]} sits before its earlier sibling ${children[i - 1]} around ${node.id}`);
  }
}

test('the rings engine is a LayoutEngine that reads captions and disarms the ring reorder', () => {
  assert.ok(new RingsLayoutEngine() instanceof LayoutEngine);
  assert.equal(RingsLayoutEngine.reorder, 'none');
  assert.equal(RingsLayoutEngine.readsCaptions, true);
});

test('an empty tree is a picture with nothing in it, and a five-thousand-step chain still lays out', () => {
  assert.deepEqual([...new RingsLayoutEngine().layout(treeOf([]))], []);
  const positions = new RingsLayoutEngine().layout(chain(5000));
  assert.equal(positions.size, 5000);
  assert.ok([...positions.values()].every(({ x, y }) => Number.isFinite(x) && Number.isFinite(y)));
});

test('the dogfood forest reads at the working zoom: short trunk links, clear footprints, a full working window', () => {
  const { tree, states } = loadDogfoodTree();
  const engine = new RingsLayoutEngine();
  const times = [];
  let positions = null;
  for (let run = 0; run < 3; run++) {
    const start = performance.now();
    positions = engine.layout(tree);
    times.push(performance.now() - start);
  }
  assert.equal(positions.size, tree.nodes.length);
  assert.ok([...positions.values()].every(({ x, y }) => Number.isFinite(x) && Number.isFinite(y)));
  assert.equal(serialise(engine.layout(tree)), serialise(positions));

  const trunkPx = trunkLinksPx(tree, positions);
  const rootToChildPx = tree.nodes
    .filter((node) => node.prerequisites.length === 0)
    .flatMap((root) => tree.trunk.trunkChildrenOf(root.id).map((childId) => px(distance(positions.get(root.id), positions.get(childId)))));
  const nearest = nearestNeighboursPx(positions);
  const frontier = tree.topoOrder().find((id) => states.get(id) === 'active');
  assert.ok(quantile(trunkPx, 0.5) <= 300, `trunk median ${quantile(trunkPx, 0.5).toFixed(0)} px`);
  assert.ok(quantile(trunkPx, 0.9) <= 700, `trunk p90 ${quantile(trunkPx, 0.9).toFixed(0)} px`);
  assert.ok(trunkPx.filter((d) => d <= 700).length / trunkPx.length >= 0.95, `only ${trunkPx.filter((d) => d <= 700).length} of ${trunkPx.length} trunk links within 700 px`);
  assert.ok(quantile(rootToChildPx, 0.5) <= 300, `root→child median ${quantile(rootToChildPx, 0.5).toFixed(0)} px`);
  assert.ok(quantile(nearest, 0.1) >= 100, `nearest neighbour p10 ${quantile(nearest, 0.1).toFixed(0)} px`);
  assert.ok(countAround(positions, 'skilltree-scene') >= 14, `${countAround(positions, 'skilltree-scene')} nodes around skilltree-scene`);
  assert.ok(countAround(positions, frontier) >= 14, `${countAround(positions, frontier)} nodes around the frontier step ${frontier}`);
  assert.deepEqual(footprintOverlaps(tree, positions), []);
  assert.ok(fitBodyPx(positions) >= 4, `fit body ${fitBodyPx(positions).toFixed(1)} px`);
  // The 55 ms figure lives in scripts/benchmark-roadmap.mjs; here only a runaway is caught, since the suite runs files in parallel.
  assert.ok(Math.min(...times) <= 600, `layout took ${Math.min(...times).toFixed(0)} ms`);
});

test('the dogfood forest is islands: the largest crown at the origin, no island inside another rim, rings outward in order', () => {
  const { tree } = loadDogfoodTree();
  const positions = new RingsLayoutEngine().layout(tree);
  const islands = islandsOf(tree, positions);
  const largest = islands.reduce((best, island) => (island.ids.length > best.ids.length ? island : best));
  assert.equal(islands.length, 9);
  assert.equal(largest.ids.length, 272);
  assert.deepEqual(largest.crown, { x: 0, y: 0 });
  for (const island of islands) {
    for (const other of islands) {
      if (other === island) continue;
      for (const id of other.ids) {
        assert.ok(distance(island.crown, positions.get(id)) > island.rim, `${id} of ${other.root.id} sits inside the rim of ${island.root.id}`);
      }
    }
  }
  const crownOf = new Map(islands.flatMap((island) => island.ids.map((id) => [id, island.crown])));
  assertRingsGrowOutwardInOrder(tree, positions, (id) => crownOf.get(id));
});

test('a lone node sits at the origin', () => {
  const only = treeOf([{ id: 'only', label: 'Only', prerequisites: [] }]);
  assert.deepEqual([...new RingsLayoutEngine().layout(only)], [['only', { x: 0, y: 0 }]]);
});

test('a two-chain hangs the child one clear pitch outside its root', () => {
  const two = treeOf([
    { id: 'a', label: 'Root', prerequisites: [] },
    { id: 'b', label: 'Child with a long two-line caption here', prerequisites: ['a'] },
  ]);
  const positions = new RingsLayoutEngine().layout(two);
  assert.deepEqual(positions.get('a'), { x: 0, y: 0 });
  const pitch = Math.hypot(positions.get('b').x, positions.get('b').y);
  assert.ok(pitch >= 100 && px(pitch) <= 300, `child at ${pitch.toFixed(0)} wu`);
  assert.deepEqual(footprintOverlaps(two, positions), []);
});

test('a fifty-chain climbs one ring per step, never a long link', () => {
  const tree = chain(50);
  const positions = new RingsLayoutEngine().layout(tree);
  const radii = tree.nodes.map((node) => Math.hypot(positions.get(node.id).x, positions.get(node.id).y));
  for (let i = 1; i < radii.length; i++) assert.ok(radii[i] > radii[i - 1], `step ${i} did not move outward`);
  assert.ok(Math.max(...trunkLinksPx(tree, positions)) <= 300);
  assert.deepEqual(footprintOverlaps(tree, positions), []);
});

test('a two-hundred-leaf fan keeps every leaf on one ring, in order, with clear footprints', () => {
  const tree = fan(200);
  const positions = new RingsLayoutEngine().layout(tree);
  const radii = tree.trunk.trunkChildrenOf('root').map((id) => Math.round(Math.hypot(positions.get(id).x, positions.get(id).y)));
  assert.equal(new Set(radii).size, 1);
  assert.ok([...positions.values()].every(({ x, y }) => Number.isFinite(x) && Number.isFinite(y)));
  assert.deepEqual(footprintOverlaps(tree, positions), []);
  assertRingsGrowOutwardInOrder(tree, positions, () => ({ x: 0, y: 0 }));
});

test('four lone roots are four islands clear of each other', () => {
  const tree = treeOf(['a', 'b', 'c', 'd'].map((id) => ({ id, label: `Root ${id}`, prerequisites: [] })));
  const islands = new RingsLayoutEngine().layout(tree);
  assert.deepEqual(islands.get('a'), { x: 0, y: 0 });
  assert.deepEqual(footprintOverlaps(tree, islands), []);
});

test('blank labels still get a seat', () => {
  const tree = treeOf([
    { id: 'a', label: '', prerequisites: [] },
    { id: 'b', label: '', prerequisites: ['a'] },
    { id: 'c', label: '', prerequisites: ['a'] },
  ]);
  const positions = new RingsLayoutEngine().layout(tree);
  assert.ok([...positions.values()].every(({ x, y }) => Number.isFinite(x) && Number.isFinite(y)));
  assert.deepEqual(footprintOverlaps(tree, positions), []);
});

test('five thousand steps lay out finite and byte-identical twice, in every shape', () => {
  for (const shape of ['mixed', 'broad', 'deep', 'multiroot']) {
    const tree = shapeOf(5000, shape);
    const engine = new RingsLayoutEngine();
    const positions = engine.layout(tree);
    assert.equal(positions.size, 5000);
    assert.ok([...positions.values()].every(({ x, y }) => Number.isFinite(x) && Number.isFinite(y)), `${shape}: a position is not finite`);
    assert.deepEqual(footprintOverlaps(tree, positions), [], `${shape}: footprints overlap`);
    if (shape === 'multiroot') assert.equal(serialise(engine.layout(tree)), serialise(positions), `${shape}: two runs differ`);
  }
});
