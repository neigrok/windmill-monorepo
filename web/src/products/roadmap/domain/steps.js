// @ts-check

import { ActDecision, ActPlan, ScopedPlan } from '../../../platform/domain-kit/acts.js';
import { EntityType, Fields, Id, compareText } from '../../../platform/domain-kit/entities.js';
import { Plan, UndoRecipe } from '../../../platform/domain-kit/plans.js';
import { Refused } from '../../../platform/domain-kit/refusals.js';
import { Check, Valid } from '../../../platform/domain-kit/validation.js';
import { Path, Violation, precondition } from '../../../platform/domain-kit/values.js';
import { utf8 } from '../../../platform/sync/core/encoding.js';
import { between, dropKey, isOrderKey } from '../../../../../packages/api-contract/sync/reference/core/fracindex.js';
import { jcs } from '../../../../../packages/api-contract/sync/reference/core/jcs.js';
import { components, FollowGraph } from './graph.js';
import { LandingNote, RoadmapTree } from './records.js';
import { HeldRecord, Restore, RoadmapChecks, RoadmapLimits, RoadmapRefusals, RoadmapScopes, RoadmapSpecs, full, gone, restoring, writeIn } from './roadmapRules.js';

/** @typedef {import('../../../platform/domain-kit/time.js').Moment} Moment */
/** @typedef {import('../../../platform/domain-kit/reading.js').Reader} Reader */
/** @typedef {import('../../../platform/domain-kit/acts.js').ActReader} ActReader */
/** @typedef {import('../../../platform/domain-kit/acts.js').ActIDSource} ActIDSource */
/** @typedef {{ url: string, label: string }} StepWebLink */
/** @typedef {{ label?: string, icon?: string, color?: string, description?: string, links?: StepWebLink[] }} StepChanges */
/** @typedef {StepChanges & { key: string }} ImportedStep */
/** @typedef {{ steps: ImportedStep[], links: string[][] }} ImportedSteps */

// A step: a `node` record of a roadmap's tree scope. `ord` is its place among its trunk parent's steps,
// computed here and written as a plain field, so a reorder carries the step's life like every other change.
export class RoadmapStepValue {
  /**
   * @param {Id<RoadmapStepValue>} id
   * @param {StepChanges & { ord?: string | null, status?: string | null, branch?: string | null }} values
   */
  constructor(id, { label = '', icon = '', color = 'terracotta', ord = null, description = '', links = [], status = null, branch = null } = {}) {
    this.id = id;
    this.label = label;
    this.icon = icon;
    this.color = color;
    this.ord = ord;
    this.description = description;
    this.links = Object.freeze(links.map((link) => Object.freeze({ url: link.url, label: link.label })));
    this.status = status;
    this.branch = branch;
    Object.freeze(this);
  }

  /** @param {StepChanges & { ord?: string | null }} changes */
  with(changes) {
    return new RoadmapStepValue(this.id, { label: this.label, icon: this.icon, color: this.color, ord: this.ord,
      description: this.description, links: [...this.links], status: this.status, branch: this.branch, ...changes });
  }

  fields() {
    return { label: this.label, icon: this.icon, color: this.color, ord: this.ord, description: this.description,
      links: this.links.map((link) => ({ url: link.url, label: link.label })) };
  }
}

/** @type {EntityType<RoadmapStepValue, null>} */
export const RoadmapStep = new EntityType({
  type: 'node', scope: null, heldRemoval: true,
  decode: (f) => new RoadmapStepValue(new Id(f.id, RoadmapStep), {
    label: f.string('label', ''), icon: f.string('icon', ''), color: f.string('color', 'terracotta'), ord: f.optionalString('ord'),
    description: f.string('description', ''), links: f.optionalList('links', (link) => ({ url: link.string('url'), label: link.string('label') })) ?? [],
    status: f.optionalString('status'), branch: f.optionalString('branch'),
  }),
  checks: [
    new Check('label', (step) => step.with({ label: RoadmapSpecs.label.apply(step.label, new Path('label')) })),
    new Check('icon', (step) => step.with({ icon: RoadmapSpecs.icon.apply(step.icon, new Path('icon')) })),
    new Check('color', (step) => step.with({ color: RoadmapSpecs.color.apply(step.color, new Path('color')) })),
    new Check('description', (step) => step.with({ description: RoadmapSpecs.description.apply(step.description, new Path('description')) })),
    new Check('links', (step) => step.with({ links: RoadmapSpecs.links.apply([...step.links], new Path('links'), (link, at) => ({
      url: RoadmapSpecs.linkUrl.apply(link.url, at.plus('url')), label: RoadmapSpecs.linkLabel.apply(link.label, at.plus('label')),
    })) })),
  ],
});

