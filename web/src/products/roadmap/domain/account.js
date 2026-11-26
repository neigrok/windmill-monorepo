// @ts-check
import { compareText } from '../../../platform/domain-kit/entities.js';
import { Stamp } from '../../../../../packages/api-contract/sync/reference/core/stamp.js';
import { RoadmapTree } from './records.js';
import { components, FollowGraph } from './graph.js';

/** @typedef {{root:string,parent:import('./records.js').Parent|null,path:{tree:string,step:string,title:string|null}[],depth:number}} Place */
/** @typedef {{standing:'standing'|'hidden'|'unknown',place:Place|null,title:string|null}} Location */
/** @typedef {{stamp:string,at:number|null}} LatestMark */
/** @typedef {{node:string,kind:'subtree'|'pointer',tree:string,status:'loaded'|'unread'|'unknown'|'dangling'}} Opening */
/** @typedef {{tree:string,done:number,total:number}} Told */

export class RoadmapAccount {
  // `told` is what a read elsewhere says roadmaps have come to, as a reader's progress answer names its subtrees: one the
  // device holds no read copy of counts as it is told, and completes once it has steps and every one is done.
  /** @param {RoadmapTree[]} trees @param {{told?: Told[]}} [elsewhere] */
  constructor(trees, { told = [] } = {}) {
    this.trees = new Map([...trees].sort((a, b) => compareText(a.id, b.id)).map((tree) => [tree.id, tree]));
    if (this.trees.size !== trees.length) throw new TypeError('Duplicate normalized tree identity');
    /** @type {Map<string,Location>} */
    this.locations = new Map();
    for (const id of this.trees.keys()) this.locate(id);
    /** @type {Map<string,{done:number,total:number}>} */
    this.told = new Map(told.filter(({ tree }) => this.locations.get(tree)?.standing !== 'hidden'
      && !(this.trees.get(tree)?.read === 'loaded' && this.locations.get(tree)?.standing === 'standing'))
      .map(({ tree, done, total }) => [tree, { done, total }]));
    /** @type {Map<string,Opening[]>} */
    this.openings = new Map();
    /** @type {Map<string,{node:string,tree:string}[]>} */
    this.staleBranches = new Map();
    /** @type {Map<string,{tree:string,node:string}[]>} */
    this.openers = new Map();
    /** @type {Map<string,number>} */
    this.pending = new Map();
    /** @type {Set<string>} */
    this.complete = new Set();
    /** @type {Map<string,LatestMark|null>} */
    this.latestMarks = new Map();
    const ready = [];
    for (const [id, tree] of this.trees) {
      const location = this.locations.get(id);
      if (location?.standing !== 'standing' || tree.read !== 'loaded') continue;
      const nodes = tree.nodes.filter((node) => node.present);
      const openings = [];
      const stale = [];
      let pending = nodes.length;
      let latest = /** @type {LatestMark|null} */ (null);
      for (const node of nodes) {
        const pointer = tree.pointers.get(node.id);
        let branch = node.branch;
        if (branch !== null) {
          const child = this.trees.get(branch);
          const place = this.locations.get(branch);
          if (child && (place?.standing === 'hidden' || (child.read === 'loaded' && (child.parent?.tree !== id || child.parent.step !== node.id)))) {
            stale.push({ node: node.id, tree: branch });
            branch = null;
          }
        }
        const target = branch ?? (pointer?.present ? pointer.opens : null);
        if (target !== null) {
          const kind = branch === null ? 'pointer' : 'subtree';
          const opened = this.trees.get(target);
          const place = this.locations.get(target);
          let status = /** @type {Opening['status']} */ ('unknown');
          if (opened) {
            const allowed = kind === 'pointer' ? opened.parent === null : opened.read === 'unread' || (opened.parent?.tree === id && opened.parent.step === node.id);
            if (!allowed || place?.standing === 'hidden') status = 'dangling';
            else if (place?.standing === 'standing') status = opened.read;
          }
          openings.push({ node: node.id, kind: /** @type {Opening['kind']} */ (kind), tree: target, status });
          if (status !== 'dangling') {
            if (status === 'loaded' || status === 'unread' || (status === 'unknown' && this.told.has(target))) {
              if (!this.openers.has(target)) this.openers.set(target, []);
              this.openers.get(target)?.push({ tree: id, node: node.id });
            }
            continue;
          }
        }
        const mark = tree.marks.get(node.id);
        if (mark?.status !== 'complete') continue;
        pending--;
        if (mark.stamp && mark.stamp !== Stamp.UNSET) latest = laterMark(latest, { stamp: mark.stamp, at: mark.at });
      }
      this.openings.set(id, openings);
      this.staleBranches.set(id, stale);
      this.pending.set(id, pending);
      this.latestMarks.set(id, latest);
      if (nodes.length && pending === 0) ready.push(id);
    }
    for (const [id, { done, total }] of this.told) if (total > 0 && done === total) ready.push(id);
    while (ready.length) {
      const id = ready.pop();
      if (id === undefined || this.complete.has(id)) continue;
      this.complete.add(id);
      for (const opener of this.openers.get(id) ?? []) {
        const remaining = (this.pending.get(opener.tree) ?? 0) - 1;
        this.pending.set(opener.tree, remaining);
        this.latestMarks.set(opener.tree, laterMark(this.latestMarks.get(opener.tree) ?? null, this.latestMarks.get(id) ?? null));
        if (remaining === 0) ready.push(opener.tree);
      }
    }
    const ids = [...this.trees.keys()].filter((id) => this.locations.get(id)?.standing === 'standing');
    const slots = new Map(ids.map((id, slot) => [id, slot]));
    const adjacency = ids.map((id) => (this.openers.get(id) ?? []).flatMap((opener) => {
      const slot = slots.get(opener.tree);
      return slot === undefined ? [] : [slot];
    }));
    this.loops = components(adjacency).groups.filter((group) => group.length > 1 || (adjacency[group[0] ?? 0] ?? []).includes(group[0] ?? 0))
      .map((group) => group.map((slot) => ids[slot] ?? '').sort(compareText)).sort((a, b) => compareText(a[0] ?? '', b[0] ?? ''));
    this.loopOf = new Map(this.loops.flatMap((loop, index) => loop.map((id) => [id, index])));
  }

