import { RoadmapTree } from '../domain/records.js';
import { FollowGraph } from '../domain/graph.js';
import { EffectsRead } from '../domain/reads.js';
import { UnlockRules } from './UnlockRules.js';

// The domain's graph of each tree with no step complete, built once and kept for every delete asked of that tree.
const unmarked = new WeakMap();

// The domain's `EffectsRead` over the room's tree, keyed in its order, complete as `progress` and its openings make it.
export function readEffects(tree, ids, progress = null) {
  if (!tree) return null;
  const width = String(tree.nodes.length).length;
  const roadmap = (marked) => new RoadmapTree({
    id: tree.id,
    nodes: tree.nodes.map((node, place) => ({ id: node.id, ord: String(place).padStart(width, '0') })),
    edges: tree.edges.map(({ from, to }) => ({ from, to, present: true })),
    marks: tree.nodes.filter((node) => marked.has(node.id)).map((node) => ({ node: node.id, status: 'complete', recordedAt: null, deviceAt: null })),
    pointers: tree.nodes.filter((node) => node.opening).map((node) => ({ node: node.id, present: true, opens: node.opening.treeId })),
  });
  if (progress !== null) return new EffectsRead(new FollowGraph(roadmap(progress.completed), UnlockRules.completed(tree, progress)), ids);
  if (!unmarked.has(tree)) unmarked.set(tree, new FollowGraph(roadmap(new Set())));
  return new EffectsRead(unmarked.get(tree), ids);
}
