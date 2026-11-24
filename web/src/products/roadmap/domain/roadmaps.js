// @ts-check

import { ActDecision, ActPlan, ScopedPlan } from '../../../platform/domain-kit/acts.js';
import { EntityType, Fields, Id, compareText } from '../../../platform/domain-kit/entities.js';
import { Plan, Prediction, UndoRecipe, UndoTarget } from '../../../platform/domain-kit/plans.js';
import { Refused } from '../../../platform/domain-kit/refusals.js';
import { Check, Valid } from '../../../platform/domain-kit/validation.js';
import { Path, Violation } from '../../../platform/domain-kit/values.js';
import { recordKey } from '../../../../../packages/api-contract/sync/reference/core/rows.js';
import { Stamp } from '../../../../../packages/api-contract/sync/reference/core/stamp.js';
import { RoadmapKind, RoadmapKindValue } from './kinds.js';
import { GENESIS_KINDS, HeldRecord, Restore, RoadmapChecks, RoadmapLimits, RoadmapRefusals, RoadmapScopes, RoadmapSpecs, gone, restoring, writeIn } from './roadmapRules.js';
import { RoadmapStep, StepsImport, readNote, readTree } from './steps.js';
import { StepMark, StepPointer } from './progress.js';
import { RoadmapTree } from './records.js';

/** @typedef {{ tree: string, step: string }} RoadmapParent */
/** @typedef {import('../../../platform/domain-kit/reading.js').Reader} Reader */
/** @typedef {import('../../../platform/domain-kit/entities.js').ViewRecord & { ru?: number }} ReceivedRecord */

// The step of another roadmap that owns a subtree, as its record and its meta both name it: null for a root.
/** @param {Fields} f */
function placeIn(f) {
  const parent = f.json('parent');
  const placed = parent !== null && typeof parent === 'object' && !Array.isArray(parent)
    && typeof parent.tree === 'string' && typeof parent.step === 'string';
  return placed ? { tree: String(parent.tree), step: String(parent.step) } : null;
}

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
  decode: (f) => new RoadmapValue(new Id(f.id, Roadmap), placeIn(f)),
});

// A roadmap's own words and a root's visibility, the singleton of its tree scope. Its place, its reach, whether its guide
// is inherited and the roadmap a fork was copied from are the server's.
export class RoadmapMetaValue {
  /**
   * @param {Id<RoadmapMetaValue>} id
   * @param {{ title?: string, guide?: string, guideInherited?: boolean, root?: string | null, parent?: RoadmapParent | null, depth?: number,
   *   visibility?: string, reach?: string, forkedFrom?: string | null }} values
   */
  constructor(id, { title = '', guide = '', guideInherited = false, root = null, parent = null, depth = 0, visibility = 'private', reach = 'private',
    forkedFrom = null } = {}) {
    this.id = id;
    this.title = title;
    this.guide = guide;
    this.guideInherited = guideInherited;
    this.root = root;
    this.parent = parent;
    this.depth = depth;
    this.visibility = visibility;
    this.reach = reach;
    this.forkedFrom = forkedFrom;
    Object.freeze(this);
  }

  /** @param {{ title?: string, guide?: string, visibility?: string }} changes */
  with(changes) {
    return new RoadmapMetaValue(this.id, { title: this.title, guide: this.guide, guideInherited: this.guideInherited, root: this.root,
      parent: this.parent, depth: this.depth, visibility: this.visibility, reach: this.reach, forkedFrom: this.forkedFrom, ...changes });
  }

  fields() { return { title: this.title, guide: this.guide, visibility: this.visibility }; }

  static blank() { return new RoadmapMetaValue(new Id('meta', RoadmapMeta)); }
}

/** @type {EntityType<RoadmapMetaValue, null>} */
export const RoadmapMeta = new EntityType({
  type: 'meta', scope: null,
  decode: (f) => new RoadmapMetaValue(new Id(f.id, RoadmapMeta), {
    title: f.string('title', ''), guide: f.string('guide', ''), guideInherited: f.bool('guideInherited', false), root: f.optionalString('root'),
    parent: placeIn(f), depth: f.optionalInt('depth') ?? 0, visibility: f.string('visibility', 'private'), reach: f.string('reach', 'private'),
    forkedFrom: f.optionalString('forkedFrom'),
  }),
  checks: [
    new Check('title', (value) => value.with({ title: RoadmapSpecs.title.apply(value.title, new Path('title')) })),
    new Check('guide', (value) => value.with({ guide: RoadmapSpecs.guide.apply(value.guide, new Path('guide')) })),
    new Check('visibility', (value) => value.with({ visibility: RoadmapSpecs.visibility.apply(value.visibility, new Path('visibility')) })),
  ],
});

