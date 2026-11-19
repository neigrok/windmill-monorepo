// @ts-check

import { ActDecision, ActPlan, ScopedPlan } from '../../../platform/domain-kit/acts.js';
import { Fields, sameJson } from '../../../platform/domain-kit/entities.js';
import { Plan, UndoRecipe, UndoTarget } from '../../../platform/domain-kit/plans.js';
import { Refused } from '../../../platform/domain-kit/refusals.js';
import { ChoiceSpec, CountSpec, TextSpec } from '../../../platform/domain-kit/values.js';
import { CONSTANTS } from '../../../../../packages/api-contract/sync/reference/core/constants.js';

/** @typedef {import('../../../platform/domain-kit/values.js').Json} Json */
/** @typedef {import('../../../platform/domain-kit/values.js').Violation} Violation */
/** @typedef {import('../../../platform/domain-kit/entities.js').RecordRef} RecordRef */
/** @typedef {import('../../../platform/domain-kit/refusals.js').RefusalPath} RefusalPath */
/**
 * @typedef {{ kind: 'invalid', violation: Violation }
 * | { kind: 'gone' | 'taken' | 'tooLarge', subject: RecordRef, path: RefusalPath }
 * | { kind: 'full', type: string, cap: number, path: RefusalPath }
 * | { kind: 'roadmapGone' | 'unreachable' | 'notARoot' | 'stepOpensARoadmap' | 'depthLimit' | 'other', refused: Refused }} RoadmapRefusal
 */

export const HUES = Object.freeze(['terracotta', 'olive', 'gold', 'brick', 'sky', 'plum']);

export const RoadmapLimits = Object.freeze({
  importChunk: 500,
  importChunkBytes: CONSTANTS.PUSH_MAX_BYTES / 2,
  maxDepth: 8,
});

export const GENESIS_KINDS = Object.freeze([
  Object.freeze({ id: 'build', hue: 'terracotta', label: 'Build', description: 'Things you make' }),
  Object.freeze({ id: 'learn', hue: 'olive', label: 'Learn', description: 'Things you figure out' }),
  Object.freeze({ id: 'milestone', hue: 'gold', label: 'Milestone', description: 'Moments that matter' }),
]);

export const RoadmapScopes = Object.freeze({
  account: 'self/roadmap',
  /** @param {string} tree */
  tree: (tree) => `tree/${tree}`,
  /** @param {string} tree */
  overlay: (tree) => `self/overlay/${tree}`,
  /** @param {string} tree */
  landing: (tree) => `landing:${tree}`,
  /** @param {string} key */
  isLanding: (key) => key.startsWith('landing:'),
});

/** @param {string} path @param {number} max @param {{ min?: number, trim?: boolean }} [rule] */
function chars(path, max, { min = 0, trim = false } = {}) {
  return new TextSpec(path, { unit: 'chars', min, max, trim, nfc: false });
}

export const RoadmapSpecs = Object.freeze({
  title: chars('meta.title', 200),
  guide: chars('meta.guide', 5000),
  label: chars('node.label', 200),
  icon: chars('node.icon', 64),
  color: new ChoiceSpec('node.color', [...HUES]),
  description: chars('node.description', 16000),
  links: new CountSpec('node.links', { min: 0, max: 32 }),
  linkUrl: chars('node.links.url', 2048, { min: 1, trim: true }),
  linkLabel: chars('node.links.label', 200),
  hue: new ChoiceSpec('kind.hue', [...HUES]),
  recolourHue: new ChoiceSpec('roadmap.recolourKind.hue', [...HUES]),
  visibility: new ChoiceSpec('meta.visibility', ['private', 'unlisted', 'public']),
  kindLabel: chars('kind.label', 24),
  kindDescription: chars('kind.description', 80),
  mark: new ChoiceSpec('progress.mark.status', ['complete', 'none']),
  subtask: chars('subtask.label', 200, { min: 1, trim: true }),
  url: chars('stepLink.url', 2048, { min: 1, trim: true }),
  linkTitle: chars('stepLink.title', 200, { trim: true }),
  note: chars('stepNote.text', 16000),
});

