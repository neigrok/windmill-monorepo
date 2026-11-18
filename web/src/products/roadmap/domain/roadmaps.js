// @ts-check

import { ActDecision, ActPlan, ScopedPlan } from '../../../platform/domain-kit/acts.js';
import { EntityType, Id } from '../../../platform/domain-kit/entities.js';
import { Plan } from '../../../platform/domain-kit/plans.js';
import { Refused } from '../../../platform/domain-kit/refusals.js';
import { Check, Valid } from '../../../platform/domain-kit/validation.js';
import { Path } from '../../../platform/domain-kit/values.js';
import { RoadmapTree } from './records.js';
import { RoadmapKind, RoadmapKindValue } from './kinds.js';
import { GENESIS_KINDS, RoadmapRefusals, RoadmapScopes, RoadmapSpecs, writeIn } from './roadmapRules.js';
import { StepsImport } from './steps.js';

/** @typedef {{ tree: string, step: string }} RoadmapParent */

// A roadmap in the person's list: the `tree` record that governs its scope. The client writes its birth
// and its death; its place under a step is the server's.
export class RoadmapValue {
  /**
   * @param {Id<RoadmapValue>} id
   * @param {RoadmapParent | null} parent
   */
  constructor(id, parent = null) {
    this.id = id;
    this.parent = parent;
    Object.freeze(this);
  }

  fields() { return {}; }
}

/** @type {EntityType<RoadmapValue, string>} */
export const Roadmap = new EntityType({
  type: 'tree', scope: RoadmapScopes.account, heldRemoval: true, checks: [],
  decode: (f) => {
    const parent = f.json('parent');
    const placed = parent !== null && typeof parent === 'object' && !Array.isArray(parent)
      && typeof parent.tree === 'string' && typeof parent.step === 'string';
    return new RoadmapValue(new Id(f.id, Roadmap), placed ? { tree: String(parent.tree), step: String(parent.step) } : null);
  },
});

// A roadmap's own words, the singleton of its tree scope. Its place, visibility and reach are the server's.
export class RoadmapMetaValue {
  /**
   * @param {Id<RoadmapMetaValue>} id
   * @param {{ title?: string, guide?: string, root?: string | null, depth?: number }} values
   */
  constructor(id, { title = '', guide = '', root = null, depth = 0 } = {}) {
    this.id = id;
    this.title = title;
    this.guide = guide;
    this.root = root;
    this.depth = depth;
    Object.freeze(this);
  }

  /** @param {{ title?: string, guide?: string }} changes */
  with(changes) {
    return new RoadmapMetaValue(this.id, { title: this.title, guide: this.guide, root: this.root, depth: this.depth, ...changes });
  }

  fields() { return { title: this.title, guide: this.guide }; }

  static blank() { return new RoadmapMetaValue(new Id('meta', RoadmapMeta)); }
}

/** @type {EntityType<RoadmapMetaValue, null>} */
export const RoadmapMeta = new EntityType({
  type: 'meta', scope: null,
  decode: (f) => new RoadmapMetaValue(new Id(f.id, RoadmapMeta), {
    title: f.string('title', ''), guide: f.string('guide', ''), root: f.optionalString('root'), depth: f.optionalInt('depth') ?? 0,
  }),
  checks: [
    new Check('title', (value) => value.with({ title: RoadmapSpecs.title.apply(value.title, new Path('title')) })),
    new Check('guide', (value) => value.with({ guide: RoadmapSpecs.guide.apply(value.guide, new Path('guide')) })),
  ],
});

// §5 Create a roadmap: the `tree` record, then its tree scope with the title, the genesis kinds and the first
// steps, in chunks when the steps are many. The engine drops the tree's intents when the record is refused.
export class CreateRoadmap {
  /**
   * @param {string} title
   * @param {import('./steps.js').ImportedSteps} steps
   */
  constructor(title, steps = { steps: [], links: [] }) {
    this.title = title;
    this.steps = steps;
    this.refusals = RoadmapRefusals;
    Object.freeze(this);
  }

