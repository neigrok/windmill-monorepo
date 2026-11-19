// @ts-check
import { compareText } from '../../../platform/domain-kit/entities.js';
import { jcs } from '../../../../../packages/api-contract/sync/reference/core/jcs.js';
import { Stamp } from '../../../../../packages/api-contract/sync/reference/core/stamp.js';

/** @typedef {{id:string, present?:boolean, born?:string|null, rc?:number|null, ru?:number|null, label?:string, icon?:string, color?:string, ord?:string, status?:string, description?:string, links?:{url:string,label:string}[], branch?:string|null, branchStamp?:string|null}} StepInput */
/** @typedef {{id:string, present?:boolean, born?:string|null, hue:string, label?:string, description?:string, ord?:string}} KindInput */
/** @typedef {{from:string,to:string,present:boolean}} Edge */
/** @typedef {{node:string,status:string,outOfOrder:boolean,recordedAt:number|null,deviceAt:number|null,stamp?:string|null}} Mark */
/** @typedef {{node:string,present:boolean,opens:string,setAt?:string|null}} Pointer */
/** @typedef {{tree:string,step:string}} Parent */
/** @typedef {{title:string,guide:string,guideInherited:boolean,root:string,depth:number,visibility:string,reach:string}} Metadata */
/** @typedef {{id:string,present?:boolean,read?:'loaded'|'unread',own?:boolean,updatedAt?:number|null,parent?:Parent|null,meta?:Partial<Metadata>|null,nodes?:StepInput[],edges?:Edge[],kinds?:KindInput[],marks?:Mark[],pointers?:Pointer[]}} TreeInput */

export class Step {
  /** @param {StepInput} input */
  constructor(input) {
    this.id = input.id;
    this.present = input.present ?? true;
    this.born = input.born ?? Stamp.UNSET;
    this.rc = input.rc ?? null;
    this.ru = input.ru ?? null;
    this.label = input.label ?? '';
    this.icon = input.icon ?? '';
    this.color = input.color ?? 'terracotta';
    this.ord = input.ord ?? '';
    this.status = input.status ?? 'none';
    this.description = input.description ?? '';
    this.links = (input.links ?? []).map((link) => ({ ...link }));
    this.branch = input.branch ?? null;
    this.branchStamp = input.branchStamp ?? null;
  }
}

export class Kind {
  /** @param {KindInput} input */
  constructor(input) {
    this.id = input.id;
    this.present = input.present ?? true;
    this.born = input.born ?? Stamp.UNSET;
    this.hue = input.hue;
    this.label = input.label ?? '';
    this.description = input.description ?? '';
    this.ord = input.ord ?? '';
  }
}

// A tree's records by slot: its present steps first, each at its slot in authored order, then every other id a live
// link names, in link order, with each vertex's parents and children over the live links; and which present steps
// the tree's own marks complete, and when, a step that owns a subtree or opens a roadmap taking none. A tree derives
// it once and every read over the tree shares it.
export class TreeIndex {
  /** @param {Step[]} nodes @param {Edge[]} edges @param {Map<string,Mark>} marks @param {Map<string,Pointer>} pointers */
  constructor(nodes, edges, marks, pointers) {
    this.nodes = nodes.filter((node) => node.present);
    this.ids = this.nodes.map((node) => node.id);
    this.slot = new Map(this.ids.map((id, index) => [id, index]));
    this.edges = edges.filter((edge) => edge.present);
    /** @type {string[]} */
    this.rawIds = [...this.ids];
    /** @type {Map<string,number>} */
    this.rawSlot = new Map(this.slot);
    /** @type {number[][]} */
    this.parents = this.ids.map(() => []);
    /** @type {number[][]} */
    this.children = this.ids.map(() => []);
    /** @type {(id: string) => number} */
    const vertexOf = (id) => {
      const known = this.rawSlot.get(id);
      if (known !== undefined) return known;
      this.rawSlot.set(id, this.rawIds.length);
      this.rawIds.push(id);
      this.parents.push([]);
      this.children.push([]);
      return this.rawIds.length - 1;
    };
    for (const edge of this.edges) {
      const from = vertexOf(edge.from);
      const to = vertexOf(edge.to);
      this.parents[to]?.push(from);
      this.children[from]?.push(to);
    }
    this.markedDone = new Uint8Array(this.ids.length);
    /** @type {(number|null)[]} */
    this.markedAt = this.ids.map(() => null);
    for (const mark of marks.values()) {
      const slot = this.slot.get(mark.node);
      if (slot === undefined) continue;
      this.markedAt[slot] = mark.recordedAt ?? mark.deviceAt;
      if (mark.status === 'complete' && !this.nodes[slot]?.branch && !pointers.get(mark.node)?.present) this.markedDone[slot] = 1;
    }
  }

