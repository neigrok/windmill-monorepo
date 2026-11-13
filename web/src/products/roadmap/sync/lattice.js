// The client's half of the graph CRDT, mirroring the backend's domain/Crdt.h, LooseGraph.h and
// Subgraph.h. A tree's truth is a lattice of stamped registers; TreeData is its present-time
// projection. The register laws — add-biased life, last-writer-wins fields — must match the
// backend bit-for-bit, and nothing enforces it.

import { GENESIS_STAMP } from '../../../../../packages/api-contract/genesis.js';

const UNSET = { ms: 0, counter: 0, actor: '' };

export function parseHlc(text) {
  if (!text) return { ...UNSET };
  const first = text.indexOf(':');
  const second = text.indexOf(':', first + 1);
  if (first < 0 || second < 0) return { ...UNSET };
  return {
    ms: Number(text.slice(0, first)),
    counter: Number(text.slice(first + 1, second)),
    actor: text.slice(second + 1),
  };
}

export function hlcText(h) {
  return `${h.ms}:${h.counter}:${h.actor}`;
}

function hlcIsSet(h) {
  return h.ms !== 0 || h.counter !== 0 || h.actor !== '';
}

// The wall time a stamp records, or null when it records none: unset, or the genesis baseline that
// seeds carry instead of a moment.
function stampedMs(h) {
  return hlcIsSet(h) && hlcText(h) !== GENESIS_STAMP ? h.ms : null;
}

// -1 / 0 / 1 for a vs b, ordered by (ms, counter, actor).
export function compareHlc(a, b) {
  if (a.ms !== b.ms) return a.ms < b.ms ? -1 : 1;
  if (a.counter !== b.counter) return a.counter < b.counter ? -1 : 1;
  if (a.actor !== b.actor) return a.actor < b.actor ? -1 : 1;
  return 0;
}

export class HlcClock {
  constructor(actor) {
    this.actor = actor;
    this.lastMs = 0;
    this.counter = 0;
  }

  tick(wallMs) {
    const ms = Math.max(wallMs, this.lastMs);
    this.counter = ms === this.lastMs ? this.counter + 1 : 0;
    this.lastMs = ms;
    return { ms, counter: this.counter, actor: this.actor };
  }

  observe(h) {
    if (!hlcIsSet(h)) return;
    if (h.ms > this.lastMs || (h.ms === this.lastMs && h.counter > this.counter)) {
      this.lastMs = h.ms;
      this.counter = h.counter;
    }
  }
}

// Present iff added and no strictly-later remove cancels it: an add that ties a remove wins.
function lifePresent(life) {
  return hlcIsSet(life.addedAt) && !(compareHlc(life.removedAt, life.addedAt) > 0);
}

function mergeLww(reg, value, at) {
  if (compareHlc(at, reg.at) > 0) {
    reg.v = value;
    reg.at = at;
  }
}

function newNode() {
  return {
    life: { addedAt: { ...UNSET }, removedAt: { ...UNSET } },
    label: { v: '', at: { ...UNSET } },
    icon: { v: '', at: { ...UNSET } },
    color: { v: 'terracotta', at: { ...UNSET } },
    order: { v: '', at: { ...UNSET } },  // fractional-index key, scoped to the parent; '' falls back to creation time
    status: { v: null, at: { ...UNSET } },
    description: { v: '', at: { ...UNSET } },
    links: { v: [], at: { ...UNSET } },
    opens: { v: '', at: { ...UNSET } },  // the id of the tree the node opens; '' opens none
  };
}

// A node's last-writer-wins registers, each carried on the wire as `name` beside its stamp `nameAt`.
export const NODE_REGISTERS = Object.keys(newNode()).filter((name) => name !== 'life');
// What each of them reads before any write.
export const UNWRITTEN_NODE = Object.freeze(Object.fromEntries(NODE_REGISTERS.map((name) => [name, newNode()[name].v])));
const nodeStamps = (record) => [record.life.addedAt, record.life.removedAt, ...NODE_REGISTERS.map((name) => record[name].at)];

