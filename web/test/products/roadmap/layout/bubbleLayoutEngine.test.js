import test from 'node:test';
import assert from 'node:assert/strict';

import { BubbleLayoutEngine } from '../../../../src/products/roadmap/layout/BubbleLayoutEngine.js';
import { SkillTree } from '../../../../src/products/roadmap/model/SkillTree.js';
import { footprintOf, footprintRect } from '../../../../src/products/roadmap/model/footprint.js';
import { BODY_WU, WORKING_ZOOM } from '../../../../src/products/roadmap/theme.js';
import { loadDogfoodTree, dogfoodTreeData } from '../fixtures/dogfoodTree.js';
import { largeRoadmap } from '../fixtures/largeRoadmap.js';
import {
  countAround, familyInView, fitBodyPx, footprintOverlaps, nearestNeighboursPx, px, quantile, serialise, trunkLinksPx,
} from '../fixtures/readability.js';

const BODY_PX = BODY_WU * WORKING_ZOOM;

function treeOf(nodes) {
  return new SkillTree({ id: 't_test', title: 'Test', nodes });
}

function rectOf(tree, positions, id) {
  const { x, y } = positions.get(id);
  return footprintRect(x, y, footprintOf(tree.nodesById.get(id).label, { root: tree.trunk.primaryParentOf(id) === null }));
}

function segmentHitsRect(a, b, rect) {
  let t0 = 0;
  let t1 = 1;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  for (const [p, q] of [[-dx, a.x - rect.minX], [dx, rect.maxX - a.x], [-dy, a.y - rect.minY], [dy, rect.maxY - a.y]]) {
    if (p === 0) {
      if (q < 0) return false;
      continue;
    }
    if (p < 0) t0 = Math.max(t0, q / p);
    else t1 = Math.min(t1, q / p);
    if (t0 > t1) return false;
  }
  return t1 - t0 > 1e-6;
}

function trunkEdgesThroughForeignCaptions(tree, positions) {
  const rects = tree.nodes.map((node) => ({ id: node.id, ...rectOf(tree, positions, node.id) })).sort((a, b) => a.minX - b.minX);
  let crossings = 0;
  for (const node of tree.nodes) {
    const parentId = tree.trunk.primaryParentOf(node.id);
    if (parentId === null) continue;
    const a = positions.get(parentId);
    const b = positions.get(node.id);
    for (const rect of rects) {
      if (rect.minX > Math.max(a.x, b.x)) break;
      if (rect.maxX < Math.min(a.x, b.x) || rect.id === node.id || rect.id === parentId) continue;
      if (segmentHitsRect(a, b, rect)) crossings += 1;
    }
  }
  return crossings;
}

function movedOverABody(before, after) {
  const moves = [...before].map(([id, p]) => px(Math.hypot(p.x - after.get(id).x, p.y - after.get(id).y)));
  return { count: moves.filter((d) => d > BODY_PX).length, maxPx: Math.max(...moves) };
}

// The angle of `to` seen from `from`, measured from the heading the node at `from` faces (away from its own parent).
function bearing(tree, positions, from, to) {
  const parentId = tree.trunk.primaryParentOf(from);
  const here = positions.get(from);
  const there = positions.get(to);
  const heading = parentId === null ? 0 : Math.atan2(here.y - positions.get(parentId).y, here.x - positions.get(parentId).x);
  let angle = Math.atan2(there.y - here.y, there.x - here.x) - heading;
  while (angle > Math.PI) angle -= 2 * Math.PI;
  while (angle <= -Math.PI) angle += 2 * Math.PI;
  return angle;
}

test('the engine reads captions and arms the parent-arc reorder: siblings sweep an arc about their parent', () => {
  assert.equal(BubbleLayoutEngine.reorder, 'parent-arc');
  assert.equal(BubbleLayoutEngine.readsCaptions, true);
});

test('an empty tree is a picture with nothing in it, and a two-thousand-step chain still lays out', () => {
  assert.deepEqual([...new BubbleLayoutEngine().layout(treeOf([]))], []);
  const chain = treeOf(Array.from({ length: 2000 }, (_, i) => ({ id: `c${i}`, label: `Step ${i}`, prerequisites: i === 0 ? [] : [`c${i - 1}`] })));
  const positions = new BubbleLayoutEngine().layout(chain);
  assert.equal(positions.size, 2000);
  assert.ok([...positions.values()].every(({ x, y }) => Number.isFinite(x) && Number.isFinite(y)));
});

