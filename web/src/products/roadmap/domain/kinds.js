// @ts-check

import { ActDecision, ActPlan, ScopedPlan } from '../../../platform/domain-kit/acts.js';
import { EntityType, Fields, Id, compareText } from '../../../platform/domain-kit/entities.js';
import { Plan, Prediction, UndoRecipe, UndoTarget } from '../../../platform/domain-kit/plans.js';
import { Check, Valid } from '../../../platform/domain-kit/validation.js';
import { Path, Violation } from '../../../platform/domain-kit/values.js';
import { between, dropKey, isOrderKey } from '../../../../../packages/api-contract/sync/reference/core/fracindex.js';
import { HeldRecord, Restore, RoadmapChecks, RoadmapRefusals, RoadmapScopes, RoadmapSpecs, UNSET, full, gone, restoring, writeIn } from './roadmapRules.js';
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

// The roadmap's kinds as one reader holds them: what the device holds of the named kind (§5), and the present ones.
/**
 * @param {Reader} read
 * @param {string} id
 */
function readKinds(read, id) {
  const kinds = read.repository(RoadmapKind);
  return {
    held: HeldRecord.read(kinds, new Id(id, RoadmapKind)),
    present: kinds.all('drawn'),
    capacity: kinds.capacity(),
    moment: read.moment,
  };
}

/** @typedef {ReturnType<typeof readKinds>} LoadedKinds */

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
  load(read) {
    return read.inScope(RoadmapScopes.tree(this.tree), (tree) => {
      const kinds = tree.repository(RoadmapKind);
      return { present: kinds.all('drawn'), capacity: kinds.capacity(), moment: tree.moment };
    });
  }

  /**
   * @param {{ present: RoadmapKindValue[], capacity: import('../../../platform/domain-kit/reading.js').Capacity, moment: import('../../../platform/domain-kit/time.js').Moment }} loaded
   * @param {ActIDSource} ids
   */
  decide({ present, capacity, moment }, ids) {
    const scope = RoadmapScopes.tree(this.tree);
    const id = ids.mint(RoadmapKind, scope);
    const keys = present.flatMap((kind) => kind.ord !== null && isOrderKey(kind.ord) ? [kind.ord] : []).sort(compareText);
    const valid = new Valid(new RoadmapKindValue(id, { ...this.kind, ord: between(keys.at(-1) ?? null, null) }), moment);
    wearing(present, valid.value.hue, String(id.record));
    const refused = full(capacity, 1, id.ref);
    if (refused) return refused;
    const plan = new Plan();
    plan.create(valid);
    plan.undoBy(UndoRecipe.createdRecord(Restore.tree, id));
    return writeIn(scope, plan, id.record);
  }
}

// §5 A change to a kind carries its life as alive, as a step's does, whether the device still holds the kind or knows
// it only by its spent id.
/**
 * @param {string} tree
 * @param {HeldRecord<RoadmapKindValue>} held
 * @param {Valid<RoadmapKindValue>} valid
 */
function revived(tree, held, valid) {
  const changed = held.changed(valid);
  if (changed.length === 0) return ActDecision.unchanged(null);
  return writeIn(RoadmapScopes.tree(tree), held.reviving(valid, changed), null);
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
  decide({ held, moment }) {
    if (!held.known) return gone(RoadmapKind.type, this.kind);
    return revived(this.tree, held, new Valid(held.value.with(this.changes), moment, Object.keys(this.changes)));
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
  decide({ held, present, moment }) {
    if (!held.known) return gone(RoadmapKind.type, this.kind);
    const kind = held.value;
    const members = present.filter((other) => String(other.id.record) !== this.kind && other.ord !== null && isOrderKey(other.ord))
      .map((other) => ({ id: String(other.id.record), key: /** @type {string} */ (other.ord) }))
      .sort((a, b) => compareText(a.key, b.key) || compareText(a.id, b.id));
    if (this.below !== null && !members.some((member) => member.id === this.below)) return gone(RoadmapKind.type, this.below);
    const own = kind.ord !== null && isOrderKey(kind.ord) ? kind.ord : null;
    const above = own === null ? undefined : members.filter((member) => member.key < own || (member.key === own && compareText(member.id, this.kind) < 0)).at(-1)?.id ?? null;
    if (above === this.below) return ActDecision.unchanged(null);
    const ord = dropKey({ stored: members, drawn: members, moved: this.kind, above: this.below });
    return revived(this.tree, held, new Valid(kind.with({ ord }), moment, ['ord']));
  }
}

// §4 `roadmap.recolourKind`: the kind's hue and the colour of every step that wears it, present or not,
// predicted so the legend and the steps change at once. A kind this device holds as deleted, or knows only by its
// spent id, is revived first, as every change to a kind carries its life; the command revives no step. Of a kind known
// only by its spent id the device knows no hue, so it predicts the kind's new hue alone, the server recolours the
// steps that wore the old one, and an Undo deletes the kind again.
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
  decide({ held, present, steps, moment }) {
    if (!held.known) return gone(RoadmapKind.type, this.kind);
    const kind = held.value;
    const recoloured = new Valid(kind.with({ hue: this.hue }), moment, ['hue']);
    const hue = recoloured.value.hue;
    wearing(present, hue, this.kind);
    if (held.changed(recoloured).length === 0) return ActDecision.unchanged(null);
    const worn = held.holdsValues ? steps.filter((step) => step.color === kind.hue).sort((a, b) => Id.compare(a.id, b.id)) : [];
    const wearers = worn.map((step) => Prediction.update(step.id, { color: hue }));
    const scope = RoadmapScopes.tree(this.tree);
    const recolour = Plan.running({ name: 'roadmap.recolourKind', specs: [RoadmapSpecs.recolourHue], args: { kind: kind.id.record, hue } },
      [Prediction.update(kind.id, { hue }), ...wearers]);
    if (held.holdsValues) {
      recolour.undoBy(UndoRecipe.fields(Restore.tree, [
        { target: UndoTarget.field(kind.id, 'hue'), defaultValue: UNSET.kind.hue },
        ...worn.map((step) => ({ target: UndoTarget.field(step.id, 'color'), defaultValue: UNSET.node.color }))]));
    }
    const command = new ScopedPlan(scope, recolour);
    if (!held.absent) return ActDecision.write(new ActPlan([command]), null);
    const revival = held.reviving(new Valid(kind, moment, []), []);
    return ActDecision.write(new ActPlan([new ScopedPlan(scope, revival), command]), null);
  }
}

// What a kind's delete is undone by: the kind back on the hue it wore. Its Undo makes the kind again, so it is checked
// where it is asked as a kind made is (§4): refused while another present kind wears that hue. The device keeps no hue of
// a kind once its delete has reached it, so the delete hands it on.
export class KindRestore {
  /**
   * @param {string} tree
   * @param {string} kind
   * @param {string} hue
   */
  constructor(tree, kind, hue) {
    this.tree = tree;
    this.kind = kind;
    this.hue = hue;
    Object.freeze(this);
  }

  get scope() { return RoadmapScopes.tree(this.tree); }

  get json() { return { tree: this.tree, kind: this.kind, hue: this.hue }; }

  /** @param {Reader} read */
  check(read) { wearing(read.repository(RoadmapKind).all('drawn'), this.hue, this.kind); }
}

// A kind's death, which an Undo writes back. It answers the kind's restore, which that Undo is checked by.
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
    plan.undoBy(restoring(Restore.tree, this.id, [], { life: true }));
    return writeIn(RoadmapScopes.tree(this.tree), plan, new KindRestore(this.tree, String(this.id.record), kind.hue));
  }
}
