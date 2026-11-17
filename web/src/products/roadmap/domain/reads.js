// @ts-check
import { compareText } from '../../../platform/domain-kit/entities.js';
import { Stamp } from '../../../../../packages/api-contract/sync/reference/core/stamp.js';
import { RoadmapTree } from './records.js';
import { FollowGraph } from './graph.js';

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
  }

  result() {
    const hues = [...this.byHue].sort((a, b) => compareText(a[0], b[0]));
    return { ids: this.kinds.map((kind) => kind.id), owners: hues.map(([hue, kinds]) => ({ hue, id: kinds[0]?.id ?? '' })),
      collisions: hues.filter(([, kinds]) => kinds.length > 1).map(([hue, kinds]) => ({ hue, owner: kinds[0]?.id ?? '', others: kinds.slice(1).map((kind) => kind.id).sort(compareText) })),
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
    this.overall = { done: graph.ids.filter((id) => graph.states.get(id) === 'complete').length, total: graph.ids.length };
    const owed = graph.owedIndex().counts;
    this.cards = graph.nodes.filter((node) => (branch === null || branch.has(node.id)) && (!hues.size || hues.has(node.color))
      && (!needle || node.label.toLowerCase().includes(needle) || node.description.toLowerCase().includes(needle))).map((node) => {
      const state = graph.states.get(node.id);
      const unlocked = state === 'complete' ? [] : graph.unlocks(node.id);
      const unmet = graph.needs.get(node.id);
      return { id: node.id, column: state === 'complete' ? 'done' : state === 'locked' ? 'locked' : 'upNext',
        needs: state === 'locked' ? { first: unmet?.first ?? null, extra: (unmet?.count ?? 0) - 1, toGo: owed.get(node.id) ?? 0 } : null,
        unlocks: state === 'available' && unlocked.length ? { first: unlocked[0] ?? '', extra: unlocked.length - 1 } : null, unlockCount: unlocked.length,
      };
    });
  }

  result() {
    const graph = this.graph;
    const columns = ['locked', 'upNext', 'done'].map((name) => {
      const cards = this.cards.filter((card) => card.column === name);
      cards.sort((a, b) => {
        if (name === 'done') {
          return dateOrder(graph.dates.get(a.id) ?? null, graph.dates.get(b.id) ?? null, true);
        }
        if (this.sort === 'roadmap') return (a.needs?.toGo ?? 0) - (b.needs?.toGo ?? 0) || b.unlockCount - a.unlockCount;
        return dateOrder(graph.tree.nodesById.get(a.id)?.rc ?? null, graph.tree.nodesById.get(b.id)?.rc ?? null, this.sort === 'newest');
      });
      const ids = cards.map((card) => card.id);
      const folded = name === 'done' && !this.expanded && ids.length > 12;
      return { name, count: ids.length, ids, shown: folded ? ids.slice(0, 12) : ids, folded };
    });
    return { overall: this.overall, sort: this.sort, branch: this.branch, recovery: this.recovery, columns, cards: this.cards };
  }
}

/** @param {number|null} a @param {number|null} b @param {boolean} newest */
function dateOrder(a, b, newest) {
  if (a === null || b === null) return Number(a === null) - Number(b === null);
  return newest ? b - a : a - b;
}

/** @param {FollowGraph} graph @param {{nodes:string[],edges:string[][]}} own */
export function landingFacts(graph, own) {
  const nodes = new Set(own.nodes);
  const edges = new Map();
  for (const [from, to] of own.edges) {
    if (!edges.has(to)) edges.set(to, new Set());
    edges.get(to).add(from);
  }
  return graph.ids.flatMap((node) => {
    if (!nodes.has(node) && !edges.has(node)) return [];
    const sources = new Set((graph.parents[graph.rawSlot.get(node) ?? 0] ?? []).map((slot) => graph.rawIds[slot] ?? '')
      .filter((from) => !graph.slot.has(from) && (nodes.has(node) || edges.get(node)?.has(from))));
    if (!sources.size) return [];
    const incoming = [...sources].sort(compareText).map((from) => [from, node]);
    const followed = graph.followed(node).flatMap((entry) => {
      const through = entry.incoming.filter(([from]) => sources.has(from ?? ''));
      return through.length ? [{ ...entry, incoming: through }] : [];
    });
    return [{ node, incoming, followed }];
  });
}
