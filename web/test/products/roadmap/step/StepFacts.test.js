import test from 'node:test';
import assert from 'node:assert/strict';

import { Opening } from '../../../../src/products/roadmap/model/Opening.js';
import { SkillTree } from '../../../../src/products/roadmap/model/SkillTree.js';
import { advanceProgress } from '../../../../src/products/roadmap/model/progress.js';
import { StepFacts, completionOpens, resetRelocks, offersCompletion, titleOf } from '../../../../src/products/roadmap/step/StepFacts.js';
import { STEP_DETAIL } from '../../../../src/products/roadmap/copy.js';

test('step surfaces share the trimmed title and the unnamed fallback', () => {
  assert.deepEqual([{}, { label: '' }, { label: '  ' }, { label: ' Read the wind ' }].map(titleOf),
    [STEP_DETAIL.unnamed, STEP_DETAIL.unnamed, STEP_DETAIL.unnamed, 'Read the wind']);
});

function learnToSail() {
  return new SkillTree({ id: 'sail', title: 'Learn to sail', nodes: [
    { id: 'course', label: 'Choose a sailing course', prerequisites: [], color: 'terracotta' },
    { id: 'parts', label: 'Name the boat parts', prerequisites: ['course'], color: 'sky' },
    { id: 'rig', label: 'Rig the boat', prerequisites: ['parts'], color: 'terracotta' },
    { id: 'bowline', label: 'Tie a bowline', prerequisites: ['parts'], color: 'olive' },
    { id: 'wind', label: 'Read the wind', prerequisites: ['parts'], color: 'sky' },
    { id: 'dock', label: 'Leave the dock', prerequisites: ['rig', 'wind'], color: 'terracotta' },
    { id: 'triangle', label: 'Sail a triangle', prerequisites: ['dock'], color: 'olive' },
    { id: 'solo', label: 'Sail solo', prerequisites: ['triangle', 'bowline'], color: 'gold' },
  ] });
}

function initialProgress() {
  return { completed: new Set(['course', 'parts', 'rig']), completedAt: { course: 100, parts: 200, rig: 300 } };
}

function render(facts) {
  const rows = (related) => related.map((entry) => `  ${entry.step.label} · ${entry.column}`);
  return [
    `${facts.step.label} · ${facts.column} · ${facts.toGo} to go`,
    `prerequisites ${facts.prerequisitesDone}/${facts.prerequisites.length}`,
    ...rows(facts.prerequisites),
    `unlocks ${facts.unlocks.length}`,
    ...rows(facts.unlocks),
    `complete opens ${facts.opens.map((step) => step.label).join(', ') || 'nothing'}`,
    `reset relocks ${facts.relocks}`,
  ].join('\n');
}

test('StepFacts — Read the wind is up next: its done prerequisite, the locked step it opens, and what Complete would move', () => {
  assert.equal(render(new StepFacts(learnToSail(), initialProgress(), 'wind')), [
    'Read the wind · upNext · 0 to go',
    'prerequisites 1/1',
    '  Name the boat parts · done',
    'unlocks 1',
    '  Leave the dock · locked',
    'complete opens Leave the dock',
    'reset relocks 0',
  ].join('\n'));
});

test('StepFacts — Sail solo is locked four steps away, and an unmet need of each column reads as its own', () => {
  assert.equal(render(new StepFacts(learnToSail(), initialProgress(), 'solo')), [
    'Sail solo · locked · 4 to go',
    'prerequisites 0/2',
    '  Sail a triangle · locked',
    '  Tie a bowline · upNext',
    'unlocks 0',
    'complete opens nothing',
    'reset relocks 0',
  ].join('\n'));
});

test('StepFacts — Name the boat parts is done: Reset would return two steps to Locked and leave Rig the boat done', () => {
  assert.equal(render(new StepFacts(learnToSail(), initialProgress(), 'parts')), [
    'Name the boat parts · done · 0 to go',
    'prerequisites 1/1',
    '  Choose a sailing course · done',
    'unlocks 3',
    '  Rig the boat · done',
    '  Tie a bowline · upNext',
    '  Read the wind · upNext',
    'complete opens nothing',
    'reset relocks 2',
  ].join('\n'));
});

test('StepFacts — a prerequisite listed twice is one row', () => {
  const tree = new SkillTree({ id: 't', title: 't', nodes: [
    { id: 'a', label: 'A', prerequisites: [] },
    { id: 'b', label: 'B', prerequisites: ['a', 'a'] },
  ] });
  const facts = new StepFacts(tree, { completed: new Set(), completedAt: {} }, 'b');
  assert.deepEqual([facts.prerequisites.map((entry) => entry.id), facts.toGo], [['a'], 1]);
});

