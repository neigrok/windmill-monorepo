// The client's half of the graph CRDT — the exact mirror of the backend's domain/Crdt.h +
// domain/LooseGraph.h + domain/Subgraph.h, in JS. A tree's truth is a lattice of stamped
// registers; TreeData is only its present-time projection. Everything that syncs is a
// subgraph joined here. The register laws (add-biased life, last-writer-wins fields) match
// the backend bit-for-bit and are pinned by test/golden.

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

export function hlcIsSet(h) {
  return h.ms !== 0 || h.counter !== 0 || h.actor !== '';
}

// -1 / 0 / 1 for a vs b, ordered by (ms, counter, actor) — the backend's Hlc spaceship.
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

// An add-biased life register: present iff added and no strictly-later remove cancels it. An
// add that ties a remove wins — "keep more, lose less".
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
    position: { v: null, at: { ...UNSET } },
    status: { v: null, at: { ...UNSET } },
    description: { v: '', at: { ...UNSET } },
    links: { v: [], at: { ...UNSET } },
  };
}

function newKind() {
  return {
    life: { addedAt: { ...UNSET }, removedAt: { ...UNSET } },
    hue: { v: 'terracotta', at: { ...UNSET } },
    label: { v: '', at: { ...UNSET } },
    description: { v: '', at: { ...UNSET } },
    rank: { v: 0, at: { ...UNSET } },
  };
}

const EDGE_SEP = String.fromCharCode(0);
const edgeKey = (from, to) => `${from}${EDGE_SEP}${to}`;

// A causal frontier — the greatest stamp seen per actor. Mirrors the backend VersionVector
// (domain/Subgraph.h): join is pointwise max; `covers` asks whether a stamp is accounted for.
// It advances ONLY through content the replica has durably joined (the coverage law), so it is
// a safe basis for "what the server already has" and thus for the offline flush delta.
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

// Emit one stamped field into a wire entry, unless it is unset (no information) or already
// covered by `vector` (masked out of a delta). A null vector masks nothing — a full frame.
function emitField(entry, key, atKey, value, at, vector) {
  if (!hlcIsSet(at)) return;
  if (vector && vector.covers(at)) return;
  entry[key] = value;
  entry[atKey] = hlcText(at);
}

function emitStamp(entry, key, at, vector) {
  if (!hlcIsSet(at)) return;
  if (vector && vector.covers(at)) return;
  entry[key] = hlcText(at);
}

