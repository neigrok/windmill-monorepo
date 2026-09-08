import test from 'node:test';
import assert from 'node:assert/strict';
import { sceneHierarchy, spotlightEdges, edgeVisibility, defaultFocusId } from '../../../../src/products/roadmap/scene/sceneHierarchy.js';
import { ConnectorBatch } from '../../../../src/products/roadmap/scene/ConnectorBatch.js';
import { Camera2D } from '../../../../src/products/roadmap/scene/Camera2D.js';
import { sceneTheme } from '../../../../src/products/roadmap/theme.js';

test('single-root summaries count their complete trunk subtree without counting extra DAG links twice', () => {
  const nodes = [
    { id: 'root', x: 0, y: 0, label: 'Roadmap' },
    { id: 'a', x: -200, y: 0, label: 'Study', color: 'sky' },
    { id: 'b', x: 200, y: 0, label: 'Practice', color: 'olive' },
    { id: 'leaf', x: -400, y: 100, label: 'Read' },
  ];
  const edges = [
    { from: 'root', to: 'a', kind: 'trunk' },
    { from: 'root', to: 'b', kind: 'trunk' },
    { from: 'a', to: 'leaf', kind: 'trunk' },
    { from: 'b', to: 'leaf', kind: 'cross-branch' },
  ];
  const hierarchy = sceneHierarchy(nodes, edges);
  assert.deepEqual([...hierarchy.anchors], ['root', 'a', 'b']);
  assert.deepEqual(hierarchy.summaries, [
    { id: 'branch-summary:a', sourceId: 'a', label: 'Study', color: 'sky', x: -300, y: 50, count: 2, summary: true },
    { id: 'branch-summary:b', sourceId: 'b', label: 'Practice', color: 'olive', x: 200, y: 0, count: 1, summary: true },
  ]);
  assert.equal(defaultFocusId(new Map(nodes.map((node) => [node.id, node])), hierarchy), 'root');
  assert.deepEqual([...spotlightEdges('leaf', hierarchy, new Map([['leaf', [2, 3]]]), edges)], ['a\u0000leaf', 'b\u0000leaf', 'root\u0000a']);
});

test('forest roots remain separate named groups and a 5000-node chain stays stack safe', () => {
  const nodes = Array.from({ length: 5000 }, (_, i) => ({ id: `n${i}`, x: i * 200, y: 0, label: `Step ${i}` }));
  const edges = nodes.slice(1).map((node, i) => ({ from: `n${i}`, to: node.id, kind: 'trunk' }));
  nodes.push({ id: 'other', x: 0, y: 400, label: 'Other' });
  const hierarchy = sceneHierarchy(nodes, edges);
  assert.deepEqual([...hierarchy.anchors], ['n0', 'other']);
  assert.deepEqual(hierarchy.summaries.map(({ sourceId, count, x, y }) => ({ sourceId, count, x, y })), [
    { sourceId: 'n0', count: 5000, x: 499900, y: 0 },
    { sourceId: 'other', count: 1, x: 0, y: 400 },
  ]);
});

test('working views hide through-edges and extra dependencies while overview retains only its sparse structural backbone', () => {
  const view = { minX: -500, maxX: 500, minY: -300, maxY: 300 };
  const outsideLeft = { x: -1000, y: 0 };
  const outsideRight = { x: 1000, y: 0 };
  const inside = { x: 0, y: 0 };
  assert.equal(edgeVisibility({ kind: 'trunk' }, outsideLeft, outsideRight, view, 1), 0);
  assert.equal(edgeVisibility({ kind: 'trunk' }, inside, { x: 200, y: 100 }, view, 1), 1);
  assert.equal(edgeVisibility({ kind: 'trunk' }, outsideLeft, inside, view, 1), 0);
  assert.equal(edgeVisibility({ kind: 'trunk', overview: true }, outsideLeft, outsideRight, view, 0.1), 1);
  assert.equal(edgeVisibility({ kind: 'trunk' }, inside, outsideRight, view, 0.1), 0);
  assert.equal(edgeVisibility({ kind: 'cross-branch' }, inside, outsideRight, view, 0.1), 0);
  assert.equal(edgeVisibility({ kind: 'in-branch' }, inside, outsideRight, view, 1, true), 2);
  assert.equal(edgeVisibility({ kind: 'trunk' }, outsideLeft, outsideRight, view, 1, true), 2);
});