function newKind() {
  return {
    life: { addedAt: { ...UNSET }, removedAt: { ...UNSET } },
    hue: { v: 'terracotta', at: { ...UNSET } },
    label: { v: '', at: { ...UNSET } },
    description: { v: '', at: { ...UNSET } },
    rank: { v: 0, at: { ...UNSET } },
  };
}

// The tree's own last-writer-wins text registers, beside its graph and legend: its name, and the guide that says how it is worked.
export const TREE_REGISTERS = ['title', 'guide'];

const EDGE_SEP = String.fromCharCode(0);
const edgeKey = (from, to) => `${from}${EDGE_SEP}${to}`;

// A causal frontier — the greatest stamp seen per actor; join is pointwise max. It may advance
// only through content the replica has durably joined.
export class VersionVector {
  constructor(marks = new Map()) { this.marks = marks; }

  observe(hlc) {
    if (!hlcIsSet(hlc)) return;
    const seen = this.marks.get(hlc.actor);
    if (seen === undefined || compareHlc(hlc, { ms: seen.ms, counter: seen.counter, actor: hlc.actor }) > 0) {
      this.marks.set(hlc.actor, { ms: hlc.ms, counter: hlc.counter });
    }
  }

  covers(hlc) {
    if (!hlcIsSet(hlc)) return true;  // the unset sentinel carries nothing to cover
    const mark = this.marks.get(hlc.actor);
    return mark !== undefined && compareHlc(hlc, { ms: mark.ms, counter: mark.counter, actor: hlc.actor }) <= 0;
  }

  join(other) { for (const [actor, m] of other.marks) this.observe({ ms: m.ms, counter: m.counter, actor }); }
  clone() { return new VersionVector(new Map(this.marks)); }
  toJSON() { return Object.fromEntries([...this.marks].map(([a, m]) => [a, `${m.ms}:${m.counter}:${a}`])); }  // full stamp: the server parses it with parseHlc

  static fromJSON(obj) {
    const marks = new Map();
    for (const [actor, text] of Object.entries(obj ?? {})) {
      const [ms, counter] = text.split(':');
      marks.set(actor, { ms: Number(ms), counter: Number(counter) });
    }
    return new VersionVector(marks);
  }
}

// Emits one field when its register has a stamp.
function emitField(entry, key, atKey, value, at) {
  if (!hlcIsSet(at)) return;
  entry[key] = value;
  entry[atKey] = hlcText(at);
}

function emitStamp(entry, key, at) {
  if (!hlcIsSet(at)) return;
  entry[key] = hlcText(at);
}

export class TreeLattice {
  // The title and guide a document carries stand unstamped, so any stamped write dominates them.
  constructor(treeId = '', title = '', guide = '') {
    this.treeId = treeId;
    this.registers = { title: { v: title, at: { ...UNSET } }, guide: { v: guide, at: { ...UNSET } } };
    this.nodes = new Map();
    this.edges = new Map();  // "from\0to" -> { addedAt, removedAt }
    this.kinds = new Map();
  }

  get title() { return this.registers.title.v; }
  get guide() { return this.registers.guide.v; }

  // A fresh lattice of the same tree holding only this one's title and guide, unstamped.
  baseline() { return new TreeLattice(this.treeId, this.title, this.guide); }

  // The trees its steps open and nothing else of them, as a frame.
  pointers() {
    const nodes = [];
    for (const [id, record] of this.nodes) {
      const entry = { id };
      emitField(entry, 'opens', 'opensAt', record.opens.v, record.opens.at);
      if ('opensAt' in entry) nodes.push(entry);
    }
    return { nodes };
  }

  nodeRecord(id) {
    let record = this.nodes.get(id);
    if (!record) { record = newNode(); this.nodes.set(id, record); }
    return record;
  }

