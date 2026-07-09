# Skill-tree feature — architecture & build contract

One self-contained feature package: `src/skilltree/`. Renders a Windmill roadmap
(a **DAG** — nodes can have multiple prerequisites) as a painterly RPG skill tree,
using **three.js r0.185** as a flat/2.5D top-down GPU renderer. Target: **60fps at
5,000+ nodes, ~3 draw calls**, with pan/zoom, hover, click-to-complete.

This file is the single source of truth for the four parallel agents. Build against
the documented interfaces; do not change file layout, export names, or method
signatures without saying so.

## The pipeline (this is the whole app, top to bottom)

Lives in `SkillTreeView.jsx` (Agent D). Reads like plain English:

```
const tree      = new SkillTree(await repo.loadTree());     // entity + DAG validation
const progress  = await repo.loadProgress(tree.id);         // {completed, inProgress}
const states    = UnlockRules.derive(tree, progress);       // Map<id, NodeState>
const positions = applyNudges(layout.layout(tree), tree);   // Map<id, Vec2>
const model     = tree.toRenderModel(positions, states);    // RenderModel
scene.setModel(model);                                       // GPU build + fit
// on click-to-complete: mutate progress → states = derive(...) → scene.applyStates(states)
```

Repository loads → domain computes → scene renders. No business logic in the scene
or React layers.

## Contracts (already authored — do not redefine)

- `model/ports.js` — data shapes (`NodeSpec`, `TreeData`, `Progress`, `RenderNode`,
  `RenderEdge`, `RenderModel`, `Bounds`, `Vec2`, `NodeState`) + base classes
  `TreeRepository`, `LayoutEngine`.
- `theme.js` — resolved hex palette (`FRUIT`, `CONNECTOR`, `LEAF`, `BACKGROUND`,
  `NODE_STATES`, `NODE_SIZE`). Scene + atlas use these so the GPU look matches the CSS.
- `scene/SkillTreeScene.js` — the scene's public API (stub now; Agent C fills it in).

Positions are in **world units** where a node is `NODE_SIZE` (56) units in diameter.

## Ownership (agents do not edit outside their subtree)

### Agent A — `model/` + `mock/`  (pure JS, no three/React)
Files:
- `model/SkillTree.js` — `class SkillTree`
  - `constructor(treeData)` — validate it's a DAG (throw on cycle / dangling prereq),
    index `byId`, derive edges from `prerequisites`.
  - getters: `id`, `title`, `nodes`, `edges` (`{from,to}[]`).
  - graph ops: `roots()`, `parentsOf(id)`, `childrenOf(id)`, `ancestorsOf(id)`,
    `topoOrder()`, `ranks()` (Map<id,int> longest-path depth from roots).
  - `toRenderModel(positions, states)` → `RenderModel`. Sets each node's `x,y` from
    `positions`, `state` from `states`, `layer = ranks()[id] % 3`, `glowSeed` = a
    stable hash of `id` mapped to 0..1. Edges get `active = states.get(from)==='complete'`.
    Compute `bounds` from node positions (pad by NODE_SIZE).
- `model/UnlockRules.js` — `class UnlockRules` with static `derive(tree, progress)`:
  - `complete` if id ∈ completed
  - else `active` if id ∈ inProgress
  - else `available` if every prerequisite ∈ completed (roots qualify vacuously)
  - else `locked`
- `model/SpatialGrid.js` — `class SpatialGrid`
  - `constructor(renderNodes, cellSize)` — bucket node ids by floor(x/cell),floor(y/cell).
  - `nearest(x, y, maxRadius)` → id | null (search the 3×3 neighborhood of cells).
  - `within(minX, minY, maxX, maxY)` → id[] (for LOD label selection).
- `mock/MockTreeRepository.js` — `class MockTreeRepository extends TreeRepository`.
  - `constructor({ size } = {})` — `size: 'demo' | 'huge'` (default `'demo'`).
  - `loadTree()` → demo tree for `'demo'`, generated 5,000+ for `'huge'` (simulate latency
    with an awaited resolved promise — no timers; `Date.now`/`Math.random` are fine in app code).
  - `loadProgress(treeId)` → a plausible `{completed, inProgress}` seeded from the tree
    (e.g. roots + first ring complete, next ring inProgress) so the first paint looks alive.
- `mock/handAuthoredTree.js` — export `handAuthoredTree`: a ~40-node `TreeData`, a real,
  legible roadmap (e.g. "Living room makeover" or "Ship a product"), DAG with a couple of
  diamonds (a node with 2 prerequisites), a few `position` nudges, good lucide `icon` names.
  This is the "nice-looking" showcase tree.
- `mock/generateBigTree.js` — export `generateBigTree(count = 5000)` → `TreeData`. A wide,
  layered DAG (branching factor ~2–4, occasional cross-links to make real diamonds).
  Deterministic given a seed arg so perf runs are reproducible.

Acceptance: `new SkillTree(generateBigTree(5000))` constructs; `topoOrder`, `ranks`,
`derive`, `toRenderModel` all run; `SpatialGrid.nearest` returns the obviously-closest node.

### Agent B — `layout/`
Files:
- `layout/DagreLayoutEngine.js` — `class DagreLayoutEngine extends LayoutEngine`.
  - `layout(tree)` → `Map<id, {x,y}>` using `@dagrejs/dagre` (already installed).
    Top-to-bottom (`rankdir: 'TB'`), `nodesep ~ NODE_SIZE*1.6`, `ranksep ~ NODE_SIZE*2.4`,
    node width/height = `NODE_SIZE`. Center coordinates on the node (dagre gives center).
  - Must handle a 5,000-node DAG without throwing; it's a one-time cost, not per-frame.