// A link: an `edge` record keyed by the step it comes from and the step it leads to.
export class RoadmapLinkValue {
  /**
   * @param {string} from
   * @param {string} to
   */
  constructor(from, to) {
    this.id = new Id([from, to], RoadmapLink);
    this.from = from;
    this.to = to;
    Object.freeze(this);
  }

  fields() { return {}; }

  get ref() { return this.id.ref; }
}

/** @type {EntityType<RoadmapLinkValue, null>} */
export const RoadmapLink = new EntityType({
  type: 'edge', scope: null, heldRemoval: false, checks: [],
  decode: (f) => {
    const [from, to] = Array.isArray(f.id) ? f.id : [];
    if (typeof from !== 'string' || typeof to !== 'string') throw f.failure('id', 'not a [from, to] key');
    return new RoadmapLinkValue(from, to);
  },
});

// The steps and links of one tree scope, every record a reader holds, absent ones included, as the read
// domain's tree: what a step follows, and its cycles, are read through absent steps (D-5). A step keeps when the server
// created and last changed it, and the stamp of the subtree it owns.
/**
 * @param {string} tree
 * @param {Reader} read
 */
export function readTree(tree, read) {
  precondition(read.scope === RoadmapScopes.tree(tree), `the steps of ${tree} are read in its tree scope`);
  const nodes = [];
  const edges = [];
  for (const record of read.views.drawn.values()) {
    const present = record.life?.[0] === 'alive';
    if (record.t === RoadmapStep.type) {
      const step = RoadmapStep.decode(Fields.record(record));
      nodes.push({ id: String(record.id), present, born: record.born ?? null, rc: record.rc ?? null,
        ru: /** @type {{ ru?: number }} */ (record).ru ?? null, label: step.label, icon: step.icon,
        color: step.color, ...(step.ord === null ? {} : { ord: step.ord }), ...(step.status === null ? {} : { status: step.status }),
        description: step.description, links: [...step.links], branch: step.branch, branchStamp: record.f?.branch?.[1] ?? null });
    }
    if (record.t === RoadmapLink.type) {
      const link = RoadmapLink.decode(Fields.record(record));
      edges.push({ from: link.from, to: link.to, present });
    }
  }
  return new RoadmapTree({ id: tree, nodes, edges });
}

// The order key after every given key, by bytes; a missing or malformed key is no bound.
/** @param {(string | null)[]} ords */
function keyAfter(ords) {
  const keys = ords.flatMap((ord) => ord !== null && isOrderKey(ord) ? [ord] : []).sort(compareText);
  return between(keys.at(-1) ?? null, null);
}

// The steps a new step joins in order: the present steps its first prerequisite leads to, or the present
// steps no live link leads to.
/**
 * @param {RoadmapTree} tree
 * @param {string | null} parent
 */
function siblingOrds(tree, parent) {
  const live = tree.edges.filter((edge) => edge.present);
  return tree.nodes.filter((node) => node.present
    && (parent === null ? !live.some((edge) => edge.to === node.id) : live.some((edge) => edge.from === parent && edge.to === node.id)))
    .map((node) => node.ord || null);
}

// The first new link on a loop among what steps follow: a loop that holds a present step. A loop of absent
// steps alone is read without harm.
/**
 * @param {RoadmapTree} tree
 * @param {string[][]} links
 * @param {Set<string>} made
 */
