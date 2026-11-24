// @ts-check
// Roadmap Coach D-2, §3, §5: the standing roadmap, the roadmaps the room reads as it shows them, in the plain data every
// ability takes (`Standing`). `readStanding` makes it from the device's copies through the domain's reads, and
// `StandingRoadmaps` is what every ability reads of it: whether a call may read the roadmap it names, and each step of
// that roadmap as the room shows it.

import { compareText } from '../../../../platform/domain-kit/entities.js';
import { precondition } from '../../../../platform/domain-kit/values.js';
import { RoadmapAccount } from '../account.js';
import { FollowGraph } from '../graph.js';
import { RoadmapTree } from '../records.js';
import { LegendRead } from '../reads.js';
import { readRoadmap } from '../roadmaps.js';
import { RoadmapScopes } from '../roadmapRules.js';
import { RoadmapStep } from '../steps.js';
import { StepMark, StepPointer } from '../progress.js';
import { AbilityCodes, refusal } from './answers.js';

/** @typedef {import('../../../../platform/domain-kit/values.js').Json} Json */
/** @typedef {import('../../../../platform/domain-kit/entities.js').ViewRecord} ViewRecord */
/** @typedef {import('../records.js').TreeInput} TreeInput */
/** @typedef {import('../records.js').MarkInput} MarkInput */
/** @typedef {import('../records.js').Mark} Mark */
/** @typedef {import('../account.js').Opening} Opening */
/** @typedef {import('./answers.js').AbilityResponse} AbilityResponse */
/** @typedef {Parameters<typeof readRoadmap>[1] & { id: string }} RoadmapCopy what the device holds of one roadmap, as `readRoadmap` reads it */
/**
 * What the room shows of a roadmap the person only reads, as it read it from the backend: the owner's completed steps,
 * the server's date of each, and by step what the server said the subtree it owns has come to, where it said (`read`).
 * @typedef {{ completed: Iterable<string>, completedAt: Record<string, number>,
 *   subtrees?: ReadonlyMap<string, { treeId: string, read: boolean, complete: boolean }> }} ShownMarks
 */
/** @typedef {{ scope: string, t: string, id: import('../../../../platform/domain-kit/entities.js').RecordID, life: string | null, f: Record<string, string> }} RecordStamps */
/**
 * The standing roadmap as plain data: every roadmap the device holds that the room reads, as the domain's pure reads take
 * it; the steps under a delete the person can still undo; whether the device holds the person's whole list (a vector's
 * trees are that list, so it holds it where `listRead` is left out); and the stamps of the registers they were read from.
 * Nothing changes it once made: its reading is made once (`StandingRoadmaps.of`).
 * @typedef {{ trees: TreeInput[], held?: { tree: string, step: string }[], listRead?: boolean, stamps?: RecordStamps[] }} Standing
 */

// D-2 from the device's copy, as the room reads it: each roadmap through `readRoadmap`, a step the person deleted and can
// still bring back absent from it (`drawn` holds the delete, `stored` the step), and a roadmap the person only reads
// carrying what the room shows of the owner's marks (`ownerMarks`, which the room read from the backend), since the device
// holds none of them: each completed step's mark, and on a step whose subtree the server told of, a mark saying whether
// that subtree is complete. Each register the roadmaps were read from keeps its stamp: the life and fields of the
// person's list record, of every record of a roadmap's tree scope, and of the marks and pointers of the owner's overlay
// the device holds.
/**
 * @param {RoadmapCopy[]} copies
 * @param {{ listRead?: boolean, ownerMarks?: ReadonlyMap<string, ShownMarks> }} [room]
 * @returns {Required<Standing>}
 */
