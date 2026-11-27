// What a step's document says, read off the whole roadmap whatever the Board shows: the step's column, the steps
// it needs and opens with theirs, and what Complete or Reset would move. All of it is the domain's (`reading`,
// `readEffects`).

import { COLUMN_OF_STATE, domainReading, readEffects } from '../model/domainReads.js';
import { takesMark } from '../model/Opening.js';
import { STEP_DETAIL } from '../copy.js';

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
    const { graph, states } = domainReading(tree, progress);
    const effects = readEffects(tree, [id], progress);
    const steps = (ids) => ids.map((step) => tree.nodesById.get(step));
    const related = (relatives) => [...new Map(relatives.map((step) => [step.id, step])).values()]
      .map((step) => new RelatedStep(step, states.get(step.id)));

    this.step = tree.nodesById.get(id);
    this.opening = this.step.opening ?? null;
    this.marked = progress.completed.has(id);
    this.roadmap = tree.title;
    this.column = COLUMN_OF_STATE[states.get(id)];
    this.toGo = this.column === 'locked' ? graph.owed(id).length : 0;
    this.needs = this.column === 'locked' ? steps(graph.unmet(id)) : [];
    this.prerequisites = related(tree.parentsOf(id));
    this.unlocks = related(steps(effects.follow));
    this.opens = steps(graph.unlocks(id));
    this.relocks = effects.relocks.length;
  }

  get id() { return this.step.id; }
  get prerequisitesDone() { return this.prerequisites.filter((prerequisite) => prerequisite.column === 'done').length; }
  // Complete and Reset are a hand's marks: a step that opens a tree offers neither.
  get takesMark() { return takesMark(this.step); }
}

// Subtasks never complete a step: once every one is checked, an unfinished step a hand may mark offers its Complete.
export function offersCompletion({ subtasks }, facts) {
  return facts.takesMark && facts.column === 'upNext' && subtasks.length > 0 && subtasks.every((subtask) => subtask.done);
}
