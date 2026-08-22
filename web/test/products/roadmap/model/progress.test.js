// The three-state machine and the milestone sentence, lifted out of SkillTreeView by Wave 17.
// Two properties carry the whole extraction: the progress handed in comes back untouched (the
// component keeps rendering off the old sets until React swaps them, so an in-place mutation
// would paint the new state a frame early and persist a set nobody chose), and every transition
// clears the stamps it invalidates — a step walked back to "not started" that keeps its
// completedAt reads as done to the share card's period math, hours later, silently.

import test from 'node:test';
import assert from 'node:assert/strict';

import { advanceProgress, milestoneAnnouncement } from '../../../../src/products/roadmap/model/progress.js';

function progress() {
  return {
    completed: new Set(['a']),
    inProgress: new Set(['b']),
    startedAt: { b: 100 },
    completedAt: { a: 50 },
  };
}

function snapshot(p) {
  return {
    completed: [...p.completed].sort(),
    inProgress: [...p.inProgress].sort(),
    startedAt: { ...p.startedAt },
    completedAt: { ...p.completedAt },
  };
}

test('completing a step adds it, drops it from in-progress, and stamps completedAt', () => {
  const before = progress();
  const next = advanceProgress(before, ['b'], 'complete', 900);

  assert.deepEqual(snapshot(next), {
    completed: ['a', 'b'],
    inProgress: [],
    startedAt: { b: 100 },   // when work began survives the completion
    completedAt: { a: 50, b: 900 },
  });
  assert.deepEqual(snapshot(before), snapshot(progress()));
});

test('a bulk mark stamps every step with the one moment it was handed', () => {
  const next = advanceProgress(progress(), ['b', 'c', 'd'], 'complete', 900);

  assert.deepEqual(snapshot(next), {
    completed: ['a', 'b', 'c', 'd'],
    inProgress: [],
    startedAt: { b: 100 },
    completedAt: { a: 50, b: 900, c: 900, d: 900 },
  });
});

test('re-completing a completed step re-stamps it and changes nothing else', () => {
  const next = advanceProgress(progress(), ['a'], 'complete', 900);

  assert.deepEqual(snapshot(next), {
    completed: ['a'],
    inProgress: ['b'],
    startedAt: { b: 100 },
    completedAt: { a: 900 },
  });
});

test('starting a step leaves completed, stamps startedAt once, and clears completedAt', () => {
  const next = advanceProgress(progress(), ['a'], 'inprogress', 900);

  assert.deepEqual(snapshot(next), {
    completed: [],
    inProgress: ['a', 'b'],
    startedAt: { b: 100, a: 900 },
    completedAt: {},
  });
});

test('re-starting a step already in progress keeps its original startedAt', () => {
  const next = advanceProgress(progress(), ['b'], 'inprogress', 900);

  assert.deepEqual(snapshot(next), {
    completed: ['a'],
    inProgress: ['b'],
    startedAt: { b: 100 },   // not 900 — the start is the first one, not the latest
    completedAt: { a: 50 },
  });
});

test('walking a step back to not-started drops both of its stamps', () => {
  const next = advanceProgress(progress(), ['a', 'b'], 'notstarted', 900);

  assert.deepEqual(snapshot(next), {
    completed: [],
    inProgress: [],
    startedAt: {},
    completedAt: {},
  });
});

test('an empty move returns an equal progress and still copies it', () => {
  const before = progress();
  const next = advanceProgress(before, [], 'complete', 900);

  assert.deepEqual(snapshot(next), snapshot(before));
  assert.notEqual(next.completed, before.completed);
  assert.notEqual(next.inProgress, before.inProgress);
  assert.notEqual(next.startedAt, before.startedAt);
  assert.notEqual(next.completedAt, before.completedAt);
});

test('no fresh milestone means no announcement', () => {
  assert.equal(milestoneAnnouncement([]), null);
  assert.equal(milestoneAnnouncement(null), null);
});

test('a branch announces its label, its count and the share-the-moment door', () => {
  const announcement = milestoneAnnouncement([{ id: 'rigging', kind: 'branch', label: 'Rigging', done: 4, total: 4 }]);

  assert.deepEqual(announcement, {
    summary: 'Branch complete: Rigging · 4/4 steps',
    label: 'Share the moment',
  });
});

test('the crown wins over any limb that landed with it, however big', () => {
  const announcement = milestoneAnnouncement([
    { id: 'rigging', kind: 'branch', label: 'Rigging', done: 9, total: 9 },
    { id: '__crown__', kind: 'crown', label: 'Sailing', done: 22, total: 22 },
  ]);

  assert.deepEqual(announcement, {
    summary: 'Tree complete — 22/22 steps.',
    label: 'Share it',
  });
});

test('with no crown the biggest limb is the picture, ties keeping the first', () => {
  const announcement = milestoneAnnouncement([
    { id: 'a', kind: 'branch', label: 'Sails', done: 3, total: 3 },
    { id: 'b', kind: 'branch', label: 'Hull', done: 7, total: 7 },
    { id: 'c', kind: 'branch', label: 'Deck', done: 7, total: 7 },
  ]);

  assert.deepEqual(announcement, {
    summary: 'Branch complete: Hull · 7/7 steps',
    label: 'Share the moment',
  });
});

