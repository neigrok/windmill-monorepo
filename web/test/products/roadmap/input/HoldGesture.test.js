import test from 'node:test';
import assert from 'node:assert/strict';
import { HoldGesture, HOLD_MS } from '../../../../src/products/roadmap/input/HoldGesture.js';

test('the shared hold fires at its deadline, only once, and consumes its release', () => {
  for (const cancelAtLimit of [true, false]) {
    const hold = new HoldGesture({ x: 30, y: 40, at: 100, cancelAtLimit });
    assert.equal(HOLD_MS, 500);
    assert.equal(hold.advance(599), false);
    assert.equal(hold.advance(600), true);
    assert.equal(hold.advance(601), false);
    assert.equal(hold.release(), true);
    assert.equal(hold.advance(1100), false);
  }
});

test('both adapters retain their boundary at exactly ten pixels', () => {
  for (const cancelAtLimit of [true, false]) {
    for (const [x, y, expected] of [[9.99, 0, true], [10, 0, !cancelAtLimit], [10.01, 0, false], [6, 8, !cancelAtLimit]]) {
      const hold = new HoldGesture({ x: 0, y: 0, cancelAtLimit });
      hold.move(x, y);
      assert.equal(hold.advance(500), expected);
      assert.equal(hold.release(), expected);
    }
  }
});

test('a cancelled or released early hold cannot fire later; cancellation after firing still consumes release', () => {
  for (const finish of ['cancel', 'release']) {
    const hold = new HoldGesture({ x: 0, y: 0 });
    hold[finish]();
    assert.equal(hold.advance(500), false);
    assert.equal(hold.release(), false);
  }
  const held = new HoldGesture({ x: 0, y: 0 });
  assert.equal(held.advance(500), true);
  held.cancel();
  assert.equal(held.release(), true);
});


test('fractional performance timestamps fire at the scheduled deadline', () => {
  for (const at of [1.23456, 18.349896, 44.222667, 123456.789123]) {
    const hold = new HoldGesture({ x: 0, y: 0, at });
    assert.equal(hold.advance(at + HOLD_MS - 0.01), false);
    assert.equal(hold.advance(at + HOLD_MS), true);
    assert.equal(hold.release(), true);
  }
});
