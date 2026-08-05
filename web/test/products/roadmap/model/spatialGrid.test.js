// The bucket grid behind pointer picking (`nearest`) and viewport label selection (`within`). It
// is small enough to look obviously right and has two edges that are not: the floor on negative
// coordinates (a tree is laid out around the origin, so half of every canvas is negative), and the
// fact that `nearest` scans only the 3×3 cells around the query — so a node inside maxRadius but
// two cells away is simply NOT found. That second one is not a bug, it is the grid's contract with
// its caller: CELL SIZE MUST BE >= MAX RADIUS, or picking silently misses nodes at the edge of the
// hit circle. It is pinned here because the pick radius and the cell size are chosen in two
// different files, and nothing else would catch them drifting apart.

import test from 'node:test';
import assert from 'node:assert/strict';

import { SpatialGrid } from '../../../../src/products/roadmap/model/SpatialGrid.js';

const node = (id, x, y) => ({ id, x, y });

test('every node is bucketed by its floored cell, on both sides of the origin', () => {
  // cellSize 100: cell 0 is [0,100), cell -1 is [-100,0). The origin is a cell BOUNDARY, so a node
  // one unit to the left of it belongs to cell -1, not cell 0 — the classic off-by-one.
  const grid = new SpatialGrid([
    node('origin', 0, 0),
    node('justLeft', -1, -1),
    node('justRight', 99.9, 99.9),
    node('onMinus100', -100, -100),
    node('justPastMinus100', -100.1, -100.1),
    node('far', 250, -350),
  ], 100);

  assert.deepEqual([...grid.cellByNode], [
    ['origin', '0,0'],
    ['justLeft', '-1,-1'],
    ['justRight', '0,0'],
    ['onMinus100', '-1,-1'],
    ['justPastMinus100', '-2,-2'],
    ['far', '2,-4'],
  ]);
  assert.equal(grid.cellSize, 100);
});

test('nearest picks the closest node and counts one exactly on maxRadius as in range', () => {
  const grid = new SpatialGrid([node('near', 3, 4), node('far', 10, 0)], 100);

  assert.equal(grid.nearest(0, 0, 100), 'near');   // 5 vs 10
  assert.equal(grid.nearest(9, 0, 100), 'far');
  assert.equal(grid.nearest(0, 0, 5), 'near');     // distance 5, radius 5 — inclusive
});

test('nearest is null when nothing is inside maxRadius, and null on an empty grid', () => {
  const grid = new SpatialGrid([node('a', 10, 0)], 100);

  assert.equal(grid.nearest(0, 0, 9.9), null);
  assert.equal(grid.nearest(0, 0, 0), null);
  assert.equal(new SpatialGrid([], 100).nearest(0, 0, 1000), null);
});

test('nearest never looks past the 3x3 cells around the query, so cellSize must be >= maxRadius', () => {
  // The node is 35 world units away and the radius is 100 — well in range by distance. With a cell
  // size of 10 it sits three cells out, past the neighbourhood the scan walks, and is missed.
  const tooFineGrid = new SpatialGrid([node('a', 35, 0)], 10);
  assert.equal(tooFineGrid.nearest(0, 0, 100), null);
  assert.equal(tooFineGrid.nearest(0, 0, 35), null);
  // one cell out is inside the neighbourhood and is found
  assert.equal(new SpatialGrid([node('a', 15, 0)], 10).nearest(0, 0, 100), 'a');
  // and with cellSize >= maxRadius the miss is impossible: anything within the radius is at most
  // one cell away by construction.
  assert.equal(new SpatialGrid([node('a', 35, 0)], 100).nearest(0, 0, 100), 'a');
});

test('nearest resolves a tie in favour of the last candidate it scans', () => {
  // Both nodes are 10 away and land in the same cell, so the scan sees them in insertion order and
  // the later one wins (the comparison rejects only strictly-worse candidates). Deterministic, and
  // worth pinning: a hover that flickers between two overlapping nodes is a real bug.
  const grid = new SpatialGrid([node('first', 50, 60), node('second', 50, 40)], 1000);

  assert.equal(grid.nearest(50, 50, 100), 'second');
  assert.equal(new SpatialGrid([node('second', 50, 40), node('first', 50, 60)], 1000).nearest(50, 50, 100), 'first');
});

test('within returns the nodes inside the exact box, not everything in the cells it scanned', () => {
  // cellSize 10, so the box below spans several cells and each of them holds a node just outside it.
  const grid = new SpatialGrid([
    node('in1', 0, 0),
    node('in2', 12, 7),
    node('outRight', 21, 5),
    node('outBelow', 5, -1),
    node('outLeft', -1, 5),
    node('outAbove', 5, 21),
  ], 10);

  assert.deepEqual(grid.within(0, 0, 20, 20).sort(), ['in1', 'in2']);
  assert.deepEqual(grid.within(-1000, -1000, 1000, 1000).sort(),
    ['in1', 'in2', 'outAbove', 'outBelow', 'outLeft', 'outRight']);
  assert.deepEqual(grid.within(100, 100, 200, 200), []);
});

test('within counts a node lying exactly on the boundary as inside', () => {
  const grid = new SpatialGrid([node('corner', 10, 20), node('opposite', -10, -20)], 100);

  assert.deepEqual(grid.within(-10, -20, 10, 20).sort(), ['corner', 'opposite']);
  assert.deepEqual(grid.within(10, 20, 10, 20), ['corner']);
});

test('within reaches into negative cells', () => {
  const grid = new SpatialGrid([node('a', -55, -55), node('b', -5, -5), node('c', 45, 45)], 50);

  assert.deepEqual(grid.within(-100, -100, 0, 0).sort(), ['a', 'b']);
  assert.deepEqual(grid.within(-60, -60, -50, -50), ['a']);
});

test('move re-buckets a node so it is picked at its new place and not at its old one', () => {
  // The grid reads coordinates off the shared node objects, so a caller moves the node and then
  // tells the grid — exactly what the scene does on a drag.
  const moving = node('moving', 5, 5);
  const grid = new SpatialGrid([moving, node('parked', 305, 5)], 100);

  moving.x = 600;
  moving.y = 600;
  grid.move('moving', 600, 600);

  assert.equal(grid.nearest(600, 600, 50), 'moving');
  assert.equal(grid.nearest(5, 5, 50), null);
  assert.deepEqual([...grid.cellByNode], [['moving', '6,6'], ['parked', '3,0']]);
  assert.deepEqual(grid.within(-1000, -1000, 1000, 1000).sort(), ['moving', 'parked']);
});

test('a move that stays inside one cell leaves the buckets exactly as they were', () => {
  const moving = node('moving', 5, 5);
  const grid = new SpatialGrid([moving], 100);

  moving.x = 95;
  grid.move('moving', 95, 5);

  assert.deepEqual([...grid.cellByNode], [['moving', '0,0']]);
  assert.equal(grid.nearest(95, 5, 10), 'moving');
});

test('move on an id the grid never held changes nothing', () => {
  const grid = new SpatialGrid([node('a', 5, 5)], 100);

  grid.move('ghost', 600, 600);

  assert.deepEqual([...grid.cellByNode], [['a', '0,0']]);
  assert.deepEqual(grid.within(-1000, -1000, 1000, 1000), ['a']);
  assert.equal(grid.nearest(600, 600, 50), null);
});