test('completionOpens and resetRelocks — completing Read the wind opens Leave the dock; resetting it again relocks it', () => {
  const tree = learnToSail();
  const completed = advanceProgress(initialProgress(), ['wind'], 'complete', 400);
  assert.deepEqual([
    completionOpens(tree, initialProgress(), 'wind').map((step) => step.id),
    completionOpens(tree, completed, 'wind'),
    resetRelocks(tree, completed, 'wind'),
    resetRelocks(tree, initialProgress(), 'wind'),
  ], [['dock'], [], 1, 0]);
});

test('offersCompletion — only an up next step whose every subtask is checked offers Complete', () => {
  const all = { subtasks: [{ id: '1', done: true }, { id: '2', done: true }] };
  const some = { subtasks: [{ id: '1', done: true }, { id: '2', done: false }] };
  const step = (column) => ({ column, takesMark: true });
  assert.deepEqual([
    offersCompletion(all, step('upNext')),
    offersCompletion(some, step('upNext')),
    offersCompletion({ subtasks: [] }, step('upNext')),
    offersCompletion(all, step('locked')),
    offersCompletion(all, step('done')),
  ], [true, false, false, false, false]);
});

function myYear(opening) {
  return new SkillTree({ id: 'year', title: 'My year', nodes: [
    { id: 'plan', label: 'Plan the year', prerequisites: [] },
    { id: 'sail', label: 'Learn to sail', prerequisites: ['plan'], opens: opening.treeId, opening },
    { id: 'coast', label: 'Sail the coast', prerequisites: ['sail', 'plan'], opens: 't_coast', opening: Opening.fromWire({ treeId: 't_coast', title: 'Coast trip', state: 'open', done: 0, total: 5, loop: false }) },
    { id: 'maya', label: 'Take Maya sailing', prerequisites: ['sail'] },
  ] });
}

test('a step that opens a tree says so in its facts, stands where its tree puts it and takes no hand mark', () => {
  const opening = Opening.fromWire({ treeId: 't_sail', title: 'Learn to sail', state: 'open', done: 3, total: 8, loop: false });
  const marked = { completed: new Set(['plan', 'sail']), completedAt: {} };
  const sail = new StepFacts(myYear(opening), marked, 'sail');
  const coast = new StepFacts(myYear(opening), marked, 'coast');
  const plan = new StepFacts(myYear(opening), marked, 'plan');

  assert.deepEqual(
    { opening: sail.opening, roadmap: sail.roadmap, column: sail.column, takesMark: sail.takesMark, opens: sail.opens, relocks: sail.relocks },
    { opening, roadmap: 'My year', column: 'upNext', takesMark: false, opens: [], relocks: 0 },
  );
  assert.deepEqual(
    { column: coast.column, toGo: coast.toGo, needs: coast.needs.map((step) => step.id), takesMark: coast.takesMark },
    { column: 'locked', toGo: 1, needs: ['sail'], takesMark: false },
  );
  assert.deepEqual({ opening: plan.opening, column: plan.column, takesMark: plan.takesMark, needs: plan.needs }, { opening: null, column: 'done', takesMark: true, needs: [] });
});

test('the subtask offer never offers Complete on a step that opens a tree, whatever its tree has come to', () => {
  const all = { subtasks: [{ id: '1', done: true }] };
  const openings = [
    Opening.fromWire({ treeId: 't_sail', title: 'Learn to sail', state: 'open', done: 3, total: 8, loop: false }),
    Opening.fromWire({ treeId: 't_sail', title: 'Learn to sail', state: 'open', done: 0, total: 0, loop: false }),
    Opening.fromWire({ treeId: 't_sail', title: 'Learn to sail', state: 'open', done: 3, total: 8, loop: true }),
    Opening.fromWire({ treeId: 't_sail', missing: true }),
    Opening.unread('t_sail'),
  ];
  const progress = { completed: new Set(['plan']), completedAt: {} };

  assert.deepEqual(openings.map((opening) => {
    const facts = new StepFacts(myYear(opening), progress, 'sail');
    return { column: facts.column, offers: offersCompletion(all, facts) };
  }), openings.map(() => ({ column: 'upNext', offers: false })));
  assert.equal(offersCompletion(all, new StepFacts(myYear(openings[0]), { completed: new Set(), completedAt: {} }, 'plan')), true);
});
