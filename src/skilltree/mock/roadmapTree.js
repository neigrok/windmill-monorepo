// Windmill's own roadmap, as a Windmill tree — we track the product's progress
// inside the product (dogfood). Nodes are real increments; `color` is the area
// (sky = rendering, olive = interaction, gold = visual system, brick =
// domain/data/layout, terracotta = editing); `status` is where each item stands.
// Only `complete`/`active` are authoritative — `available`/`locked` are derived
// from the dependency graph by UnlockRules, so the saturated "available" nodes
// are exactly what's unlocked to build next.

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
    { id: 'radial-layout', label: 'Radial layout', icon: 'compass', color: 'brick', status: 'available', prerequisites: ['domain', 'layout-dagre'] },
    { id: 'command-layer', label: 'Command + undo stack', icon: 'clipboard-check', color: 'brick', status: 'complete', prerequisites: ['domain'] },
    { id: 'persistence', label: 'Save & load', icon: 'archive', color: 'brick', status: 'locked', prerequisites: ['command-layer'] },

    // ---- visual system (gold) ----
    { id: 'color-kind', label: 'Color by kind', icon: 'palette', color: 'gold', status: 'complete', prerequisites: ['renderer'] },
    { id: 'state-tiers', label: 'Three state tiers', icon: 'layers', color: 'gold', status: 'complete', prerequisites: ['color-kind'] },
    { id: 'edge-tint', label: 'Kind-tinted edges', icon: 'leaf', color: 'gold', status: 'complete', prerequisites: ['state-tiers'] },
    { id: 'edge-trim', label: 'Trim edges to node', icon: 'frame', color: 'gold', status: 'complete', prerequisites: ['edge-tint'] },
    { id: 'bud-state', label: 'Bud + unlinked states', icon: 'gem', color: 'gold', status: 'available', prerequisites: ['state-tiers'] },

    // ---- interaction (olive) ----
    { id: 'camera', label: 'Pan · zoom · inertia', icon: 'maximize', color: 'olive', status: 'complete', prerequisites: ['renderer'] },
    { id: 'tool-seam', label: 'Tool seam', icon: 'move', color: 'olive', status: 'complete', prerequisites: ['camera'] },
    { id: 'incr-move', label: 'Incremental node move', icon: 'truck', color: 'olive', status: 'complete', prerequisites: ['tool-seam', 'edge-trim'] },
    { id: 'edit-affordances', label: 'Calm hover affordances', icon: 'sparkles', color: 'olive', status: 'complete', prerequisites: ['tool-seam', 'state-tiers'] },

    // ---- editing features (terracotta) — the incoming spec ----
    { id: 'edit-mode', label: 'Always-editable mode', icon: 'pencil', color: 'terracotta', status: 'complete', prerequisites: ['edit-affordances', 'command-layer'] },
    { id: 'create-node', label: 'Create node', icon: 'plus', color: 'terracotta', status: 'complete', prerequisites: ['edit-mode', 'bud-state'] },
    { id: 'connect', label: 'Connect + cycle guard', icon: 'plug', color: 'terracotta', status: 'complete', prerequisites: ['edit-mode', 'domain'] },
    { id: 'reconnect', label: 'Reconnect edge', icon: 'wifi', color: 'terracotta', status: 'available', prerequisites: ['connect'] },
    { id: 'delete-edge', label: 'Delete edge', icon: 'x', color: 'terracotta', status: 'locked', prerequisites: ['connect', 'bud-state'] },
    { id: 'delete-node', label: 'Delete node + splice', icon: 'trash-2', color: 'terracotta', status: 'complete', prerequisites: ['create-node'] },
    { id: 'reorder', label: 'Move / reorder', icon: 'grid-3x3', color: 'terracotta', status: 'locked', prerequisites: ['radial-layout', 'edit-mode'] },
    { id: 'rename', label: 'Rename inline', icon: 'ruler', color: 'terracotta', status: 'complete', prerequisites: ['edit-mode'] },
    { id: 'kind-picker', label: 'Kind picker', icon: 'sun', color: 'terracotta', status: 'complete', prerequisites: ['edit-mode', 'color-kind'] },
    { id: 'undo-redo', label: 'Undo / redo (⌘Z)', icon: 'flag', color: 'terracotta', status: 'complete', prerequisites: ['command-layer'] },
  ],
};