  // The steps a present step is linked from over live links that the tree holds no present step of: the absent steps
  // it follows through (D-5). None for a step that is not present.
  /** @param {string} id */
  absentParents(id) {
    const slot = this.slot.get(id);
    if (slot === undefined) return [];
    return (this.parents[slot] ?? []).map((vertex) => this.rawIds[vertex] ?? '').filter((from) => !this.slot.has(from));
  }
}

// A roadmap's normalized records. `own` says it is in the person's own list; `updatedAt` is when the server last received
// any record of it, null where it has received none; `meta` is null while its tree scope holds no meta.
export class RoadmapTree {
  /** @param {TreeInput} input */
  constructor(input) {
    this.id = input.id;
    this.present = input.present ?? true;
    this.read = input.read ?? 'loaded';
    this.own = input.own ?? false;
    this.updatedAt = input.updatedAt ?? null;
    this.parent = input.parent ? { ...input.parent } : null;
    this.meta = input.meta === null ? null
      : { title: '', guide: '', guideInherited: false, root: input.id, depth: 0, visibility: 'private', reach: 'private', ...input.meta };
    this.nodes = (input.nodes ?? []).map((node) => new Step(node)).sort(authoredOrder);
    this.nodesById = new Map(this.nodes.map((node) => [node.id, node]));
    this.edges = (input.edges ?? []).map((edge) => ({ ...edge })).sort(edgeOrder);
    this.kinds = (input.kinds ?? []).map((kind) => new Kind(kind)).sort(authoredOrder);
    this.marks = new Map((input.marks ?? []).map((mark) => [mark.node, { ...mark }]));
    this.pointers = new Map((input.pointers ?? []).map((pointer) => [pointer.node, { ...pointer }]));
    this.index = new TreeIndex(this.nodes, this.edges, this.marks, this.pointers);
    if (this.nodesById.size !== this.nodes.length || new Set(this.kinds.map((kind) => kind.id)).size !== this.kinds.length) {
      throw new TypeError('Duplicate normalized roadmap identity');
    }
  }
}

/** @param {{id:string,ord:string,born:string}} a @param {{id:string,ord:string,born:string}} b */
export function authoredOrder(a, b) {
  return compareText(a.ord, b.ord) || Stamp.compare(a.born, b.born) || compareText(a.id, b.id);
}

/** @param {{from:string,to:string}} a @param {{from:string,to:string}} b */
export function edgeOrder(a, b) {
  return compareText(a.from, b.from) || compareText(a.to, b.to);
}

// The names a note keeps at most, one for each step a roadmap holds at most (§4); the oldest goes first.
const NAMES_KEPT = 10_000;

// The order the device knows of a roadmap's writes (§6), as `landingOrder` reads it: whether the write of a step or a
// link of the device's own has landed, and whether a link met the delete of the step it comes from, the server having
// taken the delete before the link.
/** @typedef {{ step(id: string): boolean, link(from: string, to: string): boolean, met(from: string, to: string): boolean }} LandingOrder */

// The device's own note of what it made and revived in one roadmap (§6), held in its `landing:<tree>` row
// until the person has been told, or until it can tell nothing: its new steps, its new links, the steps its changes
// brought back, and the name of each step a link it still notes comes from, as it was when the device made the link.
// The device keeps nothing of a step deleted elsewhere (engine.md §7.5), so a line that names one reads it here. The
// row never leaves the device.
export class LandingNote {
  /** @param {{nodes?:string[],edges?:string[][],revived?:string[],names?:{id:string,name:string}[]}} note */
  constructor({ nodes = [], edges = [], revived = [], names = [] } = {}) {
    this.nodes = Object.freeze([...nodes]);
    this.edges = Object.freeze(edges.map(([from = '', to = '']) => Object.freeze([from, to])));
    this.revived = Object.freeze([...revived]);
    const linkedFrom = new Set(this.edges.map(([from]) => from));
    this.names = Object.freeze(names.filter(({ id }) => linkedFrom.has(id)).map(({ id, name }) => Object.freeze({ id, name })));
    Object.freeze(this);
  }

