// Runs the dagre layout off the main thread. A 5,000-node layout is ~2.3s of
// pure CPU; on the main thread that freezes the whole UI (the loading overlay
// can't even animate). Here it's just a message in, positions out. Generic
// dagre runner: all tuning arrives in cfg, so this file knows nothing about
// the domain.
import dagre from '@dagrejs/dagre';

self.onmessage = (event) => {
  const { id, nodes, edges, cfg } = event.data;
  try {
    const graph = new dagre.graphlib.Graph();
    graph.setGraph({ rankdir: cfg.rankdir, nodesep: cfg.nodesep, ranksep: cfg.ranksep, ranker: cfg.ranker });
    graph.setDefaultEdgeLabel(() => ({}));
    nodes.forEach((nodeId) => graph.setNode(nodeId, { width: cfg.nodeSize, height: cfg.nodeSize }));
    edges.forEach((edge) => graph.setEdge(edge.from, edge.to));
    dagre.layout(graph);

    const positions = nodes.map((nodeId) => {
      const node = graph.node(nodeId);
      return [nodeId, { x: node.x, y: node.y }];
    });
    self.postMessage({ id, positions });
  } catch (err) {
    self.postMessage({ id, error: String((err && err.message) || err) });
  }
};
