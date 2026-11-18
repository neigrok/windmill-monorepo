// @ts-check

import { ActDecision, ActPlan, ScopedPlan } from '../../../platform/domain-kit/acts.js';
import { EntityType, Fields, Id, compareText } from '../../../platform/domain-kit/entities.js';
import { Plan, Prediction } from '../../../platform/domain-kit/plans.js';
import { Refused } from '../../../platform/domain-kit/refusals.js';
import { Check, Valid } from '../../../platform/domain-kit/validation.js';
import { Path } from '../../../platform/domain-kit/values.js';
import { RoadmapKind, RoadmapKindValue } from './kinds.js';
import { GENESIS_KINDS, RoadmapLimits, RoadmapRefusals, RoadmapScopes, RoadmapSpecs, gone, writeIn } from './roadmapRules.js';
import { RoadmapStep, StepsImport } from './steps.js';
import { StepPointer } from './progress.js';
import { LandingNote, RoadmapTree } from './records.js';

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
   * @param {{ title?: string, guide?: string, root?: string | null, depth?: number, visibility?: string, reach?: string }} values
   */
  constructor(id, { title = '', guide = '', root = null, depth = 0, visibility = 'private', reach = 'private' } = {}) {
    this.id = id;
    this.title = title;
    this.guide = guide;
    this.root = root;
    this.depth = depth;
    this.visibility = visibility;
    this.reach = reach;
    Object.freeze(this);
  }

  /** @param {{ title?: string, guide?: string }} changes */
  with(changes) {
    return new RoadmapMetaValue(this.id, { title: this.title, guide: this.guide, root: this.root, depth: this.depth,
      visibility: this.visibility, reach: this.reach, ...changes });
  }

  fields() { return { title: this.title, guide: this.guide }; }

  static blank() { return new RoadmapMetaValue(new Id('meta', RoadmapMeta)); }
}