- `layout/applyNudges.js` — export `applyNudges(positions, tree)` → new `Map` where any
  node with a `position` override replaces the computed coordinate. Pure, returns a copy.

Acceptance: layout of `handAuthoredTree` yields non-overlapping, layered coordinates;
`applyNudges` honors overrides; layout of 5,000 nodes completes.

### Agent C — `scene/`  (the hard one — three.js r0.185, WebGL2)
Fulfill the `SkillTreeScene` API in `scene/SkillTreeScene.js`. Files:
- `scene/SkillTreeScene.js` — orchestrator: owns `WebGLRenderer`, an **OrthographicCamera**,
  the rAF loop (updates only `uTime` + camera — never per-node JS), and the three layers.
  Implements the documented API. Picking: pointer → world coords (trivial with ortho) →
  `SpatialGrid.nearest` → `onNodePick`/`onNodeHover`. Throttle hover.
- `scene/CameraController.js` — custom pan (drag), zoom (wheel, cursor-anchored), inertia,
  `fitToView(bounds)`, `focus(x,y)`. No OrbitControls (that's for 3D orbit).
- `scene/NodeLayer.js` — **one `InstancedMesh`** (a unit quad) + a custom `ShaderMaterial`.
  Per-instance `InstancedBufferAttribute`s: `aOffset(vec3 x,y,layer)`, `aState(float 0..3)`,
  `aScale(float)`, `aGlowSeed(float)`, `aSelected(float)`. Uniforms: `uTime`, `uAtlas`,
  `uAtlasCols/Rows`, `uNodeSize`. Fragment: sample the atlas cell for `aState`; add an
  additive radial **glow** that pulses `sin(uTime*speed + aGlowSeed*TAU)` for
  available/active; brighten + up-scale on `aSelected`/hover. All animation is GPU-side.
  `setInstances(renderNodes)`, `setStates(statesMap)` (updates `aState` + flags `needsUpdate`),
  `setSelected(id)`.
- `scene/ConnectorLayer.js` — **one merged `BufferGeometry`** for all edges. Each edge = a
  quadratic bézier with the same gentle perpendicular bend as the DOM `SkillConnector`,
  tessellated into a triangle-strip ribbon of width ~4. Per-vertex attrs: `aActive(0/1)`,
  `aAlongT(0..1)` (position along the curve for growth), `aGrowStart`. Uniforms `uTime`,
  `uGrowDuration`, colors from `theme.CONNECTOR`. Growth reveals ribbon where
  `aAlongT <= (uTime-aGrowStart)/uGrowDuration`. Rebuild geometry only on `setModel`;
  `setStates` updates the `aActive` buffer + growth start for newly-active edges.
- `scene/LabelLayer.js` — pooled `troika-three-text` Text objects (cap ~64). On camera
  change (throttled) and above a zoom threshold: `SpatialGrid.within(viewport)` → take the
  nearest N to viewport center → assign pooled Texts at node positions; hide the rest.
  Below the zoom threshold, hide all labels (far LOD = just fruit + branches).
- `scene/NodeAtlas.js` — `class NodeAtlas`. Draws the 4 fruit states to an offscreen canvas
  grid (e.g. 2×2, 256px cells) using `theme.FRUIT` — a radial gradient `inner→outer` body +
  `ring` stroke, matching DOM `SkillNode`. Exposes a `CanvasTexture`, `cols`, `rows`, and
  `cellForState(state)`. Glow + leaves are the shader's job, not the atlas.

Perf rules (non-negotiable): constant draw calls regardless of node count; no per-node work
in the animation loop; no per-frame allocation; `InstancedBufferAttribute` updates set
`needsUpdate` rather than reallocating. Assume ortho camera so world↔screen is linear.

Acceptance: 5,000 nodes render at ~60fps; the whole board is ~3 draw calls (nodes,
connectors, labels); pan/zoom stays smooth; hover/click hit-test via SpatialGrid.

### Agent D — `SkillTreeView.jsx` + overlay UI
Replace the placeholder. Runs the pipeline above (repo → domain → layout → scene). Wires:
- A full-viewport `<canvas className="st-canvas">`; construct `SkillTreeScene` in an effect,
  `setModel`, `start()`; `dispose()` on unmount; `resize()` on container resize (ResizeObserver).
- Overlay UI built from existing design-system components (`src/components`):
  - **Controls** (top or corner): zoom in/out (`IconButton`), fit-to-view, a size toggle
    (`Tabs` or `Select`) to switch demo ↔ huge (5k) dataset for the perf demo, a small link
    to `#/showcase`.
  - **Detail panel** (`Card`, slides in on node pick): label, state `Badge`, prerequisites,
    a `Button` "Mark complete" that mutates progress → re-derives states → `scene.applyStates`.
  - **Minimap** (corner): draws `scene.getBounds()` + `scene.getViewport()`; click to `panTo`.
- Keep all state transitions going through `UnlockRules.derive` — never hand-set a node state.

Acceptance: loads the demo tree on first paint; hover shows highlight; clicking a node opens
the panel; "Mark complete" ripples unlocks up the tree with the growth animation; the size
toggle swaps in the 5k tree and it stays smooth.

## Conventions (from CLAUDE.md — honor these)
- Optimize for the reader. Express functions as top-to-bottom fail-fast pipelines.
- Domain layer is pure and dependency-light; three.js/dagre/troika live only at the boundary.
- Constructors on entities (not factory helpers). Early returns over assign-then-return.
- No underscore-prefixed private helpers; no docstrings / multiline prose comments.
- Don't create sub-40-line files without a strong reason; group kin (all shapes in ports.js).
- Plain JS/JSX only (no TypeScript). Deps `three`, `troika-three-text`, `@dagrejs/dagre`
  are installed — do not add others or run `npm install`.
