// Windmill's own roadmap, as a Windmill tree — we track the product's progress
// inside the product (dogfood). Nodes are real increments; `color` is the area
// (sky = rendering, olive = interaction, gold = visual system, brick =
// domain/data/layout, terracotta = editing); `status` is where each item stands.
// Only `complete`/`active` are authoritative — `available`/`locked` are derived
// from the dependency graph by UnlockRules, so the saturated "available" nodes
// are exactly what's unlocked to build next.

// How to add a node and keep the tree tidy (the Tidiness badge scores this):
//   1. Give it ONE primary prerequisite in its own area (same `color`) — that's its
//      trunk, and it's what seats the node in its branch. Area seeds have `[]`.
//   2. Add a cross-area prerequisite only for a capability you genuinely can't build
//      without, and point it at the NEAREST such node. Each one draws as a faded chord
//      and costs tidiness — keep them few. (Here: 10, all real cross-area handoffs.)
//   3. Never list a prerequisite another prerequisite already implies. If A needs B and
//      B needs C, don't also put C on A — it's a redundant edge. The Tidy button strips
//      these; e.g. `connect` dropped `domain` because `edit-mode` already reaches it.
//   4. Keep in-degree low: 1 prereq ideal, 2 when a real cross-area dep exists; 3+ is a
//      smell — split the node or re-parent to a nearer ancestor.
// The connect gesture flags cross-area/redundant links live as you draw them.