test('rendering and picking share visibility for hover context, explicit selection, and finite ceremonies', () => {
  const gl = new Proxy({}, { get: (_, name) => name === 'getShaderParameter' || name === 'getProgramParameter' ? () => true : () => null });
  const batch = new ConnectorBatch(gl, sceneTheme(true));
  const nodes = [
    { id: 'root', x: -300, y: -100, state: 'complete', color: 'sky' },
    { id: 'parent', x: -100, y: -100, state: 'complete', color: 'sky' },
    { id: 'step', x: 100, y: -100, state: 'active', color: 'sky' },
    { id: 'other', x: 300, y: 100, state: 'complete', color: 'olive' },
  ];
  const edges = [
    { from: 'root', to: 'parent', kind: 'trunk' },
    { from: 'parent', to: 'step', kind: 'trunk' },
    { from: 'step', to: 'other', kind: 'cross-branch' },
  ];
  batch.setModel({ nodes, edges });
  const camera = new Camera2D();
  camera.resize(1440, 900);
  const edge = batch.edges[2];
  const vertex = edge.vertexStart + 14;
  const point = camera.worldToScreen(batch.centers[vertex * 2], batch.centers[vertex * 2 + 1]);
  batch.updateVisibility(camera, 1);
  assert.deepEqual(batch.edges.map((item) => batch.visibility[item.vertexStart]), [1, 1, 0]);
  assert.equal(batch.pickEdge(point.x, point.y, camera, 1, 6), null);
  batch.setSpotlight('step');
  batch.updateVisibility(camera, 1);
  assert.deepEqual(batch.edges.map((item) => batch.visibility[item.vertexStart]), [2, 2, 2]);
  assert.deepEqual(batch.pickEdge(point.x, point.y, camera, 1, 6), edges[2]);
  batch.setSpotlight(null);
  batch.setProjectedEdge(edges[2]);
  assert.deepEqual(batch.pickEdge(point.x, point.y, camera, 1, 6), edges[2]);
  batch.setProjectedEdge(null);
  assert.equal(batch.pickEdge(point.x, point.y, camera, 1, 6), null);
  batch.travel('step', 'other', 2, { durationMs: 500 });
  assert.deepEqual(batch.pickEdge(point.x, point.y, camera, 2.2, 6), edges[2]);
  batch.updateVisibility(camera, 3);
  assert.deepEqual(batch.edges.map((item) => batch.visibility[item.vertexStart]), [1, 1, 0]);
  assert.equal(batch.pickEdge(point.x, point.y, camera, 3, 6), null);
  assert.deepEqual(batch.edges.map(({ modelEdge }) => modelEdge), edges);
});


test('overview backbone is shallow and bounded even when a root has thousands of branches', () => {
  const nodes = [{ id: 'root', x: 0, y: 0 }];
  const edges = [];
  for (let i = 0; i < 2000; i += 1) {
    nodes.push({ id: `branch${i}`, x: i, y: 1 }, { id: `leaf${i}`, x: i, y: 2 });
    edges.push({ from: 'root', to: `branch${i}`, kind: 'trunk' }, { from: `branch${i}`, to: `leaf${i}`, kind: 'trunk' });
  }
  const hierarchy = sceneHierarchy(nodes, edges);
  assert.deepEqual([...hierarchy.backboneKeys], Array.from({ length: 64 }, (_, i) => `root\u0000branch${i}`));
});


test('default Focus chooses a meaningful major branch when the root has no readable neighborhood', () => {
  const nodes = [
    { id: 'root', x: 0, y: 0, label: 'Roadmap' },
    { id: 'branch', x: 2200, y: 0, label: 'Practice' },
    { id: 'step', x: 2400, y: 0, label: 'Repeat' },
    { id: 'leaf', x: 30, y: 3000, label: 'An isolated leaf' },
  ];
  const edges = [
    { from: 'root', to: 'branch', kind: 'trunk' },
    { from: 'branch', to: 'step', kind: 'trunk' },
    { from: 'root', to: 'leaf', kind: 'trunk' },
  ];
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const hierarchy = sceneHierarchy(nodes, edges);
  assert.equal(defaultFocusId(byId, hierarchy), 'branch');
  nodes[1].x = 200;
  assert.equal(defaultFocusId(byId, hierarchy), 'root');
  assert.equal(defaultFocusId(new Map(), sceneHierarchy([], [])), null);
});
