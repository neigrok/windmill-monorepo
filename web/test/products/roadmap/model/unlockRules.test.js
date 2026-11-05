import test from 'node:test';
import assert from 'node:assert/strict';

import { SkillTree } from '../../../../src/products/roadmap/model/SkillTree.js';
import {
  UnlockRules,
  unmetPrerequisitesOf,
  owedStepsOf,
  owedCounts,
  unlocksOf,
} from '../../../../src/products/roadmap/model/UnlockRules.js';
import { largeRoadmap } from '../fixtures/largeRoadmap.js';

function tree(nodes) {
  return new SkillTree({ id: 't', title: 'T', nodes });
}

function node(id, prerequisites, extra = {}) {
  return { id, label: id.toUpperCase(), prerequisites, ...extra };
}

test('UnlockRules.derive — completion wins, a step with every prerequisite done is available, the rest locked', () => {
  const t = tree([node('r', []), node('a', ['r']), node('b', ['a']), node('c', ['a'])]);

  assert.deepEqual(UnlockRules.derive(t, { completed: new Set(['r', 'c']), completedAt: {} }), new Map([
    ['r', 'complete'], ['a', 'available'], ['b', 'locked'], ['c', 'complete'],
  ]));
});

test('unmetPrerequisitesOf — the unfinished direct prerequisites in authored order, a repeat counted once', () => {
  const t = tree([node('r', []), node('late', ['r']), node('early', ['r']), node('target', ['late', 'r', 'early', 'late'])]);
  const states = new Map([['r', 'complete'], ['late', 'available'], ['early', 'available'], ['target', 'locked']]);

  assert.deepEqual(unmetPrerequisitesOf(t, states, 'target'), [t.nodesById.get('late'), t.nodesById.get('early')]);
  assert.deepEqual(unmetPrerequisitesOf(t, states, 'late'), []);
});

test('owedStepsOf — every unfinished step in the prerequisite closure, an up-next one included', () => {
  const t = tree([node('r', []), node('a', ['r']), node('b', ['a']), node('side', ['r']), node('target', ['b', 'side'])]);
  const states = new Map([['r', 'complete'], ['a', 'available'], ['side', 'available'], ['b', 'locked'], ['target', 'locked']]);

  assert.deepEqual(owedStepsOf(t, states, 'target').map((step) => step.id).sort(), ['a', 'b', 'side']);
  assert.deepEqual(owedStepsOf(t, states, 'a'), []);
});

test('owedCounts — one pass gives every unfinished step the count owedStepsOf walks, on chain, deep and lattice roadmaps', () => {
  const chain = tree(Array.from({ length: 300 }, (_, index) => node(`n${index}`, index === 0 ? [] : [`n${index - 1}`])));
  const deep = new SkillTree(largeRoadmap(300, 'deep'));
  const lattice = tree(Array.from({ length: 300 }, (_, index) => node(`n${index}`, [...new Set([
    ...(index > 0 ? [`n${index - 1}`] : []),
    ...(index > 2 ? [`n${Math.floor(index / 2)}`] : []),
    ...(index > 7 ? [`n${index - 7}`] : []),
  ])])));

  for (const roadmap of [chain, deep, lattice]) {
    const completed = new Set(roadmap.topoOrder().filter((id, index) => index < 120 || (index < 200 && index % 17 === 0)));
    const states = UnlockRules.derive(roadmap, { completed, completedAt: {} });
    const counts = owedCounts(roadmap, states);
    const unfinished = roadmap.nodes.filter((step) => states.get(step.id) !== 'complete');

    assert.deepEqual(
      new Map(unfinished.map((step) => [step.id, counts.get(step.id)])),
      new Map(unfinished.map((step) => [step.id, owedStepsOf(roadmap, states, step.id).length])),
    );
    assert.equal(counts.size, unfinished.length);
    assert.ok(unfinished.some((step) => counts.get(step.id) > 32), 'a fixture owes past one bitset word');
  }
});

test('unlocksOf — the children this completion alone opens, in authored order', () => {
  const t = tree([node('r', []), node('a', ['r']), node('other', ['r']), node('solo', ['a']), node('pair', ['a', 'other']), node('done', ['a'])]);
  const states = new Map([['r', 'complete'], ['a', 'available'], ['other', 'available'], ['solo', 'locked'], ['pair', 'locked'], ['done', 'complete']]);

  assert.deepEqual(unlocksOf(t, states, 'a'), [t.nodesById.get('solo')]);
  assert.deepEqual(unlocksOf(t, states, 'solo'), []);
});

