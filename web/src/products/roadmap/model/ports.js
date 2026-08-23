// Shapes shared with the C++ server: a field here is a field on the wire.
// NodeSpec: label '' is a bud; absent color reads as DEFAULT_NODE_COLOR; order '' falls back to
// createdAt; prerequisites must be complete to unlock; status is the document's authoring seed,
// read only when the account has no server overlay.
// TreeData.visibility is null until the server answers; TreeData.createdAt 0 predates the stamp.
// Progress.cleared is tombstones — a cleared mark must never be resurrected from a stale local
// copy; server false means the overlay fell back to the document's authoring seeds.
// RenderNode: layer is rank % 3, form is 0 linked | 1 bud | 2 unlinked. A RenderEdge inherits its
// source node's state.

export class TreeRepository {
  async loadTree() {
    throw new Error('TreeRepository.loadTree not implemented');
  }

  // Returns { completed, inProgress, startedAt, completedAt, server }, falling back to the
  // document's authoring seeds when the server holds no marks.
  async loadProgress(treeData) {
    throw new Error('TreeRepository.loadProgress not implemented');
  }

  // `since` is a seq cursor; 0 is the whole tail, capped by `limit`.
  async loadActivity({ since = 0, limit = 200 } = {}) {
    throw new Error('TreeRepository.loadActivity not implemented');
  }
}

export class LayoutEngine {
  // Returns Map<id, Vec2>, synchronously.
  layout(tree) {
    throw new Error('LayoutEngine.layout not implemented');
  }
}
