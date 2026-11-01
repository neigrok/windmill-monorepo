import test from 'node:test';
import assert from 'node:assert/strict';

import { SkillTree } from '../../../../src/products/roadmap/model/SkillTree.js';
import { advanceProgress } from '../../../../src/products/roadmap/model/progress.js';
import { StepFacts, completionOpens, resetRelocks, offersCompletion } from '../../../../src/products/roadmap/board/StepFacts.js';

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
  assert.deepEqual([
    offersCompletion(all, 'upNext'),
    offersCompletion(some, 'upNext'),
    offersCompletion({ subtasks: [] }, 'upNext'),
    offersCompletion(all, 'locked'),
    offersCompletion(all, 'done'),
  ], [true, false, false, false, false]);
});
