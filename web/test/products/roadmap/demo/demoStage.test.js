import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEMO_STAGED_COMPLETED,
  COACHED_NODE_ID,
  COACHED_CHILDREN,
  DEMO_COPY,
  coachEligible,
} from '../../../../src/products/roadmap/demo/demoStage.js';

// A wrong id silently seeds an empty overlay — the build's most common failure mode.
// These guard the staged set's integrity: exactly six done, the coached node ready
// (not among the done), and its two children still asleep (not among the done).
test('staged set — six done, coached node ready, both children asleep', () => {
  assert.equal(DEMO_STAGED_COMPLETED.length, 6);
  assert.equal(new Set(DEMO_STAGED_COMPLETED).size, 6);
  assert.deepEqual(
    [...DEMO_STAGED_COMPLETED].sort(),
    ['boat-parts', 'dream', 'first-aboard', 'forecast', 'points-of-sail', 'wind-basics'],
  );
  assert.equal(COACHED_NODE_ID, 'rigging');
  assert.deepEqual(COACHED_CHILDREN, ['jibing', 'tacking']);
  assert.equal(DEMO_STAGED_COMPLETED.includes(COACHED_NODE_ID), false);
  for (const child of COACHED_CHILDREN) assert.equal(DEMO_STAGED_COMPLETED.includes(child), false);
});

test('copy — the canon strings the demo speaks verbatim', () => {
  assert.equal(DEMO_COPY.coachSentence, 'This step is ready — mark it done.');
  assert.equal(DEMO_COPY.coachButton, 'Mark it done');
  assert.equal(DEMO_COPY.unlockToast, 'Step unlocked: Rig the boat yourself · 2 steps opened');
  assert.equal(DEMO_COPY.forkToast, 'Forked — 17 steps planted');
  assert.equal(DEMO_COPY.plaqueByline, 'Windmill demo');
});

test('coachEligible — a stranger is eligible, a returning or tree-owning visitor is not', () => {
  assert.equal(coachEligible({ coachDone: false, signedIn: false, ownsTrees: false }), true);
  assert.equal(coachEligible({ coachDone: false, signedIn: true, ownsTrees: false }), true);
  assert.equal(coachEligible({ coachDone: true, signedIn: false, ownsTrees: false }), false);
  assert.equal(coachEligible({ coachDone: false, signedIn: true, ownsTrees: true }), false);
  assert.equal(coachEligible({ coachDone: true, signedIn: true, ownsTrees: true }), false);
});
