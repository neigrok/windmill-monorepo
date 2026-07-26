import test from 'node:test';
import assert from 'node:assert/strict';

import { SkillTree } from '../../../src/skilltree/model/SkillTree.js';
import { planNextUp } from '../../../src/skilltree/ui/nextUpPlan.js';

function tree(nodes) {
  return new SkillTree({ id: 't', title: 'T', nodes });
}

function node(id, prerequisites, extra = {}) {
  return { id, label: id.toUpperCase(), prerequisites, ...extra };
}

test('planNextUp — a lone bud does not mount', () => {
  assert.deepEqual(planNextUp(tree([node('r', [])]), new Map([['r', 'available']])), { mount: false });
});

test('planNextUp — the featured offer is ranked by unlocks then id, with counts and pill', () => {
  const t = tree([
    node('r', []),
    node('a', ['r'], { color: 'terracotta' }),
    node('b', ['r'], { color: 'olive' }),
    node('x', ['a']),
  ]);
  const states = new Map([['r', 'complete'], ['a', 'available'], ['b', 'available'], ['x', 'locked']]);

  assert.deepEqual(planNextUp(t, states), {
    mount: true,
    mode: 'featured',
    pill: '2 ready',
    doneCount: 1,
    totalCount: 4,
    readyCount: 2,
    featured: [{ id: 'a', kind: 'terracotta', unlocks: 1 }, { id: 'b', kind: 'olive', unlocks: 0 }],
    overflow: [],
    blockers: [],
  });
});

test('planNextUp — a fully grown tree reports the allDone mode', () => {
  const t = tree([node('r', []), node('a', ['r'])]);

  assert.deepEqual(planNextUp(t, new Map([['r', 'complete'], ['a', 'complete']])), {
    mount: true,
    mode: 'allDone',
    pill: '2/2',
    doneCount: 2,
    totalCount: 2,
    readyCount: 0,
    featured: [],
    overflow: [],
    blockers: [],
  });
});

test('planNextUp — nothing ready reports the blocked mode with ranked blockers', () => {
  const t = tree([node('r', [], { color: 'terracotta' }), node('a', ['r'])]);

  assert.deepEqual(planNextUp(t, new Map([['r', 'active'], ['a', 'locked']])), {
    mount: true,
    mode: 'blocked',
    pill: '0 ready',
    doneCount: 0,
    totalCount: 2,
    readyCount: 0,
    featured: [],
    overflow: [],
    blockers: [{ id: 'r', kind: 'terracotta', unlocks: 1 }],
  });
});