function firstLoop(tree, links, made) {
  const all = [...tree.edges.filter((edge) => edge.present).map((edge) => [edge.from, edge.to]), ...links];
  const ids = [...new Set([...tree.nodes.map((node) => node.id), ...all.flat()])];
  const slot = new Map(ids.map((id, index) => [id, index]));
  /** @type {number[][]} */
  const parents = ids.map(() => []);
  for (const [from = '', to = ''] of all) parents[slot.get(to) ?? 0]?.push(slot.get(from) ?? 0);
  const { groups, componentOf } = components(parents);
  const present = new Set([...tree.nodes.filter((node) => node.present).map((node) => node.id), ...made]);
  return links.findIndex(([from = '', to = '']) => {
    if (from === to) return true;
    const component = componentOf[slot.get(from) ?? 0];
    if (component !== componentOf[slot.get(to) ?? 0]) return false;
    return (groups[component ?? 0] ?? []).some((member) => present.has(ids[member] ?? ''));
  });
}

/** @param {string[]} link @param {Path} at */
function loopAt(link, at) {
  return new Violation(RoadmapChecks.cycle, at, { kind: 'custom', custom: link[0] === link[1] ? 'self' : 'loop' });
}

// One imported step and the links that lead to it: the unit a chunk holds whole.
class ImportUnit {
  /**
   * @param {Valid<RoadmapStepValue>} step
   * @param {Valid<RoadmapLinkValue>[]} links
   */
  constructor(step, links) {
    this.step = step;
    this.links = links;
    this.count = 1 + links.length;
    this.bytes = utf8(jcs({ t: RoadmapStep.type, id: step.id.record, f: step.written })).length
      + links.reduce((sum, link) => sum + utf8(jcs({ t: RoadmapLink.type, id: link.id.record })).length, 0);
    Object.freeze(this);
  }

  // The step and its links, and, unless the act's Undo is another's, an Undo that deletes them again while they
  // are as the import made them.
  /** @param {Plan} plan @param {boolean} [undone] */
  writeTo(plan, undone = true) {
    plan.create(this.step);
    for (const link of this.links) plan.create(link);
    if (undone) plan.undoBy(...[this.step, ...this.links].map((valid) => UndoRecipe.createdRecord(Restore.tree, valid.id)));
  }
}

// Steps planned in the order they follow one another, each with the id it was given.
class ImportPlan {
  /**
   * @param {ImportUnit[]} units
   * @param {Record<string, string>} ids
   */
  constructor(units, ids) {
    this.units = units;
    this.ids = ids;
    Object.freeze(this);
  }

  get links() { return this.units.flatMap((unit) => unit.links); }

  // §5 Import and paste: chunks of at most IMPORT_CHUNK records and half the engine's push limit, a step's
  // prerequisites in its chunk or an earlier one. The first chunk keeps room for `reserved` records.
  /** @param {number} reserved */
  chunks(reserved = 0) {
    /** @type {ImportUnit[][]} */
    const chunks = [[]];
    let count = reserved;
    let bytes = 0;
    for (const unit of this.units) {
      const current = chunks.at(-1) ?? [];
      if (count > 0 && (count + unit.count > RoadmapLimits.importChunk || bytes + unit.bytes > RoadmapLimits.importChunkBytes)) {
        chunks.push([unit]);
        count = unit.count;
        bytes = unit.bytes;
        continue;
      }
      current.push(unit);
      count += unit.count;
      bytes += unit.bytes;
    }
    return chunks;
  }
}

// What an import brings: its steps under fresh ids, ordered after their trunk parents' steps, with their
// links and, under `under`, a link from it to each step the import has no prerequisite for.
export class StepsImport {
  /**
   * @param {ImportedSteps} imported
   * @param {RoadmapTree} tree
   * @param {string | null} under
   */
  constructor(imported, tree, under) {
    const keys = imported.steps.map((step) => step.key);
    precondition(new Set(keys).size === keys.length, 'an import names each step once');
    for (const [from, to] of imported.links) precondition(keys.includes(from ?? '') && keys.includes(to ?? ''), 'an import links its own steps');
    const links = new Map(imported.links.map(([from = '', to = '']) => [jcs([from, to]), [from, to]]));
    this.imported = { steps: imported.steps, links: [...links.values()] };
    this.tree = tree;
    this.under = under;
    Object.freeze(this);
  }

