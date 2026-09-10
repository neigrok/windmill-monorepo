// The pick rule over a grid and a camera: what a tap takes when the disc is a dot, and when it takes nothing at all.
import test from 'node:test';
import assert from 'node:assert/strict';

import { hitTest } from '../../../../src/products/roadmap/scene/picking.js';
import { SpatialGrid } from '../../../../src/products/roadmap/model/SpatialGrid.js';
import { NODE_SIZE } from '../../../../src/products/roadmap/theme.js';
import { SkillTree } from '../../../../src/products/roadmap/model/SkillTree.js';
import { BubbleLayoutEngine } from '../../../../src/products/roadmap/layout/BubbleLayoutEngine.js';

const PICK_RADIUS = NODE_SIZE * 0.65;

// A camera on a 1440x848 canvas centred on the world origin.
const camera = (zoom) => ({ zoom, screenToWorld: (x, y) => ({ x: (x - 720) / zoom, y: (y - 424) / zoom }) });

function scene(nodes) {
  const renderNodes = nodes.map(([id, x, y]) => ({ id, x, y }));
  return {
    grid: new SpatialGrid(renderNodes, NODE_SIZE * 2),
    nodesById: new Map(renderNodes.map((node) => [node.id, node])),
  };
}

// Screen px for a world point under `camera(zoom)`.
const at = (zoom, wx, wy) => [720 + wx * zoom, 424 + wy * zoom];

test('the disc itself takes the hit, and empty canvas beyond every floor takes nothing', () => {
  const { grid, nodesById } = scene([['a', 0, 0]]);
  assert.deepEqual(hitTest(grid, nodesById, camera(1), ...at(1, PICK_RADIUS - 1, 0), 'mouse'), { id: 'a', crowded: false });
  assert.deepEqual(hitTest(grid, nodesById, camera(1), ...at(1, PICK_RADIUS + 1, 0), 'mouse'), { id: null, crowded: false });
  assert.deepEqual(hitTest(null, nodesById, camera(1), 0, 0, 'mouse'), { id: null, crowded: false });
});

test('at an overview zoom the screen-px floor reaches out, and a touch reaches nearly twice as far', () => {
  const { grid, nodesById } = scene([['a', 0, 0]]);
  const overview = camera(0.05); // 24 px of pointer floor is 480 wu, 44 px of touch floor 880
  assert.deepEqual(hitTest(grid, nodesById, overview, ...at(0.05, 470, 0), 'mouse'), { id: 'a', crowded: false });
  assert.deepEqual(hitTest(grid, nodesById, overview, ...at(0.05, 490, 0), 'mouse'), { id: null, crowded: false });
  assert.deepEqual(hitTest(grid, nodesById, overview, ...at(0.05, 490, 0), 'touch'), { id: 'a', crowded: false });
  assert.deepEqual(hitTest(grid, nodesById, overview, ...at(0.05, 890, 0), 'touch'), { id: null, crowded: false });
});

test('the floor never reaches past halfway to the neighbour: a crowd answers crowded, not a guess', () => {
  const { grid, nodesById } = scene([['a', 0, 0], ['b', 200, 0]]);
  const overview = camera(0.05);
  // 100 wu is halfway to b: inside it the tap is a's, outside it belongs to no one in particular.
  assert.deepEqual(hitTest(grid, nodesById, overview, ...at(0.05, -99, 0), 'mouse'), { id: 'a', crowded: false });
  assert.deepEqual(hitTest(grid, nodesById, overview, ...at(0.05, -101, 0), 'mouse'), { id: null, crowded: true });
  // The disc still takes its own hit however crowded the picture is.
  assert.deepEqual(hitTest(grid, nodesById, overview, ...at(0.05, 10, 0), 'mouse'), { id: 'a', crowded: false });
});

test('a drawn overview disc takes its edge even when the nearest neighbour limits the expanded hit target', () => {
  const { grid, nodesById } = scene([['a', 0, 0], ['b', 100, 0]]);
  const overview = camera(0.01);
  assert.deepEqual(hitTest(grid, nodesById, overview, ...at(0.01, -290, 0), 'mouse'), { id: 'a', crowded: false });
  assert.deepEqual(hitTest(grid, nodesById, overview, ...at(0.01, -310, 0), 'mouse'), { id: null, crowded: true });
  nodesById.get('a').emphasis = 1;
  assert.deepEqual(hitTest(grid, nodesById, overview, ...at(0.01, -440, 0), 'mouse'), { id: 'a', crowded: false });
});

test('a neighbour outside the expanded target still caps that target at half the gap', () => {
  const { grid, nodesById } = scene([['a', 0, 0], ['b', 600, 0]]);
  const overview = camera(0.05);
  assert.deepEqual(hitTest(grid, nodesById, overview, ...at(0.05, -290, 0), 'mouse'), { id: 'a', crowded: false });
  assert.deepEqual(hitTest(grid, nodesById, overview, ...at(0.05, -310, 0), 'mouse'), { id: null, crowded: true });
});

test('the enlarged selected crown keeps its entire body selectable', () => {
  const { grid, nodesById } = scene([['root', 0, 0]]);
  nodesById.get('root').emphasis = 1;
  assert.deepEqual(hitTest(grid, nodesById, camera(2), ...at(2, 39, 0), 'mouse', 'root'), { id: 'root', crowded: false });
  assert.deepEqual(hitTest(grid, nodesById, camera(2), ...at(2, 39, 0), 'mouse'), { id: null, crowded: false });
});

test('a compact bubble crown owns its visible body before a nearer child can claim an expanded target', () => {
  const tree = new SkillTree({ id: 't', title: 'Tree', nodes: [
    { id: 'root', label: 'A', prerequisites: [] },
    { id: 'child', label: 'B', prerequisites: ['root'] },
  ] });
  const model = tree.toRenderModel(new BubbleLayoutEngine().layout(tree), new Map());
  const grid = new SpatialGrid(model.nodes, NODE_SIZE * 2);
  const nodesById = new Map(model.nodes.map((node) => [node.id, node]));
  assert.deepEqual(hitTest(grid, nodesById, camera(1), ...at(1, 33.7, 0), 'mouse'), { id: 'root', crowded: false });
});
