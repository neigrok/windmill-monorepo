// @ts-check
import { compareText } from '../../../platform/domain-kit/entities.js';
import { Stamp } from '../../../../../packages/api-contract/sync/reference/core/stamp.js';
import { RoadmapTree } from './records.js';
import { FollowGraph } from './graph.js';
import { HUES } from './roadmapRules.js';

export class LegendRead {
  /** @param {RoadmapTree} tree */
  constructor(tree) {
    this.kinds = tree.kinds.filter((kind) => kind.present);
    /** @type {Map<string,import('./records.js').Kind[]>} */
    this.byHue = new Map();
    for (const kind of this.kinds) {
      if (!this.byHue.has(kind.hue)) this.byHue.set(kind.hue, []);
      this.byHue.get(kind.hue)?.push(kind);
    }
    for (const kinds of this.byHue.values()) kinds.sort((a, b) => Stamp.compare(a.born, b.born) || compareText(a.id, b.id));
    const worn = new Set(tree.nodes.filter((node) => node.present).map((node) => node.color));
    // The legend a roadmap shows, which a paste reads its text over: each hue's owner in the kinds' order, then each hue
    // a present step wears that no kind claims, in the palette's order, with no kind.
    /** @type {{hue: string, kind: import('./records.js').Kind | null}[]} */
    this.shown = [
      ...this.kinds.filter((kind) => this.byHue.get(kind.hue)?.[0] === kind).map((kind) => ({ hue: kind.hue, kind })),
      ...HUES.filter((hue) => worn.has(hue) && !this.byHue.has(hue)).map((hue) => ({ hue, kind: null })),
    ];
  }

  result() {
    const hues = [...this.byHue].sort((a, b) => compareText(a[0], b[0]));
    return { ids: this.kinds.map((kind) => kind.id), owners: hues.map(([hue, kinds]) => ({ hue, id: kinds[0]?.id ?? '' })),
      collisions: hues.filter(([, kinds]) => kinds.length > 1).map(([hue, kinds]) => ({ hue, owner: kinds[0]?.id ?? '', others: kinds.slice(1).map((kind) => kind.id).sort(compareText) })),
      shown: this.shown.map(({ hue, kind }) => ({ hue, id: kind?.id ?? null })),
    };
  }
}

/** @param {string} text */
function asciiLower(text) { return text.replace(/[A-Z]/g, (letter) => letter.toLowerCase()); }

/** @param {RoadmapTree} tree @param {{query?:string,color?:string,kind?:string}} filter */
export function selectNodes(tree, filter = {}) {
  const kind = filter.kind === undefined ? null : tree.kinds.find((item) => item.present && item.id === filter.kind);
  if (filter.kind !== undefined && !kind) return [];
  const needle = asciiLower(filter.query ?? '');
  const ranked = [];
  for (const node of tree.nodes) {
    if (!node.present || (filter.color !== undefined && node.color !== filter.color) || (kind && node.color !== kind.hue)) continue;
    const id = asciiLower(node.id);
    const rank = needle === '' ? 5 : id === needle ? 0 : id.startsWith(needle) ? 1 : asciiLower(node.label).includes(needle) ? 2
      : id.includes(needle) ? 3 : asciiLower(node.description).includes(needle) ? 4 : -1;
    if (rank >= 0) ranked.push({ id: node.id, rank });
  }
  return ranked.sort((a, b) => a.rank - b.rank).map((match) => match.id);
}

/** @typedef {{sort?:'roadmap'|'newest'|'oldest',kinds?:string[],search?:string,branch?:string|null,doneExpanded?:boolean}} BoardQuery */

