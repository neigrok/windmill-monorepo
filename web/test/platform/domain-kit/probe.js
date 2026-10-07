// @ts-check
// The probe declarations of packages/api-contract/domain-kit/README.md: test code over the probe
// registry, never kit content. Every probe entity holds its fields as one map of JSON values.

import { EntityType, Id } from '../../../src/platform/domain-kit/entities.js';
import { Check } from '../../../src/platform/domain-kit/validation.js';
import { ChoiceSpec, NumberSpec, Path, TextSpec, Violation } from '../../../src/platform/domain-kit/values.js';
import { LocalDay } from '../../../src/platform/domain-kit/time.js';
import { applySpec } from './vectors.js';

/** @typedef {import('../../../src/platform/domain-kit/values.js').Json} Json */
/** @typedef {import('../../../src/platform/domain-kit/values.js').ValueSpec} ValueSpec */
/** @typedef {import('../../../src/platform/domain-kit/refusals.js').Refused} Refused */

export const PROBE_SCOPE = 'self/probe';
export const PROBE_TREE = 'tree/b_00000001';
export const PROBE_OVERLAY = 'self/overlay/b_00000001';

export class ProbeEntity {
  /**
   * @param {Id<ProbeEntity>} id
   * @param {Record<string, Json>} values
   */
  constructor(id, values) {
    this.id = id;
    this.values = values;
    Object.freeze(this);
  }

  fields() {
    return { ...this.values };
  }
}

// An entity declaration whose decoder takes each declared field as the record holds it, or its default,
// and whose checks apply the README's specs to their fields in order.
/**
 * @param {{ type: string, scope: string, defaults: Record<string, Json>, specs: ValueSpec[], heldRemoval?: boolean,
 *   orderField?: string, savesGuarded?: boolean, timestampField?: string }} declaration
 * @returns {EntityType<ProbeEntity>}
 */
function probeType({ type, scope, defaults, specs, ...protocols }) {
  /** @type {Check<ProbeEntity>[]} */
  const checks = [];
  if (type === 'day') {
    checks.push(Check.key((entity, moment) => {
      const day = entity.id.day;
      if (day && LocalDay.compare(day, moment.today) > 0) throw new Violation('day.notFuture', new Path('id'), { kind: 'custom', custom: 'future' });
    }));
  }
  for (const spec of specs) {
    const field = /** @type {string} */ (spec.path.split('.').at(-1));
    checks.push(new Check(field, (entity) => new ProbeEntity(entity.id, { ...entity.values, [field]: applySpec(spec, entity.values[field] ?? null, new Path(field)) })));
  }
  /** @type {EntityType<ProbeEntity>} */
  const declared = new EntityType({
    type,
    scope,
    /** @returns {ProbeEntity} */
    decode: (f) => new ProbeEntity(new Id(f.id, declared), Object.fromEntries(Object.entries(defaults).map(([name, fallback]) => {
      if (type === 'mark' && name === 'memo') return [name, f.text(name)];
      const value = f.json(name);
      return [name, value === undefined ? fallback : value];
    }))),
    checks,
    ...protocols,
  });
  return declared;
}

const chars = (/** @type {string} */ path, /** @type {number} */ min, /** @type {number} */ max) => new TextSpec(path, { unit: 'chars', min, max, trim: true, nfc: true });

export const Probe = Object.freeze({
  card: probeType({ type: 'card', scope: PROBE_SCOPE, defaults: { title: '', body: '', size: null, claim: null, tier: 'draft' },
    specs: [chars('card.title', 1, 12), new TextSpec('card.body', { unit: 'bytes', min: 0, max: 24, trim: true, nfc: true }),
      new NumberSpec('card.size', { min: -500, max: 500, quantum: 0.01 }), chars('card.claim', 0, 12),
      new ChoiceSpec('card.tier', ['draft', 'review', 'done', 'dropped'])],
    savesGuarded: true, heldRemoval: true, orderField: 'ord' }),
  day: probeType({ type: 'day', scope: PROBE_SCOPE, defaults: { score: null }, specs: [new NumberSpec('day.score', { min: 0, max: 10, integer: true })],
    savesGuarded: false, heldRemoval: true }),
  fact: probeType({ type: 'fact', scope: PROBE_SCOPE, defaults: { value: null, at: null }, specs: [new NumberSpec('fact.value', { min: 0, max: 500, quantum: 0.1 })],
    savesGuarded: false, heldRemoval: true, timestampField: 'at' }),
  mark: probeType({ type: 'mark', scope: PROBE_OVERLAY, defaults: { done: null, memo: '' },
    specs: [new TextSpec('mark.memo', { unit: 'bytes', min: 0, max: 40, trim: false, nfc: false })], savesGuarded: false }),
  meta: probeType({ type: 'meta', scope: PROBE_TREE, defaults: { title: '' }, specs: [chars('meta.title', 0, 12)], savesGuarded: false }),
  lap: probeType({ type: 'lap', scope: PROBE_SCOPE, defaults: { runId: '', at: null, weight: null },
    specs: [new NumberSpec('lap.weight', { min: -500, max: 500, quantum: 0.01 })], heldRemoval: false }),
  run: probeType({ type: 'run', scope: PROBE_SCOPE, defaults: { startedAt: null, label: null }, specs: [chars('run.label', 0, 12)], heldRemoval: false }),
  link: probeType({ type: 'link', scope: PROBE_TREE, defaults: { strength: null }, specs: [new NumberSpec('link.strength', { min: 0, max: 9, integer: true })],
    heldRemoval: true }),
  tag: probeType({ type: 'tag', scope: PROBE_TREE, defaults: { label: '' }, specs: [] }),
});

/** @param {string} type */
export function probeEntity(type) {
  const found = Object.values(Probe).find((entity) => entity.type === type);
  if (!found) throw new Error(`no probe entity ${type}`);
  return found;
}

// A probe entity decoded from a record id and the fields a vector gives, the rest at their defaults.
/**
 * @param {EntityType<ProbeEntity>} type
 * @param {import('../../../src/platform/domain-kit/entities.js').RecordID} id
 * @param {Record<string, Json>} fields
 */
export function probeValue(type, id, fields = {}) {
  return type.decoding(new Id(id, type), fields);
}

// The probe commands: `probe.start` carries the one spec, at `probe.start.label`.
/**
 * @param {string} name
 * @param {Record<string, Json>} args
 * @returns {import('../../../src/platform/domain-kit/plans.js').ServerCommand}
 */
export function probeCommand(name, args) {
  return { name, args, specs: name === 'probe.start' ? [chars('probe.start.label', 0, 12)] : [] };
}

/** @typedef {{ kind: 'invalid', violation: Violation } | { kind: 'rejected', refused: Refused }} ProbeRefusal */

/** @type {import('../../../src/platform/domain-kit/refusals.js').Refusals<ProbeRefusal>} */
export const ProbeRefusals = Object.freeze({
  ofViolation: (violation) => ({ kind: 'invalid', violation }),
  ofRefused: (refused) => ({ kind: 'rejected', refused }),
  isGeneric: (refusal) => refusal.kind === 'rejected',
});

/**
 * @param {ProbeRefusal} refusal
 * @returns {Json}
 */
export function refusalForm(refusal) {
  if (refusal.kind === 'invalid') return { violation: refusal.violation.json };
  const { code, subject, detail, path } = refusal.refused;
  return { refused: { code, subject: subject === null ? null : { t: subject.t, id: subject.id }, detail, path } };
}
