import test from 'node:test';
import assert from 'node:assert/strict';

import { RadialLayoutEngine } from '../../../../src/products/roadmap/layout/RadialLayoutEngine.js';
import { SkillTree } from '../../../../src/products/roadmap/model/SkillTree.js';
import { largeRoadmap } from '../fixtures/largeRoadmap.js';
import {
  NODE_BODY_DIAMETER, WORKING_ZOOM, LABEL_MAX_WIDTH,
  LABEL_LINE_HEIGHT, LABEL_GAP, LABEL_CLEARANCE,
} from '../../../../src/products/roadmap/model/geometry.js';

function treeOf(nodes) {
  return new SkillTree({ id: 't_test', title: 'Test', nodes });
}

function fixture(count, shape) {
  const nodes = [];
  for (let index = 0; index < count; index++) {
    const id = `n${String(index).padStart(5, '0')}`;
    const label = `Step ${index}: A long authored title that needs the whole caption footprint`;
    if (index === 0 || shape === 'multi-root' && index < 9) {
      nodes.push({ id, label, prerequisites: [] });
      continue;
    }
    const parent = shape === 'wide' ? 0
      : shape === 'deep' ? index - 1
      : shape === 'multi-root' ? Math.floor((index - 9) / 3)
      : Math.floor((index - 1) / 4);
    nodes.push({ id, label, prerequisites: [`n${String(parent).padStart(5, '0')}`] });
  }
  return treeOf(nodes);
}

function assertReadableLayout(tree, positions) {
  assert.deepEqual([...positions.keys()].sort(), tree.nodes.map(node => node.id).sort());
  const violations = [];
  const footprints = [];
  const majorById = new Map();
  const bandsByMajor = new Map();
  const centerId = tree.trunk.centerId();
  for (const id of tree.topoOrder()) {
    const parentId = tree.trunk.primaryParentOf(id);
    const majorId = parentId === null || parentId === centerId ? id : majorById.get(parentId);
    majorById.set(id, majorId);
    if (id === centerId) continue;
    if (!bandsByMajor.has(majorId)) bandsByMajor.set(majorId, new Map());
    const bands = bandsByMajor.get(majorId);
    const depth = tree.trunk.trunkDepthOf(id);
    const point = positions.get(id);
    const radius = Math.hypot(point.x, point.y);
    if (!bands.has(depth)) bands.set(depth, new Set());
    bands.get(depth).add(Math.round(radius * 1e6) / 1e6);
  }
  for (const bands of bandsByMajor.values()) {
    let previousOuterRadius = null;
    for (const [, rows] of [...bands.entries()].sort((a, b) => a[0] - b[0])) {
      const radii = [...rows].sort((a, b) => a - b);
      if (previousOuterRadius !== null && (radii[0] - previousOuterRadius) * WORKING_ZOOM < 320 - 1e-5) {
        violations.push('Logical generations interleave or lose their visible gap');
      }
      for (let index = 1; index < radii.length; index++) {
        if (Math.abs((radii[index] - radii[index - 1]) * WORKING_ZOOM - 240) > 1e-5) violations.push('Rows lose their regular radial pitch');
      }
      previousOuterRadius = radii.at(-1);
    }
  }
  for (const node of tree.nodes) {
    const { x, y } = positions.get(node.id);
    if (!Number.isFinite(x) || !Number.isFinite(y)) violations.push(`${node.id} is not finite`);
    const parent = tree.trunk.primaryParentOf(node.id);
    if (parent !== null) {
      const origin = positions.get(parent);
      if (Math.hypot(x, y) <= Math.hypot(origin.x, origin.y)) violations.push(`${node.id} does not grow outward`);
    }
    const radius = NODE_BODY_DIAMETER * (node.prerequisites.length === 0 ? 1.55 : 1) / 2;
    footprints.push({
      id: node.id,
      major: node.id === centerId ? null : majorById.get(node.id),
      depth: tree.trunk.trunkDepthOf(node.id),
      radius: Math.hypot(x, y),
      x, y,
      minX: x - (LABEL_MAX_WIDTH + LABEL_CLEARANCE) / (2 * WORKING_ZOOM),
      maxX: x + (LABEL_MAX_WIDTH + LABEL_CLEARANCE) / (2 * WORKING_ZOOM),
      minY: y - radius - LABEL_CLEARANCE / (2 * WORKING_ZOOM),
      maxY: y + radius + (LABEL_GAP + 2 * LABEL_LINE_HEIGHT + LABEL_CLEARANCE / 2) / WORKING_ZOOM,
    });
  }
  footprints.sort((a, b) => a.minX - b.minX);
  for (let index = 0; index < footprints.length; index++) {
    const left = footprints[index];
    for (let next = index + 1; next < footprints.length && footprints[next].minX < left.maxX + 128 / WORKING_ZOOM; next++) {
      const right = footprints[next];
      const distance = Math.hypot(left.x - right.x, left.y - right.y) * WORKING_ZOOM;
      if (distance < 184 - 1e-6) violations.push(`${left.id} is too close to ${right.id}`);
      if (left.major === right.major && left.depth === right.depth && Math.abs(left.radius - right.radius) < 1e-6 && distance < 208 - 1e-6) {
        violations.push(`${left.id} loses the same-row pitch beside ${right.id}`);
      }
      if (left.maxX > right.minX + 1e-7 && left.maxY > right.minY + 1e-7 && right.maxY > left.minY + 1e-7) {
        violations.push(`${left.id} overlaps ${right.id}`);
      }
      if (left.major === null || right.major === null || left.major === right.major) continue;
      const gapX = Math.max(0, left.minX - right.maxX, right.minX - left.maxX);
      const gapY = Math.max(0, left.minY - right.maxY, right.minY - left.maxY);
      if (Math.hypot(gapX, gapY) * WORKING_ZOOM < 128 - 1e-6) violations.push(`${left.id} crosses the sector gutter beside ${right.id}`);
    }
  }
  assert.deepEqual(violations, []);
}