  kindRecord(id) {
    let record = this.kinds.get(id);
    if (!record) { record = newKind(); this.kinds.set(id, record); }
    return record;
  }

  edgeRecord(from, to) {
    const key = edgeKey(from, to);
    let record = this.edges.get(key);
    if (!record) { record = { addedAt: { ...UNSET }, removedAt: { ...UNSET } }; this.edges.set(key, record); }
    return record;
  }

  addLife(life, at) { if (compareHlc(at, life.addedAt) > 0) life.addedAt = at; }
  removeLife(life, at) { if (compareHlc(at, life.removedAt) > 0) life.removedAt = at; }

  // Folds a subgraph frame into the lattice and returns the frontier of the stamps it carried.
  // Every entry is validated before mutating, so a malformed frame leaves the lattice untouched.
  join(frame) {
    for (const n of frame.nodes ?? []) if (typeof n?.id !== 'string') throw new Error('malformed node entry');
    for (const e of frame.edges ?? []) if (typeof e?.from !== 'string' || typeof e?.to !== 'string') throw new Error('malformed edge entry');
    for (const k of frame.kinds ?? []) if (typeof k?.id !== 'string') throw new Error('malformed kind entry');
    for (const name of TREE_REGISTERS) {
      const written = frame[name];
      if (written && typeof written === 'object' && typeof written.v !== 'string') throw new Error('malformed tree register');
    }

    const frontier = new VersionVector();
    const fold = (at) => { frontier.observe(at); return at; };
    for (const n of frame.nodes ?? []) {
      const record = this.nodeRecord(n.id);
      this.addLife(record.life, fold(parseHlc(n.createdAt)));
      this.removeLife(record.life, fold(parseHlc(n.deletedAt)));
      mergeLww(record.label, n.label ?? '', fold(parseHlc(n.labelAt)));
      mergeLww(record.icon, n.icon ?? '', fold(parseHlc(n.iconAt)));
      mergeLww(record.color, n.color ?? 'terracotta', fold(parseHlc(n.colorAt)));
      mergeLww(record.order, typeof n.order === 'string' ? n.order : '', fold(parseHlc(n.orderAt)));
      mergeLww(record.status, n.status === 'active' || n.status === 'inProgress' ? 'none' : n.status ?? null, fold(parseHlc(n.statusAt)));
      mergeLww(record.description, typeof n.description === 'string' ? n.description : '', fold(parseHlc(n.descriptionAt)));
      // Mirrors the backend's linksFromJson: bare strings become url-only links, other shapes drop.
      const links = Array.isArray(n.links) ? n.links.flatMap((l) => {
        if (typeof l === 'string') return [{ url: l, label: '' }];
        if (l && typeof l === 'object') return [{ url: typeof l.url === 'string' ? l.url : '', label: typeof l.label === 'string' ? l.label : '' }];
        return [];
      }) : [];
      mergeLww(record.links, links, fold(parseHlc(n.linksAt)));
      mergeLww(record.opens, typeof n.opens === 'string' ? n.opens : '', fold(parseHlc(n.opensAt)));
    }
    for (const e of frame.edges ?? []) {
      const record = this.edgeRecord(e.from, e.to);
      const added = fold(parseHlc(e.addedAt));
      const removed = fold(parseHlc(e.removedAt));
      if (compareHlc(added, record.addedAt) > 0) record.addedAt = added;
      if (compareHlc(removed, record.removedAt) > 0) record.removedAt = removed;
    }
    for (const k of frame.kinds ?? []) {
      const record = this.kindRecord(k.id);
      this.addLife(record.life, fold(parseHlc(k.createdAt)));
      this.removeLife(record.life, fold(parseHlc(k.deletedAt)));
      mergeLww(record.hue, k.hue ?? 'terracotta', fold(parseHlc(k.hueAt)));
      mergeLww(record.label, k.label ?? '', fold(parseHlc(k.labelAt)));
      mergeLww(record.description, k.description ?? '', fold(parseHlc(k.descriptionAt)));
      mergeLww(record.rank, k.rank ?? 0, fold(parseHlc(k.rankAt)));
    }
    for (const name of TREE_REGISTERS) {
      const written = frame[name];
      if (written && typeof written === 'object') mergeLww(this.registers[name], written.v, fold(parseHlc(written.at)));
    }
    return frontier;
  }

