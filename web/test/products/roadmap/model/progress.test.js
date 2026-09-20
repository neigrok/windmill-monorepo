import test from 'node:test';
import assert from 'node:assert/strict';

import { advanceProgress, progressChanges, milestoneAnnouncement } from '../../../../src/products/roadmap/model/progress.js';
import { SkillTree } from '../../../../src/products/roadmap/model/SkillTree.js';
import { UnlockRules } from '../../../../src/products/roadmap/model/UnlockRules.js';

test('completion stamps a batch at one instant without mutating the prior overlay', () => {
  const before = { completed: new Set(['a']), completedAt: { a: 50 } };

  assert.deepEqual(advanceProgress(before, ['b', 'c'], 'complete', 900), {
    completed: new Set(['a', 'b', 'c']), completedAt: { a: 50, b: 900, c: 900 },
  });
  assert.deepEqual(before, { completed: new Set(['a']), completedAt: { a: 50 } });
});

test('reset clears completion and its timestamp and locks dependent steps again', () => {
  const tree = new SkillTree({ id: 't', title: 'Sail', nodes: [
    { id: 'a', label: 'Rig', prerequisites: [] },
    { id: 'b', label: 'Sail', prerequisites: ['a'] },
  ] });
  const before = { completed: new Set(['a']), completedAt: { a: 50 } };
  const next = advanceProgress(before, ['a'], 'none', 900);

  assert.deepEqual(next, { completed: new Set(), completedAt: {} });
  assert.deepEqual(UnlockRules.derive(tree, next), new Map([['a', 'available'], ['b', 'locked']]));
});

test('legacy in-progress data cannot override prerequisite rules', () => {
  const tree = new SkillTree({ id: 't', title: 'Sail', nodes: [
    { id: 'a', label: 'Rig', prerequisites: [] },
    { id: 'b', label: 'Sail', prerequisites: ['a'] },
  ] });
  const legacy = { completed: new Set(), inProgress: new Set(['a', 'b']), startedAt: { a: 100, b: 200 } };

  assert.deepEqual(UnlockRules.derive(tree, legacy), new Map([['a', 'available'], ['b', 'locked']]));
  assert.throws(() => advanceProgress(legacy, ['a'], 'active', 900), /Unknown progress status/);
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


test('one remote batch completes both prerequisites and announces their dependent once', () => {
  const tree = new SkillTree({ id: 't', title: 'Sail', nodes: [
    { id: 'a', label: 'Rig', prerequisites: [] },
    { id: 'b', label: 'Weather', prerequisites: [] },
    { id: 'c', label: 'Sail', prerequisites: ['a', 'b'] },
  ] });
  const before = { completed: new Set() };
  const after = { completed: new Set(['a', 'b']) };

  assert.deepEqual(progressChanges(tree, before, after), { completed: ['a', 'b'], unlocked: ['c'] });
  assert.deepEqual(progressChanges(tree, after, after), { completed: [], unlocked: [] });
  assert.deepEqual(progressChanges(tree, after, before), { completed: [], unlocked: [] });
});
