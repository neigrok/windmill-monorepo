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
    { id: 'motion-visual-qa', label: 'Ceremony visual QA', icon: 'sun', color: 'plum', status: 'complete', prerequisites: ['ceremony-director', 'crown-pulse'] },
    { id: 'hover-press-feedback', label: 'Hover / press feedback', icon: 'gem', color: 'plum', status: 'complete', prerequisites: ['motion-tokens'] },
    { id: 'arrival-cascade', label: 'Paste-arrival cascade', icon: 'sprout', color: 'plum', status: 'complete', prerequisites: ['ceremony-director', 'camera-ease'] },

    // ---- share identity initiative (X2) — one frame for everything that leaves the app ----
    // A warm postcard mat around the tree's own canvas, a dominant-kind rule, the progress
    // "score" and the terracotta wordmark — one shared recipe behind the OG card, the PNG,
    // the gallery thumb and the GIF, so they can't drift. Canonical spec:
    // explorations/share-identity.html (X2). These deeds are the running log (per CLAUDE.md).
    { id: 'share-palette', label: 'Share palette (light + dark)', icon: 'palette', color: 'gold', status: 'complete', prerequisites: ['color-kind'] },
    { id: 'share-stats', label: 'Dominant kind + progress', icon: 'thermometer', color: 'brick', status: 'complete', prerequisites: ['domain'] },
    { id: 'share-frame', label: 'Shared frame recipe', icon: 'frame', color: 'gold', status: 'complete', prerequisites: ['share-palette'] },
    { id: 'tree-portrait', label: 'Tree portrait (SVG)', icon: 'image', color: 'sky', status: 'complete', prerequisites: ['share-frame'] },
    { id: 'share-export', label: 'Canvas2D export · PNG @2x', icon: 'archive', color: 'sky', status: 'complete', prerequisites: ['tree-portrait', 'share-stats'] },
    { id: 'share-dialog', label: 'Share dialog', icon: 'external-link', color: 'terracotta', status: 'complete', prerequisites: ['share-export'] },
    { id: 'gallery-card', label: 'Gallery card', icon: 'layout-grid', color: 'gold', status: 'complete', prerequisites: ['tree-portrait'] },
    { id: 'share-gif', label: 'GIF intro / outro', icon: 'sparkles', color: 'plum', status: 'active', prerequisites: ['share-export', 'reduced-motion'] },

    // ---- durable progress initiative (F1) — a started step wakes up, and progress lasts ----
    // The third calm read between available and complete: an "ember" that keeps available's
    // ring, tints its fill, and breathes at half the crown on the shared 2400ms clock —
    // kindled quietly (no ceremony, no toast) and made durable across reloads. The StepPanel
    // grows a state chip whose menu is the correction path, plus started/completed timestamps.
    // Canonical spec: explorations/progress-and-tree-registry.html (F1). These deeds are the
    // running log (per CLAUDE.md).
    { id: 'ember-state', label: 'In-progress ember read', icon: 'flame', color: 'gold', status: 'complete', prerequisites: ['state-tiers', 'crown-pulse'] },
    { id: 'kindle-beat', label: 'Kindle · start warms a node', icon: 'sparkles', color: 'plum', status: 'complete', prerequisites: ['motion-tokens', 'ember-state'] },
    { id: 'step-state-block', label: 'StepPanel state chip + menu', icon: 'clipboard-check', color: 'terracotta', status: 'complete', prerequisites: ['activity-feed', 'ember-state'] },
    { id: 'progress-timestamps', label: 'Started / completed times', icon: 'flag', color: 'terracotta', status: 'complete', prerequisites: ['step-state-block'] },
    { id: 'durable-progress', label: 'Durable progress store', icon: 'archive', color: 'brick', status: 'complete', prerequisites: ['persistence', 'step-state-block'] },

    // ---- node workspace initiative (F13) — a node becomes the surface you work from ----
    // The StepPanel grows a body: a sub-task checklist, a markdown note, and resource links.
    // The glyph wears a thin kind-hued progress arc that closes as sub-tasks complete —
    // orthogonal to tier, hidden at complete — and closing it IS the completion: the gauge
    // you fill dissolves into the halo you earn (auto-complete reuses the F1 bloom). Canonical
    // spec: explorations/node-workspace.html (F13). These deeds are the running log (per CLAUDE.md).
    { id: 'workspace-checklist', label: 'Sub-task checklist', icon: 'clipboard-check', color: 'terracotta', status: 'complete', prerequisites: ['step-state-block'] },
    { id: 'workspace-note-links', label: 'Note + links drawer', icon: 'pencil', color: 'terracotta', status: 'complete', prerequisites: ['workspace-checklist'] },
    { id: 'progress-arc', label: 'Sub-task progress arc', icon: 'thermometer', color: 'gold', status: 'complete', prerequisites: ['state-tiers', 'workspace-checklist'] },
    { id: 'auto-complete', label: 'Checklist auto-complete', icon: 'sparkles', color: 'plum', status: 'complete', prerequisites: ['progress-arc', 'kindle-beat'] },
    { id: 'workspace-store', label: 'Durable node workspaces', icon: 'archive', color: 'brick', status: 'complete', prerequisites: ['durable-progress', 'workspace-checklist'] },

    // ---- color legend initiative (F6) — kinds with names ----
    // Each tree names its hues in a small on-canvas key that is also its editor: rename,
    // recolor (swap a kind's hue, repaint its steps), add/remove, describe. Clicking a row
    // highlights that kind (the rest of the tree dims). The key is the palette contract that
    // generation (F17) and paste-import (F3) will fill against. The legend now lives on the
    // backend: seeded on tree creation, served in the tree payload, edited through legend
    // collab ops (validated server-side), copied on fork, and exposed as MCP tools — the
    // client store became a cache. Canonical spec: explorations/color-legend.html (F6).
    // These deeds are the running log (per CLAUDE.md).
    { id: 'kind-legend', label: 'On-canvas color key', icon: 'palette', color: 'gold', status: 'complete', prerequisites: ['color-kind', 'kind-picker'] },
    { id: 'legend-editor', label: 'Legend editor · name & recolor', icon: 'pencil', color: 'terracotta', status: 'complete', prerequisites: ['kind-legend'] },
    { id: 'kind-highlight', label: 'Highlight by kind', icon: 'sun', color: 'olive', status: 'complete', prerequisites: ['kind-legend', 'edit-affordances'] },
    { id: 'legend-store', label: 'Durable per-tree legend', icon: 'archive', color: 'brick', status: 'complete', prerequisites: ['legend-editor', 'persistence'] },
    { id: 'legend-backend', label: 'Server-authoritative legend', icon: 'server', color: 'brick', status: 'complete', prerequisites: ['legend-store'] },

    // ---- read-only & mobile initiative (X5) — a shared tree, first-class on a phone ----
    // The responsive read-only surface: phone bottom-sheet, tablet side-panel, desktop; editing
    // chrome absent (not disabled), keyed off a ?view param + auto on small screens. Mobile chrome
    // (kind rule, plaque, wordmark, Fork CTA, Recenter) replaces the ControlBar; the StepPanel
    // re-docks as a sheet; touch grammar adds one-finger pan, pinch, double-tap. Fork/gallery/
    // hosted routing are backend tasks (docs/backend/X5-read-only-mobile.md); full dark theme is a
    // follow-up. Canonical spec: explorations/read-only-mobile.html (X5). Running log per CLAUDE.md.
    { id: 'view-mode', label: 'Read-only mode + breakpoints', icon: 'shield', color: 'sky', status: 'complete', prerequisites: ['renderer', 'edit-mode'] },
    { id: 'touch-grammar', label: 'Touch pan / pinch / double-tap', icon: 'move', color: 'olive', status: 'complete', prerequisites: ['camera', 'view-mode'] },
    { id: 'mobile-chrome', label: 'Mobile chrome + bottom sheet', icon: 'layout-grid', color: 'gold', status: 'complete', prerequisites: ['view-mode', 'share-frame'] },
    { id: 'fork-door', label: 'Fork door · one verb (UI)', icon: 'git-branch-plus', color: 'terracotta', status: 'active', prerequisites: ['mobile-chrome'] },

    // ---- auth initiative (X6) — claiming, not gating ----
    // Passwordless magic-link auth: one door keyed by email, 15-min single-use links, 90-day
    // rolling sessions. Signing in claims your roadmaps; signed-out never blocks building —
    // "the worst case of auth is the product's normal signed-out state". The account seat is the
    // only unprompted mention of sign-in; the fork door shares the one door; every failure ends
    // in a next step (gold, never a wall — only "can't reach" is a brick). Backend contract: the
    // X6 magic-link service. Canonical spec: guidelines/auth.md. Running log per CLAUDE.md.
    { id: 'auth-client', label: 'Magic-link API client', icon: 'plug', color: 'brick', status: 'complete', prerequisites: ['persistence'] },
    { id: 'auth-session', label: 'Session provider · the seat', icon: 'shield', color: 'brick', status: 'complete', prerequisites: ['auth-client'] },
    { id: 'sign-in-door', label: 'One door · email me a link', icon: 'external-link', color: 'terracotta', status: 'complete', prerequisites: ['auth-session', 'fork-door'] },
    { id: 'auth-landing', label: 'Magic-link landing · #/auth', icon: 'wifi', color: 'sky', status: 'complete', prerequisites: ['sign-in-door'] },
    { id: 'account-seat', label: 'Account seat · claim beat', icon: 'gem', color: 'gold', status: 'complete', prerequisites: ['auth-session', 'crown-pulse'] },

    // ---- marketing landing initiative — any goal, as a skill tree ----
    // The public landing page (ui_kits/marketing): a live self-playing demo tree in the hero, three
    // how-it-works beats, developer quest thumbnails, the story trio (share / MCP / everywhere), and
    // CTAs into the app + the X6 sign-in door. A small DOM scene engine (treeScenes) renders the live
    // moat without spinning up the WebGL app. Route #/welcome. Backend contract for the CTAs:
    // docs/backend/landing-and-quests.md (quest catalog + tree creation). Running log per CLAUDE.md.
    { id: 'landing-scenes', label: 'Live tree scenes · the moat', icon: 'sparkles', color: 'sky', status: 'complete', prerequisites: ['renderer', 'bloom-beat'] },
    { id: 'landing-page', label: 'Marketing landing · #/welcome', icon: 'external-link', color: 'gold', status: 'complete', prerequisites: ['landing-scenes', 'share-frame', 'sign-in-door'] },

    // ---- transactional email initiative (X7) — the shell that survives Gmail ----
    // Table-based, inline-CSS templates for the mail service (Resend), living in /emails. Warm
    // night-sky dark mode, brand-font stacks as the contract, hidden preheaders, plain-text twins.
    // Sign-in + first-time sign-up magic links carry X6's {{magic_link}}; the frontier reminder
    // loops over ready steps. Domain moved to windmill.works across app + mail. Docs: emails/README.md.
    { id: 'email-shell', label: 'Email shell · warm, dark-aware', icon: 'frame', color: 'gold', status: 'complete', prerequisites: ['share-palette'] },
    { id: 'email-magic-link', label: 'Magic-link mail · sign-in + signup', icon: 'external-link', color: 'terracotta', status: 'complete', prerequisites: ['email-shell', 'auth-landing'] },
    { id: 'email-reminder', label: 'Frontier reminder mail', icon: 'flag', color: 'brick', status: 'complete', prerequisites: ['email-shell', 'durable-progress'] },
    { id: 'domain-works', label: 'Domain · windmill.works', icon: 'server', color: 'sky', status: 'complete', prerequisites: ['email-magic-link'] },
  ],
};