/** @type {EntityType<RoadmapMetaValue, null>} */
export const RoadmapMeta = new EntityType({
  type: 'meta', scope: null,
  decode: (f) => new RoadmapMetaValue(new Id(f.id, RoadmapMeta), {
    title: f.string('title', ''), guide: f.string('guide', ''), root: f.optionalString('root'), depth: f.optionalInt('depth') ?? 0,
    visibility: f.string('visibility', 'private'), reach: f.string('reach', 'private'),
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

const META = new Id('meta', RoadmapMeta);

// The roadmaps of the account as the device holds them, and which steps that own a subtree are present: what a
// root's branch is, and which of its subtrees stand (D-3).
class Branches {
  /**
   * @param {import('../../../platform/domain-kit/acts.js').ActReader} read
   * @param {string} root
   */
  constructor(read, root) {
    const roadmaps = read.inScope(RoadmapScopes.account, (account) => account.repository(Roadmap).all('drawn'));
    this.roadmaps = new Map(roadmaps.map((roadmap) => [String(roadmap.id.record), roadmap]));
    this.root = root;
    const members = roadmaps.filter((roadmap) => this.under(roadmap));
    const parents = [...new Set(members.flatMap((roadmap) => roadmap.parent === null ? [] : [roadmap.parent.tree]))];
    /** @type {Set<string>} */
    this.present = new Set(parents.flatMap((tree) => read.inScope(RoadmapScopes.tree(tree), (scope) => members
      .filter((roadmap) => roadmap.parent?.tree === tree && scope.repository(RoadmapStep).find(new Id(roadmap.parent.step, RoadmapStep), 'drawn') !== null)
      .map((roadmap) => String(roadmap.id.record)))));
    this.members = members.map((roadmap) => String(roadmap.id.record));
    Object.freeze(this);
  }

  // A subtree whose places lead up to the root.
  /** @param {RoadmapValue} roadmap */
  under(roadmap) {
    const seen = new Set();
    let parent = roadmap.parent;
    while (parent !== null && !seen.has(parent.tree)) {
      if (parent.tree === this.root) return true;
      seen.add(parent.tree);
      parent = this.roadmaps.get(parent.tree)?.parent ?? null;
    }
    return false;
  }

  // The subtrees of the branch that stand: each step that owns one on the way down is present.
  standing() {
    /** @param {string} id @returns {boolean} */
    const stands = (id) => {
      const parent = this.roadmaps.get(id)?.parent ?? null;
      if (parent === null || !this.present.has(id)) return false;
      return parent.tree === this.root || stands(parent.tree);
    };
    return this.members.filter(stands).sort(compareText);
  }
}

// §4 `roadmap.setVisibility`: a root's visibility, predicted as its reach and the reach of every standing subtree of
// its branch. The binding takes the intent's stamp as the gesture's.
export class SetVisibility {
  /**
   * @param {string} tree
   * @param {string} visibility
   */
  constructor(tree, visibility) {
    this.tree = tree;
    this.visibility = visibility;
    this.refusals = RoadmapRefusals;
    Object.freeze(this);
  }

  /** @param {import('../../../platform/domain-kit/acts.js').ActReader} read */
  load(read) {
    const branches = new Branches(read, this.tree);
    const meta = read.inScope(RoadmapScopes.tree(this.tree), (tree) => tree.repository(RoadmapMeta).find(META, 'drawn') ?? RoadmapMetaValue.blank());
    return { roadmap: branches.roadmaps.get(this.tree) ?? null, subtrees: branches.standing(), meta };
  }

  /** @param {ReturnType<SetVisibility['load']>} loaded */
  decide({ roadmap, subtrees, meta }) {
    if (roadmap === null) return gone(Roadmap.type, this.tree);
    if (roadmap.parent !== null) return ActDecision.refuse(RoadmapRefusals.ofRefused(new Refused('not-a-root', roadmap.id.ref, null, 'predicted')));
    if (meta.visibility === this.visibility) return ActDecision.unchanged(null);
    const plan = Plan.running({ name: 'roadmap.setVisibility', specs: [RoadmapSpecs.visibility], args: { visibility: this.visibility } }, [
      Prediction.write(META, { visibility: this.visibility, reach: this.visibility }),
      ...subtrees.map((subtree) => Prediction.write(META, { reach: this.visibility }, {}, RoadmapScopes.tree(subtree))),
    ]);
    return writeIn(RoadmapScopes.tree(this.tree), plan, null);
  }
}

// §4 `roadmap.createSubtree`, predicted so a subtree is made with no connection: the subtree's record, its meta
// and genesis kinds, and the step's `branch`. A step this device holds as deleted is revived first, and noted (§6).
export class CreateSubtree {
  /**
   * @param {string} tree
   * @param {string} step
   */
  constructor(tree, step) {
    this.tree = tree;
    this.step = step;
    this.refusals = RoadmapRefusals;
    Object.freeze(this);
  }

  /** @param {import('../../../platform/domain-kit/acts.js').ActReader} read */
  load(read) {
    const roadmap = read.inScope(RoadmapScopes.account, (account) => account.repository(Roadmap).find(new Id(this.tree, Roadmap), 'drawn'));
    const tree = read.inScope(RoadmapScopes.tree(this.tree), (scope) => {
      const record = scope.repository(RoadmapStep).record(this.step, 'drawn');
      return {
        meta: scope.repository(RoadmapMeta).find(META, 'drawn') ?? RoadmapMetaValue.blank(),
        step: record === undefined ? null : RoadmapStep.decode(Fields.record(record)),
        absent: record?.life?.[0] !== 'alive',
        note: LandingNote.of(scope.device(RoadmapScopes.landing(this.tree))),
        moment: scope.moment,
      };
    });
    const pointer = read.inScope(RoadmapScopes.overlay(this.tree), (overlay) => overlay.repository(StepPointer).find(new Id(this.step, StepPointer), 'drawn'));
    return { roadmap, pointer, ...tree };
  }

  /**
   * @param {ReturnType<CreateSubtree['load']>} loaded
   * @param {import('../../../platform/domain-kit/acts.js').ActIDSource} ids
   */
  decide({ roadmap, pointer, meta, step, absent, note, moment }, ids) {
    if (roadmap === null) return gone(Roadmap.type, this.tree);
    if (step === null) return gone(RoadmapStep.type, this.step);
    if (step.branch !== null) return ActDecision.unchanged({ subtree: step.branch });
    const refused = (/** @type {string} */ code, /** @type {import('../../../platform/domain-kit/entities.js').RecordRef} */ subject) =>
      ActDecision.refuse(RoadmapRefusals.ofRefused(new Refused(code, subject, null, 'predicted')));
    if (pointer !== null) return refused('step-opens-a-tree', step.id.ref);
    if (meta.depth + 1 > RoadmapLimits.maxDepth) return refused('depth-limit', roadmap.id.ref);
    const subtree = String(ids.mint(Roadmap, RoadmapScopes.account).record);
    const scope = RoadmapScopes.tree(subtree);
    const parent = { tree: this.tree, step: this.step };
    const command = Plan.running({ name: 'roadmap.createSubtree', specs: [],
      args: { tree: this.tree, root: meta.root ?? this.tree, step: this.step, subtree } }, [
      Prediction.create(new Id(subtree, Roadmap), { parent }),
      Prediction.write(META, { root: meta.root ?? this.tree, parent, depth: meta.depth + 1, reach: meta.reach }, {}, scope),
      ...GENESIS_KINDS.map((kind, index) => Prediction.create(new Id(kind.id, RoadmapKind),
        { hue: kind.hue, label: kind.label, description: kind.description, ord: `a${index}` }, scope)),
      Prediction.update(step.id, { branch: subtree }, RoadmapScopes.tree(this.tree)),
    ]);
    const connected = new ScopedPlan(RoadmapScopes.account, command);
    if (!absent) return ActDecision.write(new ActPlan([connected]), { subtree });
    const revival = new Plan();
    revival.revive(new Valid(step, moment, []), { fields: [] });
    revival.device(RoadmapScopes.landing(this.tree), note.adding({ revived: [this.step] }).json);
    return ActDecision.write(new ActPlan([new ScopedPlan(RoadmapScopes.tree(this.tree), revival), connected]), { subtree });
  }
}