for (const count of [300, 500, 1000, 5000]) {
  for (const shape of ['balanced', 'wide', 'deep', 'multi-root']) {
    test(`${count} ${shape} nodes keep depth bands, full caption footprints, and sector gutters`, () => {
      const tree = fixture(count, shape);
      const positions = new RadialLayoutEngine().layout(tree);
      assertReadableLayout(tree, positions);
    });
  }
}

test('empty and single-node trees have complete positions', () => {
  assert.deepEqual(new RadialLayoutEngine().layout(treeOf([])), new Map());
  const positions = new RadialLayoutEngine().layout(treeOf([{ id: 'only', label: 'only', prerequisites: [] }]));
  assert.deepEqual(positions, new Map([['only', { x: 0, y: 0 }]]));
});

test('input order and repeated layout calls do not change a node position', () => {
  const tree = fixture(500, 'multi-root');
  const engine = new RadialLayoutEngine();
  const positions = engine.layout(tree);
  assert.deepEqual(engine.layout(treeOf([...tree.nodes].reverse())), positions);
  assert.deepEqual(engine.layout(tree), positions);
});

test('crowded siblings fill regular rows without inflating an unrelated branch', () => {
  const nodes = [
    { id: 'root', label: 'root', prerequisites: [] },
    { id: 'wide', label: 'wide', prerequisites: ['root'] },
    { id: 'narrow', label: 'narrow', prerequisites: ['root'] },
    { id: 'tip', label: 'tip', prerequisites: ['narrow'] },
  ];
  const sparsePositions = new RadialLayoutEngine().layout(treeOf(nodes));
  for (let index = 0; index < 500; index++) nodes.push({ id: `wide${index}`, label: 'A wide branch caption', prerequisites: ['wide'] });
  const tree = treeOf(nodes);
  const positions = new RadialLayoutEngine().layout(tree);
  assertReadableLayout(tree, positions);
  assert.deepEqual(positions.get('narrow'), sparsePositions.get('narrow'));
  assert.deepEqual(positions.get('tip'), sparsePositions.get('tip'));
  const radii = nodes.slice(4).map(node => {
    const position = positions.get(node.id);
    return Math.round(Math.hypot(position.x, position.y));
  });
  assert.ok(new Set(radii).size > 1);
});

test('radial sibling order follows authored order across major sectors', () => {
  const tree = fixture(300, 'wide');
  tree.nodes[1].order = 'z';
  tree.nodes[2].order = 'a';
  const orderedTree = treeOf(tree.nodes);
  const positions = new RadialLayoutEngine().layout(orderedTree);
  const children = orderedTree.trunk.trunkChildrenOf('n00000');
  const actual = [...children].sort((left, right) => {
    const a = positions.get(left), b = positions.get(right);
    const angleA = (Math.atan2(a.y, a.x) + Math.PI * 2) % (Math.PI * 2);
    const angleB = (Math.atan2(b.y, b.x) + Math.PI * 2) % (Math.PI * 2);
    return angleA - angleB;
  });
  assert.deepEqual(actual, children);
});

