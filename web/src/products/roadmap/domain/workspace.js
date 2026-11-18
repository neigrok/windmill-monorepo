// @ts-check

import { ActDecision } from '../../../platform/domain-kit/acts.js';
import { SaveDraft } from '../../../platform/domain-kit/drafts.js';
import { EntityType, Id, sameJson } from '../../../platform/domain-kit/entities.js';
import { Plan, UndoRecipe } from '../../../platform/domain-kit/plans.js';
import { Placement } from '../../../platform/domain-kit/reading.js';
import { Check, Valid } from '../../../platform/domain-kit/validation.js';
import { Path } from '../../../platform/domain-kit/values.js';
import { Restore, RoadmapRefusals, RoadmapScopes, RoadmapSpecs, full, gone, restoring, writeIn } from './roadmapRules.js';
import { RoadmapStep } from './steps.js';

/** @typedef {import('../../../platform/domain-kit/acts.js').ActReader} ActReader */
/** @typedef {import('../../../platform/domain-kit/acts.js').ActIDSource} ActIDSource */
/** @typedef {SubtaskValue | StepLinkValue} WorkspaceItem */

// A step's private workspace, in its owner's overlay (R-3): its subtasks, its links and its note. Subtasks and
// links keep their order in the overlay's one list of their type, which keeps each step's items in order.
export class SubtaskValue {
  /**
   * @param {Id<SubtaskValue>} id
   * @param {string} step
   * @param {{ label?: string, done?: boolean }} values
   */
  constructor(id, step, { label = '', done = false } = {}) {
    this.id = id;
    this.step = step;
    this.label = label;
    this.done = done;
    Object.freeze(this);
  }

  /** @param {{ label?: string, done?: boolean }} changes */
  with(changes) { return new SubtaskValue(this.id, this.step, { label: this.label, done: this.done, ...changes }); }

  fields() { return { step: this.step, label: this.label, done: this.done }; }
}

/** @type {EntityType<SubtaskValue, null>} */
export const Subtask = new EntityType({
  type: 'subtask', scope: null, orderField: 'ord', heldRemoval: true,
  decode: (f) => new SubtaskValue(new Id(f.id, Subtask), f.string('step', ''), { label: f.string('label', ''), done: f.bool('done', false) }),
  checks: [new Check('label', (subtask) => subtask.with({ label: RoadmapSpecs.subtask.apply(subtask.label, new Path('label')) }))],
});

export class StepLinkValue {
  /**
   * @param {Id<StepLinkValue>} id
   * @param {string} step
   * @param {{ url?: string, title?: string }} values
   */
  constructor(id, step, { url = '', title = '' } = {}) {
    this.id = id;
    this.step = step;
    this.url = url;
    this.title = title;
    Object.freeze(this);
  }

  /** @param {{ url?: string, title?: string }} changes */
  with(changes) { return new StepLinkValue(this.id, this.step, { url: this.url, title: this.title, ...changes }); }

  fields() { return { step: this.step, url: this.url, title: this.title }; }
}

/** @type {EntityType<StepLinkValue, null>} */
export const StepLink = new EntityType({
  type: 'stepLink', scope: null, orderField: 'ord', heldRemoval: true,
  decode: (f) => new StepLinkValue(new Id(f.id, StepLink), f.string('step', ''), { url: f.string('url', ''), title: f.string('title', '') }),
  checks: [
    new Check('url', (link) => link.with({ url: RoadmapSpecs.url.apply(link.url, new Path('url')) })),
    new Check('title', (link) => link.with({ title: RoadmapSpecs.linkTitle.apply(link.title, new Path('title')) })),
  ],
});

export class StepNoteValue {
  /**
   * @param {Id<StepNoteValue>} id
   * @param {string} text
   */
  constructor(id, text = '') {
    this.id = id;
    this.text = text;
    Object.freeze(this);
  }

  fields() { return { text: this.text }; }
}