  /** @param {unknown} json */
  static of(json) {
    if (json === null || typeof json !== 'object' || Array.isArray(json)) return new LandingNote();
    const note = /** @type {{nodes?:unknown,edges?:unknown,revived?:unknown,names?:unknown}} */ (json);
    const strings = (/** @type {unknown} */ list) => Array.isArray(list) ? list.filter((item) => typeof item === 'string') : [];
    const pairs = Array.isArray(note.edges) ? note.edges.filter((edge) => Array.isArray(edge) && edge.length === 2).map((edge) => strings(edge)) : [];
    const names = Array.isArray(note.names) ? note.names.flatMap((entry) => (entry !== null && typeof entry === 'object'
      && typeof entry.id === 'string' && typeof entry.name === 'string' ? [{ id: entry.id, name: entry.name }] : [])) : [];
    return new LandingNote({ nodes: strings(note.nodes), edges: pairs.filter((edge) => edge.length === 2), revived: strings(note.revived), names });
  }

  // The note with what the device made or revived added; a step's newer name replaces the one noted before.
  /** @param {{nodes?:string[],edges?:string[][],revived?:string[],names?:{id:string,name:string}[]}} made */
  adding({ nodes = [], edges = [], revived = [], names = [] }) {
    const key = (/** @type {readonly string[]} */ edge) => jcs([...edge]);
    const known = new Set(this.edges.map(key));
    const named = new Map([...this.names, ...names].map(({ id, name }) => [id, name]));
    return new LandingNote({
      nodes: [...this.nodes, ...nodes.filter((id, index) => !this.nodes.includes(id) && nodes.indexOf(id) === index)],
      edges: [...this.edges.map((edge) => [...edge]), ...edges.filter((edge) => !known.has(key(edge)) && known.add(key(edge)))],
      revived: [...this.revived, ...revived.filter((id, index) => !this.revived.includes(id) && revived.indexOf(id) === index)],
      names: [...named].map(([id, name]) => ({ id, name })).slice(-NAMES_KEPT),
    });
  }

  // The note less what was told.
  /** @param {{nodes?:string[],edges?:string[][],revived?:string[]}} told */
  clearing({ nodes = [], edges = [], revived = [] }) {
    const key = (/** @type {readonly string[]} */ edge) => jcs([...edge]);
    const toldEdges = new Set(edges.map(key));
    return new LandingNote({
      nodes: this.nodes.filter((id) => !nodes.includes(id)),
      edges: this.edges.filter((edge) => !toldEdges.has(key(edge))).map((edge) => [...edge]),
      revived: this.revived.filter((id) => !revived.includes(id)),
      names: [...this.names],
    });
  }

  // The links whose lines the note says of `tree` as it now stands: each link it notes, and each into a step it notes,
  // that is read through a step the server took the delete of before it took the link (`order.met`).
  /**
   * @param {RoadmapTree} tree
   * @param {LandingOrder} order
   */
  saying(tree, order) {
    const { index } = tree;
    /** @type {Map<string, string[]>} */
    const links = new Map();
    for (const to of this.nodes) for (const from of index.absentParents(to)) links.set(jcs([from, to]), [from, to]);
    for (const [from = '', to = ''] of this.edges) if (index.absentParents(to).includes(from)) links.set(jcs([from, to]), [from, to]);
    return [...links.values()].filter(([from = '', to = '']) => order.met(from, to));
  }

  // The note less each entry whose write has landed and that says nothing of `tree` as it now stands: a step or a link of
  // the device's through which no line is said (`saying`), and a step its change brought back that is absent again. A
  // line is said only of a delete the server took before the write, and once the write has landed the device holds every
  // such delete, so an entry let go of could never say more.
  /**
   * @param {RoadmapTree} tree
   * @param {LandingOrder} order
   */
  settled(tree, order) {
    const said = this.saying(tree, order);
    const saidLinks = new Set(said.map((link) => jcs(link)));
    const saidInto = new Set(said.map(([, to]) => to));
    return new LandingNote({
      nodes: this.nodes.filter((id) => !order.step(id) || saidInto.has(id)),
      edges: this.edges.filter(([from = '', to = '']) => !order.link(from, to) || saidLinks.has(jcs([from, to]))).map((edge) => [...edge]),
      revived: this.revived.filter((id) => !order.step(id) || tree.nodesById.get(id)?.present === true),
      names: [...this.names],
    });
  }

  // The name the note keeps of a step, or null.
  /** @param {string} id */
  nameOf(id) { return this.names.find((entry) => entry.id === id)?.name ?? null; }

  get isEmpty() { return !this.nodes.length && !this.edges.length && !this.revived.length; }

  get json() {
    return { nodes: [...this.nodes], edges: this.edges.map((edge) => [...edge]), revived: [...this.revived],
      names: this.names.map(({ id, name }) => ({ id, name })) };
  }
}