export class BoardRead {
  /** @param {FollowGraph} graph @param {BoardQuery} query */
  constructor(graph, query = {}) {
    this.graph = graph;
    this.sort = query.sort ?? 'roadmap';
    if (!['roadmap', 'newest', 'oldest'].includes(this.sort)) throw new TypeError('Unknown Board sort');
    const branch = graph.branch(query.branch ?? '');
    this.branch = branch === null ? null : query.branch ?? null;
    const needle = (query.search ?? '').trim().toLowerCase();
    const hues = new Set(query.kinds ?? []);
    this.recovery = needle ? hues.size ? 'both' : 'search' : hues.size ? 'kinds' : null;
    this.expanded = query.doneExpanded ?? false;
    this.overall = { done: graph.stateAt.reduce((done, state) => done + (state === 2 ? 1 : 0), 0), total: graph.ids.length };
    const { toGo } = graph.owedIndex();
    /** @type {{id:string,column:string,needs:{first:string|null,extra:number,toGo:number}|null,unlocks:{first:string,extra:number}|null,unlockCount:number}[]} */
    this.cards = [];
    // Each card's slot in the graph, so a sort reads its keys by index.
    /** @type {number[]} */
    this.slots = [];
    for (let slot = 0; slot < graph.nodes.length; slot++) {
      const node = /** @type {import('./records.js').Step} */ (graph.nodes[slot]);
      if ((branch !== null && !branch.has(node.id)) || (hues.size && !hues.has(node.color))
        || (needle && !node.label.toLowerCase().includes(needle) && !node.description.toLowerCase().includes(needle))) continue;
      const state = graph.states.valueAt(slot);
      const unlocked = state === 'complete' ? [] : graph.unlocksAt(slot);
      this.slots.push(slot);
      this.cards.push({ id: node.id, column: state === 'complete' ? 'done' : state === 'locked' ? 'locked' : 'upNext',
        needs: state === 'locked' ? { first: graph.ids[graph.firstUnmet[slot] ?? -1] ?? null, extra: (graph.unmetCount[slot] ?? 0) - 1, toGo: toGo[slot] ?? 0 } : null,
        unlocks: state === 'available' && unlocked.length ? { first: unlocked[0] ?? '', extra: unlocked.length - 1 } : null, unlockCount: unlocked.length,
      });
    }
  }

  result() {
    const graph = this.graph;
    /** @type {Record<string, number[]>} */
    const byColumn = { locked: [], upNext: [], done: [] };
    for (let index = 0; index < this.cards.length; index++) byColumn[this.cards[index]?.column ?? '']?.push(index);
    const columns = ['locked', 'upNext', 'done'].map((name) => {
      const members = byColumn[name] ?? [];
      const slotOf = (/** @type {number} */ index) => this.slots[index] ?? 0;
      const cardOf = (/** @type {number} */ index) => /** @type {(typeof this.cards)[number]} */ (this.cards[index]);
      members.sort((a, b) => {
        if (name === 'done') return dateOrder(graph.dateAt[slotOf(a)] ?? null, graph.dateAt[slotOf(b)] ?? null, true);
        if (this.sort === 'roadmap') return (cardOf(a).needs?.toGo ?? 0) - (cardOf(b).needs?.toGo ?? 0) || cardOf(b).unlockCount - cardOf(a).unlockCount;
        return dateOrder(graph.nodes[slotOf(a)]?.createdAt ?? null, graph.nodes[slotOf(b)]?.createdAt ?? null, this.sort === 'newest');
      });
      const cards = members.map(cardOf);
      const ids = cards.map((card) => card.id);
      const folded = name === 'done' && !this.expanded && ids.length > 12;
      return { name, count: ids.length, ids, shown: folded ? ids.slice(0, 12) : ids, folded };
    });
    return { overall: this.overall, sort: this.sort, branch: this.branch, recovery: this.recovery, columns, cards: this.cards };
  }
}

