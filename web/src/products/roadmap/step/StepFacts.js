// What a step's page or modal says, read off the whole roadmap whatever the Board shows: the step's column, the steps
// it needs and opens with theirs, and what Complete or Reset would move. Every column comes from UnlockRules.

import { COLUMN_OF_STATE, UnlockRules, owedStepsOf, takesMark, unmetPrerequisitesOf } from '../model/UnlockRules.js';
import { advanceProgress } from '../model/progress.js';
import { STEP_DETAIL } from '../copy.js';

export const STEP_SECTIONS = ['overview', 'workspace', 'history'];
export const titleOf = (step) => step.label?.trim() || STEP_DETAIL.unnamed;

class RelatedStep {
  constructor(step, state) {
    this.step = step;
    this.column = COLUMN_OF_STATE[state];
  }

  get id() { return this.step.id; }
}

export class StepFacts {
  constructor(tree, progress, id) {
    const states = UnlockRules.derive(tree, progress);
    const related = (steps) => [...new Map(steps.map((step) => [step.id, step])).values()]
      .map((step) => new RelatedStep(step, states.get(step.id)));

    this.step = tree.nodesById.get(id);
    this.opening = this.step.opening ?? null;
    this.roadmap = tree.title;
    this.column = COLUMN_OF_STATE[states.get(id)];
    this.toGo = this.column === 'locked' ? owedStepsOf(tree, states, id).length : 0;
    this.needs = this.column === 'locked' ? unmetPrerequisitesOf(tree, states, id) : [];
    this.prerequisites = related(tree.parentsOf(id));
    this.unlocks = related(tree.childrenOf(id));
    this.opens = completionOpens(tree, progress, id);
    this.relocks = resetRelocks(tree, progress, id);
  }

  get id() { return this.step.id; }
  get prerequisitesDone() { return this.prerequisites.filter((prerequisite) => prerequisite.column === 'done').length; }
  // Complete and Reset are a hand's marks: a step that opens a tree offers neither.
  get takesMark() { return takesMark(this.step); }
}

// The steps completing `id` moves to Up next, in the roadmap's authored order.
export function completionOpens(tree, progress, id) {
  if (progress.completed.has(id)) return [];
  return movedSteps(tree, progress, advanceProgress(progress, [id], 'complete', 0), 'locked', 'available');
}

// How many steps resetting `id` returns to Locked; its completed descendants stay Done.
export function resetRelocks(tree, progress, id) {
  if (!progress.completed.has(id)) return 0;
  return movedSteps(tree, progress, advanceProgress(progress, [id], 'none', 0), 'available', 'locked').length;
}

// Subtasks never complete a step: once every one is checked, an unfinished step a hand may mark offers its Complete.
export function offersCompletion({ subtasks }, facts) {
  return facts.takesMark && facts.column === 'upNext' && subtasks.length > 0 && subtasks.every((subtask) => subtask.done);
}

function movedSteps(tree, before, after, from, to) {
  const was = UnlockRules.derive(tree, before);
  const now = UnlockRules.derive(tree, after);
  return tree.nodes.filter((step) => was.get(step.id) === from && now.get(step.id) === to);
}