export function readStanding(copies, { listRead = true, ownerMarks = new Map() } = {}) {
  const trees = copies.map(({ id, ...copy }) => {
    const tree = readRoadmap(id, copy).json;
    const shown = ownerMarks.get(id);
    if (tree.own || shown === undefined) return tree;
    /** @type {Map<string, MarkInput>} */
    const marks = new Map([...shown.completed].map((node) => [node, { node, status: 'complete', outOfOrder: false,
      recordedAt: shown.completedAt[node] ?? null, deviceAt: null, stamp: null }]));
    for (const step of tree.nodes ?? []) {
      const told = shown.subtrees?.get(step.id);
      if (told?.read && told.treeId === step.branch) marks.set(step.id, { node: step.id, status: told.complete ? 'complete' : 'none',
        outOfOrder: false, recordedAt: null, deviceAt: null, stamp: null });
    }
    return { ...tree, marks: [...marks.values()].sort((a, b) => compareText(a.node, b.node)) };
  });
  const held = copies.flatMap(({ id, tree }) => {
    const shown = new Set(tree.views.visible('drawn', RoadmapStep.type).map((record) => String(record.id)));
    return tree.views.visible('stored', RoadmapStep.type).filter((record) => !shown.has(String(record.id)))
      .map((record) => ({ tree: id, step: String(record.id) }));
  });
  /** @param {string} scope @param {ViewRecord} record @returns {RecordStamps} */
  const stamped = (scope, record) => ({ scope, t: record.t, id: record.id, life: record.life?.[1] ?? null,
    f: Object.fromEntries(Object.entries(record.f ?? {}).map(([name, [, stamp]]) => [name, stamp])) });
  const stamps = copies.flatMap(({ listed = null, tree, overlay = null }) => [
    ...(listed ? [stamped(RoadmapScopes.account, listed)] : []),
    ...[...tree.views.drawn.values()].map((record) => stamped(tree.scope, record)),
    ...(overlay ? [...overlay.views.drawn.values()].filter((record) => record.t === StepMark.type || record.t === StepPointer.type)
      .map((record) => stamped(overlay.scope, record)) : []),
  ]);
  return { trees, held, listRead, stamps };
}

// Each standing roadmap's reading, made the first time an ability reads it: a turn reads one standing many times, and
// every reading reads the device's every roadmap.
/** @type {WeakMap<Standing, StandingRoadmaps>} */
const readings = new WeakMap();

// What every ability reads of the standing roadmap: the account the domain reads over its trees, each roadmap's
// completed steps as the room shows them, and the roadmaps whose completion waits on one the device has not brought.
export class StandingRoadmaps {
  /** @type {Map<string, { completed: string[], dates: { node: string, at: number | null }[] }>} */
  #progress = new Map();
  /** @type {Map<string, StandingRoadmap>} */
  #roadmaps = new Map();
  /** @type {Set<string> | null} */
  #uncertain = null;

  /** @param {Standing} standing */
  static of(standing) {
    const known = readings.get(standing);
    if (known) return known;
    const reading = new StandingRoadmaps(standing);
    readings.set(standing, reading);
    return reading;
  }

  /** @param {Standing} standing */
  constructor({ trees, listRead = true }) {
    this.account = new RoadmapAccount(trees.map((tree) => new RoadmapTree(tree)));
    this.listRead = listRead;
  }

  // §10, §6 rule 1: the roadmap a call names, where it is the conversation's (`about`) or one of the person's own and
  // the device holds it whole; else the refusal of the call. A roadmap that is neither is unknown once the device holds
  // the person's whole list, and one the device has not finished bringing, or that stands under one it has not, is
  // unavailable until it has. A roadmap that does not stand, deleted or never finished, is unknown.
  /** @param {string} treeId @param {string | null} about @returns {{ roadmap: StandingRoadmap } | AbilityResponse} */
  open(treeId, about) {
    const tree = this.account.trees.get(treeId);
    if (tree?.own !== true && treeId !== about) return refusal(this.listRead ? AbilityCodes.unknownRoadmap : AbilityCodes.roadmapUnavailable, treeId);
    if (tree === undefined || tree.read !== 'loaded') return refusal(AbilityCodes.roadmapUnavailable, treeId);
    const { standing } = this.account.locate(treeId);
    if (standing !== 'standing') return refusal(standing === 'unknown' ? AbilityCodes.roadmapUnavailable : AbilityCodes.unknownRoadmap, treeId);
    const known = this.#roadmaps.get(treeId);
    if (known) return { roadmap: known };
    const roadmap = new StandingRoadmap(this, tree);
    this.#roadmaps.set(treeId, roadmap);
    return { roadmap };
  }