  /** @param {string} id @returns {Location} */
  locate(id) {
    const known = this.locations.get(id);
    if (known) return known;
    /** @type {RoadmapTree[]} */
    const path = [];
    const seen = new Set();
    let current = id;
    let base = /** @type {Location} */ ({ standing: 'unknown', place: null, title: null });
    while (!seen.has(current)) {
      seen.add(current);
      const location = this.locations.get(current);
      if (location) { base = location; break; }
      const tree = this.trees.get(current);
      if (!tree) break;
      // D-3: a root stands once its tree scope holds its meta; one read without it (a creation or a fork under way) does not.
      if (!tree.present || (tree.parent === null && tree.read === 'loaded' && tree.meta === null)) {
        base = { standing: 'hidden', place: null, title: null };
        this.locations.set(current, base);
        break;
      }
      if (tree.parent === null) {
        base = { standing: 'standing', place: { root: tree.id, parent: null, path: [], depth: 0 }, title: tree.read === 'loaded' ? tree.meta?.title ?? null : null };
        this.locations.set(current, base);
        break;
      }
      path.push(tree);
      current = tree.parent.tree;
    }
    for (const tree of path.reverse()) {
      const parent = tree.parent;
      const parentTree = parent ? this.trees.get(parent.tree) : undefined;
      const step = parent ? parentTree?.nodesById.get(parent.step) : undefined;
      if (base.standing === 'standing' && parentTree?.read !== 'loaded') base = { standing: 'unknown', place: null, title: null };
      else if (base.standing === 'standing' && !step?.present) base = { standing: 'hidden', place: null, title: null };
      else if (base.place && parent && step) base = { standing: 'standing', title: step.label, place: {
        root: base.place.root, parent, path: [...base.place.path, { ...parent, title: base.title }], depth: base.place.depth + 1,
      } };
      this.locations.set(tree.id, base);
    }
    return this.locations.get(id) ?? base;
  }

  /** @param {string} id */
  counts(id) {
    const tree = this.trees.get(id);
    if (!tree || tree.read !== 'loaded' || this.locations.get(id)?.standing !== 'standing') return this.told.get(id) ?? null;
    const total = tree.nodes.filter((node) => node.present).length;
    return { done: total - (this.pending.get(id) ?? total), total };
  }

  /** @param {string} id */
  completedNodes(id) {
    const tree = this.trees.get(id);
    const openings = new Map((this.openings.get(id) ?? []).map((opening) => [opening.node, opening]));
    return new Set((tree?.nodes ?? []).filter((node) => {
      if (!node.present) return false;
      const opening = openings.get(node.id);
      if (opening && opening.status !== 'dangling') return this.complete.has(opening.tree);
      return tree?.marks.get(node.id)?.status === 'complete';
    }).map((node) => node.id));
  }

  /** @param {string} id */
  graph(id) {
    const tree = this.trees.get(id);
    if (!tree || this.locations.get(id)?.standing !== 'standing' || tree.read !== 'loaded') return null;
    const progress = this.progress(id);
    return new FollowGraph(tree, this.completedNodes(id), new Map((progress?.dates ?? []).map((date) => [date.node, date.at])));
  }