  /**
   * @param {Moment} moment
   * @param {ActIDSource} ids
   * @param {string} scope
   */
  planned(moment, ids, scope) {
    const { steps, links } = this.imported;
    const keys = steps.map((step) => step.key);
    const loop = firstLoop(new RoadmapTree({ id: this.tree.id }), links, new Set(keys));
    if (loop >= 0) throw loopAt(links[loop] ?? [], new Path(`links.${loop}`));
    const order = this.followingOrder();
    /** @type {Record<string, string>} */
    const minted = {};
    for (const key of keys) minted[key] = String(ids.mint(RoadmapStep, scope).record);
    const parentOf = (/** @type {string} */ key) => {
      const first = links.find(([, to]) => to === key)?.[0];
      return first === undefined ? this.under : minted[first] ?? null;
    };
    /** @type {Map<string | null, string>} */
    const lastOrd = new Map();
    const units = order.map((index) => {
      const step = /** @type {ImportedStep} */ (steps[index]);
      const id = minted[step.key] ?? '';
      const parent = parentOf(step.key);
      const imported = links.some(([, to]) => to === step.key);
      const after = lastOrd.has(parent) ? between(lastOrd.get(parent) ?? null, null) : keyAfter(imported ? [] : siblingOrds(this.tree, parent));
      lastOrd.set(parent, after);
      const { key, ...changes } = step;
      let valid;
      try {
        valid = new Valid(new RoadmapStepValue(new Id(id, RoadmapStep), { ...changes, ord: after }), moment);
      } catch (error) {
        if (error instanceof Violation) throw new Violation(error.rule, new Path(`steps.${index}.${error.path.text}`), error.reason);
        throw error;
      }
      const leading = links.filter(([, to]) => to === key).map(([from]) => minted[from ?? ''] ?? '');
      const rooted = !imported && this.under !== null ? [this.under] : [];
      return new ImportUnit(valid, [...rooted, ...leading].map((from) => new Valid(new RoadmapLinkValue(from, id), moment)));
    });
    return new ImportPlan(units, minted);
  }

  // The import's steps with every step after those it follows, earlier steps first where the links allow.
  followingOrder() {
    const { steps, links } = this.imported;
    const waiting = steps.map((step) => links.filter(([, to]) => to === step.key).length);
    /** @type {number[]} */
    const order = [];
    const placed = new Set();
    while (order.length < steps.length) {
      const next = waiting.findIndex((count, index) => count === 0 && !placed.has(index));
      precondition(next >= 0, 'an import without a loop orders every step');
      placed.add(next);
      order.push(next);
      const key = steps[next]?.key;
      links.forEach(([from, to]) => {
        if (from !== key) return;
        const index = steps.findIndex((step) => step.key === to);
        waiting[index] = (waiting[index] ?? 0) - 1;
      });
    }
    return order;
  }
}

// The steps and links of one tree scope as an act reads them, and which of the steps it names the roadmap knows: a
// step the device holds, present or deleted, or one another device deleted that it knows only by its spent id
// (engine §7.5). A step it never knew is gone.
/**
 * @param {ActReader} read
 * @param {string} tree
 * @param {string[]} named
 */
function loadTree(read, tree, named) {
  return read.inScope(RoadmapScopes.tree(tree), (scope) => {
    const steps = scope.repository(RoadmapStep);
    const roadmap = readTree(tree, scope);
    return {
      tree: roadmap,
      known: new Set(named.filter((id) => roadmap.nodesById.has(id) || steps.spentBorn(new Id(id, RoadmapStep)) !== null)),
      steps: steps.capacity(),
      links: scope.repository(RoadmapLink).capacity(),
      note: LandingNote.of(scope.device(RoadmapScopes.landing(tree))),
      moment: scope.moment,
    };
  });
}

// The name of each step a device links from, as it holds it now, for a landing line that may come to name it once
// another device deletes it (§6): the roadmap's own, or one the act makes (`made`). A step it holds no name of has none.
/**
 * @param {RoadmapTree} tree
 * @param {string[]} froms
 * @param {Map<string, string>} [made]
 */
function linkedNames(tree, froms, made = new Map()) {
  return [...new Set(froms)].flatMap((id) => {
    const name = tree.nodesById.get(id)?.label ?? made.get(id);
    return name === undefined ? [] : [{ id, name }];
  });
}

/** @typedef {ReturnType<typeof loadTree>} LoadedTree */