test('every sibling in a broad single-root tree keeps one radius and its own sector gutter', () => {
  const tree = fixture(5000, 'wide');
  const positions = new RadialLayoutEngine().layout(tree);
  const radii = tree.nodes.slice(1).map(node => {
    const point = positions.get(node.id);
    return Math.round(Math.hypot(point.x, point.y));
  });
  assert.equal(new Set(radii).size, 1);
  assertReadableLayout(tree, positions);
});

test('long chains retain a constant generation gap after the first branch anchor', () => {
  const tree = fixture(5000, 'deep');
  const positions = new RadialLayoutEngine().layout(tree);
  const gaps = tree.nodes.slice(1).map(node => {
    const point = positions.get(node.id);
    const parent = positions.get(node.prerequisites[0]);
    return Math.round(Math.hypot(point.x - parent.x, point.y - parent.y) * WORKING_ZOOM);
  });
  assert.equal(gaps[0], 240);
  assert.deepEqual(new Set(gaps.slice(1)), new Set([320]));
});

test('deep alternating branches retain finite structured rows', () => {
  const nodes = [{ id: 'root', label: 'Root', prerequisites: [] }];
  for (let index = 1; index < 5000; index++) {
    nodes.push({
      id: `step${index}`,
      label: 'A long two-line caption along an uneven branch',
      prerequisites: [index < 3 ? 'root' : `step${index % 2 === 0 ? index - 2 : index - 1}`],
    });
  }
  const tree = treeOf(nodes);
  assertReadableLayout(tree, new RadialLayoutEngine().layout(tree));
});

test('disconnected roots reserve their larger body and caption footprints', () => {
  const tree = treeOf(Array.from({ length: 500 }, (_, index) => ({ id: `root${index}`, label: 'A full title on an independent root', prerequisites: [] })));
  assertReadableLayout(tree, new RadialLayoutEngine().layout(tree));
});

test('wrapped rows preserve authored sibling groups in their complete band sequence', () => {
  const nodes = [
    { id: 'root', label: 'Root', prerequisites: [] },
    { id: 'major', label: 'Major', prerequisites: ['root'] },
    { id: 'other', label: 'Other', prerequisites: ['root'] },
  ];
  for (let parent = 0; parent < 3; parent++) {
    nodes.push({ id: `parent${parent}`, label: 'Parent', prerequisites: ['major'], order: String(3 - parent) });
    for (let child = 0; child < 60; child++) {
      nodes.push({ id: `child${parent}-${child}`, label: 'A full child caption', prerequisites: [`parent${parent}`], order: String(60 - child).padStart(2, '0') });
    }
  }
  const tree = treeOf(nodes.reverse());
  const positions = new RadialLayoutEngine().layout(tree);
  const expected = tree.trunk.trunkChildrenOf('major').flatMap(id => tree.trunk.trunkChildrenOf(id));
  const actual = [...expected].sort((left, right) => {
    const a = positions.get(left), b = positions.get(right);
    const row = Math.hypot(a.x, a.y) - Math.hypot(b.x, b.y);
    if (Math.abs(row) > 1e-6) return row;
    return (Math.atan2(a.y, a.x) + Math.PI * 2) % (Math.PI * 2)
      - (Math.atan2(b.y, b.x) + Math.PI * 2) % (Math.PI * 2);
  });
  assert.deepEqual(actual, expected);
  assertReadableLayout(tree, positions);
});

for (const shape of ['mixed', 'broad', 'deep', 'multiroot']) {
  test(`5000-node ${shape} DAG preserves readable rows and every prerequisite edge`, () => {
    const tree = new SkillTree(largeRoadmap(5000, shape));
    const positions = new RadialLayoutEngine().layout(tree);
    assertReadableLayout(tree, positions);
    assert.deepEqual(tree.toRenderModel(positions, new Map()).edges, tree.edges.map(edge => ({
      ...edge, kind: tree.trunk.edgeKind(edge.from, edge.to),
    })));
  });
}
