import test from 'node:test';
import assert from 'node:assert/strict';

import { InputController } from '../../../../../src/products/roadmap/scene/input/InputController.js';

function tapper(startZoom) {
  const camera = { zoom: startZoom };
  camera.glideZoomAround = (px, py, target) => { camera.zoom = target; };
  const controller = new InputController({}, { camera }, {});
  const pos = { x: 100, y: 100 };
  return () => {
    controller.downPos = pos;
    controller.detectDoubleTap(pos); // first of the pair — records the tap
    controller.downPos = pos;
    controller.detectDoubleTap(pos); // second within the window — steps the zoom
    return Number(camera.zoom.toFixed(6));
  };
}

test('double-tap from a whole-tree fit walks in gently, never lunging to the in-level', () => {
  const doubleTap = tapper(0.1); // a ~20-node quest fits near here on a phone
  const walk = [doubleTap(), doubleTap(), doubleTap(), doubleTap(), doubleTap(), doubleTap()];
  // Forward-only steps of ×2 up to the out-level, then the toggle takes over — not a single 0.1→1.6 lunge.
  assert.deepEqual(walk, [0.2, 0.4, 0.8, 1, 1.6, 1]);
});

test('double-tap in the settled range toggles between the two zoom levels', () => {
  assert.equal(tapper(1)(), 1.6); // at the out-level → in
  assert.equal(tapper(1.2)(), 1.6); // below the pivot → in
  assert.equal(tapper(1.3)(), 1); // at the pivot → out
  assert.equal(tapper(1.6)(), 1); // at the in-level → out
});

test('double-tap from just below the out-level snaps to it, not past it', () => {
  assert.equal(tapper(0.8)(), 1); // ×2 would overshoot to 1.6 — capped at the out-level instead
});