  // §5 A roadmap's completed steps and their dates as the room shows them: the domain's `progress` read, where a step
  // that opens a roadmap is complete when that roadmap is; and on a roadmap the person only reads, a step that opens one
  // the device holds no whole copy of, complete where the mark the room shows of it says so, the server's word.
  /** @param {string} id */
  progress(id) {
    const known = this.#progress.get(id);
    if (known) return known;
    const tree = /** @type {RoadmapTree} */ (this.account.trees.get(id));
    const read = this.account.progress(id) ?? { completed: [], dates: [] };
    const told = (this.account.openings.get(id) ?? []).flatMap((opening) => {
      const mark = this.told(tree, opening);
      return mark?.status === 'complete' ? [{ node: opening.node, at: mark.at }] : [];
    });
    const progress = { completed: [...read.completed, ...told.map(({ node }) => node)], dates: [...read.dates, ...told] };
    this.#progress.set(id, progress);
    return progress;
  }

  // The mark the room shows of a step whose opening the device holds no whole copy of, on a roadmap the person only
  // reads: the server's word of the subtree it owns (`readStanding`). Null where the room shows none, or the device
  // reads the opening itself.
  /** @param {RoadmapTree} tree @param {Opening} opening @returns {Mark | null} */
  told(tree, opening) {
    return !tree.own && (opening.status === 'unread' || opening.status === 'unknown') ? tree.marks.get(opening.node) ?? null : null;
  }

  // §5 Whether what an opening comes to waits on a roadmap the device has not brought: one it has not finished bringing
  // or holds nothing of, or one whose own completion waits on such a roadmap in turn; the room's word taken where it shows
  // one.
  /** @param {RoadmapTree} tree @param {Opening} opening */
  waitsOnUnbrought(tree, opening) {
    if (opening.status === 'dangling' || this.told(tree, opening) !== null) return false;
    return opening.status === 'unread' || opening.status === 'unknown' || this.uncertain.has(opening.tree);
  }

  // §5 The roadmaps whose completion waits on a roadmap the device has not brought: each that is not complete, and whose
  // every unfinished step opens one the device has not brought, or one of these in turn. Grown from those that wait on an
  // unbrought roadmap directly, so a loop of roadmaps that waits on none is plainly incomplete.
  get uncertain() {
    if (this.#uncertain) return this.#uncertain;
    /** @type {Map<string, Opening[]>} */
    const waiting = new Map();
    for (const [id, openings] of this.account.openings) {
      const tree = /** @type {RoadmapTree} */ (this.account.trees.get(id));
      const done = new Set(this.progress(id).completed);
      const opens = new Map(openings.map((opening) => [opening.node, opening]));
      const unfinished = tree.nodes.filter((node) => node.present && !done.has(node.id)).map((node) => opens.get(node.id));
      if (!unfinished.length || unfinished.some((opening) => opening === undefined || opening.status === 'dangling' || this.told(tree, opening))) continue;
      waiting.set(id, /** @type {Opening[]} */ (unfinished));
    }
    const uncertain = new Set();
    for (let grew = true; grew;) {
      grew = false;
      for (const [id, openings] of waiting) {
        if (uncertain.has(id) || !openings.every((opening) => opening.status === 'unread' || opening.status === 'unknown' || uncertain.has(opening.tree))) continue;
        uncertain.add(id);
        grew = true;
      }
    }
    this.#uncertain = uncertain;
    return uncertain;
  }
}

// §5.1 The fields a step comes with where a call names none: the context's line.
export const STEP_LINE = Object.freeze(['id', 'label', 'kind', 'state', 'prerequisites', 'unlockCount', 'summary']);
// §5.1 A summary is the description's first 160 Unicode scalars, `…` added where it is longer.
const SUMMARY_SCALARS = 160;

// One roadmap as the room shows it, read whole: its present steps in the room's order, what each follows through removed
// steps and what finishing it alone opens, the kind that owns each hue, what each step opens, and each step's state.
export class StandingRoadmap {
  /** @type {number[][] | null} */
  #follows = null;
  /** @type {string[] | null} */
  #order = null;

