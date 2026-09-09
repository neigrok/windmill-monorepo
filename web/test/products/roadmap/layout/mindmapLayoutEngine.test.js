import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';

import MindmapLayoutEngine from '../../../../src/products/roadmap/layout/MindmapLayoutEngine.js';
import { SkillTree } from '../../../../src/products/roadmap/model/SkillTree.js';
import { footprintOf, footprintRect } from '../../../../src/products/roadmap/model/footprint.js';
import { NODE_SIZE, BODY_WU, WORKING_ZOOM } from '../../../../src/products/roadmap/theme.js';
import { loadDogfoodTree, dogfoodTreeData } from '../fixtures/dogfoodTree.js';
import { largeRoadmap, ROADMAP_SHAPES } from '../fixtures/largeRoadmap.js';

const WINDOW = { width: 1440, height: 848 };
const px = (wu) => wu * WORKING_ZOOM;

function treeOf(nodes) {
  return new SkillTree({ id: 't_test', title: 'Test', nodes });
}

function node(id, prerequisites, label = 'A step with a caption that runs to two lines') {
  return { id, label, prerequisites, color: 'gold', icon: 'circle' };
}

function serialised(positions) {
  return JSON.stringify([...positions.entries()].sort(([a], [b]) => (a < b ? -1 : 1)));
}

function quantile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))];
}

function inWindow(a, b) {
  return Math.abs(px(a.x - b.x)) <= WINDOW.width / 2 && Math.abs(px(a.y - b.y)) <= WINDOW.height / 2;
}

// The readability numbers the roadmap foundation is judged on, at the desktop working zoom on a 1440x848 canvas.
function readability(tree, positions) {
  const trunk = tree.trunk;
  const ids = tree.nodes.map((n) => n.id);
  const at = (id) => positions.get(id);
  const distance = (a, b) => px(Math.hypot(at(a).x - at(b).x, at(a).y - at(b).y));
  const trunkLinks = ids.filter((id) => trunk.primaryParentOf(id) !== null).map((id) => distance(trunk.primaryParentOf(id), id));
  const nearest = ids.map((a) => Math.min(...ids.filter((b) => b !== a).map((b) => distance(a, b))));
  const families = ids
    .map((id) => ({ id, kin: [trunk.primaryParentOf(id), ...trunk.trunkChildrenOf(id)].filter((other) => other !== null) }))
    .filter(({ kin }) => kin.length > 0)
    .map(({ id, kin }) => kin.filter((other) => inWindow(at(id), at(other))).length / kin.length);
  const rects = tree.nodes
    .map((n) => footprintRect(at(n.id).x, at(n.id).y, footprintOf(n.label, { root: n.prerequisites.length === 0 })))
    .sort((a, b) => a.minX - b.minX);
  let overlaps = 0;
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length && rects[j].minX < rects[i].maxX; j++) {
      if (rects[j].minY < rects[i].maxY && rects[j].maxY > rects[i].minY) overlaps++;
    }
  }
  const xs = ids.map((id) => at(id).x);
  const ys = ids.map((id) => at(id).y);
  const bounds = { width: Math.max(...xs) - Math.min(...xs) + NODE_SIZE * 2, height: Math.max(...ys) - Math.min(...ys) + NODE_SIZE * 2 };
  const fitZoom = Math.min(Math.min(WINDOW.width / bounds.width, WINDOW.height / bounds.height) * 0.9, WORKING_ZOOM);
  return {
    trunkMedianPx: quantile(trunkLinks, 0.5),
    trunkP90Px: quantile(trunkLinks, 0.9),
    trunkShareWithin700: trunkLinks.filter((d) => d <= 700).length / trunkLinks.length,
    nearestP10Px: quantile(nearest, 0.1),
    familyInView: families.reduce((sum, share) => sum + share, 0) / families.length,
    footprintOverlaps: overlaps,
    fitBodyPx: BODY_WU * fitZoom,
    inWindowAround: (id) => ids.filter((other) => inWindow(at(id), at(other))).length,
  };
}