test('the dogfood tree meets the readability bar at the working zoom', () => {
  const { tree, states } = loadDogfoodTree();
  const engine = new BubbleLayoutEngine();
  const positions = engine.layout(tree);

  assert.equal(positions.size, tree.nodes.length);
  const links = trunkLinksPx(tree, positions);
  assert.ok(quantile(links, 0.5) <= 210, `trunk median ${quantile(links, 0.5)} px`);
  assert.ok(quantile(links, 0.9) <= 650, `trunk p90 ${quantile(links, 0.9)} px`);
  assert.ok(links.filter((d) => d <= 700).length / links.length >= 0.9, 'at least 90% of trunk links within 700 px');
  assert.ok(familyInView(tree, positions) >= 0.85, `family in view ${familyInView(tree, positions)}`);
  const nearestP10 = quantile(nearestNeighboursPx(positions), 0.1);
  assert.ok(nearestP10 >= 88, `nearest neighbour p10 ${nearestP10} px`);
  assert.deepEqual(footprintOverlaps(tree, positions), []);
  assert.equal(trunkEdgesThroughForeignCaptions(tree, positions), 0);
  assert.ok(countAround(positions, 'skilltree-scene') >= 15, 'the working window on skilltree-scene');
  const frontier = tree.topoOrder().find((id) => states.get(id) === 'active');
  assert.equal(frontier, 'gym-coach-wave');
  assert.ok(countAround(positions, frontier) >= 18, 'the working window on the frontier root');
  assert.ok(fitBodyPx(positions) >= 5, `fit body ${fitBodyPx(positions)} px`);
  assert.equal(serialise(positions), serialise(new BubbleLayoutEngine().layout(tree)));
});

test('children fan around their parent in trunk order and never sit in its in-edge corridor', () => {
  const { tree } = loadDogfoodTree();
  const positions = new BubbleLayoutEngine().layout(tree);
  let fans = 0;
  for (const node of tree.nodes) {
    const children = tree.trunk.trunkChildrenOf(node.id);
    const bearings = children.map((childId) => bearing(tree, positions, node.id, childId));
    for (let i = 1; i < bearings.length; i++) assert.ok(bearings[i] > bearings[i - 1], `${node.id}: children out of trunk order`);
    if (tree.trunk.primaryParentOf(node.id) !== null) {
      for (const angle of bearings) assert.ok(Math.abs(angle) <= Math.PI - Math.PI / 6 + 1e-9, `${node.id}: a child sits in the in-edge corridor`);
    }
    if (children.length >= 2) fans += 1;
  }
  assert.ok(fans > 100, `${fans} fans checked`);
});

test('a rename and a leaf insert move at most a handful of nodes by more than a body', () => {
  const data = dogfoodTreeData();
  const nodesOf = () => data.nodes.map(({ status, outOfOrder, ...node }) => node);
  const build = (nodes) => new SkillTree({ id: data.id, title: data.title, kinds: data.kinds, nodes });
  const engine = new BubbleLayoutEngine();
  const before = engine.layout(build(nodesOf()));

  const renamed = engine.layout(build(nodesOf().map((node) => (node.id === 'skilltree-scene' ? { ...node, label: 'Scene' } : node))));
  const afterRename = movedOverABody(before, renamed);
  assert.ok(afterRename.count <= 30, `${afterRename.count} nodes moved by more than a body on a rename`);
  assert.ok(afterRename.maxPx <= 400, `a node moved ${afterRename.maxPx} px on a rename`);

  const inserted = engine.layout(build([...nodesOf(), { id: 'zz-new-leaf', label: 'A brand new step', color: 'sky', icon: 'circle', prerequisites: ['skilltree-scene'] }]));
  const afterInsert = movedOverABody(before, inserted);
  assert.ok(afterInsert.count <= 30, `${afterInsert.count} nodes moved by more than a body on an insert`);
  assert.ok(afterInsert.maxPx <= 400, `a node moved ${afterInsert.maxPx} px on an insert`);
});

