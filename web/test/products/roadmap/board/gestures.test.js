import test from 'node:test';
import assert from 'node:assert/strict';
import { SwipeGesture, LongPress } from '../../../../src/products/roadmap/board/gestures.js';

test('swipe claims only horizontal leading movement outside OS edges', () => {
  const swipe = new SwipeGesture({ x: 80, y: 100, width: 390 });
  assert.deepEqual(swipe.move(85, 101), { claimed: false, offset: 0, tick: false });
  assert.deepEqual(swipe.move(90, 102), { claimed: true, offset: 10, tick: false });
  for (const x of [10, 380]) assert.deepEqual(new SwipeGesture({ x, y: 100, width: 390 }).move(x + 100, 100), { claimed: false, offset: 0, tick: false });
  assert.deepEqual(new SwipeGesture({ x: 80, y: 100, width: 390 }).move(90, 120), { claimed: false, offset: 0, tick: false });
});

test('swipe tracks 1:1 through 96, resists beyond, ticks once and only reveals on release', () => {
  const swipe = new SwipeGesture({ x: 80, y: 100, width: 390 });
  assert.deepEqual(swipe.move(176, 100), { claimed: true, offset: 96, tick: true });
  assert.deepEqual(swipe.move(276, 100), { claimed: true, offset: 131, tick: false });
  assert.equal(swipe.release(), true);
  assert.deepEqual(swipe.move(175, 100), { claimed: true, offset: 95, tick: false });
  assert.equal(swipe.release(), false);
});

test('long press requires 500ms within 10px and cancellation is final', () => {
  const press = new LongPress({ x: 40, y: 50, now: 100 });
  press.move(46, 58);
  assert.deepEqual([press.ready(599), press.ready(600)], [false, true]);
  press.move(51, 50);
  assert.equal(press.ready(1000), false);
  const cancelled = new LongPress({ x: 0, y: 0, now: 0 });
  cancelled.cancel();
  assert.equal(cancelled.ready(1000), false);
});
