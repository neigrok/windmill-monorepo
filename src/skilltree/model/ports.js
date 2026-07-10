// Contracts for the skilltree feature: the shared data shapes plus the two
// ports (TreeRepository, LayoutEngine) that let mock data plug in now and a
// real backend plug in later. Everything in model/ is pure — no WebGL, no React.

/**
 * @typedef {'locked'|'available'|'active'|'complete'} NodeState
 * @typedef {{ x: number, y: number }} Vec2
 * @typedef {{ minX: number, minY: number, maxX: number, maxY: number }} Bounds
 *
 * @typedef {'terracotta'|'olive'|'gold'|'sky'|'brick'} NodeColor
 *
 * @typedef {Object} NodeSpec              input shape (mock now, backend later)
 * @property {string} id
 * @property {string} label
 * @property {string} icon                 lucide icon name
 * @property {NodeColor} [color]           the node's kind; picks its hue (defaults to terracotta)
 * @property {string[]} prerequisites      ids that must be complete to unlock (DAG parents)
 * @property {Vec2} [position]             manual nudge; overrides auto-layout
 * @property {Object} [meta]
 *
 * @typedef {Object} TreeData              what a TreeRepository returns
 * @property {string} id
 * @property {string} title
 * @property {NodeSpec[]} nodes
 *
 * @typedef {Object} Progress              a user's progress over one tree
 * @property {Set<string>} completed
 * @property {Set<string>} inProgress
 *
 * @typedef {Object} RenderNode            domain output consumed by the scene
 * @property {string} id
 * @property {string} label
 * @property {string} icon
 * @property {NodeColor} color             its kind → hue
 * @property {number} x
 * @property {number} y
 * @property {number} layer                z-band for parallax (0 = back)
 * @property {NodeState} state             progress → brightness/glow envelope
 * @property {number} glowSeed             stable 0..1 per node; decorrelates pulse phase
 *
 * @typedef {Object} RenderEdge            a branch; its look follows its source node
 * @property {string} from
 * @property {string} to
 *
 * @typedef {Object} RenderModel
 * @property {RenderNode[]} nodes
 * @property {RenderEdge[]} edges
 * @property {Bounds} bounds
 */

export class TreeRepository {
  async loadTree() {
    throw new Error('TreeRepository.loadTree not implemented');
  }

  async loadProgress(treeId) {
    throw new Error('TreeRepository.loadProgress not implemented');
  }
}

export class LayoutEngine {
  // layout(tree) -> Map<id, Vec2>, or a Promise of one (the worker engine is async).
  layout(tree) {
    throw new Error('LayoutEngine.layout not implemented');
  }
}