test('the dogfood tree reads at the working zoom: short trunk links, whole families, no footprint overlaps', () => {
  const { tree } = loadDogfoodTree();
  const engine = new MindmapLayoutEngine();
  const times = [];
  let positions;
  for (let run = 0; run < 5; run++) {
    const start = performance.now();
    positions = engine.layout(tree);
    times.push(performance.now() - start);
  }
  assert.equal(positions.size, tree.nodes.length);
  const m = readability(tree, positions);
  assert.ok(m.trunkMedianPx <= 230, `trunk median ${m.trunkMedianPx.toFixed(0)} px`);
  assert.ok(m.trunkP90Px <= 600, `trunk p90 ${m.trunkP90Px.toFixed(0)} px`);
  assert.ok(m.trunkShareWithin700 >= 0.9, `${(m.trunkShareWithin700 * 100).toFixed(1)}% of trunk links within 700 px`);
  assert.ok(m.familyInView >= 0.9, `family in view ${(m.familyInView * 100).toFixed(1)}%`);
  assert.ok(m.nearestP10Px >= 100, `nearest neighbour p10 ${m.nearestP10Px.toFixed(0)} px`);
  assert.equal(m.footprintOverlaps, 0);
  assert.ok(m.fitBodyPx >= 4, `fit body ${m.fitBodyPx.toFixed(1)} px`);
  assert.ok(m.inWindowAround('gym-coach-wave') >= 20, `${m.inWindowAround('gym-coach-wave')} steps around the frontier root`);
  assert.ok(m.inWindowAround('skilltree-scene') >= 8, `${m.inWindowAround('skilltree-scene')} steps around skilltree-scene`);
  assert.ok(quantile(times, 0.5) <= 40, `layout took ${quantile(times, 0.5).toFixed(1)} ms`);
  assert.equal(serialised(new MindmapLayoutEngine().layout(tree)), serialised(positions));
});

test('the dogfood forest: the two big roots face east and west, the next two south and north, strays sit in the hub', () => {
  const { tree } = loadDogfoodTree();
  const positions = new MindmapLayoutEngine().layout(tree);
  const at = (id) => positions.get(id);
  const onAxis = (value) => Math.abs(value) < 1e-9;
  assert.ok(at('a679631b-d65c-4a4c-a00b-ad04be0ecc1a').x > 0 && onAxis(at('a679631b-d65c-4a4c-a00b-ad04be0ecc1a').y), 'the 272-step root faces east');
  assert.ok(at('product').x < 0 && onAxis(at('product').y), 'the 152-step root faces west');
  assert.ok(at('gym-coach-wave').y > 0 && onAxis(at('gym-coach-wave').x), 'the 28-step root faces south');
  assert.ok(at('debt-audit-2026-08-05').y < 0 && onAxis(at('debt-audit-2026-08-05').x), 'the 14-step root faces north');
  assert.deepEqual(
    ['boot-ground-the-app-stops-flashing', 'pg-connection-pool', 'web-marketing-appearance-toggle'].map((id) => at(id).x),
    [0, 0, 0],
  );
  assert.deepEqual(at('pg-connection-pool'), { x: 0, y: 0 });
  assert.ok(at('boot-ground-the-app-stops-flashing').y < 0 && at('web-marketing-appearance-toggle').y > 0, 'strays stack in their own order');
});

test('siblings sit in trunk order across the branch and every level lies farther out along it', () => {
  const { tree } = loadDogfoodTree();
  const positions = new MindmapLayoutEngine().layout(tree);
  const trunk = tree.trunk;
  const headOf = (id) => (trunk.primaryParentOf(id) === null ? id : headOf(trunk.primaryParentOf(id)));
  const axisOf = (id) => {
    const head = positions.get(headOf(id));
    const length = Math.hypot(head.x, head.y);
    return { x: head.x / length, y: head.y / length };
  };
  const along = (id, axis) => positions.get(id).x * axis.x + positions.get(id).y * axis.y;
  const across = (id, axis) => positions.get(id).x * -axis.y + positions.get(id).y * axis.x;
  for (const node of tree.nodes) {
    const axis = axisOf(node.id);
    const children = trunk.trunkChildrenOf(node.id);
    for (const childId of children) {
      assert.ok(along(childId, axis) > along(node.id, axis) + 60, `${childId} grows outward from ${node.id}`);
    }
    const seats = children.map((childId) => across(childId, axis));
    const ascending = seats.every((seat, i) => i === 0 || seat > seats[i - 1]);
    const descending = seats.every((seat, i) => i === 0 || seat < seats[i - 1]);
    assert.ok(ascending || descending, `the children of ${node.id} keep their order across the branch`);
  }
});

test('renaming a step moves nothing; a step born under skilltree-scene moves its branch by at most 100 px', () => {
  const data = dogfoodTreeData();
  const nodes = data.nodes.map(({ status, outOfOrder, ...n }) => n);
  const build = (edited) => new SkillTree({ id: data.id, title: data.title, nodes: edited });
  const engine = new MindmapLayoutEngine();
  const before = engine.layout(build(nodes));
  const movedPx = (after) => [...before.keys()].map((id) => px(Math.hypot(after.get(id).x - before.get(id).x, after.get(id).y - before.get(id).y)));

  const renamed = engine.layout(build(nodes.map((n) => (n.id === 'webgl-renderer' ? { ...n, label: 'WebGL2 painter' } : n))));
  assert.equal(Math.max(...movedPx(renamed)), 0);

  const grown = engine.layout(build([...nodes, node('born', ['skilltree-scene'], 'A new step under the scene')]));
  assert.ok(Math.max(...movedPx(grown)) <= 100, `a birth moved a step ${Math.max(...movedPx(grown)).toFixed(0)} px`);
});