// A roadmap's Activity, or with `step` that step's History (spec §3, R-11): each present step's creation and completion
// that the copy holds a time for, newest first. At one time a completion stands before a creation, then the roadmap's
// authored order reversed, the last authored step first. A completion is the graph's, so a step that opens or owns a
// roadmap is completed, and dated, as the Board's Done has it.
export class ActivityRead {
  /** @param {FollowGraph} graph @param {string|null} step */
  constructor(graph, step = null) {
    /** @type {{kind:'created'|'completed', step:string, at:number, slot:number}[]} */
    const rows = [];
    for (let slot = 0; slot < graph.nodes.length; slot++) {
      const node = /** @type {import('./records.js').Step} */ (graph.nodes[slot]);
      if (step !== null && node.id !== step) continue;
      const completedAt = graph.done[slot] ? graph.dateAt[slot] ?? null : null;
      if (completedAt !== null) rows.push({ kind: 'completed', step: node.id, at: completedAt, slot });
      if (node.createdAt !== null) rows.push({ kind: 'created', step: node.id, at: node.createdAt, slot });
    }
    rows.sort((a, b) => b.at - a.at || Number(a.kind === 'created') - Number(b.kind === 'created') || b.slot - a.slot);
    this.rows = rows.map(({ kind, step: id, at }) => ({ kind, step: id, at }));
  }

  result() { return this.rows; }
}

/** @param {number|null} a @param {number|null} b @param {boolean} newest */
function dateOrder(a, b, newest) {
  if (a === null || b === null) return Number(a === null) - Number(b === null);
  return newest ? b - a : a - b;
}

/** @param {FollowGraph} graph @param {string[][]} edges the device's own links, `[from, to]` */
export function landingFacts(graph, edges) {
  const linked = new Map();
  for (const [from, to] of edges) {
    if (!linked.has(to)) linked.set(to, new Set());
    linked.get(to).add(from);
  }
  return graph.ids.flatMap((node) => {
    if (!linked.has(node)) return [];
    const sources = new Set(graph.tree.index.absentParents(node).filter((from) => linked.get(node).has(from)));
    if (!sources.size) return [];
    const incoming = [...sources].sort(compareText).map((from) => [from, node]);
    const followed = graph.followed(node).flatMap((entry) => {
      const through = entry.incoming.filter(([from]) => sources.has(from ?? ''));
      return through.length ? [{ ...entry, incoming: through }] : [];
    });
    return [{ node, incoming, followed }];
  });
}

// What deleting `ids` or resetting one would do (the corpus README's `effects`); `follow` walks the graph when asked.
export class EffectsRead {
  /** @type {FollowGraph} */
  #graph;
  /** @type {number[]} */
  #chosen;
  /** @type {boolean} */
  #marked;

  /** @param {FollowGraph} graph @param {string[]} ids */
  constructor(graph, ids) {
    const slots = ids.flatMap((id) => {
      const slot = graph.slot.get(id);
      return slot === undefined ? [] : [slot];
    });
    const chosen = new Set(slots);
    const present = slots.length === ids.length;
    this.#graph = graph;
    this.#chosen = [...chosen];
    this.kept = graph.starting.length === 1 ? graph.starting[0] ?? null : null;
    this.takesEveryStart = graph.starting.length > 0 && graph.starting.every((id) => chosen.has(graph.slot.get(id) ?? -1));
    this.deletable = ids.length > 0 && present && !this.takesEveryStart;
    const [only = -1] = this.#chosen;
    this.#marked = present && chosen.size === 1 && graph.done[only] === 1 && graph.tree.index.markedDone[only] === 1;
  }

  get follow() {
    const graph = this.#graph;
    // A present step stops the walk: what follows it follows it, not the selection.
    const passed = new Set(this.#chosen);
    const pending = [...this.#chosen];
    /** @type {number[]} */
    const followers = [];
    for (let vertex = pending.pop(); vertex !== undefined; vertex = pending.pop()) {
      for (const next of graph.children[vertex] ?? []) {
        if (passed.has(next)) continue;
        passed.add(next);
        if (next < graph.ids.length) followers.push(next);
        else pending.push(next);
      }
    }
    return followers.sort((a, b) => a - b).map((slot) => graph.ids[slot] ?? '');
  }

  get relocks() { return this.#marked ? this.follow.filter((id) => this.#graph.states.get(id) === 'available') : []; }

  result() {
    return { kept: this.kept, takesEveryStart: this.takesEveryStart, deletable: this.deletable, follow: this.follow, relocks: this.relocks };
  }
}
