import test from 'node:test';
import assert from 'node:assert/strict';

import { InputController } from '../../../../../src/products/roadmap/scene/input/InputController.js';
import { NavigateTool, ReadOnlyTool } from '../../../../../src/products/roadmap/scene/input/tools.js';

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

test('a tap picks the bubble visible at pointerdown before a settle moves it, in editor and viewer tools', () => {
  for (const ToolClass of [NavigateTool, ReadOnlyTool]) {
    let settled = false;
    const selected = [];
    const context = {
      camera: { stopMotion() {} },
      pick: () => settled ? 'new-seat' : 'visible-bubble',
      onInteract: () => { settled = true; },
      select: (id) => selected.push(id),
    };
    const canvas = { setPointerCapture() {}, hasPointerCapture: () => false, getBoundingClientRect: () => ({ left: 0, top: 0 }) };
    const controller = new InputController(canvas, context, new ToolClass(context));
    const pointer = { pointerId: 1, pointerType: 'mouse', clientX: 100, clientY: 100 };
    controller.onDown(pointer);
    controller.onUp(pointer);
    assert.deepEqual(selected, ['visible-bubble']);
  }
});

test('a cancelled pointer abandons its gesture without selecting or double-tap zooming', () => {
  const selected = [];
  const context = { camera: {}, pick: () => 'bubble', select: (id) => selected.push(id) };
  const canvas = { setPointerCapture() {}, hasPointerCapture: () => false, getBoundingClientRect: () => ({ left: 0, top: 0 }) };
  const tool = new NavigateTool(context);
  const controller = new InputController(canvas, context, tool);
  const pointer = { pointerId: 1, pointerType: 'touch', clientX: 100, clientY: 100 };
  controller.onDown(pointer);
  controller.onUp({ ...pointer, type: 'pointercancel' });
  assert.deepEqual(selected, []);
  assert.equal(tool.drag, null);
  assert.equal(controller.lastTap, null);
});

function holdController({ acceptsHold = true, picked = 'visible-step' } = {}) {
  const calls = [];
  const captures = new Set();
  const canvas = {
    addEventListener() {},
    removeEventListener() {},
    setPointerCapture: (id) => captures.add(id),
    hasPointerCapture: (id) => captures.has(id),
    releasePointerCapture: (id) => captures.delete(id),
    getBoundingClientRect: () => ({ left: 10, top: 20 }),
  };
  const context = {
    camera: { stopMotion() {}, pan() {}, zoomAtScale() {} },
    pick: () => picked,
    onLongPress: (id) => { calls.push(['hold', id]); return acceptsHold; },
    press: (id) => calls.push(['press', id]),
  };
  const tool = {
    onPointerDown: (pos, event, id) => calls.push(['down', pos, id]),
    onPointerDrag: (pos) => calls.push(['drag', pos]),
    onPointerUp: (pos) => calls.push(['up', pos]),
    onPointerCancel: () => calls.push(['cancel']),
  };
  const pointer = { pointerId: 1, pointerType: 'touch', clientX: 110, clientY: 120 };
  return { controller: new InputController(canvas, context, tool), calls, pointer };
}

test('Graph hold starts multi-select at 500ms and swallows the lift without a tap', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { controller, calls, pointer } = holdController();
  controller.onDown(pointer);
  t.mock.timers.tick(499);
  assert.deepEqual(calls, [['press', 'visible-step'], ['down', { x: 100, y: 100 }, 'visible-step']]);
  t.mock.timers.tick(1);
  t.mock.timers.tick(500);
  controller.onUp(pointer);
  assert.deepEqual(calls, [
    ['press', 'visible-step'], ['down', { x: 100, y: 100 }, 'visible-step'],
    ['hold', 'visible-step'], ['press', null],
  ]);
  assert.equal(controller.lastTap, null);
  assert.equal(controller.longPressTimer, null);
  assert.equal(controller.hold, null);
  assert.equal(controller.longPressFired, false);
});

test('Graph hold before 500ms remains a tap; a refused multi-select also retains the tap', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const [acceptsHold, duration, held] of [[true, 499, false], [false, 500, true]]) {
    const { controller, calls, pointer } = holdController({ acceptsHold });
    controller.onDown(pointer);
    t.mock.timers.tick(duration);
    controller.onUp(pointer);
    t.mock.timers.tick(1000);
    assert.deepEqual(calls, [
      ['press', 'visible-step'], ['down', { x: 100, y: 100 }, 'visible-step'],
      ...(held ? [['hold', 'visible-step']] : []),
      ['press', null], ['up', { x: 100, y: 100 }],
    ]);
  }
});

test('Graph hold preserves movement at ten pixels and cancels above it', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const [distance, held] of [[9.99, true], [10, true], [10.01, false]]) {
    const { controller, calls, pointer } = holdController();
    controller.onDown(pointer);
    const moved = { ...pointer, clientX: pointer.clientX + distance };
    controller.onMove(moved);
    t.mock.timers.tick(500);
    controller.onUp(moved);
    const pos = { x: moved.clientX - 10, y: 100 };
    assert.deepEqual(calls, [
      ['press', 'visible-step'], ['down', { x: 100, y: 100 }, 'visible-step'], ['drag', pos],
      ...(held ? [['hold', 'visible-step']] : []), ['press', null],
      ...(held ? [] : [['up', pos]]),
    ]);
  }
});