export const RoadmapChecks = Object.freeze({
  cycle: 'edge.cycle',
  wornHue: 'kind.hue.worn',
  opening: 'progress.opening',
});

/** @type {import('../../../platform/domain-kit/refusals.js').Refusals<RoadmapRefusal>} */
export const RoadmapRefusals = Object.freeze({
  ofViolation: (violation) => Object.freeze({ kind: 'invalid', violation }),
  ofRefused: (refused) => {
    const { code, subject, path } = refused;
    if (subject !== null) {
      if (code === 'unknown-record' || code === 'record-dead') return Object.freeze({ kind: 'gone', subject, path });
      if (code === 'id-taken' || code === 'id-spent') return Object.freeze({ kind: 'taken', subject, path });
      if (code === 'too-large') return Object.freeze({ kind: 'tooLarge', subject, path });
    }
    if (refused.cap !== null) return Object.freeze({ kind: 'full', ...refused.cap, path });
    switch (code) {
      case 'scope-dead': return Object.freeze({ kind: 'roadmapGone', refused });
      case 'forbidden':
      case 'not-found': return Object.freeze({ kind: 'unreachable', refused });
      case 'not-a-root': return Object.freeze({ kind: 'notARoot', refused });
      case 'step-opens-a-tree': return Object.freeze({ kind: 'stepOpensARoadmap', refused });
      case 'depth-limit': return Object.freeze({ kind: 'depthLimit', refused });
      default: return Object.freeze({ kind: 'other', refused });
    }
  },
  isGeneric: (refusal) => refusal.kind === 'other',
});

/**
 * @param {RoadmapRefusal} refusal
 * @returns {Json}
 */
export function refusalForm(refusal) {
  if (refusal.kind === 'invalid') return { invalid: refusal.violation.json };
  if (refusal.kind === 'full') return { full: { type: refusal.type, cap: refusal.cap, path: refusal.path } };
  if ('subject' in refusal) return { [refusal.kind]: { subject: refusal.subject, path: refusal.path } };
  const { code, subject, detail, path } = refusal.refused;
  return { [refusal.kind]: { code, subject, detail, path } };
}

// An act that writes one scope.
/**
 * @template T
 * @param {string} scope
 * @param {import('../../../platform/domain-kit/plans.js').Plan} plan
 * @param {T} result
 */
export function writeIn(scope, plan, result) {
  return ActDecision.write(new ActPlan([new ScopedPlan(scope, plan)]), result);
}

// A record the act names that the roadmap never held, or no longer draws where it must: refused before anything
// is written, as the kit's gone check refuses.
/**
 * @param {string} type
 * @param {import('../../../platform/domain-kit/entities.js').RecordID} id
 */
export function gone(type, id) {
  return ActDecision.refuse(RoadmapRefusals.ofRefused(new Refused('unknown-record', { t: type, id }, null, 'predicted')));
}

// The growth rule (§7.3) heard where the gesture is made: a cap another device has not yet filled refuses here.
/**
 * @param {import('../../../platform/domain-kit/reading.js').Capacity} capacity
 * @param {number} growth
 * @param {import('../../../platform/domain-kit/entities.js').RecordRef | null} subject
 */
export function full(capacity, growth, subject) {
  const refused = capacity.refusal(growth, subject);
  return refused === null ? null : ActDecision.refuse(RoadmapRefusals.ofRefused(refused));
}

// K-3: each scope kind's restore command, and the value equivalent to unset of each client field a restore may
// write back, as the registry declares it. `ord` has none: every create writes it.
export const Restore = Object.freeze({ tree: 'roadmap.restoreTree', overlay: 'roadmap.restoreOverlay' });

export const UNSET = Object.freeze({
  meta: Object.freeze({ title: '', guide: '', visibility: 'private' }),
  node: Object.freeze({ label: '', icon: '', color: 'terracotta', description: '', links: Object.freeze([]) }),
  kind: Object.freeze({ hue: 'terracotta', label: '', description: '' }),
  progress: Object.freeze({ mark: Object.freeze({ status: 'none', outOfOrder: false }) }),
  subtask: Object.freeze({ label: '', done: false }),
  stepLink: Object.freeze({ title: '' }),
});