test('a lone node sits at the origin', () => {
  const positions = new BubbleLayoutEngine().layout(treeOf([{ id: 'only', label: 'Only', prerequisites: [] }]));
  assert.deepEqual(positions.get('only'), { x: 0, y: 0 });
});

test('a chain grows straight out of its root, each footprint exactly a margin from the one before', () => {
  const chain = (length) => treeOf(Array.from({ length }, (_, i) => ({ id: `c${i}`, label: `Step ${i + 1}`, prerequisites: i === 0 ? [] : [`c${i - 1}`] })));
  for (const length of [2, 50]) {
    const tree = chain(length);
    const positions = new BubbleLayoutEngine().layout(tree);
    assert.deepEqual(positions.get('c0'), { x: 0, y: 0 });
    for (let i = 1; i < length; i++) {
      const gap = rectOf(tree, positions, `c${i}`).minX - rectOf(tree, positions, `c${i - 1}`).maxX;
      assert.ok(Math.abs(gap - 8 / WORKING_ZOOM) < 1e-6, `link ${i} of ${length}: gap ${gap} wu`);
      assert.ok(Math.abs(positions.get(`c${i}`).y) < 1e-9, 'the chain stays on the root line');
    }
    assert.deepEqual(footprintOverlaps(tree, positions), []);
  }
});

test('a two-hundred-leaf fan, nine uneven roots and five thousand steps all lay out finite, apart and deterministic', () => {
  const fan = treeOf([{ id: 'root', label: 'A crown with two hundred children', prerequisites: [] }, ...Array.from({ length: 200 }, (_, i) => ({ id: `f${i}`, label: `Leaf number ${i + 1}`, prerequisites: ['root'] }))]);
  const uneven = treeOf([150, 80, 30, 14, 5, 2, 1, 1, 1].flatMap((size, r) => Array.from({ length: size }, (_, i) => ({ id: `r${r}n${i}`, label: `Root ${r} step ${i} · a caption of ordinary length`, prerequisites: i === 0 ? [] : [`r${r}n${Math.floor((i - 1) / 3)}`] }))));
  const large = largeRoadmap(5000, 'mixed');
  const fiveThousand = new SkillTree({ id: large.id, title: large.title, nodes: large.nodes.map(({ status, ...node }) => node) });
  for (const [name, tree] of [['fan', fan], ['uneven', uneven], ['5000', fiveThousand]]) {
    const engine = new BubbleLayoutEngine();
    const positions = engine.layout(tree);
    assert.equal(positions.size, tree.nodes.length, name);
    for (const { x, y } of positions.values()) assert.ok(Number.isFinite(x) && Number.isFinite(y), `${name}: a non-finite position`);
    assert.deepEqual(footprintOverlaps(tree, positions), [], `${name}: overlapping footprints`);
    assert.equal(serialise(positions), serialise(engine.layout(tree)), `${name}: not deterministic`);
  }
  const unevenPositions = new BubbleLayoutEngine().layout(uneven);
  assert.equal(trunkEdgesThroughForeignCaptions(uneven, unevenPositions), 0);
  assert.deepEqual(unevenPositions.get('r0n0'), { x: 0, y: 0 });
  const links = trunkLinksPx(uneven, unevenPositions);
  assert.ok(quantile(links, 0.5) <= 210, `nine roots: trunk median ${quantile(links, 0.5)} px`);
});


test('five thousand deep steps and a wide fan keep finite, separate seats inside a bounded layout pass', () => {
  const deep = new SkillTree(largeRoadmap(5000, 'deep'));
  const fan = treeOf(Array.from({ length: 5000 }, (_, i) => ({
    id: `n${i}`, label: `Practice meaningful skill ${i}`, prerequisites: i ? ['n0'] : [],
  })));
  for (const [name, tree] of [['deep', deep], ['fan', fan]]) {
    const engine = new BubbleLayoutEngine();
    const positions = engine.layout(tree);
    assert.equal(positions.size, 5000);
    assert.ok([...positions.values()].every(({ x, y }) => Number.isFinite(x) && Number.isFinite(y)), name);
    assert.deepEqual(footprintOverlaps(tree, positions), [], name);
    assert.equal(serialise(positions), serialise(engine.layout(tree)), name);
  }
  assert.equal(trunkEdgesThroughForeignCaptions(deep, new BubbleLayoutEngine().layout(deep)), 0);
});
