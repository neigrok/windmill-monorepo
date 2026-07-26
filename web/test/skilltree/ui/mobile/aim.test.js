import test from 'node:test';
import assert from 'node:assert/strict';

import { SkillTree } from '../../../../src/skilltree/model/SkillTree.js';
import { illegalTargets, edgeFor } from '../../../../src/skilltree/ui/mobile/aim.js';

// root → a → b → c → c2, plus a → x (x is a sibling of b under a), plus a detached m.
// Source is b throughout: it has ancestors {a, root}, a child c, deeper descendants {c, c2},
// a parent a, and two legal off-branch targets (x — a multi-parent join — and m).
function fakeTree() {
  return new SkillTree({
    id: 't',
    title: 'Fake',
    nodes: [
      { id: 'root', label: 'root', prerequisites: [] },
      { id: 'a', label: 'a', prerequisites: ['root'] },
      { id: 'b', label: 'b', prerequisites: ['a'] },
      { id: 'c', label: 'c', prerequisites: ['b'] },
      { id: 'c2', label: 'c2', prerequisites: ['c'] },
      { id: 'x', label: 'x', prerequisites: ['a'] },
      { id: 'm', label: 'm', prerequisites: [] },
    ],
  });
}

const sorted = (set) => [...set].sort();

test('illegalTargets — unlocks blocks the source, its ancestors, and its existing children', () => {
  const illegal = illegalTargets(fakeTree(), 'b', 'unlocks');
  assert.deepEqual(sorted(illegal), ['a', 'b', 'c', 'root']);
});

test('illegalTargets — unlocks leaves deeper descendants and off-branch nodes eligible', () => {
  const illegal = illegalTargets(fakeTree(), 'b', 'unlocks');
  assert.equal(illegal.has('c2'), false); // b → c2 is redundant, not a cycle
  assert.equal(illegal.has('x'), false);  // a legal multi-parent join
  assert.equal(illegal.has('m'), false);
});

test('illegalTargets — needs blocks the source, its descendants, and its existing parents', () => {
  const illegal = illegalTargets(fakeTree(), 'b', 'needs');
  assert.deepEqual(sorted(illegal), ['a', 'b', 'c', 'c2']);
});

test('illegalTargets — needs leaves an ancestor other than a direct parent eligible', () => {
  const illegal = illegalTargets(fakeTree(), 'b', 'needs');
  assert.equal(illegal.has('root'), false); // root → b is redundant, not a cycle
  assert.equal(illegal.has('x'), false);
  assert.equal(illegal.has('m'), false);
});

test('edgeFor — unlocks points from the source to the tapped target', () => {
  assert.deepEqual(edgeFor('b', 'x', 'unlocks'), { from: 'b', to: 'x' });
});

test('edgeFor — needs points from the tapped prerequisite into the source', () => {
  assert.deepEqual(edgeFor('b', 'x', 'needs'), { from: 'x', to: 'b' });
});