  /** @param {string} id */
  progress(id) {
    const tree = this.trees.get(id);
    if (!tree || tree.read !== 'loaded' || this.locations.get(id)?.standing !== 'standing') return null;
    const completed = [...this.completedNodes(id)];
    const openings = new Map((this.openings.get(id) ?? []).map((opening) => [opening.node, opening]));
    const dates = completed.map((node) => {
      const mark = tree.marks.get(node);
      const opening = openings.get(node);
      if (!opening || opening.status === 'dangling') return { node, at: mark?.at ?? null };
      if (mark?.status === 'complete' && (this.told.has(opening.tree) || (mark.stamp && mark.stamp !== Stamp.UNSET))) return { node, at: mark.at };
      const setAt = opening.kind === 'subtree' ? tree.nodesById.get(node)?.branchStamp : tree.pointers.get(node)?.setAt;
      const pointer = setAt && setAt !== Stamp.UNSET ? { stamp: setAt, at: Stamp.parse(setAt).ms } : null;
      return { node, at: laterMark(this.latestMarks.get(opening.tree) ?? null, pointer)?.at ?? null };
    });
    return { completed, dates };
  }

  /** @param {string} target */
  waysBack(target) {
    /** @type {Map<string,{distance:number,next:string|null}>} */
    const ways = new Map();
    if (this.locations.get(target)?.standing !== 'standing') return ways;
    ways.set(target, { distance: 0, next: null });
    let level = [target];
    let distance = 0;
    while (level.length) {
      distance++;
      const above = [];
      for (const below of level) {
        for (const opener of this.openers.get(below) ?? []) {
          const old = ways.get(opener.tree);
          if (!old) { ways.set(opener.tree, { distance, next: below }); above.push(opener.tree); }
          else if (old.distance === distance && old.next !== null && compareText(below, old.next) < 0) old.next = below;
        }
      }
      level = above;
    }
    return ways;
  }

  /** @param {string} id */
  guides(id) {
    if (this.locations.get(id)?.standing !== 'standing') return [];
    const candidates = [...this.waysBack(id)].flatMap(([treeId, way]) => {
      const tree = this.trees.get(treeId);
      if (!tree || tree.read !== 'loaded' || !tree.meta || tree.meta.guide === '') return [];
      return [{ tree: treeId, title: this.locations.get(treeId)?.title ?? '', text: tree.meta.guide, own: !tree.meta.guideInherited, distance: way.distance }];
    });
    candidates.sort((a, b) => a.distance - b.distance || compareText(a.tree, b.tree));
    return candidates.slice(0, 8).sort((a, b) => b.distance - a.distance || compareText(a.tree, b.tree))
      .map(({ distance, ...guide }) => guide);
  }

  // What each step of one tree opens comes to, read without reading every tree: whether that tree is complete, how far
  // it is and whether it leads back to this one.
  /** @param {string} id */
  openingsOf(id) {
    return (this.openings.get(id) ?? []).map((opening) => ({ ...opening,
      complete: opening.status !== 'dangling' && this.complete.has(opening.tree),
      counts: opening.status === 'dangling' ? null : this.counts(opening.tree),
      loop: opening.status !== 'dangling' && opening.status !== 'unknown' && this.loopOf.has(id) && this.loopOf.get(id) === this.loopOf.get(opening.tree),
    }));
  }

  // The person's own roadmaps as their list shows them: each root of theirs that stands, newest first by when the server
  // last received a record of it, or, of a roadmap no server has received, by its newest stamp the device holds; one with
  // neither last, ties in id byte order.
  list() {
    const recency = (/** @type {RoadmapTree} */ tree) => tree.updatedAt ?? tree.stampedAt;
    return [...this.trees.values()]
      .filter((tree) => tree.own && this.locate(tree.id).standing === 'standing' && this.locate(tree.id).place?.parent === null)
      .sort((a, b) => Number(recency(a) === null) - Number(recency(b) === null) || (recency(b) ?? 0) - (recency(a) ?? 0) || compareText(a.id, b.id))
      .flatMap((tree) => this.listing(tree.id) ?? []);
  }

  // A roadmap that stands, whoever owns it, as a list shows it: what a reader names a roadmap someone else shared by. Null
  // for one that does not stand.
  /** @param {string} id */
  listing(id) {
    const tree = this.trees.get(id);
    if (!tree || this.locate(id).standing !== 'standing') return null;
    return { id, title: this.locate(id).title, counts: this.counts(id), updatedAt: tree.updatedAt };
  }

  result() {
    return { trees: [...this.trees].map(([id, tree]) => {
      const location = this.locate(id);
      return { id, ...location, read: tree.read, counts: this.counts(id), complete: this.complete.has(id), openings: this.openingsOf(id) };
    }), loops: this.loops };
  }
}

/** @param {LatestMark|null} a @param {LatestMark|null} b */
function laterMark(a, b) {
  if (a === null) return b;
  if (b === null) return a;
  return Stamp.compare(a.stamp, b.stamp) < 0 ? b : a;
}