test('a lone root sits at the origin and a two-step chain hangs its child to the east', () => {
  const engine = new MindmapLayoutEngine();
  assert.deepEqual(engine.layout(treeOf([node('only', [])])).get('only'), { x: 0, y: 0 });

  const chain = engine.layout(treeOf([node('a', []), node('b', ['a'])]));
  assert.deepEqual(chain.get('a'), { x: 0, y: 0 });
  assert.ok(chain.get('b').x > 0 && chain.get('b').y === 0);
  assert.ok(px(chain.get('b').x) <= 230, `the child sits ${px(chain.get('b').x).toFixed(0)} px out`);
});

test('a fifty-step chain runs east one level at a time: the first step clears the crowned root, the rest advance 200 px', () => {
  const nodes = Array.from({ length: 50 }, (_, i) => node(`c${i}`, i === 0 ? [] : [`c${i - 1}`]));
  const positions = new MindmapLayoutEngine().layout(treeOf(nodes));
  assert.deepEqual(positions.get('c0'), { x: 0, y: 0 });
  const steps = Array.from({ length: 49 }, (_, i) => px(positions.get(`c${i + 1}`).x - positions.get(`c${i}`).x));
  assert.ok(steps[0] >= 200 && steps[0] <= 230, `the first step advances ${steps[0].toFixed(0)} px`);
  assert.deepEqual(steps.slice(1).map((step) => Math.round(step)), new Array(48).fill(200));
  assert.deepEqual(nodes.map((n) => positions.get(n.id).y), new Array(50).fill(0));
});

test('a root with two hundred leaves, nine uneven roots and three strays all lay out finite, apart and byte-identically', () => {
  const engine = new MindmapLayoutEngine();
  const subtree = (prefix, size, branching) => {
    const out = [node(`${prefix}0`, [])];
    for (let i = 1; i < size; i++) out.push(node(`${prefix}${i}`, [`${prefix}${Math.floor((i - 1) / branching)}`]));
    return out;
  };
  const cases = {
    fan: [node('root', []), ...Array.from({ length: 200 }, (_, i) => node(`leaf${String(i).padStart(3, '0')}`, ['root']))],
    forest: [150, 80, 30, 14, 5, 2, 1, 1, 1].flatMap((size, k) => subtree(`r${k}_`, size, [3, 2, 4, 2, 4, 1, 1, 1, 1][k])),
    strays: [node('a', []), node('b', []), node('c', [])],
  };
  for (const [name, nodes] of Object.entries(cases)) {
    const tree = treeOf(nodes);
    const positions = engine.layout(tree);
    assert.equal(positions.size, nodes.length, name);
    for (const [id, { x, y }] of positions) assert.ok(Number.isFinite(x) && Number.isFinite(y), `${name}: ${id} is finite`);
    assert.equal(readability(tree, positions).footprintOverlaps, 0, `${name}: no footprint overlaps`);
    assert.equal(serialised(new MindmapLayoutEngine().layout(tree)), serialised(positions), `${name}: deterministic`);
  }
  const fan = engine.layout(treeOf(cases.fan));
  assert.deepEqual(fan.get('root'), { x: 0, y: 0 });
  const strays = engine.layout(treeOf(cases.strays));
  assert.deepEqual([strays.get('a').x, strays.get('b'), strays.get('c').x], [0, { x: 0, y: 0 }, 0]);
});

test('five thousand steps of every shape lay out finite and byte-identically', () => {
  const engine = new MindmapLayoutEngine();
  for (const shape of ROADMAP_SHAPES) {
    const data = largeRoadmap(5000, shape);
    const tree = new SkillTree({ id: data.id, title: data.title, nodes: data.nodes.map(({ status, ...n }) => n) });
    const positions = engine.layout(tree);
    assert.equal(positions.size, 5000, shape);
    for (const [id, { x, y }] of positions) assert.ok(Number.isFinite(x) && Number.isFinite(y), `${shape}: ${id} is finite`);
    assert.equal(serialised(new MindmapLayoutEngine().layout(tree)), serialised(positions), `${shape}: deterministic`);
  }
});

test('the reorder hint is none: siblings sit on a line, not an arc', () => {
  assert.equal(MindmapLayoutEngine.reorder, 'none');
});
