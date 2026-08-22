// Contracts for the roadmap feature: the shared data shapes plus the two ports
// (TreeRepository, LayoutEngine) the load pipeline drives. Everything in model/ is
// pure — no WebGL, no React. The C++ server answers these same shapes over HTTP, so
// a field written down here is a field on the wire; when one moves, both sides move.

// ---- scalars ---------------------------------------------------------------
//
// NodeState  'locked' | 'available' | 'active' | 'complete'. UnlockRules.derive mints
//            it from a tree plus a Progress; nothing else may hand-set a node state.
// NodeKind   the hue a step wears — one of theme.js's NODE_COLOR_NAMES: 'terracotta',
//            'olive', 'gold', 'brick', 'sky', 'plum'. A node's `color` field IS its
//            kind; model/Legend.js only names and orders those six hues.
// Vec2       { x, y } in world units, where a node is NODE_SIZE (56) across.
// Bounds     { minX, minY, maxX, maxY }, the same world units.
// Hlc        { ms, counter, node } — the sync clock's stamp (sync/lattice.js).

// ---- what a repository returns ----------------------------------------------
//
// NodeSpec — one step, as the server's tree document carries it and as the lattice
// projects it (sync/lattice.js `toTreeData`):
//   id             string
//   label          string — '' means a bud: born, not yet named
//   icon           string — a lucide icon name
//   color          NodeKind — absent reads as terracotta (DEFAULT_NODE_COLOR)
//   order          string — the fractional-index sibling key the layout sorts by;
//                  '' falls back to `createdAt`
//   createdAt      Hlc — creation stamp, and the order fallback's tiebreak
//   prerequisites  string[] — ids that must be complete to unlock (the DAG parents)
//   description    string, optional
//   links          [{ id, url, title, domain }], optional — the node workspace's links
//   status         'complete' | 'active', optional — the document's authoring seed,
//                  read only when the account has no server overlay
//   position       Vec2, optional — a register mirrored with the backend's LooseGraph
//                  and carried on the wire, but NOT read on the render path today:
//                  RadialLayoutEngine places every node, and the layout/applyNudges
//                  override that once consumed it is gone.
//
// Kind — one legend entry: { id, hue: NodeKind, label, description }. Legend order is
// generation priority; `count` is derived per render by Legend.withCounts, never stored.
//
// TreeData — what loadTree() returns and what SkillTree consumes:
//   id, title, nodes: NodeSpec[], kinds: Kind[] (the legend, in order)
// plus what the server knows ABOUT the document rather than in it:
//   visibility     'private' | 'unlisted' | 'public' | null — null until the server answers
//   mine           boolean — is the caller its owner
//   createdAt      number — planting time, epoch ms; 0 when the row predates the stamp
// A device-born tree projected from the local lattice blob stamps `mine` from the device
// index and leaves the other two at their null/0 defaults.
//
// Progress — one user's overlay of one tree:
//   completed      Set<string>
//   inProgress     Set<string>
//   cleared        Set<string> — tombstones. A mark the server holds as explicitly
//                  cleared must never be resurrected from a stale local copy.
//   server         boolean — true when this IS the account's overlay from the server,
//                  false when it fell back to the document's authoring seeds. The load
//                  pipeline lets a real overlay win over stale localStorage.
//
// ActivityEvent — one row of the op log's structural history: { id, actor, verb, nodeId,
// label, kind, at, summary }, the shape activity/ActivityLog.js constructs.

// ---- what the domain hands the scene ----------------------------------------
//
// RenderNode — SkillTree.toRenderModel's projection of a NodeSpec:
//   id, label, icon
//   color          NodeKind → hue
//   x, y           world units, from the layout
//   layer          rank % 3 — the parallax z-band (0 = back)
//   state          NodeState → the tier the shader draws
//   form           0 linked | 1 bud | 2 unlinked (theme.js `nodeForm`) — structure,
//                  orthogonal to state
//   glowSeed       stable 0..1 per id; decorrelates the pulse phase
//   branch         the top-level trunk branch (sector) this node belongs to
//   emphasis       1 for a root (the tree's heart) → larger + crowned, else 0
//
// RenderEdge — { from, to, kind } where kind is 'trunk' | 'in-branch' | 'cross-branch'.
// A branch carries no state of its own — it inherits its SOURCE node, which is why there
// is no `active` field here: ConnectorBatch reads the source's state to grow the edge.
//
// RenderModel — { nodes: RenderNode[], edges: RenderEdge[], bounds: Bounds }.

export class TreeRepository {
  async loadTree() {
    throw new Error('TreeRepository.loadTree not implemented');
  }

  // The overlay to open at — { completed, inProgress, startedAt, completedAt, server } — falling
  // back to the document's authoring seeds when the server holds no marks, hence the whole
  // TreeData rather than just an id. A bootstrap read: once the SyncSession's private lane grafts,
  // IT owns the overlay for an editable view, and this answer is only what a share view keeps.
  async loadProgress(treeData) {
    throw new Error('TreeRepository.loadProgress not implemented');
  }

  // The op log's structural history — added/renamed/removed and the edge deeds, each
  // with a ready `summary` and a real timestamp, including edits by collaborators this
  // browser never saw. `since` is a seq cursor; 0 is the whole tail, capped by `limit`.
  async loadActivity({ since = 0, limit = 200 } = {}) {
    throw new Error('TreeRepository.loadActivity not implemented');
  }
}

export class LayoutEngine {
  // layout(tree) -> Map<id, Vec2>, synchronously — the live path re-lays on every
  // structural change, so an engine must be cheap enough to run inline.
  layout(tree) {
    throw new Error('LayoutEngine.layout not implemented');
  }
}