// §5 Create a step: the step and one link from each prerequisite, in one intent. The device notes both, so
// it can tell the person once if the step turns out to follow through a step deleted elsewhere (§6). A surface that
// shows the step before its write lands mints its id at random and gives it here; an id the roadmap holds, a deleted
// step's included, is refused, so no step is made over another.
export class CreateStep {
  /**
   * @param {string} tree
   * @param {StepChanges} step
   * @param {string[]} prerequisites
   * @param {string | null} id
   */
  constructor(tree, step, prerequisites = [], id = null) {
    this.tree = tree;
    this.step = step;
    this.prerequisites = [...new Set(prerequisites)];
    this.id = id;
    this.refusals = RoadmapRefusals;
    Object.freeze(this);
  }

  /** @param {ActReader} read */
  load(read) { return loadTree(read, this.tree, this.id === null ? this.prerequisites : [...this.prerequisites, this.id]); }

  /**
   * @param {LoadedTree} loaded
   * @param {ActIDSource} ids
   */
  decide({ tree, known, steps, links, note, moment }, ids) {
    const scope = RoadmapScopes.tree(this.tree);
    const unknown = this.prerequisites.find((id) => !known.has(id));
    if (unknown !== undefined) return gone(RoadmapStep.type, unknown);
    if (this.id !== null && known.has(this.id)) {
      return ActDecision.refuse(RoadmapRefusals.ofRefused(new Refused('id-taken', { t: RoadmapStep.type, id: this.id }, null, 'predicted')));
    }
    const id = this.id ?? String(ids.mint(RoadmapStep, scope).record);
    const ord = keyAfter(siblingOrds(tree, this.prerequisites[0] ?? null));
    const step = new Valid(new RoadmapStepValue(new Id(id, RoadmapStep), { ...this.step, ord }), moment);
    const made = this.prerequisites.map((from) => new Valid(new RoadmapLinkValue(from, id), moment));
    const refused = full(steps, 1, step.id.ref) ?? full(links, made.length, made[0]?.id.ref ?? null);
    if (refused) return refused;
    const plan = new Plan();
    plan.create(step);
    for (const link of made) plan.create(link);
    plan.undoBy(...[step, ...made].map((valid) => UndoRecipe.createdRecord(Restore.tree, valid.id)));
    plan.device(RoadmapScopes.landing(this.tree), note.adding({ nodes: [id], edges: this.prerequisites.map((from) => [from, id]),
      names: linkedNames(tree, this.prerequisites) }).json);
    return writeIn(scope, plan, id);
  }
}

// §5 Any change to a step carries its life as alive under the gesture's stamp, so a step deleted elsewhere
// comes back with the change (P-4, INV-1), whether this device still holds it or knows it only by its spent id. A step
// the device found absent is noted as revived (§6).
/**
 * @param {string} tree
 * @param {Reader} read
 * @param {string} id
 */
function readStep(tree, read, id) {
  return {
    held: HeldRecord.read(read.repository(RoadmapStep), new Id(id, RoadmapStep)),
    note: LandingNote.of(read.device(RoadmapScopes.landing(tree))),
    moment: read.moment,
  };
}

/**
 * @param {string} tree
 * @param {HeldRecord<RoadmapStepValue>} held
 * @param {Valid<RoadmapStepValue>} valid
 * @param {LandingNote} note
 */
function revived(tree, held, valid, note) {
  const changed = held.changed(valid);
  if (changed.length === 0) return ActDecision.unchanged(null);
  const plan = held.reviving(valid, changed);
  if (held.absent) plan.device(RoadmapScopes.landing(tree), note.adding({ revived: [String(held.id.record)] }).json);
  return writeIn(RoadmapScopes.tree(tree), plan, null);
}

export class ChangeStep {
  /**
   * @param {string} tree
   * @param {string} step
   * @param {StepChanges} changes
   */
  constructor(tree, step, changes) {
    this.tree = tree;
    this.step = step;
    this.changes = changes;
    this.refusals = RoadmapRefusals;
    Object.freeze(this);
  }

  /** @param {ActReader} read */
  load(read) { return read.inScope(RoadmapScopes.tree(this.tree), (tree) => readStep(this.tree, tree, this.step)); }