/** @type {EntityType<StepNoteValue, null>} */
export const StepNote = new EntityType({
  type: 'stepNote', scope: null, savesGuarded: false,
  decode: (f) => new StepNoteValue(new Id(f.id, StepNote), f.text('text')),
  checks: [new Check('text', (note) => new StepNoteValue(note.id, RoadmapSpecs.note.apply(note.text, new Path('text'))))],
});

// A step's note is edited in one draft and saved by the kit's draft save, its text merged by the engine.
/** @param {import('../../../platform/domain-kit/drafts.js').Draft<StepNoteValue>} draft */
export function SaveStepNote(draft) { return SaveDraft.ofDraft(draft, RoadmapRefusals); }

// A new subtask or link, at the bottom of its step's list. Its step must be one the roadmap knows, present or
// deleted elsewhere.
export class AddToWorkspace {
  /**
   * @param {EntityType<any, null>} type
   * @param {string} tree
   * @param {string} step
   * @param {(id: Id<any>) => WorkspaceItem} item
   */
  constructor(type, tree, step, item) {
    this.type = type;
    this.tree = tree;
    this.step = step;
    this.item = item;
    this.refusals = RoadmapRefusals;
    Object.freeze(this);
  }

  /** @param {ActReader} read */
  load(read) {
    const known = read.inScope(RoadmapScopes.tree(this.tree), (tree) => tree.repository(RoadmapStep).record(this.step, 'drawn') !== undefined);
    return read.inScope(RoadmapScopes.overlay(this.tree), (overlay) => {
      const items = overlay.repository(this.type);
      return { known, anchor: items.anchor(Placement.bottom), capacity: items.capacity(), moment: overlay.moment };
    });
  }

  /**
   * @param {{ known: boolean, anchor: import('../../../platform/domain-kit/entities.js').RecordID | null,
   *   capacity: import('../../../platform/domain-kit/reading.js').Capacity, moment: import('../../../platform/domain-kit/time.js').Moment }} loaded
   * @param {ActIDSource} ids
   */
  decide({ known, anchor, capacity, moment }, ids) {
    if (!known) return gone(RoadmapStep.type, this.step);
    const scope = RoadmapScopes.overlay(this.tree);
    const valid = new Valid(this.item(ids.mint(this.type, scope)), moment);
    const refused = full(capacity, 1, valid.id.ref);
    if (refused) return refused;
    const plan = new Plan();
    plan.insert(valid, anchor);
    plan.undoBy(UndoRecipe.createdRecord(Restore.overlay, valid.id));
    return writeIn(scope, plan, valid.id.record);
  }
}

/** @param {string} tree @param {string} step @param {string} label */
export function AddSubtask(tree, step, label) {
  return new AddToWorkspace(Subtask, tree, step, (id) => new SubtaskValue(id, step, { label }));
}

/** @param {string} tree @param {string} step @param {{ url: string, title?: string }} link */
export function AddStepLink(tree, step, link) {
  return new AddToWorkspace(StepLink, tree, step, (id) => new StepLinkValue(id, step, link));
}

// One workspace item as the overlay draws it, and its step's items in their order.
/**
 * @param {ActReader} read
 * @param {string} tree
 * @param {EntityType<any, null>} type
 * @param {string} id
 */
function readItem(read, tree, type, id) {
  return read.inScope(RoadmapScopes.overlay(tree), (overlay) => {
    const items = overlay.repository(type);
    /** @type {WorkspaceItem | null} */
    const item = items.find(new Id(id, type), 'drawn');
    return { item, siblings: item === null ? [] : items.children(new Id(item.step, RoadmapStep), 'step', 'drawn'), moment: overlay.moment };
  });
}

export class ChangeInWorkspace {
  /**
   * @param {EntityType<any, null>} type
   * @param {string} tree
   * @param {string} id
   * @param {{ label?: string, done?: boolean } | { url?: string, title?: string }} changes
   */
  constructor(type, tree, id, changes) {
    this.type = type;
    this.tree = tree;
    this.id = id;
    this.changes = changes;
    this.refusals = RoadmapRefusals;
    Object.freeze(this);
  }

