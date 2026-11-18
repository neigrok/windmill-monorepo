// @ts-check

import { ActDecision } from '../../../platform/domain-kit/acts.js';
import { EntityType, Fields, Id, compareText, sameJson } from '../../../platform/domain-kit/entities.js';
import { Plan, Prediction } from '../../../platform/domain-kit/plans.js';
import { Refused } from '../../../platform/domain-kit/refusals.js';
import { Check, Valid } from '../../../platform/domain-kit/validation.js';
import { Path, Violation } from '../../../platform/domain-kit/values.js';
import { between, dropKey, isOrderKey } from '../../../../../packages/api-contract/sync/reference/core/fracindex.js';
import { RoadmapChecks, RoadmapRefusals, RoadmapScopes, RoadmapSpecs, writeIn } from './roadmapRules.js';
import { RoadmapStep } from './steps.js';

/** @typedef {import('../../../platform/domain-kit/reading.js').Reader} Reader */
/** @typedef {import('../../../platform/domain-kit/acts.js').ActReader} ActReader */
/** @typedef {import('../../../platform/domain-kit/acts.js').ActIDSource} ActIDSource */
/** @typedef {{ label?: string, description?: string }} KindWords */

// A kind of the roadmap's legend: a hue, its words, and its place among the roadmap's kinds.
export class RoadmapKindValue {
  /**
   * @param {Id<RoadmapKindValue>} id
   * @param {KindWords & { hue?: string, ord?: string | null }} values
   */
  constructor(id, { hue = 'terracotta', label = '', description = '', ord = null } = {}) {
    this.id = id;
    this.hue = hue;
    this.label = label;
    this.description = description;
    this.ord = ord;
    Object.freeze(this);
  }

  /** @param {KindWords & { hue?: string, ord?: string | null }} changes */
  with(changes) {
    return new RoadmapKindValue(this.id, { hue: this.hue, label: this.label, description: this.description, ord: this.ord, ...changes });
  }

  fields() { return { hue: this.hue, label: this.label, description: this.description, ord: this.ord }; }
}

/** @type {EntityType<RoadmapKindValue, null>} */
export const RoadmapKind = new EntityType({
  type: 'kind', scope: null, heldRemoval: false,
  decode: (f) => new RoadmapKindValue(new Id(f.id, RoadmapKind), {
    hue: f.string('hue', 'terracotta'), label: f.string('label', ''), description: f.string('description', ''), ord: f.optionalString('ord'),
  }),
  checks: [
    new Check('hue', (kind) => kind.with({ hue: RoadmapSpecs.hue.apply(kind.hue, new Path('hue')) })),
    new Check('label', (kind) => kind.with({ label: RoadmapSpecs.kindLabel.apply(kind.label, new Path('label')) })),
    new Check('description', (kind) => kind.with({ description: RoadmapSpecs.kindDescription.apply(kind.description, new Path('description')) })),
  ],
});

// The roadmap's kinds as one reader holds them: the record of each, present or not, and the present ones.
/**
 * @param {Reader} read
 * @param {string | null} id
 */
function readKinds(read, id) {
  const kinds = read.repository(RoadmapKind);
  const record = id === null ? undefined : kinds.record(id, 'drawn');
  return {
    kind: record === undefined ? null : RoadmapKind.decode(Fields.record(record)),
    absent: record?.life?.[0] !== 'alive',
    present: kinds.all('drawn'),
    capacity: kinds.capacity(),
    moment: read.moment,
  };
}

/** @typedef {ReturnType<typeof readKinds>} LoadedKinds */

/** @param {string} id */
function gone(id) {
  return ActDecision.refuse(RoadmapRefusals.ofRefused(new Refused('unknown-record', { t: RoadmapKind.type, id }, null, 'predicted')));
}

// A hue another present kind wears is refused where a kind is made or changed (§4).
/**
 * @param {LoadedKinds['present']} present
 * @param {string} hue
 * @param {string} own
 */
function wearing(present, hue, own) {
  if (present.some((other) => other.hue === hue && String(other.id.record) !== own)) {
    throw new Violation(RoadmapChecks.wornHue, new Path('hue'), { kind: 'custom', custom: 'worn' });
  }
}

export class CreateKind {
  /**
   * @param {string} tree
   * @param {KindWords & { hue: string }} kind
   */
  constructor(tree, kind) {
    this.tree = tree;
    this.kind = kind;
    this.refusals = RoadmapRefusals;
    Object.freeze(this);
  }

  /** @param {ActReader} read */
  load(read) { return read.inScope(RoadmapScopes.tree(this.tree), (tree) => readKinds(tree, null)); }

  /**
   * @param {LoadedKinds} loaded
   * @param {ActIDSource} ids
   */
  decide({ present, capacity, moment }, ids) {
    const scope = RoadmapScopes.tree(this.tree);
    const id = ids.mint(RoadmapKind, scope);
    const keys = present.flatMap((kind) => kind.ord !== null && isOrderKey(kind.ord) ? [kind.ord] : []).sort(compareText);
    const valid = new Valid(new RoadmapKindValue(id, { ...this.kind, ord: between(keys.at(-1) ?? null, null) }), moment);
    wearing(present, valid.value.hue, String(id.record));
    const refused = capacity.refusal(1, id.ref);
    if (refused) return ActDecision.refuse(RoadmapRefusals.ofRefused(refused));
    const plan = new Plan();
    plan.create(valid);
    return writeIn(scope, plan, id.record);
  }
}