// An Undo that writes back the named fields of one record, and its life where `life` says so, each from its value
// before the act, or the value equivalent to unset.
/**
 * @param {string} command
 * @param {import('../../../platform/domain-kit/entities.js').Id<any>} id
 * @param {readonly string[]} names
 * @param {{ life?: boolean, scope?: string | null }} [options]
 */
export function restoring(command, id, names, { life = false, scope = null } = {}) {
  const unset = /** @type {Record<string, Record<string, import('../../../platform/domain-kit/values.js').Json>>} */ (/** @type {unknown} */ (UNSET))[id.entity.type] ?? {};
  const fields = names.map((name) => Object.hasOwn(unset, name)
    ? { target: UndoTarget.field(id, name, scope), defaultValue: /** @type {import('../../../platform/domain-kit/values.js').Json} */ (unset[name]) }
    : UndoTarget.field(id, name, scope));
  return UndoRecipe.fields(command, [...fields, ...(life ? [UndoTarget.life(id, scope)] : [])]);
}

// What this device holds of one step or kind (§5): the record it draws, present or deleted; where another device's
// delete left it no row, only the record's spent id (engine §7.5), so that it knows the record was and nothing of its
// values; or nothing, for a record it never knew. A change carries the record's life, so a record the device knows
// comes back with it, and one it never knew is gone. `value` is the record's values, or a blank where it holds none.
/** @template {{ id: import('../../../platform/domain-kit/entities.js').Id<any>, fields(): Record<string, Json> }} E */
export class HeldRecord {
  /**
   * @template {{ id: import('../../../platform/domain-kit/entities.js').Id<any>, fields(): Record<string, Json> }} T
   * @param {import('../../../platform/domain-kit/reading.js').Repository<T>} repository
   * @param {import('../../../platform/domain-kit/entities.js').Id<T>} id
   * @returns {HeldRecord<T>}
   */
  static read(repository, id) {
    const record = repository.record(id.record, 'drawn');
    if (record !== undefined) return new HeldRecord(repository.type.decode(Fields.record(record)), record.life?.[0] === 'alive' ? 'present' : 'deleted');
    const blank = repository.type.decode(Fields.values(repository.type.type, id.record, {}));
    return new HeldRecord(blank, repository.spentBorn(id) === null ? 'unknown' : 'spent');
  }

  /**
   * @param {E} value
   * @param {'present' | 'deleted' | 'spent' | 'unknown'} state
   */
  constructor(value, state) {
    this.value = value;
    this.state = state;
    Object.freeze(this);
  }

  get id() { return this.value.id; }
  get known() { return this.state !== 'unknown'; }
  get absent() { return this.state === 'deleted' || this.state === 'spent'; }
  get holdsValues() { return this.state === 'present' || this.state === 'deleted'; }

  // The fields a change writes: each it names whose value differs from the record's, or each it names where the
  // device holds no values to compare.
  /** @param {import('../../../platform/domain-kit/validation.js').Valid<E>} valid */
  changed(valid) {
    if (!this.holdsValues) return [...valid.checked];
    const before = this.value.fields();
    return valid.checked.filter((name) => !sameJson(before[name], valid.written[name]));
  }

  // The revival a change plans: the record's life under the gesture's stamp and the fields it writes, and its Undo,
  // which writes each field back to the value it held and the life where the change brought the record back. A record
  // known only by its spent id was dead and its values are the server's alone, so its Undo deletes it again and keeps
  // what the change wrote. A record that held no `ord` has none to write back: every create writes it.
  /**
   * @param {import('../../../platform/domain-kit/validation.js').Valid<E>} valid
   * @param {readonly string[]} fields
   */
  reviving(valid, fields) {
    const plan = new Plan();
    plan.revive(valid, { fields: [...fields] });
    if (!this.holdsValues) {
      plan.undoBy(UndoRecipe.fields(Restore.tree, [{ target: UndoTarget.life(this.id), defaultValue: 'dead' }]));
      return plan;
    }
    const before = this.value.fields();
    const restorable = fields.filter((name) => name !== 'ord' || before.ord !== null);
    if (restorable.length || this.absent) plan.undoBy(restoring(Restore.tree, this.id, restorable, { life: this.absent }));
    return plan;
  }
}
