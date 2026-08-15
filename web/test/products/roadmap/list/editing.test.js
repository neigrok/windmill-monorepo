import test from 'node:test';
import assert from 'node:assert/strict';

import { SkillTree } from '../../../../src/products/roadmap/model/SkillTree.js';
import { swipeBegin, swipeMove, swipeEnd, swipeCancel, keyboardPin, scrollerClearance, pickerCandidates, stillEditing, holdCancelledByMove, HOLD_MS } from '../../../../src/products/roadmap/list/editing.js';

function tree(nodes) {
  return new SkillTree({ id: 't', title: 'T', nodes });
}

function node(id, prerequisites, extra = {}) {
  return { id, label: id.toUpperCase(), prerequisites, ...extra };
}

test('swipeBegin — a fresh gesture is live, unarmed, at rest', () => {
  assert.deepEqual(swipeBegin(), { armed: false, live: true, dx: 0 });
});

test('swipeMove — arms once rightward travel passes 14px and out-runs vertical by 1.3x', () => {
  assert.deepEqual(swipeMove(swipeBegin(), 20, 10), { armed: true, live: true, dx: 20 });
});

test('swipeMove — a leftward drag never arms (mark-done is right-swipe only)', () => {
  assert.deepEqual(swipeMove(swipeBegin(), -20, 0), { armed: false, live: true, dx: 0 });
  assert.deepEqual(swipeMove(swipeBegin(), -40, 5), { armed: false, live: true, dx: 0 });
});

test('swipeMove — small travel or a shallow angle leaves the gesture untouched', () => {
  assert.deepEqual(swipeMove(swipeBegin(), 12, 2), { armed: false, live: true, dx: 0 });
  assert.deepEqual(swipeMove(swipeBegin(), 16, 13), { armed: false, live: true, dx: 0 });
});

test('swipeMove — a vertical-first drag kills the gesture (the list scrolls instead)', () => {
  assert.deepEqual(swipeMove(swipeBegin(), 4, 20), { armed: false, live: false, dx: 0 });
});

test('swipeMove — a dead gesture stays dead', () => {
  const dead = { armed: false, live: false, dx: 0 };
  assert.deepEqual(swipeMove(dead, 40, 5), dead);
});

test('swipeMove — once armed it tracks the finger and clamps to 0..120, ratio no longer gating', () => {
  const armed = { armed: true, live: true, dx: 20 };
  assert.deepEqual(swipeMove(armed, 60, 200), { armed: true, live: true, dx: 60 });
  assert.deepEqual(swipeMove(armed, 400, 0), { armed: true, live: true, dx: 120 });
  assert.deepEqual(swipeMove(armed, -30, 0), { armed: true, live: true, dx: 0 });
});

test('swipeEnd — release at or past 72px commits; every armed release swallows the trailing click', () => {
  assert.deepEqual(swipeEnd({ armed: true, live: true, dx: 72 }), { commit: true, swallow: true });
  assert.deepEqual(swipeEnd({ armed: true, live: true, dx: 120 }), { commit: true, swallow: true });
  assert.deepEqual(swipeEnd({ armed: true, live: true, dx: 40 }), { commit: false, swallow: true });
  assert.deepEqual(swipeEnd({ armed: false, live: true, dx: 0 }), { commit: false, swallow: false });
});

test('swipeCancel — a cancelled pointer never commits, even past the threshold; armed still swallows', () => {
  assert.deepEqual(swipeCancel({ armed: true, live: true, dx: 120 }), { commit: false, swallow: true });
  assert.deepEqual(swipeCancel({ armed: true, live: true, dx: 40 }), { commit: false, swallow: true });
  assert.deepEqual(swipeCancel({ armed: false, live: true, dx: 0 }), { commit: false, swallow: false });
});

test('scrollerClearance — the lane is cut out of the scroller whole; with no keyboard nothing is padded inside', () => {
  assert.deepEqual(scrollerClearance({ laneInset: 70, keyboardInset: 0 }), { lane: 70, keyboardCover: 0 });
});

