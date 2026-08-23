import test from 'node:test';
import assert from 'node:assert/strict';

import { RadialLayoutEngine } from '../../../../src/products/roadmap/layout/RadialLayoutEngine.js';
import { SkillTree } from '../../../../src/products/roadmap/model/SkillTree.js';
import { NODE_SIZE } from '../../../../src/products/roadmap/theme.js';

const MIN_ARC = NODE_SIZE * 1.7;

function treeOf(nodes) {
  return new SkillTree({ id: 't_test', title: 'Test', nodes });
}

function star(childCount) {
  const nodes = [{ id: 'root', label: 'root', prerequisites: [] }];
  for (let i = 0; i < childCount; i++)
    nodes.push({ id: `c${i}`, label: `c${i}`, prerequisites: ['root'] });
  return treeOf(nodes);
}

// No two nodes on one ring end up closer than a node is wide.
function closestPairOnAnyRing(positions) {
  const points = [...positions.values()];
  let closest = Infinity;
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      const ri = Math.hypot(points[i].x, points[i].y);
      const rj = Math.hypot(points[j].x, points[j].y);
      if (Math.abs(ri - rj) > 0.001) continue;  // different rings
      closest = Math.min(closest, Math.hypot(points[i].x - points[j].x, points[i].y - points[j].y));
    }
  }
  return closest;
}

test('a crowded ring keeps its nodes a node-width apart', () => {
  for (const count of [8, 12, 20, 40, 120]) {
    const positions = new RadialLayoutEngine().layout(star(count));
    const closest = closestPairOnAnyRing(positions);
    assert.ok(closest >= MIN_ARC * 0.98, `${count} siblings: closest pair ${closest.toFixed(1)} < ${MIN_ARC}`);
  }
});

test('a sparse tree is left exactly where it was', () => {
  const positions = new RadialLayoutEngine().layout(star(6));
  const child = positions.get('c0');
  assert.equal(Math.round(Math.hypot(child.x, child.y)), Math.round(NODE_SIZE * 2.8));
});

test('a lopsided split does not push the ring out for a thin wedge', () => {
  const nodes = [
    { id: 'root', label: 'root', prerequisites: [] },
    { id: 'wide', label: 'wide', prerequisites: ['root'] },
    { id: 'narrow', label: 'narrow', prerequisites: ['root'] },
  ];
  for (let i = 0; i < 30; i++) nodes.push({ id: `w${i}`, label: `w${i}`, prerequisites: ['wide'] });
  const positions = new RadialLayoutEngine().layout(treeOf(nodes));
  assert.equal(Math.round(Math.hypot(positions.get('wide').x, positions.get('wide').y)), Math.round(NODE_SIZE * 2.8));
});

test('rings always clear the ring inside them', () => {
  const nodes = [{ id: 'root', label: 'root', prerequisites: [] }];
  for (let i = 0; i < 25; i++) nodes.push({ id: `a${i}`, label: `a${i}`, prerequisites: ['root'] });
  for (let i = 0; i < 25; i++) nodes.push({ id: `b${i}`, label: `b${i}`, prerequisites: [`a${i}`] });
  const positions = new RadialLayoutEngine().layout(treeOf(nodes));
  const ringA = Math.hypot(positions.get('a0').x, positions.get('a0').y);
  const ringB = Math.hypot(positions.get('b0').x, positions.get('b0').y);
  assert.ok(ringB - ringA >= NODE_SIZE * 2.8 - 0.001, `rings ${ringA.toFixed(0)} and ${ringB.toFixed(0)} are too close`);
});

test('a lone node sits at the origin', () => {
  const positions = new RadialLayoutEngine().layout(treeOf([{ id: 'only', label: 'only', prerequisites: [] }]));
  const only = positions.get('only');
  assert.equal(Math.hypot(only.x, only.y), 0);  // signed zero is still the origin
});

test('rings open up as they go outward', () => {
  const nodes = [{ id: 'n0', label: 'n0', prerequisites: [] }];
  for (let i = 1; i < 8; i++) nodes.push({ id: `n${i}`, label: `n${i}`, prerequisites: [`n${i - 1}`] });
  const positions = new RadialLayoutEngine().layout(treeOf(nodes));
  const radii = nodes.map(n => Math.hypot(positions.get(n.id).x, positions.get(n.id).y));
  const gaps = radii.slice(1).map((r, i) => r - radii[i]);
  for (let i = 1; i < gaps.length; i++)
    assert.ok(gaps[i] > gaps[i - 1], `gap ${i} (${gaps[i].toFixed(0)}) should exceed ${gaps[i - 1].toFixed(0)}`);
});

test('a thin branch gets more room than its leaf count alone would buy', () => {
  const nodes = [
    { id: 'root', label: 'root', prerequisites: [] },
    { id: 'wide', label: 'wide', prerequisites: ['root'] },
    { id: 'narrow', label: 'narrow', prerequisites: ['root'] },
  ];
  for (let i = 0; i < 30; i++) nodes.push({ id: `w${i}`, label: `w${i}`, prerequisites: ['wide'] });
  const positions = new RadialLayoutEngine().layout(treeOf(nodes));
  const angleOf = (id) => Math.atan2(positions.get(id).y, positions.get(id).x);
  let apart = Math.abs(angleOf('wide') - angleOf('narrow'));
  if (apart > Math.PI) apart = 2 * Math.PI - apart;
  assert.ok(apart > (Math.PI * 2) / 31, `only ${apart.toFixed(3)} rad apart`);
});