  /** @param {import('../../../platform/domain-kit/acts.js').ActReader} read */
  load(read) {
    read.inScope(RoadmapScopes.account, () => null);
    return { moment: read.moment };
  }

  /**
   * @param {ReturnType<CreateRoadmap['load']>} loaded
   * @param {import('../../../platform/domain-kit/acts.js').ActIDSource} ids
   */
  decide({ moment }, ids) {
    const meta = new Valid(RoadmapMetaValue.blank().with({ title: this.title }), moment, ['title']);
    const id = ids.mint(Roadmap, RoadmapScopes.account);
    const scope = RoadmapScopes.tree(String(id.record));
    const genesis = GENESIS_KINDS.map((kind, index) => new Valid(new RoadmapKindValue(new Id(kind.id, RoadmapKind),
      { hue: kind.hue, label: kind.label, description: kind.description, ord: `a${index}` }), moment));
    const imported = new StepsImport(this.steps, new RoadmapTree({ id: String(id.record) }), null).planned(moment, ids, scope);
    const account = new Plan();
    account.create(new Valid(new RoadmapValue(id), moment));
    const opening = new Plan();
    opening.create(meta, { fields: ['title'] });
    for (const kind of genesis) opening.create(kind);
    const chunks = imported.chunks(1 + genesis.length);
    for (const unit of chunks[0] ?? []) unit.writeTo(opening);
    const later = chunks.slice(1).map((chunk) => {
      const plan = new Plan();
      for (const unit of chunk) unit.writeTo(plan);
      return new ScopedPlan(scope, plan);
    });
    return ActDecision.write(new ActPlan([new ScopedPlan(RoadmapScopes.account, account), new ScopedPlan(scope, opening), ...later]),
      { tree: id.record, steps: imported.ids });
  }
}

// §5 Delete a roadmap: held nine seconds, and permanent once the hold ends (R-7). A subtree goes with the step
// that owns it, so only a root's record is deleted here.
export class DeleteRoadmap {
  /** @param {string} tree */
  constructor(tree) {
    this.id = new Id(tree, Roadmap);
    this.refusals = RoadmapRefusals;
    Object.freeze(this);
  }

  /** @param {import('../../../platform/domain-kit/acts.js').ActReader} read */
  load(read) {
    return read.inScope(RoadmapScopes.account, (account) => account.repository(Roadmap).find(this.id, 'drawn'));
  }

  /** @param {RoadmapValue | null} roadmap */
  decide(roadmap) {
    if (roadmap === null) return ActDecision.unchanged(null);
    if (roadmap.parent !== null) return ActDecision.refuse(RoadmapRefusals.ofRefused(new Refused('not-a-root', this.id.ref, null, 'predicted')));
    const plan = new Plan();
    plan.remove(this.id);
    return writeIn(RoadmapScopes.account, plan, null);
  }
}

// A roadmap's title or guide, written in its tree scope.
export class WriteRoadmap {
  /**
   * @param {string} tree
   * @param {{ title?: string, guide?: string }} changes
   */
  constructor(tree, changes) {
    this.scope = RoadmapScopes.tree(tree);
    this.changes = changes;
    this.refusals = RoadmapRefusals;
    Object.freeze(this);
  }

  /** @param {import('../../../platform/domain-kit/acts.js').ActReader} read */
  load(read) {
    return read.inScope(this.scope, (tree) => ({
      meta: tree.repository(RoadmapMeta).find(new Id('meta', RoadmapMeta), 'drawn') ?? RoadmapMetaValue.blank(),
      moment: tree.moment,
    }));
  }

  /** @param {ReturnType<WriteRoadmap['load']>} loaded */
  decide({ meta, moment }) {
    const valid = new Valid(meta.with(this.changes), moment, Object.keys(this.changes));
    const before = /** @type {Record<string, string>} */ (meta.fields());
    const changed = valid.checked.filter((name) => valid.written[name] !== before[name]);
    if (changed.length === 0) return ActDecision.unchanged(null);
    const plan = new Plan();
    plan.update(valid, { fields: changed });
    return writeIn(this.scope, plan, null);
  }
}
