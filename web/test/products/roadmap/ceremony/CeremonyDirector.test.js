// The director's `busy()` — what the week's offer asks before its safety cap closes. Pinned: it is
// true from the moment a ceremony is scheduled until its last beat has run, whether that ceremony
// speaks (the arrival's toast), speaks nothing (a summary-less plan, the demo's suppressed arrival),
// or is cut short (reduced motion, cancel); and true while a changeset waits for the floor.

import test from 'node:test';
import assert from 'node:assert/strict';
import { CeremonyDirector } from '../../../../src/products/roadmap/ceremony/CeremonyDirector.js';

function director({ motion = 1 } = {}) {
  const spoken = [];
  const d = new CeremonyDirector({
    nodes: { igniteNode() {}, pulse() {} },
    edges: { travel() {}, edgeDuration: () => 280 },
    camera: { glideTo() {}, settleProgress: () => 1 },
    speak: (message) => spoken.push(message),
    clock: () => 0,
    motion: () => motion,
  });
  return { d, spoken };
}

const node = (id, tier = 1) => ({ id, tier, x: 0, y: 0 });
const plan = (summary = 'Planted — 3 steps') => ({
  rings: [[node('root', 2)], [node('a'), node('b')]],
  litEdgesByRing: [[], [{ from: 'root', to: 'a' }, { from: 'root', to: 'b' }]],
  summary,
});

test('busy from arrival() until its last beat, and the toast lands before it clears', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { d, spoken } = director();
  assert.equal(d.busy(), false);
  d.arrival(plan());
  assert.equal(d.busy(), true);
  t.mock.timers.tick(1059); // ring 1 at 320 + BLOSSOM 620 = 940 settle, toast at +120
  assert.deepEqual(spoken, []);
  assert.equal(d.busy(), true);
  t.mock.timers.tick(1);
  assert.deepEqual(spoken, ['Planted — 3 steps']);
  assert.equal(d.busy(), true);
  t.mock.timers.tick(1);
  assert.equal(d.busy(), false);
});

test('a summary-less arrival speaks nothing and still goes idle', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { d, spoken } = director();
  d.arrival(plan(null));
  assert.equal(d.busy(), true);
  t.mock.timers.tick(1061);
  assert.deepEqual(spoken, []);
  assert.equal(d.busy(), false);
});

test('reduced motion: the one-beat cross-fade clears busy at its toast', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { d, spoken } = director({ motion: 0 });
  d.arrival(plan());
  assert.equal(d.busy(), true);
  t.mock.timers.tick(279);
  assert.equal(d.busy(), true);
  t.mock.timers.tick(1);
  assert.deepEqual(spoken, ['Planted — 3 steps']);
  assert.equal(d.busy(), false);
});

test('a changeset held while editing is pending, and pending is busy', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { d, spoken } = director();
  d.setEditing(true);
  d.celebrate({ focus: null, risen: [{ id: 'a', fromTier: 0, toTier: 1, x: 0, y: 0 }], fell: [], litEdges: [], wakeByEdge: {}, frontier: [], summary: 'a lit', action: null });
  assert.equal(d.busy(), true);
  assert.deepEqual(spoken, []);
  d.setEditing(false);
  t.mock.timers.tick(400); // IDLE_COALESCE — the held changeset begins
  assert.equal(d.busy(), true);
  t.mock.timers.tick(620 + 120 + 1);
  assert.deepEqual(spoken, ['a lit']);
  assert.equal(d.busy(), false);
});

test('cancel() clears both live and pending', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { d, spoken } = director();
  d.arrival(plan());
  d.celebrate({ focus: null, risen: [{ id: 'z', fromTier: 0, toTier: 1, x: 0, y: 0 }], fell: [], litEdges: [], wakeByEdge: {}, frontier: [], summary: 'z', action: null });
  assert.equal(d.busy(), true);
  d.cancel();
  assert.equal(d.busy(), false);
  t.mock.timers.tick(5000);
  assert.deepEqual(spoken, []);
});