test('Graph hold leaves pinch ownership and cancellation with the active tool', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { controller, calls, pointer } = holdController();
  controller.onDown(pointer);
  t.mock.timers.tick(499);
  const second = { ...pointer, pointerId: 2, clientX: 210 };
  controller.onDown(second);
  t.mock.timers.tick(1000);
  controller.onUp(pointer);
  controller.onUp(second);
  assert.deepEqual(calls, [
    ['press', 'visible-step'], ['down', { x: 100, y: 100 }, 'visible-step'],
    ['cancel'], ['press', null],
  ]);
  assert.equal(controller.pinch, null);
  assert.equal(controller.activePointerId, null);
  assert.equal(controller.longPressTimer, null);
  assert.equal(controller.hold, null);
  assert.equal(controller.longPressFired, false);
});

test('Graph hold cancels on pointer cancellation, tool replacement and controller unbinding', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const end of ['pointercancel', 'tool', 'unbind']) {
    const { controller, calls, pointer } = holdController();
    controller.onDown(pointer);
    if (end === 'pointercancel') controller.onUp({ ...pointer, type: 'pointercancel' });
    if (end === 'tool') controller.setTool({});
    if (end === 'unbind') controller.unbind();
    t.mock.timers.tick(1000);
    assert.deepEqual(calls, [
      ['press', 'visible-step'], ['down', { x: 100, y: 100 }, 'visible-step'],
      ...(end === 'pointercancel' ? [['press', null], ['cancel']] : []),
    ]);
    assert.equal(controller.longPressTimer, null);
    assert.equal(controller.hold, null);
    assert.equal(controller.longPressFired, false);
  }
});

test('mouse pointers and empty canvas never arm Graph multi-select', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const [pointerType, picked] of [['mouse', 'visible-step'], ['touch', null]]) {
    const { controller, calls, pointer } = holdController({ picked });
    const event = { ...pointer, pointerType };
    controller.onDown(event);
    t.mock.timers.tick(1000);
    controller.onUp(event);
    assert.deepEqual(calls, [
      ...(picked ? [['press', picked]] : []),
      ['down', { x: 100, y: 100 }, picked], ['press', null], ['up', { x: 100, y: 100 }],
    ]);
  }
});

test('Graph multi-select receives the initially visible step and the navigation tool never also selects it', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const selected = [];
  const multi = [];
  let settled = false;
  const context = {
    camera: { stopMotion() {} },
    pick: () => settled ? 'settled-step' : 'visible-step',
    onInteract: () => { settled = true; },
    select: (id) => selected.push(id),
    onLongPress: (id) => { multi.push(id); return true; },
  };
  const canvas = { setPointerCapture() {}, hasPointerCapture: () => false, getBoundingClientRect: () => ({ left: 0, top: 0 }) };
  const controller = new InputController(canvas, context, new NavigateTool(context));
  const pointer = { pointerId: 1, pointerType: 'touch', clientX: 100, clientY: 100 };
  controller.onDown(pointer);
  t.mock.timers.tick(500);
  controller.onUp(pointer);
  assert.deepEqual(multi, ['visible-step']);
  assert.deepEqual(selected, []);
});

test('Graph movement after an accepted hold still consumes the release', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { controller, calls, pointer } = holdController();
  controller.onDown(pointer);
  t.mock.timers.tick(500);
  const moved = { ...pointer, clientX: 150 };
  controller.onMove(moved);
  controller.onUp(moved);
  assert.deepEqual(calls, [
    ['press', 'visible-step'], ['down', { x: 100, y: 100 }, 'visible-step'],
    ['hold', 'visible-step'], ['drag', { x: 140, y: 100 }], ['press', null],
  ]);
});


test('production cleanup: unbinding cancels a pending hold before it can start multi-select', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { controller, calls, pointer } = holdController();
  controller.onDown(pointer);
  t.mock.timers.tick(499);
  controller.unbind();
  t.mock.timers.tick(1);
  assert.deepEqual(calls, [
    ['press', 'visible-step'], ['down', { x: 100, y: 100 }, 'visible-step'],
  ]);
  assert.equal(controller.hold, null);
  assert.equal(controller.longPressTimer, null);
  assert.equal(controller.longPressFired, false);
});

test('Graph movement clears a cancelled pending hold but retains an accepted hold until release', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const elapsed of [499, 500]) {
    const { controller, pointer } = holdController();
    controller.onDown(pointer);
    t.mock.timers.tick(elapsed);
    const moved = { ...pointer, clientX: pointer.clientX + 11 };
    controller.onMove(moved);
    assert.equal(controller.hold !== null, elapsed === 500);
    assert.equal(controller.longPressTimer, null);
    controller.onUp(moved);
    assert.equal(controller.hold, null);
    assert.equal(controller.longPressFired, false);
  }
});
