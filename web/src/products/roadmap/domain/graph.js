// @ts-check
import { compareText } from '../../../platform/domain-kit/entities.js';
import { RoadmapTree } from './records.js';

/** @param {number[][]} adjacency */
export function components(adjacency) {
  const reached = new Int32Array(adjacency.length).fill(-1);
  const low = new Int32Array(adjacency.length);
  const active = new Uint8Array(adjacency.length);
  const componentOf = new Int32Array(adjacency.length);
  /** @type {number[]} */
  const pending = [];
  /** @type {number[][]} */
  const groups = [];
  let serial = 0;
  for (let start = 0; start < adjacency.length; start++) {
    if (reached[start] !== -1) continue;
    const walk = [{ vertex: start, next: 0 }];
    while (walk.length) {
      const frame = walk[walk.length - 1];
      if (!frame) break;
      const vertex = frame.vertex;
      if (reached[vertex] === -1) {
        reached[vertex] = low[vertex] = serial++;
        active[vertex] = 1;
        pending.push(vertex);
      }
      const parents = adjacency[vertex] ?? [];
      if (frame.next < parents.length) {
        const parent = parents[frame.next++] ?? 0;
        if (reached[parent] === -1) walk.push({ vertex: parent, next: 0 });
        else if (active[parent]) low[vertex] = Math.min(low[vertex] ?? 0, reached[parent] ?? 0);
        continue;
      }
      walk.pop();
      const previous = walk[walk.length - 1];
      if (previous) low[previous.vertex] = Math.min(low[previous.vertex] ?? 0, low[vertex] ?? 0);
      if (low[vertex] !== reached[vertex]) continue;
      const group = [];
      let member;
      do {
        member = pending.pop();
        if (member === undefined) throw new TypeError('Invalid roadmap component stack');
        active[member] = 0;
        componentOf[member] = groups.length;
        group.push(member);
      } while (member !== vertex);
      groups.push(group);
    }
  }
  return { groups, componentOf };
}

// Bitset rows over `size` bits for the `members` of a raw graph, through strongly connected components: a member's row
// holds the bit `seedOf` gives its vertex (none for -1) and, where `follows` reads the member through to its parents,
// the rows of the members among them. A vertex outside the members has no row, so only the vertices a read passes
// through take one.
class Closure {
  /**
   * @param {number[]} members
   * @param {number[][]} parents
   * @param {Int32Array} seedOf
   * @param {(vertex: number) => boolean} follows
   * @param {number} size
   */
  constructor(members, parents, seedOf, follows, size) {
    this.words = Math.ceil(size / 32);
    this.index = new Int32Array(seedOf.length).fill(-1);
    members.forEach((vertex, index) => { this.index[vertex] = index; });
    const adjacency = members.map((vertex) => {
      /** @type {number[]} */
      const inside = [];
      for (const parent of follows(vertex) ? parents[vertex] ?? [] : []) {
        const index = this.index[parent] ?? -1;
        if (index >= 0) inside.push(index);
      }
      return inside;
    });
    const { groups, componentOf } = components(adjacency);
    this.componentOf = componentOf;
    this.bits = new Uint32Array(groups.length * this.words);
    const merged = new Int32Array(groups.length).fill(-1);
    for (const [component, group] of groups.entries()) {
      const row = component * this.words;
      for (const member of group) {
        const bit = seedOf[members[member] ?? 0] ?? -1;
        if (bit >= 0) this.bits[row + (bit >>> 5)] = (this.bits[row + (bit >>> 5)] ?? 0) | (1 << (bit & 31));
        for (const parent of adjacency[member] ?? []) {
          const dependency = componentOf[parent] ?? 0;
          if (dependency === component || merged[dependency] === component) continue;
          merged[dependency] = component;
          const source = dependency * this.words;
          for (let word = 0; word < this.words; word++) this.bits[row + word] = (this.bits[row + word] ?? 0) | (this.bits[source + word] ?? 0);
        }
      }
    }
  }

