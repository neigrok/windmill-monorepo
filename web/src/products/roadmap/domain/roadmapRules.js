// @ts-check

import { ActDecision, ActPlan, ScopedPlan } from '../../../platform/domain-kit/acts.js';
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
