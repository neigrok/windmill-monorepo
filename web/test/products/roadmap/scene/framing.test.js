import test from 'node:test';
import assert from 'node:assert/strict';

import { centreFor, clampZoom, familyCentre, fitFrame, fitZoomFor, focusFrame, minZoom, visibleSpanAt } from '../../../../src/products/roadmap/scene/framing.js';

function canvasOf({ width = 1000, height = 800, insets = {}, workingZoom = 1, fitBounds = null } = {}) {
  return { viewportWidth: width, viewportHeight: height, insets: { top: 0, right: 0, bottom: 0, left: 0, ...insets }, workingZoom, fitBounds };
}

test('a roadmap is fitted inside what the chrome leaves, a tenth short of its edges, and never past the working zoom', () => {
  const bounds = { minX: -600, maxX: 2600, minY: -500, maxY: 500 };
  const canvas = canvasOf({ insets: { top: 100, right: 200, bottom: 0, left: 0 }, fitBounds: bounds });
  assert.equal(fitZoomFor(canvas, bounds), 0.225);
  assert.deepEqual(fitFrame(canvas, bounds), { x: 1000 + 200 / 0.45, y: -100 / 0.45, zoom: 0.225 });
  const small = { minX: -50, maxX: 50, minY: -50, maxY: 50 };
  assert.deepEqual(fitFrame(canvasOf({ fitBounds: small }), small), { x: 0, y: 0, zoom: 1 });
  assert.deepEqual(fitFrame(canvasOf({ fitBounds: small }), small, 0.5, 6), { x: 0, y: 0, zoom: 4 });
});

test('no zoom passes below half the roadmap’s fit, nor half the working zoom when the fit is nearer', () => {
  const wide = canvasOf({ fitBounds: { minX: 0, maxX: 8000, minY: 0, maxY: 100 } });
  assert.deepEqual([minZoom(wide), clampZoom(wide, 0.001), clampZoom(wide, 0.3), clampZoom(wide, 9), clampZoom(wide, 9, 2.5)], [0.05625, 0.05625, 0.3, 6, 2.5]);
  const small = canvasOf({ workingZoom: 0.8, fitBounds: { minX: 0, maxX: 100, minY: 0, maxY: 100 } });
  assert.deepEqual([minZoom(small), minZoom(canvasOf())], [0.4, 0.006]);
});

test('a focus frames the step’s trunk family when it fits the visible area, and the step alone when it does not', () => {
  const step = { id: 'step', x: 0, y: 0 };
  const nodesById = new Map([step, { id: 'parent', x: -200, y: 0 }, { id: 'child', x: 200, y: 100 }, { id: 'far', x: 5000, y: 0 }].map((node) => [node.id, node]));
  const edges = [{ from: 'parent', to: 'step', kind: 'trunk' }, { from: 'step', to: 'child', kind: 'trunk' }, { from: 'far', to: 'step', kind: 'cross-branch' }];
  const canvas = canvasOf({ insets: { top: 100, right: 300, bottom: 0, left: 0 } });
  assert.deepEqual(visibleSpanAt(canvas, 2), { width: 350, height: 350 });
  assert.deepEqual(centreFor(canvas, 10, 20, 2), { x: 85, y: -5 });
  assert.deepEqual(familyCentre(canvas, edges, nodesById, step, 1), { x: 0, y: 50 });
  assert.equal(familyCentre(canvas, edges, nodesById, step, 2), step);
  assert.deepEqual(focusFrame(canvas, edges, nodesById, step), { x: 150, y: 0, zoom: 1 });
  assert.deepEqual(focusFrame(canvasOf({ width: 600 }), edges, nodesById, step), { x: 0, y: 0, zoom: 1 });
});