  /** @param {StandingRoadmaps} roadmaps @param {RoadmapTree} tree */
  constructor(roadmaps, tree) {
    this.roadmaps = roadmaps;
    this.tree = tree;
    this.id = tree.id;
    const progress = roadmaps.progress(tree.id);
    this.graph = new FollowGraph(tree, new Set(progress.completed), new Map(progress.dates.map(({ node, at }) => [node, at])));
    // The kinds the legend shows, and the one that owns each hue.
    this.kinds = new LegendRead(tree).shown;
    this.owners = new Map(this.kinds.map((kind) => [kind.hue, kind.id]));
    /** @type {Map<string, Opening>} */
    this.openings = new Map((roadmaps.account.openings.get(tree.id) ?? []).map((opening) => [opening.node, opening]));
    this.stateAt = this.states();
  }

  // §5: each present step's state by slot, the one the room shows, but `unknown` for an unfinished step whose opened
  // roadmap waits on one the device has not brought, and for every unfinished step that waits on such a step.
  /** @returns {('locked' | 'available' | 'complete' | 'unknown')[]} */
  states() {
    const { graph } = this;
    /** @type {('locked' | 'available' | 'complete' | 'unknown')[]} */
    const states = graph.ids.map((_, slot) => graph.states.valueAt(slot));
    const pending = [...this.openings.values()].flatMap((opening) => {
      const slot = graph.slot.get(opening.node);
      return slot !== undefined && !graph.done[slot] && this.roadmaps.waitsOnUnbrought(this.tree, opening) ? [slot] : [];
    });
    if (!pending.length) return states;
    const waiting = this.waiting();
    const reached = new Uint8Array(states.length);
    for (const slot of pending) reached[slot] = 1;
    while (pending.length) {
      const slot = /** @type {number} */ (pending.pop());
      states[slot] = 'unknown';
      for (const next of waiting[slot] ?? []) {
        if (reached[next] || graph.done[next]) continue;
        reached[next] = 1;
        pending.push(next);
      }
    }
    return states;
  }

  // What each present step follows, by slot, through removed steps, in the room's order (the graph's `followed`).
  follows() {
    this.#follows ??= this.graph.ids.map((id) => this.graph.followed(id).map((entry) => this.graph.slot.get(entry.id) ?? 0));
    return this.#follows;
  }

  // The steps that follow each present step, by slot.
  waiting() {
    /** @type {number[][]} */
    const waiting = this.graph.ids.map(() => []);
    for (const [slot, prerequisites] of this.follows().entries()) for (const prerequisite of prerequisites) waiting[prerequisite]?.push(slot);
    return waiting;
  }

  /** @param {string} id */
  state(id) {
    const slot = this.graph.slot.get(id);
    return slot === undefined ? null : this.stateAt[slot] ?? null;
  }

