// Auto-layout for a SkillTree DAG. This is the only file in the app that talks
// to @dagrejs/dagre — the domain layer and scene only ever see the plain
// Map<id, Vec2> this produces. One-time cost per tree load, not a per-frame path.
import dagre from '@dagrejs/dagre';
import { LayoutEngine } from '../model/ports.js';
import { NODE_SIZE } from '../theme.js';

const NODE_SEPARATION = NODE_SIZE * 1.6;
const RANK_SEPARATION = NODE_SIZE * 2.4;
const NETWORK_SIMPLEX_MAX = 800;

export class DagreLayoutEngine extends LayoutEngine {
  layout(tree) {
    const graph = new dagre.graphlib.Graph();
    // network-simplex gives the tightest, least-tangled layout but is superlinear
    // on big diamond-heavy DAGs; fall back to the O(V+E) longest-path ranker only
    // for the large stress tree.
    const ranker = tree.nodes.length <= NETWORK_SIMPLEX_MAX ? 'network-simplex' : 'longest-path';
    graph.setGraph({
      rankdir: 'TB',
      nodesep: NODE_SEPARATION,
      ranksep: RANK_SEPARATION,
      ranker,
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