export class TreeLattice {
  constructor(treeId = '', title = '') {
    this.treeId = treeId;
    this.title = title;
    this.nodes = new Map();
    this.edges = new Map();  // "from\0to" -> { addedAt, removedAt }
    this.kinds = new Map();
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

  // Fold a subgraph frame (the parsed wire envelope) into the lattice, field by field, and
  // return the frontier of the stamps it carried. This is the one merge — a live edit, a
  // snapshot graft, and a reconnect delta all land here. Two-phase and all-or-nothing: it
  // validates every entry before mutating, so a malformed frame leaves the lattice untouched
  // and the caller can treat the throw as a gap (I8). The returned frontier lets the caller
  // advance coverage/clock from the join itself, so folded-but-not-applied is impossible.
  join(frame) {
    for (const n of frame.nodes ?? []) if (typeof n?.id !== 'string') throw new Error('malformed node entry');
    for (const e of frame.edges ?? []) if (typeof e?.from !== 'string' || typeof e?.to !== 'string') throw new Error('malformed edge entry');
    for (const k of frame.kinds ?? []) if (typeof k?.id !== 'string') throw new Error('malformed kind entry');

    const frontier = new VersionVector();
    const fold = (at) => { frontier.observe(at); return at; };
    for (const n of frame.nodes ?? []) {
      const record = this.nodeRecord(n.id);
      this.addLife(record.life, fold(parseHlc(n.createdAt)));
      this.removeLife(record.life, fold(parseHlc(n.deletedAt)));
      mergeLww(record.label, n.label ?? '', fold(parseHlc(n.labelAt)));
      mergeLww(record.icon, n.icon ?? '', fold(parseHlc(n.iconAt)));
      mergeLww(record.color, n.color ?? 'terracotta', fold(parseHlc(n.colorAt)));
      const position = n.position && typeof n.position === 'object' ? { x: n.position.x, y: n.position.y } : null;
      mergeLww(record.position, position, fold(parseHlc(n.positionAt)));
      mergeLww(record.status, n.status ?? null, fold(parseHlc(n.statusAt)));
      mergeLww(record.description, typeof n.description === 'string' ? n.description : '', fold(parseHlc(n.descriptionAt)));
      // Mirrors the backend's linksFromJson: bare strings become url-only links, other shapes drop.
      const links = Array.isArray(n.links) ? n.links.flatMap((l) => {
        if (typeof l === 'string') return [{ url: l, label: '' }];
        if (l && typeof l === 'object') return [{ url: typeof l.url === 'string' ? l.url : '', label: typeof l.label === 'string' ? l.label : '' }];
        return [];
      }) : [];
      mergeLww(record.links, links, fold(parseHlc(n.linksAt)));
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
    if (frame.title && typeof frame.title === 'object') {
      const at = fold(parseHlc(frame.title.at));
      this._titleAt = this._titleAt ?? { ...UNSET };
      if (compareHlc(at, this._titleAt) > 0) { this.title = frame.title.v ?? ''; this._titleAt = at; }
    }
    return frontier;
  }

  // Fold every stamp the lattice carries into a clock, so a fresh mint dominates them all.
  seedClock(clock) {
    for (const record of this.nodes.values()) {
      for (const reg of [record.life.addedAt, record.life.removedAt, record.label.at, record.icon.at,
        record.color.at, record.position.at, record.status.at, record.description.at, record.links.at]) clock.observe(reg);
    }
    for (const record of this.edges.values()) { clock.observe(record.addedAt); clock.observe(record.removedAt); }
    for (const record of this.kinds.values()) {
      for (const reg of [record.life.addedAt, record.life.removedAt, record.hue.at, record.label.at,
        record.description.at, record.rank.at]) clock.observe(reg);
    }
    if (this._titleAt) clock.observe(this._titleAt);
  }

  hasNode(id) {
    const record = this.nodes.get(id);
    return !!record && lifePresent(record.life);
  }

  // Every id the lattice has a record for — present AND tombstoned. A `created` write
  // re-lives a tombstone (its old fields and edges survive the delete, see maskedWork),
  // so a graft must reserve these ids against collision, not just the present ones.
  knownNodeIds() { return [...this.nodes.keys()]; }

  edgePresent(from, to) {
    const record = this.edges.get(edgeKey(from, to));
    return !!record && lifePresent(record);
  }

  // Present edges between present, distinct endpoints — the drawable graph.
  liveEdges() {
    const live = [];
    for (const [key, record] of this.edges) {
      if (!lifePresent(record)) continue;
      const [from, to] = key.split(EDGE_SEP);
      if (from !== to && this.hasNode(from) && this.hasNode(to)) live.push({ from, to });
    }
    return live;
  }

  presentColors() {
    const colors = new Set();
    for (const record of this.nodes.values()) if (lifePresent(record.life)) colors.add(record.color.v);
    return colors;
  }

  // "Keep more, lose less" made visible: nodes deleted while a subtree of live children hangs
  // off them (a delete that raced a concurrent build). The delete stands and the children float,
  // but the deleted node's fields survive — resurrecting it (a fresh life.add) re-connects the
  // subtree. Returns { id, label, children } per tombstoned parent that still has present children.
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

  // The frontier of everything the lattice holds — every stamp folded together.
  frontier() {
    const vector = new VersionVector();
    for (const record of this.nodes.values()) {
      for (const at of [record.life.addedAt, record.life.removedAt, record.label.at, record.icon.at,
        record.color.at, record.position.at, record.status.at, record.description.at, record.links.at]) vector.observe(at);
    }
    for (const record of this.edges.values()) { vector.observe(record.addedAt); vector.observe(record.removedAt); }
    for (const record of this.kinds.values()) {
      for (const at of [record.life.addedAt, record.life.removedAt, record.hue.at, record.label.at,
        record.description.at, record.rank.at]) vector.observe(at);
    }
    if (this._titleAt) vector.observe(this._titleAt);
    return vector;
  }

  // A subgraph frame carrying every entry with a stamp `vector` does not cover, covered fields
  // masked out. A null vector masks nothing — the whole lattice as one frame (toFrame). This is
  // both the offline flush payload (deltaSince the server's acked frontier) and the IndexedDB blob.
  deltaSince(vector) {
    const nodes = [];
    for (const [id, record] of this.nodes) {
      const entry = { id };
      emitStamp(entry, 'createdAt', record.life.addedAt, vector);
      emitStamp(entry, 'deletedAt', record.life.removedAt, vector);
      emitField(entry, 'label', 'labelAt', record.label.v, record.label.at, vector);
      emitField(entry, 'icon', 'iconAt', record.icon.v, record.icon.at, vector);
      emitField(entry, 'color', 'colorAt', record.color.v, record.color.at, vector);
      emitField(entry, 'position', 'positionAt', record.position.v, record.position.at, vector);
      emitField(entry, 'status', 'statusAt', record.status.v, record.status.at, vector);
      emitField(entry, 'description', 'descriptionAt', record.description.v, record.description.at, vector);
      emitField(entry, 'links', 'linksAt', record.links.v, record.links.at, vector);
      if (Object.keys(entry).length > 1) nodes.push(entry);
    }
    const edges = [];
    for (const [key, record] of this.edges) {
      const [from, to] = key.split(EDGE_SEP);
      const entry = { from, to };
      emitStamp(entry, 'addedAt', record.addedAt, vector);
      emitStamp(entry, 'removedAt', record.removedAt, vector);
      if (Object.keys(entry).length > 2) edges.push(entry);
    }
    const kinds = [];
    for (const [id, record] of this.kinds) {
      const entry = { id };
      emitStamp(entry, 'createdAt', record.life.addedAt, vector);
      emitStamp(entry, 'deletedAt', record.life.removedAt, vector);
      emitField(entry, 'hue', 'hueAt', record.hue.v, record.hue.at, vector);
      emitField(entry, 'label', 'labelAt', record.label.v, record.label.at, vector);
      emitField(entry, 'description', 'descriptionAt', record.description.v, record.description.at, vector);
      emitField(entry, 'rank', 'rankAt', record.rank.v, record.rank.at, vector);
      if (Object.keys(entry).length > 1) kinds.push(entry);
    }
    const frame = { nodes, edges, kinds };
    if (this._titleAt && hlcIsSet(this._titleAt) && !(vector && vector.covers(this._titleAt))) {
      frame.title = { v: this.title, at: hlcText(this._titleAt) };
    }
    return frame;
  }

  // The whole lattice as one frame — for the IndexedDB blob and a fresh peer bootstrap.
  toFrame() {
    return this.deltaSince(null);  // null vector masks nothing; title rides along
  }

  // The present-time projection every render path already consumes.
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
        prerequisites: parentsOf.get(id) ?? [],
        position: record.position.v ? { ...record.position.v } : undefined,
        status: record.status.v ?? undefined,
        description: record.description.v || undefined,
        links: record.links.v.length ? record.links.v.map((l) => ({ ...l })) : undefined,
      });
    }
    return { id: this.treeId, title: this.title, nodes, kinds: this.orderedKinds() };
  }
}
