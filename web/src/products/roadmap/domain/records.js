// @ts-check
import { compareText } from '../../../platform/domain-kit/entities.js';
import { Stamp } from '../../../../../packages/api-contract/sync/reference/core/stamp.js';

/** @typedef {{id:string, present?:boolean, born?:string|null, rc?:number|null, ru?:number|null, label?:string, icon?:string, color?:string, ord?:string, status?:string, description?:string, links?:{url:string,label:string}[], branch?:string|null, branchStamp?:string|null}} StepInput */
/** @typedef {{id:string, present?:boolean, born?:string|null, hue:string, label?:string, description?:string, ord?:string}} KindInput */
/** @typedef {{from:string,to:string,present:boolean}} Edge */
/** @typedef {{node:string,status:string,outOfOrder:boolean,recordedAt:number|null,deviceAt:number|null,stamp?:string|null}} Mark */
/** @typedef {{node:string,present:boolean,opens:string,setAt?:string|null}} Pointer */
/** @typedef {{tree:string,step:string}} Parent */
/** @typedef {{title:string,guide:string,guideInherited:boolean,root:string,depth:number,visibility:string,reach:string}} Metadata */
/** @typedef {{id:string,present?:boolean,read?:'loaded'|'unread',parent?:Parent|null,meta?:Partial<Metadata>,nodes?:StepInput[],edges?:Edge[],kinds?:KindInput[],marks?:Mark[],pointers?:Pointer[]}} TreeInput */

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

export class RoadmapTree {
  /** @param {TreeInput} input */
  constructor(input) {
    this.id = input.id;
    this.present = input.present ?? true;
    this.read = input.read ?? 'loaded';
    this.parent = input.parent ? { ...input.parent } : null;
    this.meta = { title: '', guide: '', guideInherited: false, root: input.id, depth: 0, visibility: 'private', reach: 'private', ...input.meta };
    this.nodes = (input.nodes ?? []).map((node) => new Step(node)).sort(authoredOrder);
    this.nodesById = new Map(this.nodes.map((node) => [node.id, node]));
    this.edges = (input.edges ?? []).map((edge) => ({ ...edge })).sort(edgeOrder);
    this.kinds = (input.kinds ?? []).map((kind) => new Kind(kind)).sort(authoredOrder);
    this.marks = new Map((input.marks ?? []).map((mark) => [mark.node, { ...mark }]));
    this.pointers = new Map((input.pointers ?? []).map((pointer) => [pointer.node, { ...pointer }]));
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
