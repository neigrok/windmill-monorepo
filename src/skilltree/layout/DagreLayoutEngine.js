// Auto-layout for a SkillTree DAG. This is the only file in the app that talks
// to @dagrejs/dagre — the domain layer and scene only ever see the plain
// Map<id, Vec2> this produces. One-time cost per tree load, not a per-frame path.
import dagre from '@dagrejs/dagre';
import { LayoutEngine } from '../model/ports.js';
import { NODE_SIZE } from '../theme.js';

const NODE_SEPARATION = NODE_SIZE * 1.6;
const RANK_SEPARATION = NODE_SIZE * 2.4;

export class DagreLayoutEngine extends LayoutEngine {
  layout(tree) {
    const graph = new dagre.graphlib.Graph();
    // 'longest-path': the default 'network-simplex' ranker is superlinear on
    // diamond-heavy DAGs (minutes at 5,000 nodes); this stays O(V+E) and
    // agrees with SkillTree.ranks(), which is also longest-path depth.
    graph.setGraph({
      rankdir: 'TB',
      nodesep: NODE_SEPARATION,
      ranksep: RANK_SEPARATION,
      ranker: 'longest-path',
    });
    graph.setDefaultEdgeLabel(() => ({}));

    tree.nodes.forEach((node) => {
      graph.setNode(node.id, { width: NODE_SIZE, height: NODE_SIZE });
    });
    tree.edges.forEach((edge) => {
      graph.setEdge(edge.from, edge.to);
    });

    dagre.layout(graph);

    const positions = new Map();
    tree.nodes.forEach((node) => {
      const { x, y } = graph.node(node.id);
      positions.set(node.id, { x, y });
    });
    return positions;
  }
}