  /** @param {ActReader} read */
  load(read) { return readItem(read, this.tree, this.type, this.id); }

  /** @param {ReturnType<typeof readItem>} loaded */
  decide({ item, moment }) {
    if (item === null) return gone(this.type.type, this.id);
    const valid = new Valid(/** @type {any} */ (item).with(this.changes), moment, Object.keys(this.changes));
    const before = /** @type {Record<string, import('../../../platform/domain-kit/values.js').Json>} */ (item.fields());
    const changed = valid.checked.filter((name) => !sameJson(before[name], valid.written[name]));
    if (changed.length === 0) return ActDecision.unchanged(null);
    const plan = new Plan();
    plan.update(valid, { fields: changed });
    plan.undoBy(restoring(Restore.overlay, item.id, changed));
    return writeIn(RoadmapScopes.overlay(this.tree), plan, null);
  }
}

// A drop in place among its step's items writes nothing; otherwise the item lands below another of its step's.
export class MoveInWorkspace {
  /**
   * @param {EntityType<any, null>} type
   * @param {string} tree
   * @param {string} id
   * @param {string | null} below
   */
  constructor(type, tree, id, below) {
    this.type = type;
    this.tree = tree;
    this.id = id;
    this.below = below;
    this.refusals = RoadmapRefusals;
    Object.freeze(this);
  }

  /** @param {ActReader} read */
  load(read) { return readItem(read, this.tree, this.type, this.id); }

  /** @param {ReturnType<typeof readItem>} loaded */
  decide({ item, siblings }) {
    if (item === null) return gone(this.type.type, this.id);
    const ids = siblings.map((sibling) => String(sibling.id.record));
    if (this.below !== null && !ids.includes(this.below)) return gone(this.type.type, this.below);
    const above = ids[ids.indexOf(this.id) - 1] ?? null;
    if (this.below === this.id || this.below === above) return ActDecision.unchanged(null);
    const plan = new Plan();
    plan.move(item.id, this.below === null ? null : new Id(this.below, this.type));
    plan.undoBy(restoring(Restore.overlay, item.id, ['ord']));
    return writeIn(RoadmapScopes.overlay(this.tree), plan, null);
  }
}

export class RemoveFromWorkspace {
  /**
   * @param {EntityType<any, null>} type
   * @param {string} tree
   * @param {string} id
   */
  constructor(type, tree, id) {
    this.type = type;
    this.tree = tree;
    this.id = id;
    this.refusals = RoadmapRefusals;
    Object.freeze(this);
  }

  /** @param {ActReader} read */
  load(read) { return readItem(read, this.tree, this.type, this.id); }

  /** @param {ReturnType<typeof readItem>} loaded */
  decide({ item }) {
    if (item === null) return ActDecision.unchanged(null);
    const plan = new Plan();
    plan.remove(item.id);
    return writeIn(RoadmapScopes.overlay(this.tree), plan, null);
  }
}

/** @param {string} tree @param {string} subtask @param {{ label?: string, done?: boolean }} changes */
export function ChangeSubtask(tree, subtask, changes) { return new ChangeInWorkspace(Subtask, tree, subtask, changes); }

/** @param {string} tree @param {string} subtask @param {string | null} below */
export function MoveSubtask(tree, subtask, below) { return new MoveInWorkspace(Subtask, tree, subtask, below); }

/** @param {string} tree @param {string} subtask */
export function DeleteSubtask(tree, subtask) { return new RemoveFromWorkspace(Subtask, tree, subtask); }

/** @param {string} tree @param {string} link @param {{ url?: string, title?: string }} changes */
export function ChangeStepLink(tree, link, changes) { return new ChangeInWorkspace(StepLink, tree, link, changes); }

/** @param {string} tree @param {string} link @param {string | null} below */
export function MoveStepLink(tree, link, below) { return new MoveInWorkspace(StepLink, tree, link, below); }

/** @param {string} tree @param {string} link */
export function DeleteStepLink(tree, link) { return new RemoveFromWorkspace(StepLink, tree, link); }