test('scrollerClearance — a keyboard taller than the lane covers the body by only the excess', () => {
  assert.deepEqual(scrollerClearance({ laneInset: 70, keyboardInset: 300 }), { lane: 70, keyboardCover: 230 });
});

test('scrollerClearance — a keyboard shorter than the lane band never reaches the body', () => {
  assert.deepEqual(scrollerClearance({ laneInset: 132, keyboardInset: 100 }), { lane: 132, keyboardCover: 0 });
});

test('keyboardPin — scrolls down just enough to clear the keyboard, leaving a 16px margin', () => {
  assert.equal(keyboardPin({ rowBottom: 900, bodyHeight: 700, keyboardInset: 300, scrollTop: 0 }), 516);
});

test('keyboardPin — a row already above the keyboard is left where it sits (never scrolls up)', () => {
  assert.equal(keyboardPin({ rowBottom: 300, bodyHeight: 700, keyboardInset: 300, scrollTop: 200 }), 200);
  assert.equal(keyboardPin({ rowBottom: 900, bodyHeight: 700, keyboardInset: 300, scrollTop: 800 }), 800);
});

test('pickerCandidates — legal prerequisites first, cycle-closers as would-loop, self and parents dropped', () => {
  const t = tree([
    node('r', []),
    node('a', ['r'], { order: 'a' }),
    node('b', ['a'], { order: 'b' }),
    node('d', ['b'], { order: 'd' }),
    node('c', ['r'], { order: 'c' }),
  ]);

  const { legal, looping } = pickerCandidates(t, 'a');
  assert.deepEqual(legal.map((n) => n.id), ['c']);
  assert.deepEqual(looping.map((n) => n.id), ['b', 'd']);
});

test('pickerCandidates — a leaf can need any other step; nothing loops', () => {
  const t = tree([
    node('r', []),
    node('a', ['r'], { order: 'a' }),
    node('b', ['a'], { order: 'b' }),
    node('d', ['b'], { order: 'd' }),
    node('c', ['r'], { order: 'c' }),
  ]);

  const { legal, looping } = pickerCandidates(t, 'd');
  assert.deepEqual(legal.map((n) => n.id), ['r', 'a', 'c']);
  assert.deepEqual(looping.map((n) => n.id), []);
});

test('pickerCandidates — a target that no longer exists (deleted remotely) returns null', () => {
  const t = tree([node('r', []), node('a', ['r'], { order: 'a' })]);
  assert.equal(pickerCandidates(t, 'gone'), null);
});

test('holdCancelledByMove — a still finger (at or within the 10px slop) keeps the hold armed', () => {
  assert.equal(holdCancelledByMove(0, 0), false);
  assert.equal(holdCancelledByMove(10, 0), false);
  assert.equal(holdCancelledByMove(0, -10), false);
  assert.equal(holdCancelledByMove(7, 7), false); // hypot ≈ 9.9, still inside
});

test('holdCancelledByMove — any travel past the slop cancels the hold, in any direction', () => {
  assert.equal(holdCancelledByMove(0, 11), true); // a scroll starting wins
  assert.equal(holdCancelledByMove(11, 0), true); // a swipe arming wins
  assert.equal(holdCancelledByMove(-11, 0), true); // a leftward drag counts too
  assert.equal(holdCancelledByMove(8, 8), true); // hypot ≈ 11.3, radial — a diagonal drift cancels
});

test('HOLD_MS — the deliberate-entry hold is half a second', () => {
  assert.equal(HOLD_MS, 500);
});

test('stillEditing — an add field is keyed by parentId, every other field by node id', () => {
  assert.equal(stillEditing({ mode: 'rename', id: 'n1' }, 'rename', 'n1'), true);
  assert.equal(stillEditing({ mode: 'rename', id: 'n1' }, 'rename', 'n2'), false);
  assert.equal(stillEditing({ mode: 'rename', id: 'n1' }, 'describe', 'n1'), false);
  assert.equal(stillEditing({ mode: 'add', parentId: 'p1' }, 'add', 'p1'), true);
  assert.equal(stillEditing({ mode: 'add', parentId: 'p1' }, 'add', 'p2'), false);
  assert.equal(stillEditing(null, 'rename', 'n1'), false);
});
