import test from 'node:test';
import assert from 'node:assert/strict';

import { Camera2D } from '../../../../src/products/roadmap/scene/Camera2D.js';

function fresh(zoom = 1) {
  const cam = new Camera2D();
  cam.resize(800, 600);
  cam.restore(0, 0, zoom); // centred on the origin, no glide
  return cam;
}

function settle(cam, dt = 0.06) {
  for (let i = 0; i < 200 && cam.isGliding(); i += 1) cam.update(dt);
}

test('glideZoomAround — the tapped point stays pinned under the finger for the whole ease', () => {
  const cam = fresh(1);
  const px = 200;
  const py = 150;
  const world = cam.screenToWorld(px, py);
  cam.glideZoomAround(px, py, 1.6);

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

test('working focus gives an ordinary node a 52px body in the unobstructed viewport', async () => {
  const { NODE_BODY_DIAMETER } = await import('../../../../src/products/roadmap/model/geometry.js');
  const camera = fresh(0.04);
  camera.setInsets({ left: 24, right: 360, top: 88, bottom: 32 });
  camera.focus(500, 600, true);
  settle(camera);
  assert.equal(NODE_BODY_DIAMETER * camera.zoom, 52);
  const point = camera.worldToScreen(500, 600);
  assert.ok(Math.abs(point.x - 232) < 1e-9 && Math.abs(point.y - 328) < 1e-9);
});

test('all steps fits the full extent of a 5000-step deep chain below ordinary zoom', () => {
  const camera = fresh();
  camera.setInsets({ left: 24, right: 360, top: 88, bottom: 32 });
  camera.fitToView({ minX: 0, minY: 0, maxX: 100, maxY: 1000000 }, 800, 600);
  const first = camera.worldToScreen(0, 0);
  const last = camera.worldToScreen(100, 1000000);
  assert.ok(first.y >= 88 && last.y <= 568);
  assert.ok(camera.zoom < 0.006);
  camera.zoomAtScale(400, 300, 0.9);
  assert.ok(camera.zoom < 0.006);
});

test('reduced motion lands focus and anchored zoom immediately', () => {
  const camera = fresh(0.1);
  camera.motion = false;
  camera.focus(400, 300, true);
  assert.equal(camera.isGliding(), false);
  assert.deepEqual(camera.worldToScreen(400, 300), { x: 400, y: 300 });
  const world = camera.screenToWorld(180, 220);
  camera.glideZoomAround(180, 220, 1.6);
  assert.equal(camera.isGliding(), false);
  assert.equal(camera.zoom, 1.6);
  const screen = camera.worldToScreen(world.x, world.y);
  assert.ok(Math.abs(screen.x - 180) < 1e-9 && Math.abs(screen.y - 220) < 1e-9);
});

test('a one-pixel pan after inset focus remains one pixel with read-only bounds', () => {
  const camera = fresh();
  camera.resize(1440, 900);
  camera.setInsets({ left: 24, right: 408, top: 88, bottom: 32 });
  camera.setPanBounds({ minX: -56, minY: -56, maxX: 56, maxY: 56 });
  camera.focus(0, 0);
  const before = camera.worldToScreen(0, 0);
  camera.pan(1, 1);
  const after = camera.worldToScreen(0, 0);
  assert.ok(Math.abs(after.x - before.x - 1) < 1e-9);
  assert.ok(Math.abs(after.y - before.y - 1) < 1e-9);
});
