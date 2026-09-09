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

test('focus and a zoom-less glide floor at the working zoom; an explicit zoom is honoured', () => {
  const cam = fresh(0.05);
  cam.focus(300, 200);
  assert.equal(cam.zoom, cam.workingZoom);
  assert.deepEqual(cam.worldToScreen(300, 200), { x: 400, y: 300 });

  const above = fresh(2);
  above.focus(0, 0);
  assert.equal(above.zoom, 2);

  const gliding = fresh(0.05);
  gliding.glideTo(900, 900);
  settle(gliding);
  assert.equal(gliding.zoom, gliding.workingZoom);

  const explicit = fresh(0.05);
  explicit.glideTo(900, 900, 0.3);
  settle(explicit);
  assert.ok(Math.abs(explicit.zoom - 0.3) < 1e-9);
});

test('the scene hands in the working zoom: the phone floors lower than the desktop', () => {
  const cam = new Camera2D({ workingZoom: 0.85 });
  cam.resize(390, 792);
  cam.restore(0, 0, 0.02);
  cam.focus(0, 0);
  assert.equal(cam.zoom, 0.85);
  cam.setWorkingZoom(1.5);
  cam.focus(0, 0);
  assert.equal(cam.zoom, 1.5);
});

test('the zoom floor is half the fit zoom of the installed model, for wheel, pinch and restore alike', () => {
  const cam = fresh(1);
  const bounds = { minX: -8000, maxX: 8000, minY: -6000, maxY: 6000 }; // 16000 × 12000 on 800 × 600 → fit 0.045
  cam.setFitBounds(bounds);
  assert.ok(Math.abs(cam.minZoom() - 0.0225) < 1e-9);

  cam.zoomAt(400, 300, 100000);
  assert.ok(Math.abs(cam.zoom - 0.0225) < 1e-9, 'wheel stops at the floor');
  cam.restore(0, 0, 1);
  cam.zoomAtScale(400, 300, 0.000001);
  assert.ok(Math.abs(cam.zoom - 0.0225) < 1e-9, 'pinch stops at the floor');
  cam.restore(0, 0, 0.000001);
  assert.ok(Math.abs(cam.zoom - 0.0225) < 1e-9, 'a saved place is clamped up to the floor');
  cam.restore(0, 0, 99);
  assert.equal(cam.zoom, 6, 'and down to the ceiling');

  const modelless = fresh(1);
  modelless.restore(0, 0, 0.000001);
  assert.equal(modelless.zoom, 0.006);
});

test('fit shows the whole model inside the visible area and never past the working zoom', () => {
  const cam = fresh(1);
  cam.fitToView({ minX: -8000, maxX: 8000, minY: -6000, maxY: 6000 });
  assert.ok(Math.abs(cam.zoom - 0.045) < 1e-9);
  assert.deepEqual([cam.x, cam.y], [0, 0]);

  const tiny = fresh(1);
  tiny.fitToView({ minX: -10, maxX: 10, minY: -10, maxY: 10 });
  assert.equal(tiny.zoom, tiny.workingZoom);

  const inset = fresh(1);
  inset.setInsets({ left: 24, right: 408, top: 76, bottom: 32 });
  inset.fitToView({ minX: -8000, maxX: 8000, minY: -6000, maxY: 6000 });
  // 368 × 492 px visible → zoom 0.023 on the width; the bounds centre lands mid-visible-area (x 208, y 322).
  assert.ok(Math.abs(inset.zoom - 0.0207) < 1e-9);
  const centre = inset.worldToScreen(0, 0);
  assert.ok(Math.abs(centre.x - 208) < 1e-9 && Math.abs(centre.y - 322) < 1e-9);
});

test('insets shift focus and glide targets into the area the chrome leaves visible', () => {
  const cam = fresh(0.05);
  cam.setInsets({ left: 24, right: 408, top: 76, bottom: 32 });
  cam.focus(500, 600);
  const point = cam.worldToScreen(500, 600);
  assert.ok(Math.abs(point.x - 208) < 1e-9 && Math.abs(point.y - 322) < 1e-9);

  const glide = fresh(0.05);
  glide.setInsets({ right: 400 });
  glide.glideTo(500, 600, glide.workingZoom, { force: true });
  settle(glide);
  const landed = glide.worldToScreen(500, 600);
  assert.ok(Math.abs(landed.x - 200) < 1e-9 && Math.abs(landed.y - 300) < 1e-9);
});

test('a glide declines when the point is already well inside the visible area, unless forced', () => {
  const cam = fresh(2); // above the working zoom, so a zoom-less glide changes no zoom
  cam.glideTo(10, 10);
  assert.equal(cam.isGliding(), false);
  cam.glideTo(10, 10, null, { force: true });
  assert.equal(cam.isGliding(), true);

  const hidden = fresh(2);
  hidden.setInsets({ right: 500 }); // the visible area is the left 300 px: x < -50 wu
  hidden.glideTo(200, 0);
  assert.equal(hidden.isGliding(), true, 'a point under the chrome is not "in view"');
});