export const roadmapTree = {
  id: 'windmill-roadmap',
  title: 'Product Roadmap',
  nodes: [
    { id: 'product', label: 'Windmill', icon: 'sprout', color: 'gold', status: 'complete', prerequisites: [] },

    // ---- rendering foundation (sky) ----
    { id: 'renderer', label: 'WebGL2 renderer', icon: 'zap', color: 'sky', status: 'complete', prerequisites: ['product'] },
    { id: 'icons', label: 'Icon atlas + LOD', icon: 'image', color: 'sky', status: 'complete', prerequisites: ['renderer'] },
    { id: 'labels', label: 'Zoom-scaled labels', icon: 'book-open', color: 'sky', status: 'complete', prerequisites: ['renderer'] },
    { id: 'minimap', label: 'Minimap + overlays', icon: 'map', color: 'sky', status: 'complete', prerequisites: ['renderer'] },

    // ---- domain / data / layout (brick) ----
    { id: 'domain', label: 'DAG domain + validation', icon: 'git-branch-plus', color: 'brick', status: 'complete', prerequisites: ['product'] },
    { id: 'layout-dagre', label: 'Layered layout', icon: 'layout-grid', color: 'brick', status: 'complete', prerequisites: ['domain'] },
    { id: 'radial-layout', label: 'Radial layout engine', icon: 'compass', color: 'brick', status: 'complete', prerequisites: ['layout-dagre', 'trunk-skeleton'] },
    { id: 'command-layer', label: 'Command + undo stack', icon: 'clipboard-check', color: 'brick', status: 'complete', prerequisites: ['domain'] },
    { id: 'persistence', label: 'Save & load', icon: 'archive', color: 'brick', status: 'complete', prerequisites: ['command-layer'] },

    // ---- visual system (gold) ----
    { id: 'color-kind', label: 'Color by kind', icon: 'palette', color: 'gold', status: 'complete', prerequisites: ['renderer'] },
    { id: 'state-tiers', label: 'Three state tiers', icon: 'layers', color: 'gold', status: 'complete', prerequisites: ['color-kind'] },
    { id: 'edge-tint', label: 'Kind-tinted edges', icon: 'leaf', color: 'gold', status: 'complete', prerequisites: ['state-tiers'] },
    { id: 'edge-trim', label: 'Trim edges to node', icon: 'frame', color: 'gold', status: 'complete', prerequisites: ['edge-tint'] },
    { id: 'bud-state', label: 'Bud + unlinked states', icon: 'gem', color: 'gold', status: 'complete', prerequisites: ['state-tiers'] },

    // ---- interaction (olive) ----
    { id: 'camera', label: 'Pan · zoom · inertia', icon: 'maximize', color: 'olive', status: 'complete', prerequisites: ['renderer'] },
    { id: 'tool-seam', label: 'Tool seam', icon: 'move', color: 'olive', status: 'complete', prerequisites: ['camera'] },
    { id: 'incr-move', label: 'Incremental node move', icon: 'truck', color: 'olive', status: 'complete', prerequisites: ['tool-seam', 'edge-trim'] },
    { id: 'edit-affordances', label: 'Calm hover affordances', icon: 'sparkles', color: 'olive', status: 'complete', prerequisites: ['tool-seam', 'state-tiers'] },

    // ---- editing features (terracotta) — the incoming spec ----
    { id: 'edit-mode', label: 'Always-editable mode', icon: 'pencil', color: 'terracotta', status: 'complete', prerequisites: ['edit-affordances', 'command-layer'] },
    { id: 'create-node', label: 'Create node', icon: 'plus', color: 'terracotta', status: 'complete', prerequisites: ['edit-mode', 'bud-state'] },
    { id: 'connect', label: 'Connect + cycle guard', icon: 'plug', color: 'terracotta', status: 'complete', prerequisites: ['edit-mode'] },
    { id: 'reconnect', label: 'Reconnect edge', icon: 'wifi', color: 'terracotta', status: 'complete', prerequisites: ['connect'] },
    { id: 'delete-edge', label: 'Delete edge', icon: 'x', color: 'terracotta', status: 'complete', prerequisites: ['connect', 'bud-state'] },
    { id: 'delete-node', label: 'Delete node + splice', icon: 'trash-2', color: 'terracotta', status: 'complete', prerequisites: ['create-node'] },
    { id: 'reorder', label: 'Move / reorder', icon: 'grid-3x3', color: 'terracotta', status: 'locked', prerequisites: ['radial-layout', 'edit-mode'] },
    { id: 'rename', label: 'Rename inline', icon: 'ruler', color: 'terracotta', status: 'complete', prerequisites: ['edit-mode'] },
    { id: 'kind-picker', label: 'Kind picker', icon: 'sun', color: 'terracotta', status: 'complete', prerequisites: ['edit-mode'] },
    { id: 'undo-redo', label: 'Undo / redo (⌘Z)', icon: 'flag', color: 'terracotta', status: 'complete', prerequisites: ['command-layer'] },
    { id: 'activity-feed', label: 'Activity feed', icon: 'activity', color: 'terracotta', status: 'complete', prerequisites: ['edit-mode', 'state-tiers'] },

    // ---- radial constraints initiative — keep any user's DAG clean & beautiful ----
    // Working theory: elect one trunk parent per node → radial sectors by branch →
    // demote/measure cross-branch links so mess reads as visible cost, not chaos.
    // These nodes double as the running task log for the initiative (per CLAUDE.md).
    { id: 'trunk-skeleton', label: 'Trunk skeleton pass', icon: 'anchor', color: 'brick', status: 'complete', prerequisites: ['domain'] },
    { id: 'edge-kinds', label: 'Trunk / link / chord edges', icon: 'fan', color: 'gold', status: 'complete', prerequisites: ['trunk-skeleton', 'edge-trim'] },
    { id: 'tree-health', label: 'Tidiness metrics', icon: 'thermometer', color: 'brick', status: 'complete', prerequisites: ['trunk-skeleton'] },
    { id: 'tidiness-badge', label: 'Tidiness score badge', icon: 'star', color: 'gold', status: 'complete', prerequisites: ['tree-health'] },
    { id: 'edit-cost-hints', label: 'Cross-boundary cost hints', icon: 'flame', color: 'terracotta', status: 'complete', prerequisites: ['connect', 'tree-health'] },
    { id: 'tidy-action', label: 'One-click tidy', icon: 'spray-can', color: 'terracotta', status: 'complete', prerequisites: ['tree-health', 'command-layer'] },
    { id: 'clean-create', label: 'Clean-by-default create', icon: 'feather', color: 'terracotta', status: 'complete', prerequisites: ['create-node', 'trunk-skeleton'] },

    // ---- motion language initiative (plum) — the tree breathes, it doesn't flash ----
    // One grammar for every animated moment: camera ease → travel → bloom → pulse →
    // toast, composed one ceremony at a time. Canonical spec: guidelines/motion-language.md
    // (X1). These plum deeds are the running log for the initiative (per CLAUDE.md); the
    // beats are GPU/DOM increments the ceremony director composes into the sentence.
    { id: 'motion-tokens', label: 'Motion tokens & beats', icon: 'ruler', color: 'plum', status: 'complete', prerequisites: ['state-tiers'] },
    { id: 'bloom-beat', label: 'Bloom · node ignites', icon: 'sparkles', color: 'plum', status: 'complete', prerequisites: ['motion-tokens'] },
    { id: 'travel-beat', label: 'Travel · light runs the edge', icon: 'zap', color: 'plum', status: 'complete', prerequisites: ['bloom-beat'] },
    { id: 'camera-ease', label: 'Camera ease · settle', icon: 'camera', color: 'plum', status: 'complete', prerequisites: ['motion-tokens'] },
    { id: 'crown-pulse', label: 'Crown & pulse · the breath', icon: 'star', color: 'plum', status: 'complete', prerequisites: ['bloom-beat'] },
    { id: 'toast-beat', label: 'Toast · quiet status', icon: 'speaker', color: 'plum', status: 'complete', prerequisites: ['motion-tokens'] },
    { id: 'reduced-motion', label: 'Reduced-motion fallbacks', icon: 'shield', color: 'plum', status: 'complete', prerequisites: ['motion-tokens'] },
    { id: 'ceremony-director', label: 'Ceremony director', icon: 'compass', color: 'plum', status: 'complete', prerequisites: ['travel-beat', 'camera-ease', 'toast-beat'] },
    { id: 'yield-to-input', label: 'Motion yields to interaction', icon: 'move', color: 'plum', status: 'complete', prerequisites: ['ceremony-director'] },
    { id: 'motion-visual-qa', label: 'Ceremony visual QA', icon: 'sun', color: 'plum', status: 'active', prerequisites: ['ceremony-director', 'crown-pulse'] },
  ],
};
