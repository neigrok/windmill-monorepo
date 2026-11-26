// @ts-check
// The context's own rules beyond the corpus's cases: a guide is the person's own only on a roadmap that is theirs, and
// what a caller changes in one context reaches no context after it.

import assert from 'node:assert/strict';
import test from 'node:test';
import { readContext } from '../../../../../src/products/roadmap/domain/abilities/context.js';

test('a guide written on a roadmap the person does not own is not theirs, though it sits above a roadmap of theirs', () => {
  const mine = { id: 't_0000000000000001', own: true, meta: { title: 'Learn to sail', guide: 'One step a weekend.' }, nodes: [{ id: 'a', label: 'Leave the dock' }] };
  const theirs = { id: 't_0000000000000002', own: false, meta: { title: 'A sailing club', guide: 'Ask the club before you sail alone.' },
    nodes: [{ id: 'p', label: 'Learn to sail' }], pointers: [{ node: 'p', present: true, opens: mine.id }] };
  const answer = /** @type {any} */ (readContext({ trees: [mine, theirs] }, { about: mine.id }));
  assert.deepEqual(answer.result.tree.guides, [
    { treeId: theirs.id, title: 'A sailing club', text: 'Ask the club before you sail alone.', yours: false },
    { treeId: mine.id, title: 'Learn to sail', text: 'One step a weekend.', yours: true },
  ]);
});

test('a context is its caller\'s own: what one caller changes in it is in no context read after it', () => {
  const tree = { id: 't_0000000000000001', own: true, meta: { title: 'Learn to sail', guide: 'One step a weekend.' },
    nodes: [{ id: 'a', label: 'Leave the dock' }, { id: 'b', label: 'Tie a bowline' }, { id: 'c', label: 'Sail across' }],
    edges: [{ from: 'a', to: 'c', present: true }, { from: 'c', to: 'z', present: true }],
    marks: [{ node: 'a', status: 'complete', recordedAt: 1_800_000_000_000, deviceAt: 1_800_000_000_000 }] };
  const standing = { trees: [tree] };
  const first = /** @type {any} */ (readContext(standing, { about: tree.id, step: 'c' }));
  const kept = structuredClone(first);
  first.result.tree.kinds.push({ id: 'changed' });
  first.result.tree.guides[0].text = 'changed';
  first.result.diagnostics.dangling = -1;
  first.result.recent[0].label = 'changed';
  first.result.completed[0].at = 0;
  first.result.steps[0].prerequisites.push('z');
  first.result.step.links.push({ url: 'https://example.org', label: 'changed' });
  assert.deepEqual(readContext(standing, { about: tree.id, step: 'c' }), kept);
});