  // §5.1 get_tree's order, as present step ids: each step after every step it follows, and of the steps that can come
  // next, the first in the room's order (its slot); a step on a loop, or after one, last, in id byte order.
  order() {
    if (this.#order) return this.#order;
    const { ids } = this.graph;
    const waits = Int32Array.from(this.follows(), (prerequisites) => prerequisites.length);
    const waiting = this.waiting();
    const ready = new SlotHeap(ids.flatMap((_, slot) => (waits[slot] === 0 ? [slot] : [])));
    const placed = new Uint8Array(ids.length);
    /** @type {string[]} */
    const order = [];
    for (let slot = ready.pop(); slot !== null; slot = ready.pop()) {
      placed[slot] = 1;
      order.push(ids[slot] ?? '');
      for (const next of waiting[slot] ?? []) {
        const left = (waits[next] ?? 0) - 1;
        waits[next] = left;
        if (left === 0) ready.push(next);
      }
    }
    this.#order = [...order, ...ids.filter((_, slot) => !placed[slot]).sort(compareText)];
    return this.#order;
  }

  // §5.1 get_tree's header: the roadmap's title, its kinds as the legend shows them, its own guide and how many steps it has.
  get header() {
    return { title: this.roadmaps.account.locate(this.id).title ?? '', kinds: this.kinds.map(({ id, label, hue, description }) => ({ id, label, hue, description })),
      guide: this.tree.meta?.guide ?? '', stepCount: this.graph.ids.length };
  }

  // §5.1 One present step with the fields asked for, `id` always and first.
  /** @param {string} id @param {readonly string[]} fields @returns {{ [field: string]: Json }} */
  step(id, fields) {
    const slot = this.graph.slot.get(id);
    precondition(slot !== undefined, `a step is read only where the roadmap shows it: ${id}`);
    const node = /** @type {import('../records.js').Step} */ (this.graph.nodes[slot]);
    /** @type {Record<string, () => Json>} */
    const field = {
      label: () => node.label,
      kind: () => this.owners.get(node.color) ?? null,
      state: () => this.stateAt[slot] ?? null,
      prerequisites: () => this.graph.followed(id).map((entry) => entry.id),
      unlockCount: () => this.graph.unlocksAt(slot).length,
      summary: () => {
        const scalars = [...node.description];
        return scalars.length > SUMMARY_SCALARS ? `${scalars.slice(0, SUMMARY_SCALARS).join('')}…` : node.description;
      },
      description: () => node.description,
      links: () => node.links.map(({ url, label }) => ({ url, label })),
      opens: () => this.openings.get(id)?.tree ?? null,
    };
    return Object.fromEntries([['id', id], ...fields.filter((name) => name !== 'id' && field[name]).map((name) => [name, field[name]?.() ?? null])]);
  }

  // §5.1 list_trees' counts: every present step, and how many stand in each state.
  get counts() {
    const counts = { total: this.stateAt.length, done: 0, available: 0, locked: 0, unknown: 0 };
    for (const state of this.stateAt) counts[state === 'complete' ? 'done' : state]++;
    return counts;
  }

  // The newest date the roadmap's completions carry, or null where none carries one.
  get lastCompletedAt() {
    return this.roadmaps.progress(this.id).dates.reduce((latest, { at }) => (at !== null && (latest === null || at > latest) ? at : latest),
      /** @type {number | null} */ (null));
  }
}

// The present steps that can come next in get_tree's order, the first in the room's order (the lowest slot) first.
class SlotHeap {
  /** @param {number[]} slots in ascending order, so already a heap */
  constructor(slots) { this.slots = slots; }

  /** @param {number} slot */
  push(slot) {
    const { slots } = this;
    let at = slots.push(slot) - 1;
    while (at > 0) {
      const parent = (at - 1) >> 1;
      if ((slots[parent] ?? 0) <= slot) break;
      slots[at] = slots[parent] ?? 0;
      at = parent;
    }
    slots[at] = slot;
  }

  pop() {
    const { slots } = this;
    const first = slots[0];
    const last = slots.pop();
    if (first === undefined || last === undefined) return null;
    if (!slots.length) return first;
    let at = 0;
    for (;;) {
      const child = 2 * at + 1;
      if (child >= slots.length) break;
      const smaller = child + 1 < slots.length && (slots[child + 1] ?? 0) < (slots[child] ?? 0) ? child + 1 : child;
      if ((slots[smaller] ?? 0) >= last) break;
      slots[at] = slots[smaller] ?? 0;
      at = smaller;
    }
    slots[at] = last;
    return first;
  }
}
