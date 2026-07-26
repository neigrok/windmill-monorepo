// milestone-share-beat: the share offer fires for a whole branch or the crown, never a single
// step, once per fresh crossing. detectMilestones is the pure core — the owner-only / once-ever
// conduct lives in the shell, so this pins exactly what counts as a milestone.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SkillTree } from '../../../../src/products/roadmap/model/SkillTree.js';
import { detectMilestones, CROWN } from '../../../../src/products/roadmap/model/milestones.js';

// root ─ a1 ─ a2   (branch A, 2 steps)
//      ├ b1 ─ b2   (branch B, 2 steps)
//      └ c1 ─ c2   (branch C, 2 steps) — a spare limb kept incomplete so a branch test never
//                                        accidentally also completes the whole tree (crown).
function forkedTree() {
  return new SkillTree({
    id: 't', title: 'Bakery',
    nodes: [
      { id: 'root', label: 'Root', prerequisites: [] },
      { id: 'a1', label: 'Find a space', prerequisites: ['root'] },
      { id: 'a2', label: 'Sign the lease', prerequisites: ['a1'] },
      { id: 'b1', label: 'Master sourdough', prerequisites: ['root'] },
      { id: 'b2', label: 'Perfect croissants', prerequisites: ['b1'] },
      { id: 'c1', label: 'Name & sign', prerequisites: ['root'] },
      { id: 'c2', label: 'Website', prerequisites: ['c1'] },
    ],
  });
}
const S = (...ids) => new Set(ids);

test('a whole branch completing is a milestone, labelled by its root-child', () => {
  const tree = forkedTree();
  const found = detectMilestones(tree, S('root', 'a1'), S('root', 'a1', 'a2'));
  assert.deepEqual(found, [{ id: 'a1', kind: 'branch', label: 'Find a space', done: 2, total: 2 }]);
});

test('finishing a step mid-branch is not a milestone', () => {
  const tree = forkedTree();
  assert.deepEqual(detectMilestones(tree, S('root'), S('root', 'a1')), []);
});

test('a single-node limb (a root-child leaf) is a step, never a branch', () => {
  const tree = new SkillTree({
    id: 't', title: 'T',
    nodes: [
      { id: 'root', label: 'Root', prerequisites: [] },
      { id: 'leaf', label: 'Lone', prerequisites: ['root'] },
      { id: 'x1', label: 'X1', prerequisites: ['root'] },
      { id: 'x2', label: 'X2', prerequisites: ['x1'] },
    ],
  });
  assert.deepEqual(detectMilestones(tree, S('root'), S('root', 'leaf')), []);
});

test('an already-complete branch never re-fires when another step lands', () => {
  const tree = forkedTree();
  // branch A already done; completing b2 finishes branch B — A must not re-appear.
  const found = detectMilestones(tree, S('root', 'a1', 'a2', 'b1'), S('root', 'a1', 'a2', 'b1', 'b2'));
  assert.deepEqual(found, [{ id: 'b1', kind: 'branch', label: 'Master sourdough', done: 2, total: 2 }]);
});

test('the last step anywhere is the crown, and it supersedes the branch it also finishes', () => {
  const tree = forkedTree();
  const prev = S('root', 'a1', 'a2', 'b1', 'b2', 'c1'); // everything but c2
  const found = detectMilestones(tree, prev, S('root', 'a1', 'a2', 'b1', 'b2', 'c1', 'c2'));
  assert.deepEqual(found, [{ id: CROWN, kind: 'crown', label: 'Bakery', done: 7, total: 7 }]);
});

test('a crown never re-fires on an already-complete tree', () => {
  const tree = forkedTree();
  const all = S('root', 'a1', 'a2', 'b1', 'b2', 'c1', 'c2');
  assert.deepEqual(detectMilestones(tree, all, all), []);
});

test('a one-node tree completing is a step, not a shareable crown', () => {
  const tree = new SkillTree({ id: 't', title: 'Solo', nodes: [{ id: 'only', label: 'Only', prerequisites: [] }] });
  assert.deepEqual(detectMilestones(tree, new Set(), S('only')), []);
});

test('a shared (diamond) step completes every limb it finishes at once', () => {
  // root ─ x ┐        w (a spare limb) keeps the tree incomplete so this is two branches, not crown.
  //      ├ y ┼─ z
  //      └ w
  const tree = new SkillTree({
    id: 't', title: 'Diamond',
    nodes: [
      { id: 'root', label: 'Root', prerequisites: [] },
      { id: 'x', label: 'X', prerequisites: ['root'] },
      { id: 'y', label: 'Y', prerequisites: ['root'] },
      { id: 'z', label: 'Z', prerequisites: ['x', 'y'] },
      { id: 'w', label: 'W1', prerequisites: ['root'] },
      { id: 'w2', label: 'W2', prerequisites: ['w'] },
    ],
  });
  const found = detectMilestones(tree, S('root', 'x', 'y'), S('root', 'x', 'y', 'z'));
  assert.deepEqual(new Set(found.map((m) => m.id)), S('x', 'y'));
  assert.ok(found.every((m) => m.kind === 'branch' && m.done === 2));
});
