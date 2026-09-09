import test from 'node:test';
import assert from 'node:assert/strict';

import { InputController } from '../../../../../src/products/roadmap/scene/input/InputController.js';

function tapper(startZoom, workingZoom = 1) {
  const camera = { zoom: startZoom, workingZoom };
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

test('the ladder is measured in the camera\'s working zoom: the out-level is the working view itself', () => {
  const desktop = 1.1054421768707483;
  assert.equal(tapper(0.04, desktop)(), 0.08);
  assert.equal(tapper(0.8, desktop)(), Number(desktop.toFixed(6)));
  assert.equal(tapper(desktop, desktop)(), Number((desktop * 1.6).toFixed(6)));
  assert.equal(tapper(desktop * 1.6, desktop)(), Number(desktop.toFixed(6)));
  assert.equal(tapper(0.5, 0.85)(), 0.85); // the phone: ×2 would overshoot its 0.85 working view
});

test('a tap the tool turned into a zoom runs no ladder step on top of it and pairs with no later tap', () => {
  const camera = { zoom: 0.1, workingZoom: 1, glideZoomAround: (px, py, target) => { camera.zoom = target; } };
  const canvas = { addEventListener() {}, setPointerCapture() {}, hasPointerCapture: () => false, getBoundingClientRect: () => ({ left: 0, top: 0 }) };
  const controller = new InputController(canvas, { camera }, { onPointerDown() {}, onPointerUp: () => true });
  const touch = { pointerId: 1, pointerType: 'touch', clientX: 100, clientY: 100 };
  controller.onDown(touch);
  controller.onUp(touch);
  assert.equal(camera.zoom, 0.1);
  assert.equal(controller.lastTap, null);

  // The next lift is a plain tap: it records itself and steps nothing.
  controller.tool = { onPointerDown() {}, onPointerUp() {} };
  controller.onDown(touch);
  controller.onUp(touch);
  assert.equal(camera.zoom, 0.1);
  assert.deepEqual({ x: controller.lastTap.x, y: controller.lastTap.y }, { x: 100, y: 100 });
});
