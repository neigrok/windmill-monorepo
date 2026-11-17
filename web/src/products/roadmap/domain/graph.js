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

class BitClosure {
  /** @param {number[][]} adjacency @param {Map<number,number>} seeds @param {number} size */
  constructor(adjacency, seeds, size) {
    this.words = Math.ceil(size / 32);
    const { groups, componentOf } = components(adjacency);
    this.componentOf = componentOf;
    this.bits = new Uint32Array(groups.length * this.words);
    for (const [component, members] of groups.entries()) {
      const row = component * this.words;
      const dependencies = new Set();
      for (const vertex of members) {
        const seed = seeds.get(vertex);
        if (seed !== undefined) this.bits[row + (seed >>> 5)] = (this.bits[row + (seed >>> 5)] ?? 0) | (1 << (seed & 31));
        for (const parent of adjacency[vertex] ?? []) {
          const dependency = componentOf[parent] ?? 0;
          if (dependency !== component) dependencies.add(dependency);
        }
      }
      for (const dependency of dependencies) {
        const source = dependency * this.words;
        for (let word = 0; word < this.words; word++) this.bits[row + word] = (this.bits[row + word] ?? 0) | (this.bits[source + word] ?? 0);
      }
    }
  }

  /** @param {number} vertex */
  row(vertex) { return (this.componentOf[vertex] ?? 0) * this.words; }
}

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
    this.nodes = tree.nodes.filter((node) => node.present);
    this.ids = this.nodes.map((node) => node.id);
    this.slot = new Map(this.ids.map((id, index) => [id, index]));
    this.edges = tree.edges.filter((edge) => edge.present);
    this.rawIds = [...new Set([...this.ids, ...this.edges.flatMap((edge) => [edge.from, edge.to])])];
    this.rawSlot = new Map(this.rawIds.map((id, index) => [id, index]));
    /** @type {number[][]} */
    this.parents = Array.from({ length: this.rawIds.length }, () => []);
    /** @type {number[][]} */
    this.children = Array.from({ length: this.rawIds.length }, () => []);
    for (const edge of this.edges) {
      const from = this.rawSlot.get(edge.from) ?? 0;
      const to = this.rawSlot.get(edge.to) ?? 0;
      this.parents[to]?.push(from);
      this.children[from]?.push(to);
    }
    const seeds = new Map(this.ids.map((id, index) => [this.rawSlot.get(id) ?? 0, index]));
    this.frontier = new BitClosure(this.parents.map((parents, vertex) => seeds.has(vertex) ? [] : parents), seeds, this.ids.length);
    this.words = this.frontier.words;
    this.direct = new Uint32Array(this.ids.length * this.words);
    this.completed = new Set(completed ?? [...tree.marks.values()].filter((mark) => mark.status === 'complete' && !tree.nodesById.get(mark.node)?.branch && !tree.pointers.get(mark.node)?.present).map((mark) => mark.node));
    this.dates = new Map(dates ?? [...tree.marks.values()].map((mark) => [mark.node, mark.recordedAt ?? mark.deviceAt]));
    const completeBits = new Uint32Array(this.words);
    for (const id of this.completed) {
      const slot = this.slot.get(id);
      if (slot !== undefined) completeBits[slot >>> 5] = (completeBits[slot >>> 5] ?? 0) | (1 << (slot & 31));
    }
    /** @type {Map<string,'complete'|'available'|'locked'>} */
    this.states = new Map();
    /** @type {Map<string,{count:number,first:string|null}>} */
    this.needs = new Map();
    /** @type {Map<string,number>} */
    this.inDegree = new Map();
    /** @type {Map<string,string[]>} */
    this.unlocked = new Map(this.ids.map((id) => [id, []]));
    for (const [slot, id] of this.ids.entries()) {
      const row = slot * this.words;
      for (const parent of this.parents[this.rawSlot.get(id) ?? 0] ?? []) {
        const source = this.frontier.row(parent);
        for (let word = 0; word < this.words; word++) this.direct[row + word] = (this.direct[row + word] ?? 0) | (this.frontier.bits[source + word] ?? 0);
      }
      let count = 0;
      let degree = 0;
      let first = -1;
      for (let word = 0; word < this.words; word++) {
        degree += bitCount(this.direct[row + word] ?? 0);
        const unmet = (this.direct[row + word] ?? 0) & ~(completeBits[word] ?? 0);
        count += bitCount(unmet);
        if (first < 0 && unmet) first = word * 32 + 31 - Math.clz32(unmet & -unmet);
      }
      const prerequisite = this.ids[first] ?? null;
      this.needs.set(id, { count, first: prerequisite });
      this.inDegree.set(id, degree);
      this.states.set(id, this.completed.has(id) ? 'complete' : count ? 'locked' : 'available');
      if (!this.completed.has(id) && count === 1 && prerequisite !== id && prerequisite !== null) this.unlocked.get(prerequisite)?.push(id);
    }
    /** @type {{closure:BitClosure,ids:string[],counts:Map<string,number>}|null} */
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
      const row = this.frontier.row(parent);
      const throughAbsent = !this.slot.has(from);
      for (let word = 0; word < this.words; word++) {
        let bits = this.frontier.bits[row + word] ?? 0;
        while (bits) {
          const bit = 31 - Math.clz32(bits & -bits);
          const prerequisite = this.ids[word * 32 + bit];
          bits &= bits - 1;
          if (prerequisite === undefined) continue;
          let entry = found.get(prerequisite);
          if (!entry) { entry = { id: prerequisite, incoming: [], throughAbsent: false }; found.set(prerequisite, entry); }
          entry.incoming.push([from, id]);
          entry.throughAbsent ||= throughAbsent;
        }
      }
    }
    return [...found.values()].sort((a, b) => (this.slot.get(a.id) ?? 0) - (this.slot.get(b.id) ?? 0)).map((entry) => ({
      ...entry, incoming: entry.incoming.sort((a, b) => compareText(a[0] ?? '', b[0] ?? '')),
    }));
  }

  /** @param {string} id */
  unmet(id) {
    const slot = this.slot.get(id);
    if (slot === undefined) return [];
    return this.ids.filter((parent, index) => !this.completed.has(parent) && ((this.direct[slot * this.words + (index >>> 5)] ?? 0) & (1 << (index & 31))) !== 0);
  }

  owedIndex() {
    if (this.debt) return this.debt;
    const ids = this.ids.filter((id) => !this.completed.has(id));
    const seeds = new Map(ids.map((id, index) => [this.rawSlot.get(id) ?? 0, index]));
    const adjacency = this.parents.map((parents, vertex) => this.completed.has(this.rawIds[vertex] ?? '') && this.slot.has(this.rawIds[vertex] ?? '') ? [] : parents);
    const closure = new BitClosure(adjacency, seeds, ids.length);
    const counts = new Map();
    for (const id of this.ids) {
      const row = closure.row(this.rawSlot.get(id) ?? 0);
      let count = 0;
      for (let word = 0; word < closure.words; word++) count += bitCount(closure.bits[row + word] ?? 0);
      counts.set(id, this.completed.has(id) ? 0 : count - 1);
    }
    this.debt = { closure, ids, counts };
    return this.debt;
  }

  /** @param {string} id */
  owed(id) {
    if (!this.slot.has(id)) return [];
    const { closure, ids } = this.owedIndex();
    const bits = new Uint32Array(closure.words);
    for (const parent of this.parents[this.rawSlot.get(id) ?? 0] ?? []) {
      const row = closure.row(parent);
      for (let word = 0; word < closure.words; word++) bits[word] = (bits[word] ?? 0) | (closure.bits[row + word] ?? 0);
    }
    return ids.filter((parent, slot) => parent !== id && ((bits[slot >>> 5] ?? 0) & (1 << (slot & 31))) !== 0);
  }

  /** @param {string} id */
  unlocks(id) { return this.unlocked.get(id) ?? []; }

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