// One roadmap as a device's replica holds it, as the domain's normalized tree. `tree` reads its tree scope: the steps and
// links as `readTree` reads them, absent ones included, its meta, with the roadmap a fork was copied from, and its kinds. `overlay` reads its owner's overlay for
// the marks and pointers, null where the reader takes none (a roadmap someone else owns); `queued` are the overlay's
// records an entry the device still queues changes. `listed` is its record in the person's own list, null where it is
// not theirs, and says whether it is present and where it sits; without it the meta says where. `read` says the device
// holds the server's whole copy of the roadmap: the first pull of every scope it is read through has ended. Before that
// it is read only where it holds records of it and the server has sent none of them, nor of its overlay (none carries
// the server's `ru`): a roadmap the device made, which the server does not hold yet. A pull under way leaves it unread,
// whatever it has brought.
// §5 Dates: the server has received a mark once no entry the device queues still changes it, and its time is its
// record's `ru`, the server's; a mark an entry still changes is the device's, timed by its stamp. A roadmap was last
// changed when the server last received a record of it: the newest `ru` among its record, its tree scope's and its
// overlay's.
/**
 * @param {string} id
 * @param {{ listed?: ReceivedRecord | null, tree: Reader, overlay?: Reader | null, queued?: { t: string, id: import('../../../platform/domain-kit/entities.js').RecordID }[], read?: boolean }} held
 */
export function readRoadmap(id, { listed = null, tree, overlay = null, queued = [], read = true }) {
  const steps = readTree(id, tree);
  const records = /** @type {ReceivedRecord[]} */ ([...tree.views.drawn.values()]);
  const overlaid = /** @type {ReceivedRecord[]} */ (overlay ? [...overlay.views.drawn.values()] : []);
  const metaRecord = tree.repository(RoadmapMeta).record('meta', 'drawn');
  const meta = metaRecord ? RoadmapMeta.decode(Fields.record(metaRecord)) : RoadmapMetaValue.blank();
  const alive = (/** @type {ReceivedRecord} */ record) => record.life?.[0] === 'alive';
  const changing = new Set(queued.map((record) => recordKey(record.t, record.id)));
  const updatedAt = [listed, ...records, ...overlaid].reduce((latest, record) => (typeof record?.ru === 'number' && (latest === null || record.ru > latest)
    ? record.ru : latest), /** @type {number | null} */ (null));
  const madeHere = records.length > 0 && [...records, ...overlaid].every((record) => typeof record.ru !== 'number');
  return new RoadmapTree({
    id,
    present: listed === null || alive(listed),
    read: read || madeHere ? 'loaded' : 'unread',
    own: listed !== null,
    updatedAt,
    parent: listed ? placeIn(Fields.record(listed)) : meta.parent,
    meta: metaRecord ? { title: meta.title, guide: meta.guide, guideInherited: meta.guideInherited, root: meta.root ?? id, depth: meta.depth,
      visibility: meta.visibility, reach: meta.reach, forkedFrom: meta.forkedFrom } : null,
    nodes: steps.nodes,
    edges: steps.edges,
    kinds: records.filter((record) => record.t === RoadmapKind.type).map((record) => {
      const kind = RoadmapKind.decode(Fields.record(record));
      return { id: String(record.id), present: alive(record), born: record.born ?? null, hue: kind.hue, label: kind.label,
        description: kind.description, ord: kind.ord ?? '' };
    }),
    marks: overlaid.filter((record) => record.t === StepMark.type).map((record) => {
      const mark = StepMark.decode(Fields.record(record));
      const stamp = record.f?.mark?.[1] ?? null;
      return { node: String(record.id), status: mark.status, outOfOrder: mark.outOfOrder, stamp,
        recordedAt: changing.has(recordKey(record.t, record.id)) ? null : record.ru ?? null, deviceAt: stamp === null ? null : Stamp.parse(stamp).ms };
    }),
    pointers: overlaid.filter((record) => record.t === StepPointer.type).map((record) => ({
      node: String(record.id), present: alive(record), opens: StepPointer.decode(Fields.record(record)).opens, setAt: record.f?.opens?.[1] ?? null,
    })),
  });
}