  /** @param {ReturnType<typeof readStep>} loaded */
  decide({ held, note, moment }) {
    if (!held.known) return gone(RoadmapStep.type, this.step);
    return revived(this.tree, held, new Valid(held.value.with(this.changes), moment, Object.keys(this.changes)), note);
  }
}

// §5 Reorder: the step lands below the sibling above it among its trunk parent's steps, which the layout names.
// A drop in place writes nothing.
export class MoveStep {
  /**
   * @param {string} tree
   * @param {string} step
   * @param {string | null} below
   * @param {string[]} siblings
   */
  constructor(tree, step, below, siblings) {
    this.tree = tree;
    this.step = step;
    this.below = below;
    this.siblings = siblings.filter((id) => id !== step);
    this.refusals = RoadmapRefusals;
    Object.freeze(this);
  }

  /** @param {ActReader} read */
  load(read) {
    return read.inScope(RoadmapScopes.tree(this.tree), (tree) => {
      const steps = tree.repository(RoadmapStep);
      const members = this.siblings.flatMap((id) => {
        const ord = steps.find(new Id(id, RoadmapStep), 'drawn')?.ord ?? null;
        return ord !== null && isOrderKey(ord) ? [{ id, key: ord }] : [];
      });
      return { ...readStep(this.tree, tree, this.step), members };
    });
  }

  /** @param {ReturnType<typeof readStep> & { members: { id: string, key: string }[] }} loaded */
  decide({ held, note, moment, members }) {
    if (!held.known) return gone(RoadmapStep.type, this.step);
    if (this.below !== null && !members.some((member) => member.id === this.below)) return gone(RoadmapStep.type, this.below);
    const step = held.value;
    const own = step.ord !== null && isOrderKey(step.ord) ? step.ord : null;
    const above = own === null ? null : [...members].filter((member) => member.key < own || (member.key === own && compareText(member.id, this.step) < 0))
      .sort((a, b) => compareText(a.key, b.key) || compareText(a.id, b.id)).at(-1)?.id ?? null;
    if (own !== null && above === this.below) return ActDecision.unchanged(null);
    const ord = dropKey({ stored: members, drawn: members, moved: this.step, above: this.below });
    return revived(this.tree, held, new Valid(step.with({ ord }), moment, ['ord']), note);
  }
}

// §5 Delete a step: held, and the step's death alone. Its links stay, unread while it is absent.
export class DeleteStep {
  /**
   * @param {string} tree
   * @param {string} step
   */
  constructor(tree, step) {
    this.tree = tree;
    this.id = new Id(step, RoadmapStep);
    this.refusals = RoadmapRefusals;
    Object.freeze(this);
  }

  /** @param {ActReader} read */
  load(read) { return read.inScope(RoadmapScopes.tree(this.tree), (tree) => tree.repository(RoadmapStep).find(this.id, 'drawn')); }

  /** @param {RoadmapStepValue | null} step */
  decide(step) {
    if (step === null) return ActDecision.unchanged(null);
    const plan = new Plan();
    plan.remove(this.id);
    plan.undoBy(restoring(Restore.tree, this.id, [], { life: true }));
    return writeIn(RoadmapScopes.tree(this.tree), plan, null);
  }
}

// A step's prerequisites, added and removed in one gesture. A removed prerequisite the step follows through an
// absent step retires the link from that step (§5); an added one that closes a loop among what steps follow
// is refused before anything is written.
export class ChangePrerequisites {
  /**
   * @param {string} tree
   * @param {string} step
   * @param {{ add?: string[], remove?: string[] }} change
   */
  constructor(tree, step, { add = [], remove = [] }) {
    this.tree = tree;
    this.step = step;
    this.add = [...new Set(add)];
    this.remove = [...new Set(remove)];
    this.refusals = RoadmapRefusals;
    Object.freeze(this);
  }

  /** @param {ActReader} read */
  load(read) { return loadTree(read, this.tree, [this.step, ...this.add]); }