  // Folds every stamp the lattice carries into a clock, so a fresh mint dominates them all.
  seedClock(clock) {
    for (const record of this.nodes.values()) for (const at of nodeStamps(record)) clock.observe(at);
    for (const record of this.edges.values()) { clock.observe(record.addedAt); clock.observe(record.removedAt); }
    for (const record of this.kinds.values()) {
      for (const reg of [record.life.addedAt, record.life.removedAt, record.hue.at, record.label.at,
        record.description.at, record.rank.at]) clock.observe(reg);
    }
    for (const name of TREE_REGISTERS) clock.observe(this.registers[name].at);
  }

  hasNode(id) {
    const record = this.nodes.get(id);
    return !!record && lifePresent(record.life);
  }

  // Every id the lattice has a record for, present and tombstoned. A `created` write re-lives a
  // tombstone, so a graft must reserve these ids against collision, not just the present ones.
  knownNodeIds() { return [...this.nodes.keys()]; }

  edgePresent(from, to) {
    const record = this.edges.get(edgeKey(from, to));
    return !!record && lifePresent(record);
  }

  // Present edge records, including those masked by an absent endpoint.
  presentEdges() {
    const present = [];
    for (const [key, record] of this.edges) {
      if (!lifePresent(record)) continue;
      const [from, to] = key.split(EDGE_SEP);
      present.push({ from, to });
    }
    return present;
  }

  // Present edges between present, distinct endpoints.
  liveEdges() {
    return this.presentEdges().filter(({ from, to }) => from !== to && this.hasNode(from) && this.hasNode(to));
  }

  presentColors() {
    const colors = new Set();
    for (const record of this.nodes.values()) if (lifePresent(record.life)) colors.add(record.color.v);
    return colors;
  }

  // The ids of deleted nodes whose colour register holds `color`, written or not: a kind's recolour repaints them with
  // the present ones, so a node brought back is under its kind (the server's deletedNodesWithColor). A record never
  // created is not one.
  deletedNodesWithColor(color) {
    const ids = [];
    for (const [id, record] of this.nodes) {
      if (hlcIsSet(record.life.addedAt) && !lifePresent(record.life) && record.color.v === color) ids.push(id);
    }
    return ids;
  }

  // { id, label, children } per tombstoned node that still has present children; a fresh life.add
  // re-connects the subtree.
  maskedWork() {
    const childrenOf = new Map();  // present edge `from` -> [present `to`, ...]
    for (const [key, edge] of this.edges) {
      if (!lifePresent(edge)) continue;
      const [from, to] = key.split(EDGE_SEP);
      if (!this.hasNode(to)) continue;
      if (!childrenOf.has(from)) childrenOf.set(from, []);
      childrenOf.get(from).push(to);
    }
    const masked = [];
    for (const [id, record] of this.nodes) {
      if (lifePresent(record.life) || !hlcIsSet(record.life.addedAt)) continue;  // present, or never created
      const children = childrenOf.get(id);
      if (children?.length) masked.push({ id, label: record.label.v, children });
    }
    return masked;
  }

  // The rank a newly-added kind takes: just past the last present one (matches Legend::nextRank).
  nextRank() {
    let max = -1;
    for (const record of this.kinds.values()) if (lifePresent(record.life)) max = Math.max(max, record.rank.v);
    return max + 1;
  }