// §5 Create a roadmap: the `tree` record, then its tree scope with the title, its kinds and the first steps, in chunks
// when the steps are many. Its kinds are the genesis kinds, or a legend of its own in its order (a pasted plan's or a
// quest's), each checked as a kind made is and none wearing a hue a kind before it wears. The engine drops the tree's
// intents when the record is refused. Its Undo is `roadmap.undoCreateRoadmap`, while the record, the tree and the
// owner's overlay of it are as it left them; each tree segment is journaled as that Undo's evidence, so its receipts
// prove the tree unchanged.
export class CreateRoadmap {
  /**
   * @param {string} title
   * @param {import('./steps.js').ImportedSteps} steps
   * @param {(import('./kinds.js').KindWords & { hue: string })[] | null} kinds its own legend, null for the genesis kinds
   */
  constructor(title, steps = { steps: [], links: [] }, kinds = null) {
    this.title = title;
    this.steps = steps;
    this.kinds = kinds;
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
    const kinds = this.kinds === null
      ? GENESIS_KINDS.map((kind, index) => new Valid(new RoadmapKindValue(new Id(kind.id, RoadmapKind),
        { hue: kind.hue, label: kind.label, description: kind.description, ord: `a${index}` }), moment))
      : this.kinds.map((_, index) => this.legendKind(index, ids.mint(RoadmapKind, scope), moment));
    const imported = new StepsImport(this.steps, new RoadmapTree({ id: String(id.record) }), null).planned(moment, ids, scope);
    const account = new Plan();
    account.create(new Valid(new RoadmapValue(id), moment));
    account.undoBy(UndoRecipe.command('roadmap.undoCreateRoadmap', { tree: String(id.record) },
      { unchangedCreatedRecords: [{ id, scope: null }], unchangedCreatedScopes: [scope] }));
    const opening = new Plan();
    opening.create(meta, { fields: ['title'] });
    for (const kind of kinds) opening.create(kind);
    const chunks = imported.chunks(1 + kinds.length);
    for (const unit of chunks[0] ?? []) unit.writeTo(opening, false);
    const later = chunks.slice(1).map((chunk) => {
      const plan = new Plan();
      for (const unit of chunk) unit.writeTo(plan, false);
      return new ScopedPlan(scope, plan);
    });
    for (const plan of [opening, ...later.map((segment) => segment.plan)]) plan.evidenceForUndo();
    return ActDecision.write(new ActPlan([new ScopedPlan(RoadmapScopes.account, account), new ScopedPlan(scope, opening), ...later]),
      { tree: id.record, steps: imported.ids });
  }

  // The legend's kind at `index` under the id minted for it, refused where a kind before it wears its hue or as a kind
  // made is refused, named by its place in the legend.
  /**
   * @param {number} index
   * @param {Id<RoadmapKindValue>} id
   * @param {import('../../../platform/domain-kit/time.js').Moment} moment
   */
  legendKind(index, id, moment) {
    const legend = this.kinds ?? [];
    const kind = legend[index] ?? { hue: '' };
    if (legend.slice(0, index).some((before) => before.hue === kind.hue)) {
      throw new Violation(RoadmapChecks.wornHue, new Path(`kinds.${index}.hue`), { kind: 'custom', custom: 'worn' });
    }
    try {
      return new Valid(new RoadmapKindValue(id, { hue: kind.hue, label: kind.label ?? '', description: kind.description ?? '', ord: `a${index}` }), moment);
    } catch (error) {
      if (error instanceof Violation) throw new Violation(error.rule, new Path(`kinds.${index}.${error.path.text}`), error.reason);
      throw error;
    }
  }
}

// §5 Delete a roadmap: held nine seconds, and permanent once the hold ends (R-7). A subtree goes with the step
// that owns it, so only a root's record is deleted here. The device's notes (§6) of the roadmap and of every subtree
// under it go at once, and an Undo within the hold does not bring them back.
export class DeleteRoadmap {
  /** @param {string} tree */
  constructor(tree) {
    this.id = new Id(tree, Roadmap);
    this.refusals = RoadmapRefusals;
    Object.freeze(this);
  }

  /** @param {import('../../../platform/domain-kit/acts.js').ActReader} read */
  load(read) {
    return read.inScope(RoadmapScopes.account, (account) => {
      const roadmaps = account.repository(Roadmap).all('drawn');
      const under = [String(this.id.record)];
      for (const id of under) {
        for (const each of roadmaps) {
          const subtree = String(each.id.record);
          if (each.parent?.tree === id && !under.includes(subtree)) under.push(subtree);
        }
      }
      return {
        roadmap: account.repository(Roadmap).find(this.id, 'drawn'),
        notes: under.map(RoadmapScopes.landing).filter((key) => account.device(key) !== null),
      };
    });
  }

  /** @param {{ roadmap: RoadmapValue | null, notes: string[] }} loaded */
  decide({ roadmap, notes }) {
    if (roadmap === null) return ActDecision.unchanged(null);
    if (roadmap.parent !== null) return ActDecision.refuse(RoadmapRefusals.ofRefused(new Refused('not-a-root', this.id.ref, null, 'predicted')));
    const plan = new Plan();
    plan.remove(this.id);
    for (const key of notes) plan.device(key, null);
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
    plan.undoBy(restoring(Restore.tree, META, changed));
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

// §4 a root's visibility: the owner's field, written under the gesture's stamp, so the newest choice stands. The
// server writes the reach of the root and of every standing subtree of its branch, predicted here under the tree's
// capture command.
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
    return { roadmap: branches.roadmaps.get(this.tree) ?? null, subtrees: branches.standing(), meta, moment: read.moment };
  }