  /** @param {LoadedTree} loaded */
  decide({ tree, known, links, note, moment }) {
    const unknown = [this.step, ...this.add].find((id) => !known.has(id));
    if (unknown !== undefined) return gone(RoadmapStep.type, unknown);
    const live = new Set(tree.edges.filter((edge) => edge.present).map((edge) => jcs([edge.from, edge.to])));
    const adding = this.add.filter((from) => !live.has(jcs([from, this.step]))).map((from) => [from, this.step]);
    const loop = firstLoop(tree, adding, new Set());
    if (loop >= 0) throw loopAt(adding[loop] ?? [], new Path(`add.${this.add.indexOf(adding[loop]?.[0] ?? '')}`));
    const followed = new FollowGraph(tree).followed(this.step);
    /** @type {Map<string, string[]>} */
    const retiring = new Map();
    for (const from of this.remove) {
      const direct = live.has(jcs([from, this.step]));
      for (const edge of direct ? [[from, this.step]] : followed.find((entry) => entry.id === from)?.incoming ?? []) {
        if (!adding.some((made) => jcs(made) === jcs(edge))) retiring.set(jcs(edge), edge);
      }
    }
    const removing = [...retiring.values()];
    if (adding.length === 0 && removing.length === 0) return ActDecision.unchanged(null);
    const made = adding.map(([from = '']) => new Valid(new RoadmapLinkValue(from, this.step), moment));
    const refused = full(links, made.length - removing.length, made[0]?.id.ref ?? null);
    if (refused) return refused;
    const plan = new Plan();
    for (const link of made) plan.create(link);
    for (const [from = '', to = ''] of removing) plan.remove(new RoadmapLinkValue(from, to).id);
    const held = new Set(tree.edges.map((edge) => jcs([edge.from, edge.to])));
    plan.undoBy(...made.map((link) => (held.has(jcs([link.value.from, link.value.to]))
      ? restoring(Restore.tree, link.id, [], { life: true }) : UndoRecipe.createdRecord(Restore.tree, link.id))),
    ...removing.map(([from = '', to = '']) => restoring(Restore.tree, new RoadmapLinkValue(from, to).id, [], { life: true })));
    if (adding.length) plan.device(RoadmapScopes.landing(this.tree), note.adding({ edges: adding, names: linkedNames(tree, adding.map(([from = '']) => from)) }).json);
    return writeIn(RoadmapScopes.tree(this.tree), plan, null);
  }
}

// §5 Import and paste into a roadmap: the steps under fresh ids, in chunks, prerequisites first, one act and so
// one Undo. Under a step, the import's first steps follow it.
export class ImportSteps {
  /**
   * @param {string} tree
   * @param {ImportedSteps} imported
   * @param {string | null} under
   */
  constructor(tree, imported, under = null) {
    this.tree = tree;
    this.imported = imported;
    this.under = under;
    this.refusals = RoadmapRefusals;
    Object.freeze(this);
  }

  /** @param {ActReader} read */
  load(read) { return loadTree(read, this.tree, this.under === null ? [] : [this.under]); }

  /**
   * @param {LoadedTree} loaded
   * @param {ActIDSource} ids
   */
  decide({ tree, known, steps, links, note, moment }, ids) {
    if (this.under !== null && !known.has(this.under)) return gone(RoadmapStep.type, this.under);
    if (this.imported.steps.length === 0) return ActDecision.unchanged({});
    const scope = RoadmapScopes.tree(this.tree);
    const planned = new StepsImport(this.imported, tree, this.under).planned(moment, ids, scope);
    const made = planned.links;
    const refused = full(steps, planned.units.length, planned.units[0]?.step.id.ref ?? null) ?? full(links, made.length, made[0]?.id.ref ?? null);
    if (refused) return refused;
    const segments = planned.chunks().map((chunk) => {
      const plan = new Plan();
      for (const unit of chunk) unit.writeTo(plan);
      return new ScopedPlan(scope, plan);
    });
    const labels = new Map(planned.units.map((unit) => [String(unit.step.id.record), unit.step.value.label]));
    segments[0]?.plan.device(RoadmapScopes.landing(this.tree), note.adding({
      nodes: planned.units.map((unit) => String(unit.step.id.record)),
      edges: made.map((link) => [link.value.from, link.value.to]),
      names: linkedNames(tree, made.map((link) => link.value.from), labels),
    }).json);
    return ActDecision.write(new ActPlan(segments), planned.ids);
  }
}