  orderedKinds() {
    const present = [];
    for (const [id, record] of this.kinds) {
      if (lifePresent(record.life)) present.push({ id, hue: record.hue.v, label: record.label.v, description: record.description.v, rank: record.rank.v });
    }
    present.sort((a, b) => (a.rank !== b.rank ? a.rank - b.rank : (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)));
    return present.map(({ id, hue, label, description }) => ({ id, hue, label, description }));
  }

  // The frontier of everything the lattice holds.
  frontier() {
    const vector = new VersionVector();
    for (const record of this.nodes.values()) for (const at of nodeStamps(record)) vector.observe(at);
    for (const record of this.edges.values()) { vector.observe(record.addedAt); vector.observe(record.removedAt); }
    for (const record of this.kinds.values()) {
      for (const at of [record.life.addedAt, record.life.removedAt, record.hue.at, record.label.at,
        record.description.at, record.rank.at]) vector.observe(at);
    }
    for (const name of TREE_REGISTERS) vector.observe(this.registers[name].at);
    return vector;
  }

  // The whole lattice as one frame.
  toFrame() {
    const nodes = [];
    for (const [id, record] of this.nodes) {
      const entry = { id };
      emitStamp(entry, 'createdAt', record.life.addedAt);
      emitStamp(entry, 'deletedAt', record.life.removedAt);
      for (const name of NODE_REGISTERS) emitField(entry, name, `${name}At`, record[name].v, record[name].at);
      if (Object.keys(entry).length > 1) nodes.push(entry);
    }
    const edges = [];
    for (const [key, record] of this.edges) {
      const [from, to] = key.split(EDGE_SEP);
      const entry = { from, to };
      emitStamp(entry, 'addedAt', record.addedAt);
      emitStamp(entry, 'removedAt', record.removedAt);
      if (Object.keys(entry).length > 2) edges.push(entry);
    }
    const kinds = [];
    for (const [id, record] of this.kinds) {
      const entry = { id };
      emitStamp(entry, 'createdAt', record.life.addedAt);
      emitStamp(entry, 'deletedAt', record.life.removedAt);
      emitField(entry, 'hue', 'hueAt', record.hue.v, record.hue.at);
      emitField(entry, 'label', 'labelAt', record.label.v, record.label.at);
      emitField(entry, 'description', 'descriptionAt', record.description.v, record.description.at);
      emitField(entry, 'rank', 'rankAt', record.rank.v, record.rank.at);
      if (Object.keys(entry).length > 1) kinds.push(entry);
    }
    const frame = { nodes, edges, kinds };
    for (const name of TREE_REGISTERS) {
      const { v, at } = this.registers[name];
      if (hlcIsSet(at)) frame[name] = { v, at: hlcText(at) };
    }
    return frame;
  }

  // The present-time projection every render path consumes.
  toTreeData() {
    const parentsOf = new Map();
    for (const { from, to } of this.liveEdges()) {
      if (!parentsOf.has(to)) parentsOf.set(to, []);
      parentsOf.get(to).push(from);
    }
    const nodes = [];
    for (const [id, record] of this.nodes) {
      if (!lifePresent(record.life)) continue;
      nodes.push({
        id,
        label: record.label.v,
        icon: record.icon.v,
        color: record.color.v,
        order: record.order.v,                 // the sibling sort key; '' ⇒ creation-time fallback
        createdAt: { ...record.life.addedAt },  // the creation stamp that fallback compares
        createdMs: stampedMs(record.life.addedAt),  // when the step was added to this tree; null is unknown
        prerequisites: parentsOf.get(id) ?? [],
        status: record.status.v ?? undefined,
        description: record.description.v || undefined,
        links: record.links.v.length ? record.links.v.map((l) => ({ ...l })) : undefined,
        opens: record.opens.v || undefined,
      });
    }
    return { id: this.treeId, title: this.title, guide: this.guide, nodes, kinds: this.orderedKinds() };
  }
}