  /** @param {ReturnType<SetVisibility['load']>} loaded */
  decide({ roadmap, subtrees, meta, moment }) {
    if (roadmap === null) return gone(Roadmap.type, this.tree);
    if (roadmap.parent !== null) return ActDecision.refuse(RoadmapRefusals.ofRefused(new Refused('not-a-root', roadmap.id.ref, null, 'predicted')));
    const valid = new Valid(meta.with({ visibility: this.visibility }), moment, ['visibility']);
    const { visibility } = valid.value;
    if (meta.visibility === visibility) return ActDecision.unchanged(null);
    const plan = Plan.running({ name: 'roadmap.captureTree', specs: [], args: {} }, [
      Prediction.write(META, { reach: visibility }),
      ...subtrees.map((subtree) => Prediction.write(META, { reach: visibility }, {}, RoadmapScopes.tree(subtree))),
    ]);
    plan.update(valid, { fields: ['visibility'] });
    plan.undoBy(restoring(Restore.tree, META, ['visibility']));
    return writeIn(RoadmapScopes.tree(this.tree), plan, null);
  }
}

// §4 `roadmap.createSubtree`, predicted so a subtree is made with no connection: the subtree's record, its meta
// and genesis kinds, and the step's `branch`. A step this device holds as deleted, or knows only by its spent id, is
// revived first, and noted (§6); of the latter the device knows no subtree, so the server answers any it owns.
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
      const held = HeldRecord.read(scope.repository(RoadmapStep), new Id(this.step, RoadmapStep));
      return { meta: scope.repository(RoadmapMeta).find(META, 'drawn') ?? RoadmapMetaValue.blank(), held,
        note: held.absent ? readNote(this.tree, scope) : null, moment: scope.moment };
    });
    const pointer = read.inScope(RoadmapScopes.overlay(this.tree), (overlay) => overlay.repository(StepPointer).find(new Id(this.step, StepPointer), 'drawn'));
    return { roadmap, pointer, ...tree };
  }

  /**
   * @param {ReturnType<CreateSubtree['load']>} loaded
   * @param {import('../../../platform/domain-kit/acts.js').ActIDSource} ids
   */
  decide({ roadmap, pointer, meta, held, note, moment }, ids) {
    if (roadmap === null) return gone(Roadmap.type, this.tree);
    if (!held.known) return gone(RoadmapStep.type, this.step);
    const step = held.value;
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
    command.undoBy(UndoRecipe.command('roadmap.undoCreateSubtree', { tree: this.tree, step: this.step, subtree }, {
      ownedFields: [UndoTarget.field(step.id, 'branch', RoadmapScopes.tree(this.tree))],
      unchangedCreatedRecords: [{ id: new Id(subtree, Roadmap), scope: null }],
      unchangedCreatedScopes: [scope],
    }));
    const connected = new ScopedPlan(RoadmapScopes.account, command);
    const created = { subtree, root: meta.root ?? this.tree, revived: held.absent };
    if (note === null) return ActDecision.write(new ActPlan([connected]), created);
    const revival = held.reviving(new Valid(step, moment, []), []);
    revival.device(RoadmapScopes.landing(this.tree), note.adding({ revived: [this.step] }).json);
    return ActDecision.write(new ActPlan([new ScopedPlan(RoadmapScopes.tree(this.tree), revival), connected]), created);
  }
}

// R-8 Redo of creating a subtree: the Undo's inverse act, its sources by ordinal, given recipes of the product's own.
// `roadmap.redoCreateSubtree` plants a new subtree under `fresh` while the step's `branch` is still the one the Undo
// cleared; a step the creation revived is revived again. The Undo's sources walk the creation backwards: the command's
// inverse first, then the revival's restore.
/**
 * @param {{ tree: string, step: string, root: string, revived: boolean }} creation the creation's input and result
 * @param {string} fresh
 * @returns {{ index: number, scope: string, plan: Plan }[]}
 */
export function redoCreateSubtree({ tree, step, root, revived }, fresh) {
  const planted = new Plan();
  planted.undoBy(UndoRecipe.command('roadmap.redoCreateSubtree', { tree, root, step, subtree: fresh },
    { ownedFields: [UndoTarget.field(new Id(step, RoadmapStep), 'branch', RoadmapScopes.tree(tree))] }));
  if (!revived) return [{ index: 0, scope: RoadmapScopes.account, plan: planted }];
  const alive = new Plan();
  alive.undoBy(restoring(Restore.tree, new Id(step, RoadmapStep), [], { life: true }));
  return [{ index: 0, scope: RoadmapScopes.account, plan: planted }, { index: 1, scope: RoadmapScopes.tree(tree), plan: alive }];
}

