import test from 'node:test';
import assert from 'node:assert/strict';
import { Opening } from '../../../../src/products/roadmap/model/Opening.js';
import { SkillTree } from '../../../../src/products/roadmap/model/SkillTree.js';
import { readEffects } from '../../../../src/products/roadmap/model/effects.js';

test('delete cost names a step keeping another prerequisite, and a step following two of the steps once', () => {
  const tree = new SkillTree({ id: 'sail', title: 'Learn to sail', nodes: [
    { id: 'wind', label: 'Read the wind', prerequisites: [] },
    { id: 'rig', label: 'Rig the boat', prerequisites: [] },
    { id: 'dock', label: 'Leave the dock', prerequisites: ['wind', 'rig'] },
    { id: 'solo', label: 'Sail solo', prerequisites: ['dock'] },
  ] });
  assert.deepEqual([['wind'], ['rig'], ['wind', 'rig', 'rig'], ['wind', 'rig', 'dock'], []].map((ids) => readEffects(tree, ids).follow),
    [['dock'], ['dock'], ['dock'], ['solo'], []]);
});

test('a selection takes every starting step only when it holds each one the roadmap has', () => {
  const sole = new SkillTree({ id: 'sole', title: 'Sole', nodes: [
    { id: 'root', label: 'Root', prerequisites: [] },
    { id: 'leaf', label: 'Leaf', prerequisites: ['root'] },
  ] });
  const twoRoots = new SkillTree({ id: 'two', title: 'Two', nodes: [
    { id: 'root', label: 'Root', prerequisites: [] },
    { id: 'other', label: 'Other', prerequisites: [] },
  ] });
  assert.deepEqual([
    [sole, ['root']], [sole, ['leaf', 'root']], [sole, ['leaf']], [sole, []], [sole, ['gone']], [twoRoots, ['root']], [twoRoots, ['root', 'other']],
  ].map(([tree, ids]) => readEffects(tree, ids).takesEveryStart), [true, true, false, false, false, false, true]);
});

test('a step complete by the roadmap it opens keeps its mark set aside, so its Reset relocks nothing, where a marked step relocks', () => {
  const year = new SkillTree({ id: 'year', title: 'My year', nodes: [
    { id: 'plan', label: 'Plan the year', prerequisites: [] },
    { id: 'sail', label: 'Learn to sail', prerequisites: ['plan'], opens: 't_sail',
      opening: Opening.fromWire({ treeId: 't_sail', title: 'Learn to sail', state: 'complete', done: 8, total: 8, loop: false }) },
    { id: 'maya', label: 'Take Maya sailing', prerequisites: ['sail'] },
    { id: 'coast', label: 'Sail the coast', prerequisites: ['plan'] },
  ] });
  const progress = { completed: new Set(['plan', 'sail']), completedAt: {} };
  assert.deepEqual(['sail', 'plan'].map((id) => readEffects(year, [id], progress).relocks), [[], ['coast']]);
});
