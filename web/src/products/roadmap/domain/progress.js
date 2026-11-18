// @ts-check

import { ActDecision } from '../../../platform/domain-kit/acts.js';
import { EntityType, Id } from '../../../platform/domain-kit/entities.js';
import { Plan, UndoRecipe } from '../../../platform/domain-kit/plans.js';
import { Check, Valid } from '../../../platform/domain-kit/validation.js';
import { Path, Violation } from '../../../platform/domain-kit/values.js';
import { Restore, RoadmapChecks, RoadmapRefusals, RoadmapScopes, RoadmapSpecs, gone, restoring, writeIn } from './roadmapRules.js';
import { RoadmapStep } from './steps.js';

/** @typedef {import('../../../platform/domain-kit/acts.js').ActReader} ActReader */

// A person's mark on a step, in their own overlay of the roadmap: complete or none, with their word that it
// was completed before its prerequisites.
export class StepMarkValue {
  /**
   * @param {Id<StepMarkValue>} id
   * @param {'complete' | 'none' | string} status
   * @param {boolean} outOfOrder
   */
  constructor(id, status = 'none', outOfOrder = false) {
    this.id = id;
    this.status = status;
    this.outOfOrder = outOfOrder;
    Object.freeze(this);
  }

  fields() { return { mark: { status: this.status, outOfOrder: this.outOfOrder } }; }

  /** @param {string} status @param {boolean} outOfOrder */
  holds(status, outOfOrder) { return this.status === status && this.outOfOrder === outOfOrder; }
}

/** @type {EntityType<StepMarkValue, null>} */
export const StepMark = new EntityType({
  type: 'progress', scope: null,
  decode: (f) => {
    const mark = f.optionalValue('mark', (m) => ({ status: m.string('status', 'none'), outOfOrder: m.bool('outOfOrder', false) }));
    return new StepMarkValue(new Id(f.id, StepMark), mark?.status ?? 'none', mark?.outOfOrder ?? false);
  },
  checks: [
    new Check('mark', (mark) => new StepMarkValue(mark.id, RoadmapSpecs.mark.apply(mark.status, new Path('mark.status')), mark.outOfOrder)),
  ],
});

// The roadmap a step opens, in its owner's overlay only (R-3).
export class StepPointerValue {
  /**
   * @param {Id<StepPointerValue>} id
   * @param {string} opens
   */
  constructor(id, opens) {
    this.id = id;
    this.opens = opens;
    Object.freeze(this);
  }

  fields() { return { opens: this.opens }; }
}

/** @type {EntityType<StepPointerValue, null>} */
export const StepPointer = new EntityType({
  type: 'pointer', scope: null, heldRemoval: false, checks: [],
  decode: (f) => new StepPointerValue(new Id(f.id, StepPointer), f.string('opens', '')),
});

// What a mark or a pointer reads of its step in the tree, and of the step in the person's overlay.
class StepOverlay {
  /**
   * @param {ActReader} read
   * @param {string} tree
   * @param {string} step
   */
  constructor(read, tree, step) {
    const known = read.inScope(RoadmapScopes.tree(tree), (scope) => {
      const record = scope.repository(RoadmapStep).record(step, 'drawn');
      return { known: record !== undefined, branch: typeof record?.f?.branch?.[0] === 'string' };
    });
    const overlay = read.inScope(RoadmapScopes.overlay(tree), (scope) => ({
      mark: scope.repository(StepMark).find(new Id(step, StepMark), 'drawn'),
      pointer: scope.repository(StepPointer).find(new Id(step, StepPointer), 'drawn'),
      pointerHeld: scope.repository(StepPointer).record(step, 'drawn') !== undefined,
      moment: scope.moment,
    }));
    this.known = known.known;
    this.owns = known.branch;
    this.mark = overlay.mark ?? new StepMarkValue(new Id(step, StepMark));
    this.pointer = overlay.pointer;
    this.pointerHeld = overlay.pointerHeld;
    this.moment = overlay.moment;
    Object.freeze(this);
  }
}

// §5 Complete and Reset write the step's mark in the person's overlay. A step that owns a subtree, or whose
// pointer opens a standing roadmap, is complete exactly when that roadmap is, and takes no mark. Whether the
// pointer's roadmap stands is read from the account by the caller; a pointer that dangles leaves the mark its meaning.
export class MarkStep {
  /**
   * @param {string} tree
   * @param {string} step
   * @param {'complete' | 'none'} status
   * @param {boolean} outOfOrder
   * @param {boolean} opensStanding
   */
  constructor(tree, step, status, outOfOrder = false, opensStanding = false) {
    this.tree = tree;
    this.step = step;
    this.status = status;
    this.outOfOrder = status === 'complete' && outOfOrder;
    this.opensStanding = opensStanding;
    this.refusals = RoadmapRefusals;
    Object.freeze(this);
  }

  /** @param {ActReader} read */
  load(read) { return new StepOverlay(read, this.tree, this.step); }

  /** @param {StepOverlay} loaded */
  decide({ known, owns, mark, moment }) {
    if (!known) return gone(RoadmapStep.type, this.step);
    if (this.status === 'complete' && (owns || this.opensStanding)) throw new Violation(RoadmapChecks.opening, new Path('step'), { kind: 'custom', custom: 'opens' });
    if (mark.holds(this.status, this.outOfOrder)) return ActDecision.unchanged(null);
    const plan = new Plan();
    plan.create(new Valid(new StepMarkValue(mark.id, this.status, this.outOfOrder), moment), { fields: ['mark'] });
    plan.undoBy(restoring(Restore.overlay, mark.id, ['mark']));
    return writeIn(RoadmapScopes.overlay(this.tree), plan, null);
  }
}

// The roadmap a step opens, set or cleared.
export class PointStep {
  /**
   * @param {string} tree
   * @param {string} step
   * @param {string | null} opens
   */
  constructor(tree, step, opens) {
    this.tree = tree;
    this.step = step;
    this.opens = opens;
    this.refusals = RoadmapRefusals;
    Object.freeze(this);
  }

  /** @param {ActReader} read */
  load(read) { return new StepOverlay(read, this.tree, this.step); }

  /** @param {StepOverlay} loaded */
  decide({ known, pointer, pointerHeld, moment }) {
    if (!known) return gone(RoadmapStep.type, this.step);
    if ((pointer?.opens ?? null) === this.opens) return ActDecision.unchanged(null);
    const plan = new Plan();
    const id = new Id(this.step, StepPointer);
    if (this.opens === null) plan.remove(id);
    else plan.create(new Valid(new StepPointerValue(id, this.opens), moment), { fields: ['opens'] });
    plan.undoBy(pointerHeld ? restoring(Restore.overlay, id, this.opens === null ? [] : ['opens'], { life: true }) : UndoRecipe.createdRecord(Restore.overlay, id));
    return writeIn(RoadmapScopes.overlay(this.tree), plan, null);
  }
}

/** @param {string} tree @param {string} step @param {{ outOfOrder?: boolean, opensStanding?: boolean }} [word] */
export function Complete(tree, step, { outOfOrder = false, opensStanding = false } = {}) { return new MarkStep(tree, step, 'complete', outOfOrder, opensStanding); }

/** @param {string} tree @param {string} step */
export function Reset(tree, step) { return new MarkStep(tree, step, 'none'); }

/** @param {string} tree @param {string} step @param {string} opens */
export function SetPointer(tree, step, opens) { return new PointStep(tree, step, opens); }

/** @param {string} tree @param {string} step */
export function ClearPointer(tree, step) { return new PointStep(tree, step, null); }
