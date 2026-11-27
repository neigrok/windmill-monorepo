// @ts-check

import { Rule, RuleBook } from '../../../platform/domain-kit/rules.js';
import { RoadmapChecks, RoadmapSpecs } from './roadmapRules.js';
import { Roadmap, RoadmapMeta } from './roadmaps.js';
import { RoadmapLink, RoadmapStep } from './steps.js';
import { RoadmapKind } from './kinds.js';
import { StepMark, StepPointer } from './progress.js';
import { StepLink, StepNote, Subtask } from './workspace.js';
import { CoachMessage, CoachProposal, CoachThread, CoachWriteFate } from './conversation.js';

/** @typedef {import('../../../../../packages/api-contract/sync/reference/core/registry.js').Registry} Registry */

// The rule book of roadmap's records, over the registry that declares them: a surface composes roadmap's
// registry before it loads, so the book takes it from the caller.
export class RoadmapRules {
  /** @param {Registry} registry */
  constructor(registry) {
    this.registry = registry;
    this.book = new RuleBook(registry, [Roadmap, RoadmapMeta, RoadmapStep, RoadmapLink, RoadmapKind, StepMark, StepPointer, Subtask, StepLink, StepNote,
      CoachThread, CoachMessage, CoachProposal, CoachWriteFate], [
      ...Object.values(RoadmapSpecs).map((spec) => Rule.localSpec(spec)),
      Rule.localCheck(RoadmapChecks.cycle, 'edge'),
      Rule.localCheck(RoadmapChecks.wornHue, 'kind'),
      Rule.localCheck(RoadmapChecks.opening, 'progress'),
      Rule.localCheck(RoadmapChecks.question, 'coachMessage'),
      Rule.serverDecided('tree.root', ['not-a-root'], 'tree'),
      Rule.serverDecided('tree.alive', ['scope-dead'], 'tree'),
      Rule.serverDecided('tree.reach', ['forbidden', 'not-found'], 'tree'),
      Rule.serverDecided('tree.subtreeStep', ['step-opens-a-tree'], 'node'),
      Rule.serverDecided('tree.depth', ['depth-limit'], 'tree'),
    ]);
    Object.freeze(this);
  }

  /** @param {string} path */
  static spec(path) {
    return Object.values(RoadmapSpecs).find((spec) => spec.path === path) ?? null;
  }
}