// §5 A change to a kind carries its life as alive, as a step's does.
/**
 * @param {string} tree
 * @param {RoadmapKindValue} kind
 * @param {Valid<RoadmapKindValue>} valid
 */
function revived(tree, kind, valid) {
  const before = kind.fields();
  const changed = valid.checked.filter((name) => !sameJson(before[/** @type {keyof typeof before} */ (name)], valid.written[name]));
  if (changed.length === 0) return ActDecision.unchanged(null);
  const plan = new Plan();
  plan.revive(valid, { fields: changed });
  return writeIn(RoadmapScopes.tree(tree), plan, null);
}

export class ChangeKind {
  /**
   * @param {string} tree
   * @param {string} kind
   * @param {KindWords} changes
   */
  constructor(tree, kind, changes) {
    this.tree = tree;
    this.kind = kind;
    this.changes = changes;
    this.refusals = RoadmapRefusals;
    Object.freeze(this);
  }

  /** @param {ActReader} read */
  load(read) { return read.inScope(RoadmapScopes.tree(this.tree), (tree) => readKinds(tree, this.kind)); }

  /** @param {LoadedKinds} loaded */
  decide({ kind, moment }) {
    if (kind === null) return gone(this.kind);
    return revived(this.tree, kind, new Valid(kind.with(this.changes), moment, Object.keys(this.changes)));
  }
}

export class MoveKind {
  /**
   * @param {string} tree
   * @param {string} kind
   * @param {string | null} below
   */
  constructor(tree, kind, below) {
    this.tree = tree;
    this.kind = kind;
    this.below = below;
    this.refusals = RoadmapRefusals;
    Object.freeze(this);
  }

  /** @param {ActReader} read */
  load(read) { return read.inScope(RoadmapScopes.tree(this.tree), (tree) => readKinds(tree, this.kind)); }

  /** @param {LoadedKinds} loaded */
  decide({ kind, present, moment }) {
    if (kind === null) return gone(this.kind);
    const members = present.filter((other) => String(other.id.record) !== this.kind && other.ord !== null && isOrderKey(other.ord))
      .map((other) => ({ id: String(other.id.record), key: /** @type {string} */ (other.ord) }))
      .sort((a, b) => compareText(a.key, b.key) || compareText(a.id, b.id));
    if (this.below !== null && !members.some((member) => member.id === this.below)) return gone(this.below);
    const own = kind.ord !== null && isOrderKey(kind.ord) ? kind.ord : null;
    const above = own === null ? undefined : members.filter((member) => member.key < own || (member.key === own && compareText(member.id, this.kind) < 0)).at(-1)?.id ?? null;
    if (above === this.below) return ActDecision.unchanged(null);
    const ord = dropKey({ stored: members, drawn: members, moved: this.kind, above: this.below });
    return revived(this.tree, kind, new Valid(kind.with({ ord }), moment, ['ord']));
  }
}

// §4 `roadmap.recolourKind`: the kind's hue and the colour of every step that wears it, present or not,
// predicted so the legend and the steps change at once. The server revives the kind and no step.
export class RecolourKind {
  /**
   * @param {string} tree
   * @param {string} kind
   * @param {string} hue
   */
  constructor(tree, kind, hue) {
    this.tree = tree;
    this.kind = kind;
    this.hue = hue;
    this.refusals = RoadmapRefusals;
    Object.freeze(this);
  }

  /** @param {ActReader} read */
  load(read) {
    return read.inScope(RoadmapScopes.tree(this.tree), (tree) => ({
      ...readKinds(tree, this.kind),
      steps: [...tree.views.drawn.values()].filter((record) => record.t === RoadmapStep.type)
        .map((record) => RoadmapStep.decode(Fields.record(record))),
    }));
  }

  /** @param {LoadedKinds & { steps: import('./steps.js').RoadmapStepValue[] }} loaded */
  decide({ kind, present, steps, moment }) {
    if (kind === null) return gone(this.kind);
    const hue = new Valid(kind.with({ hue: this.hue }), moment, ['hue']).value.hue;
    wearing(present, hue, this.kind);
    if (hue === kind.hue) return ActDecision.unchanged(null);
    const wearers = steps.filter((step) => step.color === kind.hue).sort((a, b) => Id.compare(a.id, b.id))
      .map((step) => Prediction.update(step.id, { color: hue }));
    const plan = Plan.running({ name: 'roadmap.recolourKind', specs: [RoadmapSpecs.recolourHue], args: { kind: kind.id.record, hue } },
      [Prediction.update(kind.id, { hue }), ...wearers]);
    return writeIn(RoadmapScopes.tree(this.tree), plan, null);
  }
}

export class DeleteKind {
  /**
   * @param {string} tree
   * @param {string} kind
   */
  constructor(tree, kind) {
    this.tree = tree;
    this.id = new Id(kind, RoadmapKind);
    this.refusals = RoadmapRefusals;
    Object.freeze(this);
  }

  /** @param {ActReader} read */
  load(read) { return read.inScope(RoadmapScopes.tree(this.tree), (tree) => tree.repository(RoadmapKind).find(this.id, 'drawn')); }

  /** @param {RoadmapKindValue | null} kind */
  decide(kind) {
    if (kind === null) return ActDecision.unchanged(null);
    const plan = new Plan();
    plan.remove(this.id);
    return writeIn(RoadmapScopes.tree(this.tree), plan, null);
  }
}
