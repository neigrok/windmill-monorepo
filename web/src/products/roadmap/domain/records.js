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

// The device's own note of what it made and revived in one roadmap (§6), held in its `landing:<tree>` row
// until the person has been told.
export class LandingNote {
  /** @param {{nodes?:string[],edges?:string[][],revived?:string[]}} note */
  constructor({ nodes = [], edges = [], revived = [] } = {}) {
    this.nodes = Object.freeze([...nodes]);
    this.edges = Object.freeze(edges.map(([from = '', to = '']) => Object.freeze([from, to])));
    this.revived = Object.freeze([...revived]);
    Object.freeze(this);
  }

  /** @param {unknown} json */
  static of(json) {
    if (json === null || typeof json !== 'object' || Array.isArray(json)) return new LandingNote();
    const note = /** @type {{nodes?:unknown,edges?:unknown,revived?:unknown}} */ (json);
    const strings = (/** @type {unknown} */ list) => Array.isArray(list) ? list.filter((item) => typeof item === 'string') : [];
    const pairs = Array.isArray(note.edges) ? note.edges.filter((edge) => Array.isArray(edge) && edge.length === 2).map((edge) => strings(edge)) : [];
    return new LandingNote({ nodes: strings(note.nodes), edges: pairs.filter((edge) => edge.length === 2), revived: strings(note.revived) });
  }

  /** @param {{nodes?:string[],edges?:string[][],revived?:string[]}} made */
  adding({ nodes = [], edges = [], revived = [] }) {
    const key = (/** @type {readonly string[]} */ edge) => jcs([...edge]);
    const known = new Set(this.edges.map(key));
    return new LandingNote({
      nodes: [...this.nodes, ...nodes.filter((id, index) => !this.nodes.includes(id) && nodes.indexOf(id) === index)],
      edges: [...this.edges.map((edge) => [...edge]), ...edges.filter((edge) => !known.has(key(edge)) && known.add(key(edge)))],
      revived: [...this.revived, ...revived.filter((id, index) => !this.revived.includes(id) && revived.indexOf(id) === index)],
    });
  }

  /** @param {{nodes?:string[],edges?:string[][],revived?:string[]}} told */
  clearing({ nodes = [], edges = [], revived = [] }) {
    const key = (/** @type {readonly string[]} */ edge) => jcs([...edge]);
    const toldEdges = new Set(edges.map(key));
    return new LandingNote({
      nodes: this.nodes.filter((id) => !nodes.includes(id)),
      edges: this.edges.filter((edge) => !toldEdges.has(key(edge))).map((edge) => [...edge]),
      revived: this.revived.filter((id) => !revived.includes(id)),
    });
  }

  get isEmpty() { return !this.nodes.length && !this.edges.length && !this.revived.length; }

  get json() { return { nodes: [...this.nodes], edges: this.edges.map((edge) => [...edge]), revived: [...this.revived] }; }
}
