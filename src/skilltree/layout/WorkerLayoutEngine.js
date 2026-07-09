// The production LayoutEngine: same layered dagre layout as DagreLayoutEngine,
// but run in a Web Worker so the 5,000-node pass never freezes the UI. layout()
// is async here (the port allows Map or Promise<Map>); the worker is created
// lazily and reused, and concurrent calls are correlated by request id so a
// fast dataset re-toggle can't cross its wires.
import { LayoutEngine } from '../model/ports.js';
import { NODE_SIZE } from '../theme.js';

const NODE_SEPARATION = NODE_SIZE * 1.6;
const RANK_SEPARATION = NODE_SIZE * 2.4;
const NETWORK_SIMPLEX_MAX = 800;

export class WorkerLayoutEngine extends LayoutEngine {
  constructor() {
    super();
    this.worker = null;
    this.nextId = 0;
    this.pending = new Map();
  }

  layout(tree) {
    const worker = this.ensureWorker();
    const id = this.nextId++;
    // network-simplex is the tightest ranker but superlinear on big diamond-heavy
    // DAGs; use the O(V+E) longest-path ranker only for the large stress tree.
    const ranker = tree.nodes.length <= NETWORK_SIMPLEX_MAX ? 'network-simplex' : 'longest-path';
    const request = {
      id,
      nodes: tree.nodes.map((node) => node.id),
      edges: tree.edges,
      cfg: { rankdir: 'TB', nodesep: NODE_SEPARATION, ranksep: RANK_SEPARATION, ranker, nodeSize: NODE_SIZE },
    };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      worker.postMessage(request);
    });
  }

  ensureWorker() {
    if (this.worker) return this.worker;
    this.worker = new Worker(new URL('./dagre.worker.js', import.meta.url), { type: 'module' });
    this.worker.onmessage = (event) => {
      const { id, positions, error } = event.data;
      const entry = this.pending.get(id);
      if (!entry) return;
      this.pending.delete(id);
      if (error) return entry.reject(new Error(`layout worker failed: ${error}`));
      entry.resolve(new Map(positions));
    };
    this.worker.onerror = (event) => {
      const failures = [...this.pending.values()];
      this.pending.clear();
      failures.forEach((entry) => entry.reject(new Error(`layout worker crashed: ${event.message || 'unknown'}`)));
    };
    return this.worker;
  }

  dispose() {
    if (!this.worker) return;
    this.worker.terminate();
    this.worker = null;
    this.pending.clear();
  }
}