  // The offset of a vertex's row, or -1 when it has none.
  /** @param {number} vertex */
  row(vertex) {
    const index = this.index[vertex] ?? -1;
    return index < 0 ? -1 : (this.componentOf[index] ?? 0) * this.words;
  }

}

// The present steps' values by id, read from a value kept at each step's slot: a map that costs nothing to build.
/** @template V */
export class BySlot {
  /** @param {Map<string,number>} slot @param {string[]} ids @param {(slot: number) => V} valueAt */
  constructor(slot, ids, valueAt) {
    this.slot = slot;
    this.ids = ids;
    this.valueAt = valueAt;
    Object.freeze(this);
  }

  /** @param {string} id */
  get(id) {
    const slot = this.slot.get(id);
    return slot === undefined ? undefined : this.valueAt(slot);
  }

  /** @returns {IterableIterator<[string, V]>} */
  *[Symbol.iterator]() {
    for (const [slot, id] of this.ids.entries()) yield [id, this.valueAt(slot)];
  }
}

const STATES = /** @type {const} */ (['available', 'locked', 'complete']);

/** @param {number} bits */
function bitCount(bits) {
  bits -= (bits >>> 1) & 0x55555555;
  bits = (bits & 0x33333333) + ((bits >>> 2) & 0x33333333);
  return Math.imul((bits + (bits >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24;
}

export class FollowGraph {
  /** @param {RoadmapTree} tree @param {ReadonlySet<string>|null} completed @param {ReadonlyMap<string,number|null>|null} dates */
  constructor(tree, completed = null, dates = null) {
    if (tree.read !== 'loaded') throw new TypeError('Roadmap graph is unread');
    this.tree = tree;
    // The tree's link structure, shared: a graph adds what the marks decide.
    const { nodes, ids, slot, edges, rawIds, rawSlot, parents, children, markedDone, markedAt } = tree.index;
    this.nodes = nodes;
    this.ids = ids;
    this.slot = slot;
    this.edges = edges;
    this.rawIds = rawIds;
    this.rawSlot = rawSlot;
    this.parents = parents;
    this.children = children;
    // A present step's raw vertex is its slot, since present steps come first among the raw ids.
    const present = (/** @type {number} */ vertex) => vertex < this.ids.length;
    const absent = Array.from({ length: this.rawIds.length - this.ids.length }, (_, index) => this.ids.length + index);
    // What each absent step is read through to: the present steps behind it (D-5). A present step that leads into an
    // absent one stops the read and holds its own bit.
    const touching = new Set(absent.flatMap((vertex) => (this.parents[vertex] ?? []).filter(present)));
    const ownSlot = new Int32Array(this.rawIds.length).fill(-1);
    for (const vertex of touching) ownSlot[vertex] = vertex;
    /** @type {Closure} */
    this.reach = new Closure([...touching, ...absent], this.parents, ownSlot, (vertex) => !present(vertex), this.ids.length);
    // Which steps are complete, and when, by slot: the given ones, or the tree's own marks.
    const done = completed === null ? markedDone : new Uint8Array(this.ids.length);
    for (const id of completed ?? []) {
      const at = this.slot.get(id);
      if (at !== undefined) done[at] = 1;
    }
    /** @type {(number|null)[]} */
    this.dateAt = dates === null ? markedAt : this.ids.map((id) => dates.get(id) ?? null);
    this.done = done;
    this.dates = new BySlot(this.slot, this.ids, (slot) => this.dateAt[slot] ?? null);
    // The followed prerequisites of a step behind an absent parent, as a bitset row; any other step follows its parents.
    /** @type {Map<number,Uint32Array>} */
    this.rows = new Map();
    // Each step's state (an index of STATES), its unmet prerequisites' count and first, its followed count, and the
    // steps it alone would open, all by slot.
    this.stateAt = new Uint8Array(this.ids.length);
    this.unmetCount = new Int32Array(this.ids.length);
    this.firstUnmet = new Int32Array(this.ids.length).fill(-1);
    this.degree = new Int32Array(this.ids.length);
    /** @type {(number[]|undefined)[]} */
    this.opens = [];
    // The step whose parents last counted each parent, so a parent linked twice counts once.
    const countedFor = new Int32Array(this.ids.length).fill(-1);
    for (let slot = 0; slot < this.ids.length; slot++) {
      const parents = this.parents[slot] ?? [];
      let count = 0;
      let degree = 0;
      let first = -1;
      if (parents.every(present)) {
        for (const parent of parents) {
          if (countedFor[parent] === slot) continue;
          countedFor[parent] = slot;
          degree++;
          if (done[parent]) continue;
          if (first < 0 || parent < first) first = parent;
          count++;
        }
      } else {
        const row = new Uint32Array(this.reach.words);
        for (const parent of parents) {
          if (present(parent)) {
            row[parent >>> 5] = (row[parent >>> 5] ?? 0) | (1 << (parent & 31));
            continue;
          }
          const source = this.reach.row(parent);
          if (source >= 0) for (let word = 0; word < row.length; word++) row[word] = (row[word] ?? 0) | (this.reach.bits[source + word] ?? 0);
        }
        this.rows.set(slot, row);
        for (let word = 0; word < row.length; word++) {
          degree += bitCount(row[word] ?? 0);
          for (let bits = row[word] ?? 0; bits; bits &= bits - 1) {
            const prerequisite = word * 32 + 31 - Math.clz32(bits & -bits);
            if (done[prerequisite]) continue;
            if (first < 0) first = prerequisite;
            count++;
          }
        }
      }
      this.unmetCount[slot] = count;
      this.firstUnmet[slot] = first;
      this.degree[slot] = degree;
      this.stateAt[slot] = done[slot] ? 2 : count ? 1 : 0;
      if (!done[slot] && count === 1 && first !== slot && first >= 0) (this.opens[first] ??= []).push(slot);
    }
    this.states = new BySlot(this.slot, this.ids, (slot) => STATES[this.stateAt[slot] ?? 0] ?? 'available');
    this.needs = new BySlot(this.slot, this.ids, (slot) => ({ count: this.unmetCount[slot] ?? 0, first: this.ids[this.firstUnmet[slot] ?? -1] ?? null }));
    this.inDegree = new BySlot(this.slot, this.ids, (slot) => this.degree[slot] ?? 0);
    /** @type {{closure:Closure,ids:string[],toGo:Int32Array,counts:BySlot<number>}|null} */
    this.debt = null;
  }

  /** @param {string} id */
  followed(id) {
    if (!this.slot.has(id)) return [];
    /** @type {Map<string,{id:string,incoming:string[][],throughAbsent:boolean}>} */
    const found = new Map();
    const vertex = this.rawSlot.get(id) ?? 0;
    for (const parent of new Set(this.parents[vertex])) {
      const from = this.rawIds[parent] ?? '';
      const throughAbsent = !this.slot.has(from);
      const reached = (/** @type {number} */ slot) => {
        const prerequisite = this.ids[slot];
        if (prerequisite === undefined) return;
        let entry = found.get(prerequisite);
        if (!entry) { entry = { id: prerequisite, incoming: [], throughAbsent: false }; found.set(prerequisite, entry); }
        entry.incoming.push([from, id]);
        entry.throughAbsent ||= throughAbsent;
      };
      if (!throughAbsent) {
        reached(parent);
        continue;
      }
      const row = this.reach.row(parent);
      for (let word = 0; row >= 0 && word < this.reach.words; word++) {
        for (let bits = this.reach.bits[row + word] ?? 0; bits; bits &= bits - 1) reached(word * 32 + 31 - Math.clz32(bits & -bits));
      }
    }
    return [...found.values()].sort((a, b) => (this.slot.get(a.id) ?? 0) - (this.slot.get(b.id) ?? 0)).map((entry) => ({
      ...entry, incoming: entry.incoming.sort((a, b) => compareText(a[0] ?? '', b[0] ?? '')),
    }));
  }

  // The followed prerequisites a step still owes, in authored order.
  /** @param {string} id */
  unmet(id) {
    const slot = this.slot.get(id);
    if (slot === undefined) return [];
    const row = this.rows.get(slot);
    const prerequisites = row ? [] : [...new Set(this.parents[slot])].sort((a, b) => a - b);
    for (let word = 0; row && word < row.length; word++) {
      for (let bits = row[word] ?? 0; bits; bits &= bits - 1) prerequisites.push(word * 32 + 31 - Math.clz32(bits & -bits));
    }
    return prerequisites.flatMap((prerequisite) => (this.done[prerequisite] ? [] : [this.ids[prerequisite] ?? '']));
  }

  // What each unfinished step owes: every unfinished step behind it, read through absent steps and stopping at
  // completed ones. Only the unfinished and absent vertices take a row.
  owedIndex() {
    if (this.debt) return this.debt;
    const ids = this.ids.filter((_, slot) => !this.done[slot]);
    const seedOf = new Int32Array(this.rawIds.length).fill(-1);
    /** @type {number[]} */
    const members = [];
    let seed = 0;
    for (let vertex = 0; vertex < this.rawIds.length; vertex++) {
      if (vertex < this.ids.length && this.done[vertex]) continue;
      if (vertex < this.ids.length) seedOf[vertex] = seed++;
      members.push(vertex);
    }
    const closure = new Closure(members, this.parents, seedOf, () => true, ids.length);
    const toGo = new Int32Array(this.ids.length);
    for (let slot = 0; slot < this.ids.length; slot++) {
      const row = closure.row(slot);
      if (row < 0) continue;
      let count = 0;
      for (let word = 0; word < closure.words; word++) count += bitCount(closure.bits[row + word] ?? 0);
      toGo[slot] = count - 1;
    }
    this.debt = { closure, ids, toGo, counts: new BySlot(this.slot, this.ids, (slot) => toGo[slot] ?? 0) };
    return this.debt;
  }

  /** @param {string} id */
  owed(id) {
    if (!this.slot.has(id)) return [];
    const { closure, ids } = this.owedIndex();
    const bits = new Uint32Array(closure.words);
    for (const parent of this.parents[this.rawSlot.get(id) ?? 0] ?? []) {
      const row = closure.row(parent);
      if (row < 0) continue;
      for (let word = 0; word < closure.words; word++) bits[word] = (bits[word] ?? 0) | (closure.bits[row + word] ?? 0);
    }
    return ids.filter((parent, slot) => parent !== id && ((bits[slot >>> 5] ?? 0) & (1 << (slot & 31))) !== 0);
  }

  /** @param {string} id */
  unlocks(id) {
    const slot = this.slot.get(id);
    return slot === undefined ? [] : this.unlocksAt(slot);
  }

  // The steps finishing the step at `slot` alone would open, in authored order.
  /** @param {number} slot */
  unlocksAt(slot) { return (this.opens[slot] ?? []).map((opened) => this.ids[opened] ?? ''); }

  /** @param {string} id */
  branch(id) {
    if (!this.slot.has(id)) return null;
    const origin = this.rawSlot.get(id) ?? 0;
    const included = new Set([id]);
    for (const adjacency of [this.parents, this.children]) {
      const seen = new Set([origin]);
      const pending = [origin];
      while (pending.length) {
        const vertex = pending.pop() ?? 0;
        for (const next of adjacency[vertex] ?? []) {
          if (seen.has(next)) continue;
          seen.add(next);
          const reached = this.rawIds[next] ?? '';
          if (this.slot.has(reached)) included.add(reached);
          pending.push(next);
        }
      }
    }
    return included;
  }

  /** @param {string[]} subjects */
  result(subjects) {
    return { presentIds: this.ids, states: [...this.states].map(([id, state]) => ({ id, state })), steps: subjects.map((id) => {
      const owed = this.owed(id);
      return { id, followed: this.followed(id), unmet: this.unmet(id), owed, owedCount: owed.length, unlocks: this.unlocks(id) };
    }) };
  }
}
