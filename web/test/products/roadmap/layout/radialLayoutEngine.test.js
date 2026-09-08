import test from 'node:test';
import assert from 'node:assert/strict';

import { RadialLayoutEngine } from '../../../../src/products/roadmap/layout/RadialLayoutEngine.js';
import { SkillTree } from '../../../../src/products/roadmap/model/SkillTree.js';
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
      minX: x - (LABEL_MAX_WIDTH + LABEL_CLEARANCE) / (2 * WORKING_ZOOM),
      maxX: x + (LABEL_MAX_WIDTH + LABEL_CLEARANCE) / (2 * WORKING_ZOOM),
      minY: y - radius - LABEL_CLEARANCE / (2 * WORKING_ZOOM),
      maxY: y + radius + (LABEL_GAP + 2 * LABEL_LINE_HEIGHT + LABEL_CLEARANCE / 2) / WORKING_ZOOM,
    });
  }
  footprints.sort((a, b) => a.minX - b.minX);
  for (let index = 0; index < footprints.length; index++) {
    const left = footprints[index];
    for (let next = index + 1; next < footprints.length && footprints[next].minX < left.maxX - 1e-7; next++) {
      const right = footprints[next];
      if (left.maxY > right.minY + 1e-7 && right.maxY > left.minY + 1e-7) {
        violations.push(`${left.id} overlaps ${right.id}`);
      }
    }
  }
  assert.deepEqual(violations, []);
}

for (const count of [300, 500, 1000, 5000]) {
  for (const shape of ['balanced', 'wide', 'deep', 'multi-root']) {
    test(`${count} ${shape} nodes keep complete caption footprints clear and grow outward`, () => {
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

test('crowded siblings use local radii while a sparse branch remains near the center', () => {
  const nodes = [
    { id: 'root', label: 'root', prerequisites: [] },
    { id: 'wide', label: 'wide', prerequisites: ['root'] },
    { id: 'narrow', label: 'narrow', prerequisites: ['root'] },
    { id: 'tip', label: 'tip', prerequisites: ['narrow'] },
  ];
  for (let index = 0; index < 500; index++) nodes.push({ id: `wide${index}`, label: 'A wide branch caption', prerequisites: ['wide'] });
  const tree = treeOf(nodes);
  const positions = new RadialLayoutEngine().layout(tree);
  assertReadableLayout(tree, positions);
  assert.ok(Math.hypot(positions.get('tip').x, positions.get('tip').y) < 400);
  const radii = nodes.slice(4).map(node => {
    const position = positions.get(node.id);
    return Math.round(Math.hypot(position.x, position.y));
  });
  assert.ok(new Set(radii).size > 1);
});

test('radial sibling order follows authored order even when siblings occupy different radii', () => {
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

test('wide trees use their interior instead of making one ring grow with the sibling count', () => {
  const tree = fixture(5000, 'wide');
  const positions = new RadialLayoutEngine().layout(tree);
  const extent = Math.max(...[...positions.values()].map(point => Math.hypot(point.x, point.y)));
  assert.ok(extent < 8000, `wide-tree radius ${extent} exceeds its compact envelope`);
});

test('long chains retain constant gaps instead of increasing clearance at every depth', () => {
  const tree = fixture(5000, 'deep');
  const positions = new RadialLayoutEngine().layout(tree);
  const gaps = tree.nodes.slice(1).map(node => {
    const point = positions.get(node.id);
    const parent = positions.get(node.prerequisites[0]);
    return Math.round(Math.hypot(point.x - parent.x, point.y - parent.y));
  });
  assert.deepEqual(new Set(gaps), new Set([166]));
});

test('deep alternating branches retain finite local placement when angular wedges become tiny', () => {
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
