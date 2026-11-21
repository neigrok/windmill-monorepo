// @ts-check
import { compareText } from '../../../platform/domain-kit/entities.js';
import { utf8 } from '../../../platform/sync/core/encoding.js';
import { components, FollowGraph } from './graph.js';
import { LegendRead } from './reads.js';
import { RoadmapAccount } from './account.js';

/** @template T @param {T[]} entries */
function listed(entries) { return { entries: entries.slice(0, 50), omitted: Math.max(0, entries.length - 50) }; }

/** @param {string[]} ids */
function counted(ids) { return { count: ids.length, named: ids.slice(0, 10) }; }

/** @param {FollowGraph} graph */
export function diagnose(graph) {
  const cycles = [];
  const absentCycles = [];
  for (const group of components(graph.parents).groups) {
    if (group.length === 1 && !(graph.parents[group[0] ?? 0] ?? []).includes(group[0] ?? 0)) continue;
    const ids = group.map((slot) => graph.rawIds[slot] ?? '');
    const present = ids.filter((id) => graph.slot.has(id)).sort(compareText);
    if (present.length) cycles.push(present);
    else absentCycles.push(ids.sort(compareText));
  }
  for (const groups of [cycles, absentCycles]) groups.sort((a, b) => compareText(a[0] ?? '', b[0] ?? ''));
  const legend = new LegendRead(graph.tree);
  const legendEmpty = !legend.kinds.length && graph.nodes.length > 0;
  const ids = [...graph.ids].sort(compareText);
  const longLabel = [];
  const emptyIcon = [];
  const highDegree = [];
  /** @type {Map<string,string[]>} */
  const unclaimed = new Map();
  for (const id of ids) {
    const node = graph.tree.nodesById.get(id);
    if (!node) continue;
    if (utf8(node.label).length > 256) longLabel.push(id);
    if (node.icon === '') emptyIcon.push(id);
    if ((graph.inDegree.get(id) ?? 0) > 4) highDegree.push(id);
    if (!legendEmpty && !legend.byHue.has(node.color)) {
      if (!unclaimed.has(node.color)) unclaimed.set(node.color, []);
      unclaimed.get(node.color)?.push(id);
    }
  }
  const smells = [
    { kind: 'label-too-long', nodes: counted(longLabel) },
    { kind: 'empty-icon', nodes: counted(emptyIcon) },
    { kind: 'high-in-degree', nodes: counted(highDegree) },
  ].filter((smell) => smell.nodes.count > 0);
  const hues = ['terracotta', 'olive', 'gold', 'brick', 'sky', 'plum'];
  return {
    cycles: listed(cycles.map(counted)), absentCycles: listed(absentCycles.map(counted)),
    missingEdges: listed(graph.edges.filter((edge) => !graph.tree.nodesById.has(edge.from) || !graph.tree.nodesById.has(edge.to)).map((edge) => [edge.from, edge.to])),
    selfEdges: listed(graph.edges.filter((edge) => edge.from === edge.to).map((edge) => [edge.from, edge.to])),
    smells, legendEmpty, unclaimedHues: [...unclaimed].sort((a, b) => hues.indexOf(a[0]) - hues.indexOf(b[0]) || compareText(a[0], b[0])).map(([hue, nodes]) => ({ hue, nodes: counted(nodes) })),
  };
}

/** @param {RoadmapAccount} account @param {string} tree */
export function pointerDiagnostics(account, tree) {
  const ways = account.waysBack(tree);
  const treeLoops = [];
  const danglingPointers = [];
  let treeLoopsOmitted = 0;
  let danglingPointersOmitted = 0;
  for (const opening of [...(account.openings.get(tree) ?? [])].sort((a, b) => compareText(a.node, b.node))) {
    if (opening.status === 'dangling') {
      if (danglingPointers.length === 50) danglingPointersOmitted++;
      else danglingPointers.push({ node: opening.node, tree: opening.tree });
      continue;
    }
    const way = ways.get(opening.tree);
    if (!way || opening.status === 'unknown') continue;
    if (treeLoops.length === 50) { treeLoopsOmitted++; continue; }
    const length = way.distance + 1;
    const path = [];
    let current = opening.tree;
    while (path.length < Math.min(8, length)) {
      path.push({ tree: current, title: account.locations.get(current)?.title ?? null });
      const next = ways.get(current)?.next;
      if (next === null || next === undefined) break;
      current = next;
    }
    treeLoops.push({ node: opening.node, path, pathOmitted: Math.max(0, length - path.length) });
  }
  const stale = [...(account.staleBranches.get(tree) ?? [])].sort((a, b) => compareText(a.node, b.node));
  return { treeLoops, treeLoopsOmitted, danglingPointers, danglingPointersOmitted, staleBranches: stale.slice(0, 50), staleBranchesOmitted: Math.max(0, stale.length - 50) };
}
