// @ts-check
// Roadmap Coach D-2, §3, §5: the standing roadmap, the roadmaps the room reads as it shows them, in the plain data every
// ability takes (`Standing`). `readStanding` makes it from the device's copies through the domain's reads, and
// `StandingRoadmaps` is what every ability reads of it: whether a call may read the roadmap it names, and each step of
// that roadmap as the room shows it.

import { compareText } from '../../../../platform/domain-kit/entities.js';
import { RoadmapAccount } from '../account.js';
import { RoadmapTree } from '../records.js';
import { LegendRead } from '../reads.js';
import { readRoadmap } from '../roadmaps.js';
import { RoadmapScopes } from '../roadmapRules.js';
import { RoadmapStep } from '../steps.js';
import { StepMark, StepPointer } from '../progress.js';

/** @typedef {import('../../../../platform/domain-kit/values.js').Json} Json */
/** @typedef {import('../../../../platform/domain-kit/entities.js').ViewRecord} ViewRecord */
/** @typedef {import('../records.js').TreeInput} TreeInput */
/** @typedef {import('../records.js').MarkInput} MarkInput */
/** @typedef {import('../graph.js').FollowGraph} FollowGraph */
/** @typedef {import('../account.js').Opening} Opening */
/** @typedef {Parameters<typeof readRoadmap>[1] & { id: string }} RoadmapCopy what the device holds of one roadmap, as `readRoadmap` reads it */
/** @typedef {{ completed: Iterable<string>, completedAt: Record<string, number> }} ShownMarks the marks the room shows of a roadmap */
/** @typedef {{ scope: string, t: string, id: import('../../../../platform/domain-kit/entities.js').RecordID, life: string | null, f: Record<string, string> }} RecordStamps */
/**
 * The standing roadmap as plain data: every roadmap the device holds that the room reads, as the domain's pure reads take
 * it; the steps under a delete the person can still undo; whether the device holds the person's whole list (a vector's
 * trees are that list, so it holds it where `listRead` is left out); and the stamps of the registers they were read from.
 * @typedef {{ trees: TreeInput[], held?: { tree: string, step: string }[], listRead?: boolean, stamps?: RecordStamps[] }} Standing
 */
/** @typedef {{ code: string, id?: string }} AbilityRefusal */
/** @typedef {{ result: { [key: string]: Json } } | { refused: AbilityRefusal }} AbilityAnswer */

// §6.1 The codes a read refuses with.
export const AbilityCodes = Object.freeze({
  invalidInput: 'invalid-input',
  roadmapUnavailable: 'roadmap-unavailable',
  unknownRoadmap: 'unknown-roadmap',
  unknownStep: 'unknown-step',
  roadmapChanged: 'roadmap-changed',
});

/** @param {string} code @param {string} [id] @returns {AbilityAnswer} */
export function refusal(code, id) {
  return { refused: id === undefined ? { code } : { code, id } };
}

// D-2 from the device's copy, as the room reads it: each roadmap through `readRoadmap`, a step the person deleted and can
// still bring back absent from it (`drawn` holds the delete, `stored` the step), and a roadmap the person only reads
// carrying the owner's marks the room shows (`ownerMarks`, which the room read from the backend), since the device holds
// none of them. Each register the roadmaps were read from keeps its stamp: the life and fields of the person's list
// record, of every record of a roadmap's tree scope, and of the marks and pointers of the owner's overlay the device holds.
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
    /** @type {MarkInput[]} */
    const marks = [...shown.completed].sort(compareText).map((node) => ({ node, status: 'complete', outOfOrder: false,
      recordedAt: shown.completedAt[node] ?? null, deviceAt: null, stamp: null }));
    return { ...tree, marks };
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

// What every ability reads of the standing roadmap: the account the domain reads over its trees.
export class StandingRoadmaps {
  /** @param {Standing} standing */
  constructor({ trees, listRead = true }) {
    this.account = new RoadmapAccount(trees.map((tree) => new RoadmapTree(tree)));
    this.listRead = listRead;
  }

  // §10, §6 rule 1: the roadmap a call names, where it is the conversation's (`about`) or one of the person's own and
  // the device holds it whole; else the refusal of the call. A roadmap that is neither is unknown once the device holds
  // the person's whole list, and one the device has not finished bringing, or that stands under one it has not, is
  // unavailable until it has. A roadmap that does not stand, deleted or never finished, is unknown.
  /** @param {string} treeId @param {string | null} about @returns {{ roadmap: StandingRoadmap } | AbilityAnswer} */
  open(treeId, about) {
    const tree = this.account.trees.get(treeId);
    if (tree?.own !== true && treeId !== about) return refusal(this.listRead ? AbilityCodes.unknownRoadmap : AbilityCodes.roadmapUnavailable, treeId);
    if (tree === undefined || tree.read !== 'loaded') return refusal(AbilityCodes.roadmapUnavailable, treeId);
    const graph = this.account.graph(treeId);
    if (graph === null) return refusal(this.account.locate(treeId).standing === 'unknown' ? AbilityCodes.roadmapUnavailable : AbilityCodes.unknownRoadmap, treeId);
    return { roadmap: new StandingRoadmap(this.account, tree, graph) };
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

  /** @param {RoadmapAccount} account @param {RoadmapTree} tree @param {FollowGraph} graph */
  constructor(account, tree, graph) {
    this.account = account;
    this.tree = tree;
    this.graph = graph;
    this.id = tree.id;
    const legend = new LegendRead(tree);
    const owners = legend.result().owners;
    /** @type {Map<string, string>} */
    this.owners = new Map(owners.map(({ hue, id }) => [hue, id]));
    // The kinds the legend shows: each that owns its hue, in the room's order.
    this.kinds = legend.kinds.filter((kind) => owners.some((owner) => owner.id === kind.id));
    /** @type {Map<string, Opening>} */
    this.openings = new Map((account.openings.get(tree.id) ?? []).map((opening) => [opening.node, opening]));
    this.stateAt = this.states();
  }

  // §5: each present step's state by slot, the one the room shows, but `unknown` for an unfinished step that opens a
  // roadmap the device has not finished bringing, or holds nothing of, and for every unfinished step that waits on one.
  /** @returns {('locked' | 'available' | 'complete' | 'unknown')[]} */
  states() {
    const { graph } = this;
    /** @type {('locked' | 'available' | 'complete' | 'unknown')[]} */
    const states = graph.ids.map((_, slot) => graph.states.valueAt(slot));
    const pending = [...this.openings.values()].flatMap((opening) => {
      const slot = graph.slot.get(opening.node);
      return slot !== undefined && !graph.done[slot] && (opening.status === 'unread' || opening.status === 'unknown') ? [slot] : [];
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
    return [...order, ...ids.filter((_, slot) => !placed[slot]).sort(compareText)];
  }

  // §5.1 get_tree's header: the roadmap's title, its kinds as the legend shows them, its own guide and how many steps it has.
  get header() {
    return { title: this.account.locate(this.id).title ?? '', kinds: this.kinds.map(({ id, label, hue, description }) => ({ id, label, hue, description })),
      guide: this.tree.meta?.guide ?? '', stepCount: this.graph.ids.length };
  }

  // §5.1 One present step with the fields asked for, `id` always and first.
  /** @param {string} id @param {readonly string[]} fields @returns {{ [field: string]: Json }} */
  step(id, fields) {
    const slot = this.graph.slot.get(id) ?? 0;
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
    return (this.account.progress(this.id)?.dates ?? []).reduce((latest, { at }) => (at !== null && (latest === null || at > latest) ? at : latest),
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
