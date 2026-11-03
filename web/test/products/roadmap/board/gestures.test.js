import test from 'node:test';
import assert from 'node:assert/strict';
import { SwipeGesture } from '../../../../src/products/roadmap/board/gestures.js';
import { HoldGesture } from '../../../../src/products/roadmap/input/HoldGesture.js';

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

test('a swipe claim cancels the hold and a fired hold keeps its release swallowed', () => {
  const hold = new HoldGesture({ x: 80, y: 100 });
  const swipe = new SwipeGesture({ x: 80, y: 100, width: 390 });
  if (swipe.move(100, 100).claimed) hold.cancel();
  assert.equal(hold.advance(500), false);
  assert.equal(hold.release(), false);
  const held = new HoldGesture({ x: 80, y: 100 });
  assert.equal(held.advance(500), true);
  held.cancel();
  assert.equal(held.release(), true);
});
