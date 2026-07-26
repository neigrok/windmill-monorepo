import test from 'node:test';
import assert from 'node:assert/strict';

import { Camera2D } from '../../../src/skilltree/scene/Camera2D.js';

function fresh(zoom = 1) {
  const cam = new Camera2D();
  cam.resize(800, 600);
  cam.restore(0, 0, zoom); // centred on the origin, no glide
  return cam;
}

// Run the glide to completion in fixed steps, so the whole ease is exercised, not just the ends.
function settle(cam, dt = 0.06) {
  for (let i = 0; i < 200 && cam.isGliding(); i += 1) cam.update(dt);
}

test('glideZoomAround — the tapped point stays pinned under the finger for the whole ease', () => {
  const cam = fresh(1);
  const px = 200;
  const py = 150; // an off-centre tap — the case the old centre-glide lunged on
  const world = cam.screenToWorld(px, py);
  cam.glideZoomAround(px, py, 1.6);

  // At every frame the tapped world point maps back to the exact tap screen point.
  for (let i = 0; i < 12 && cam.isGliding(); i += 1) {
    cam.update(0.05);
    const screen = cam.worldToScreen(world.x, world.y);
    assert.ok(Math.abs(screen.x - px) < 1e-6, `x pinned at frame ${i}`);
    assert.ok(Math.abs(screen.y - py) < 1e-6, `y pinned at frame ${i}`);
  }
});

test('glideZoomAround — lands exactly on the target zoom, tap point still pinned', () => {
  const cam = fresh(1);
  const px = 620;
  const py = 90;
  const world = cam.screenToWorld(px, py);
  cam.glideZoomAround(px, py, 1.6);
  settle(cam);

  assert.equal(cam.isGliding(), false);
  assert.ok(Math.abs(cam.zoom - 1.6) < 1e-9);
  const screen = cam.worldToScreen(world.x, world.y);
  assert.ok(Math.abs(screen.x - px) < 1e-6);
  assert.ok(Math.abs(screen.y - py) < 1e-6);
});

test('glideZoomAround — the toggle-out target settles back to 1x around the tap', () => {
  const cam = fresh(1.6);
  const px = 300;
  const py = 400;
  const world = cam.screenToWorld(px, py);
  cam.glideZoomAround(px, py, 1);
  settle(cam);

  assert.ok(Math.abs(cam.zoom - 1) < 1e-9);
  const screen = cam.worldToScreen(world.x, world.y);
  assert.ok(Math.abs(screen.x - px) < 1e-6);
  assert.ok(Math.abs(screen.y - py) < 1e-6);
});

test('glideZoomAround — a grab cancels it in place (the user always wins)', () => {
  const cam = fresh(1);
  cam.glideZoomAround(200, 150, 1.6);
  cam.update(0.1);
  assert.equal(cam.isGliding(), true);
  cam.stopMotion();
  assert.equal(cam.isGliding(), false);
});
