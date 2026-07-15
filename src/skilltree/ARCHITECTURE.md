# Skill-tree feature — architecture

One self-contained feature package: `src/skilltree/`. Renders a Windmill roadmap
(a **DAG** — nodes can have multiple prerequisites) as a painterly RPG skill tree,
using a **hand-rolled WebGL2 renderer** (no three.js). Target: **60fps at 5,000+
nodes, 2 GPU draw calls** (one instanced node draw + one connector draw; labels are
pooled DOM), with pan/zoom, hover, and click-to-complete.

The renderer began on three.js and was rewritten in raw WebGL2 — the reasons and
the lesson live in `NOTES.md`. Three.js and troika were removed; the only runtime
dep the feature pulls in is `@dagrejs/dagre` (layout), at the boundary.

## The pipeline (this is the whole app, top to bottom)

Lives in `SkillTreeView.jsx`. Reads like plain English:

```
const tree      = new SkillTree(await repo.loadTree());       // entity + DAG validation
const progress  = await repo.loadProgress(tree.id);           // {completed, inProgress}
const states    = UnlockRules.derive(tree, progress);         // Map<id, NodeState>
const positions = applyNudges(await layout.layout(tree), tree); // Map<id, Vec2> (worker)
const model     = tree.toRenderModel(positions, states);      // RenderModel
scene.setModel(model);                                        // GPU build + fit
// on click-to-complete: mutate progress → states = derive(...) → scene.applyStates(states)
```

Repository loads → domain computes → scene renders. No business logic in the scene
or React layers. Layout runs off the main thread, so `layout.layout(tree)` is awaited.

## Contracts

- `model/ports.js` — data shapes (`NodeSpec`, `TreeData`, `Progress`, `RenderNode`,
  `RenderEdge`, `RenderModel`, `Bounds`, `Vec2`, `NodeState`) + base ports
  `TreeRepository`, `LayoutEngine` (`layout` may return a `Map` or a `Promise` of one).
- `theme.js` — resolved hex palette, pulled from the design system's `--kind-*`
  tokens + the `dag-clean-colors` exploration. A node's look is two orthogonal
  dimensions: `NODE_COLORS` / `NODE_COLOR_NAMES` (its *kind* — six hues
  terracotta/olive/gold/brick/sky/plum → `base` accent-500, `ring` accent-600,
  `soft` accent-200, `glow`; the shader + swatches size themselves off the name
  list, so a new kind is a one-line addition) and one of three
  `nodeTier(state)` tiers — `unavailable` (locked → low-opacity wash, no glow),
  `available` (saturated fill + ring, glow on hover), `activated` (active/complete
  → + an outer ring + a breathing glow). `isDone(state)` (complete only) still
  drives edge growth. Also `CONNECTOR`, `LEAF`, `BACKGROUND`, `NODE_SIZE`. Scene +
  atlas use these so the GPU look matches the design-system tree.

Positions are in **world units** where a node is `NODE_SIZE` (56) units in diameter.
Everything in `model/` is pure JS — no WebGL, no React.

## `model/`  (pure JS)

- `model/SkillTree.js` — `class SkillTree`. Constructor validates the DAG (throws on
  duplicate id, dangling prereq, or cycle), indexes `nodesById` + `childrenIndex`,
  and precomputes `topoOrder()` and `ranks()` (longest-path depth). Getters `id`,
  `title`, `nodes`, `edges`; graph ops `roots()`, `parentsOf`, `childrenOf`,
  `ancestorsOf`, `topoOrder`, `ranks`. `toRenderModel(positions, states)` →
  `RenderModel`: each node gets `x,y` from `positions`, `state` from `states`,
  `layer = rank % 3`, `glowSeed` = a stable FNV hash of `id` in 0..1; edges get
  `active = states.get(from) === 'complete'`; `bounds` = node extent padded by NODE_SIZE.
- `model/UnlockRules.js` — `class UnlockRules`, static `derive(tree, progress)`:
  `complete` if completed, else `active` if inProgress, else `available` if every
  prerequisite is complete (roots qualify vacuously), else `locked`.
- `model/SpatialGrid.js` — `class SpatialGrid`. Buckets node ids by cell. `nearest(x,
  y, maxRadius)` → id | null (scans the 3×3 neighborhood, so keep `cellSize ≥ pickRadius`);
  `within(minX, minY, maxX, maxY)` → id[] for LOD label selection; `move(id, x, y)`
  re-buckets a node after a live drag so picking follows it.

## `layout/`

- `layout/WorkerLayoutEngine.js` — `class WorkerLayoutEngine extends LayoutEngine`. The
  engine the app uses: posts the tree to `layout/dagre.worker.js` and resolves a
  `Map<id, Vec2>`, so a 5k layout never blocks the main thread.
- `layout/DagreLayoutEngine.js` — `class DagreLayoutEngine extends LayoutEngine`. The
  synchronous `@dagrejs/dagre` layout (top-to-bottom, `nodesep ~ NODE_SIZE*1.6`,
  `ranksep ~ NODE_SIZE*2.4`); it runs inside the worker.
- `layout/applyNudges.js` — `applyNudges(positions, tree)` → a new `Map` where any node
  with a `position` override replaces the computed coordinate. Pure, returns a copy.

## `scene/`  (raw WebGL2)

- `scene/glcore.js` — tiny GL helpers: compile/link programs, resolve uniform/attrib
  locations, upload a canvas as a texture (`createTextureFromCanvas`).
- `scene/Camera2D.js` — pure ortho 2D camera; world↔screen is scale (`zoom`) + translate,
  Y-down. `screenToWorld` is the exact inverse of the shader projection, so picking is
  pixel-accurate. `pan`, `zoomAt` (cursor-anchored), `zoomBy`, `panTo`, `focus`,
  `fitToView(bounds,w,h)`, `launchInertia`, `update(dt)` (glides + decays inertia, returns
  whether it moved), `getViewport()`.
- `scene/NodeBatch.js` — **one instanced draw** for all fruit. A base quad drawn N times;
  per-instance attributes (offset/state/glowSeed/selected/iconCell). Fruit body is
  procedural (disc + gradient + ring); glow pulses from `uTime`; the icon atlas is sampled
  and tinted per state (`uIconColor`), fading in with zoom and back out over the DOM-icon
  handoff band so the baked raster never has to hold up under extreme zoom. `setInstances`,
  `setStates`, `setSelected`, `setIconAtlas`, and `moveInstance(id, x, y)` (a ranged
  `bufferSubData` write of one node's offset — the live-drag fast path).
- `scene/ConnectorBatch.js` — **one draw** for all edges; bézier ribbons packed into one
  buffer. Activation replays as a GPU color/growth sweep driven by `uTime`; `setModel`
  rebuilds geometry, `setStates` only rewrites the active/grow attributes. `moveNode(id,
  x, y)` re-tessellates just that node's incident edges (via an internal node→edge index)
  and re-uploads their vertex ranges — no full rebuild, so it's cheap under a live drag.
- `scene/IconAtlas.js` — rasterizes lucide glyphs (via the app's Icon registry) into an
  alpha-mask canvas atlas (192px cells) for the **far/mid LOD**, where thousands of small
  icons draw in the single node instanced call; the scene uploads it as a GL texture and
  re-uploads once async glyph decode completes (`onReady`). Exposes `canvas`, `cols`, `rows`.
- `scene/NodeOverlay.js` — DOM overlays above the canvas: an abstract `NodeOverlay` owns one
  placement skeleton (a **fixed pool of ~64** absolutely-positioned elements on the nodes
  nearest the viewport center, LOD-gated by zoom, positioned via CSS `transform` so a frame
  costs no layout), and two subclasses override only element / visibility band / draw:
  - `LabelOverlay` — captions (`<span>` text) below the node; visible above a zoom threshold.
  - `IconOverlay` — the **near LOD** for icons: live `<Icon>` SVG (crisp at any zoom, tinted
    per state to match the fruit) that cross-fades in as the baked atlas fades out over the
    handoff band. `setStates` re-tints on completion; only near nodes get a DOM element.
- `scene/AffordanceLayer.js` — the **calm edit chrome**: a DOM layer that fades a bark-and-cream
  plus chip + ports onto the **selected** node (spec v2 — hover shows no structure; invisible at
  rest, 150ms fade). The plus sits on the node's outward rim (opposite its parents), ports at the
  widest gaps between branches; repositioned per frame so it tracks the camera and drags. Tools are
  neutral — never a kind hue. A **grace window** keeps the chrome alive briefly after deselect so
  the plus stays reachable. The plus is live (`onCreate`); each port starts a `ConnectGesture`.
- `scene/HoverLabel.js` — the **hover name tip** (spec v2 §1.1): hovering a node shows only its
  label on a dark bark pill below the disc — never structural chrome. A scene overlay repositioned
  from the render loop; inline-styled, so it owns no CSS. Hidden when nothing is hovered / unnamed.
- `scene/EdgeChrome.js` — the **selected-edge** chrome (spec v2 §4.2): a clicked branch turns bark
  and grows two endpoint handles + a midpoint × (delete). Selection-gated, not hover — `setSelectedEdge`
  shows it, handles hand `(edge, end)` to the shared `ConnectGesture` (reconnect), the × fires `onDeleteEdge`.
- `scene/ConnectGesture.js` — dragging a dependency from a port (or an edge handle) to another node: a
  dashed SVG **ghost branch** follows the cursor; the node under it gets an **olive ring** (valid) or a
  **brick ring + "would create a loop" tip** (a cycle). The whole cycle-closing set is collected up front
  and **faded to 30%** for the drag (`onFadeNodes` → `NodeBatch.setFaded`); that same set is the cyclic
  predicate, so a faded node can never take the drop. A valid release fires `onConnect`/`onReconnect`.
- `scene/input/` — pointer interaction, extracted so the scene isn't a god-object and edit
  tools plug in without touching event plumbing. `InputController` owns the canvas listeners
  + pointer capture + single-pointer bookkeeping, forwards down/drag/move/up/leave to the
  active `Tool`, and handles wheel-zoom globally. `tools.js`: the `Tool` contract + two
  impls sharing a small scene context (`camera`, `pick`, `getNode`, `select`, `hover`,
  `moveNode`) — `NavigateTool` (drag-pan + inertia, click-select, throttled hover) and
  `MoveTool` (adds node dragging: press-on-node drags it live, press-on-empty falls back to
  pan). The scene defaults to `MoveTool` and can `input.setTool(...)` later.
- `scene/SkillTreeScene.js` — orchestrator: owns the GL context, the `Camera2D`, both
  batches, the `IconAtlas`, the label + icon overlays, and the `InputController`. The rAF loop
  advances `uTime` and the camera; **whenever the camera moved (or a node moved) that frame it
  updates both overlays**, and on camera move emits the viewport to per-frame
  `subscribeViewport` listeners (the minimap) — no throttle, so overlays track the GPU at frame
  rate. Exposes scene-state hooks the active tool drives (`select`/`selectEdge` — node and edge
  selection are mutually exclusive; `hover`, `hoverEdge`, `pick`, `pickEdge`) and incremental edit
  APIs. Selection is mirrored two ways: `select` drives it from the canvas and notifies the shell;
  `setSelection` lets the shell mirror an Esc/close/create deselect back to the scene without echoing.
  Live panel previews: `previewKind`/`restoreKind`, `previewDeleteCost`/`clearDeleteCost`. Public API
  (renderer-agnostic, so the React shell never touches GL): `setModel` (full load, fits camera),
  `applyModel` (re-derived graph — add/remove/relayout — preserving camera + selection, reusing the
  atlas unless a new icon appears), `moveNode` (live per-instance reposition of a node + its edges),
  `applyStates`, `fitToView`, `focusNode`, `panTo`, `zoomBy`, `subscribeViewport`, `getBounds`,
  `getViewport`, `resize`, `start`, `stop`, `dispose`.

Perf rules (non-negotiable): constant draw calls regardless of node count; no per-node JS
in the animation loop except the LOD-gated, bounded overlay pick; no per-frame allocation;
instanced attribute updates flag their buffer rather than reallocating. Ortho camera keeps
world↔screen linear.

## `editing/`  (pure edit logic)

Direct-manipulation editing of the tree. Pure and dependency-light — the view drives it
and feeds results back through the render pipeline.
- `editing/TreeEditor.js` — `class TreeEditor`. Session edit history: a `present` TreeData
  plus undo/redo stacks. `commit(next)` records one step (and clears redo — linear history),
  `undo()`/`redo()` swap snapshots, `canUndo`/`canRedo`. Snapshots share unchanged node
  objects, so a compound edit is one step and keeping many is cheap.
- `editing/edits.js` — pure `TreeData → TreeData` transforms with structural sharing (only
  touched nodes replaced). `repositionNode(treeData, id, x, y)` pins a manual position; the
  structural transforms (add/connect/delete/rename/kind) land here as their features are built.

## `share/`  (the X2 share identity)

Everything Windmill exports — the OG/unfurl card, the share PNG, the gallery thumb,
the GIF frames — through one shared recipe so the surfaces can't drift. Canonical
spec: the design system's `explorations/share-identity.html`. Grouped as one
feature package (not split across layers) because it's a self-contained surface.

- `share/palette.js` — `SHARE_PALETTE` (`light` + `dark`) + `KIND_ORDER`. Light is the
  design system 1:1 (kinds pulled from `theme.js`, so an exported tree can't drift from
  the in-app tree); dark is the export-only night skin the live renderer doesn't have.
  Per theme: chrome (`mat/panel/edge/track/brand/grad*`) + per-kind `{c,rgb,soft}`.
- `share/ShareStats.js` — `class ShareStats`; `from(tree, states)` → `done/total/percent`
  and the **dominant kind**: the most common kind among *done* nodes, a shared max (or an
  empty tree) tying to terracotta. The only hue the frame chrome takes.
- `share/ShareFrame.js` — the pure **frame recipe**: `SHARE_SIZES` (OG 1200×630, feed
  1600×900, square 1080×1080, GIF 960×540) and `class ShareFrame` resolving every rect,
  hue and type size off `k = w/1200` (mat, kind rule, panel, identity strip, safe inset,
  1:1 crop). No rendering — renderers read it.
- `share/TreePortrait.js` — `treePortraitSvg(model, palette, box)`: the tree as a
  standalone SVG string from the `RenderModel` (glow halos, crowned root, kind hues, done/
  available/locked looks), self-contained (own xmlns, unique filter ids, no text/urls) so it
  rasterizes into an `<img>`. Deterministic and resolution-independent, in light and dark —
  chosen over capturing the WebGL canvas so both themes and any size work without a GL
  read-back or `preserveDrawingBuffer` (see NOTES).
- `share/exportImage.js` — the one **Canvas2D compositor**: `renderShareCanvas(frame, model,
  {scale})` paints mat → kind rule → panel → rasterized portrait → identity strip onto a
  canvas; `canvasToPngBlob` / `canvasToDataUrl` for @2x export. Reads font stacks off the
  document root (Canvas2D can't parse `var()` in `ctx.font`).
- `share/ShareDialog.jsx` — the Share surface. **The preview IS the export**: it renders the
  frame onto a canvas via `renderShareCanvas` and shows/downloads that very canvas, so what
  the user sees and what they post can't diverge. Size + light/dark pickers; the dominant
  kind is computed, never chosen. A filmstrip illustrates GIF intro → final ≡ the PNG.
- `share/GalleryCard.jsx` — the in-product card (#12): drops the mat (it lives inside app
  chrome) but keeps the kind rule + the same title/readout, presentational, light and dark.

`ControlBar` gains a Share button; `SkillTreeView` opens `ShareDialog` with the live
`renderModel` + `ShareStats.from(tree, states)`.

## `SkillTreeView.jsx` + overlay UI

Runs the pipeline above (repo → domain → layout → scene) and owns the edit loop: builds a
`TreeEditor` from the loaded TreeData, caches the raw layout, and funnels every edit through
`syncStructure()` (re-derive the model from `editor.treeData` — which re-validates the DAG —
and `scene.applyModel`). Edits: `MoveTool` drops (`onNodeMoveEnd` → `repositionNode`); the
affordance plus (`onCreateChild` → `addChildNode`, committed as an unnamed bud, auto-selected with
the panel's name field focused); rename/kind from the step panel (`renameNode`/`setNodeColor`, one
step each); ⌫/Delete on the selection (`deleteNode`, children splice up, one step + an Undo toast;
or the scene's selected edge → `removeEdge`). Keys: ⌘Z/⇧⌘Z → `undo`/`redo`, Esc deselects. A
`selectedId`→`scene.setSelection` effect keeps the canvas chrome in step with React selection. Wires:
- A full-viewport `<canvas className="st-canvas">`; constructs `SkillTreeScene` in an effect,
  `setModel` + `start()`, `dispose()` on unmount, `resize()` on container resize (ResizeObserver).
  Holds the scene in state so overlay children can subscribe once it exists.
- Overlay UI (`src/components` design system):
  - `ui/ControlBar.jsx` — zoom in/out, fit-to-view, a demo↔huge (5k) size toggle, link to
    `#/showcase`.
  - `ui/StepPanel.jsx` — the one docked panel (spec v2 §01), slides in on node pick: an inline-editable
    **name**, the six **kind** swatches (hover previews live via `scene.previewKind`, click commits),
    the **prerequisites** + "Mark complete" (mutates progress → re-derives states → `scene.applyStates`),
    and an isolated **Delete** at the bottom (hover dims the step via `scene.previewDeleteCost`). It
    absorbed the old floating action bar, kind fan, inline name field, and `DetailPanel`.
  - `ui/Minimap.jsx` — two stacked canvases: a **dots** layer (a dot per node, redrawn only on
    node/state/bounds change) and a **viewport-rectangle** layer redrawn every frame via
    `scene.subscribeViewport`, so the rectangle tracks the camera without redrawing thousands
    of dots. Click to `panTo`.
- All node-state transitions go through `UnlockRules.derive` — never hand-set a node state.

## Conventions (from CLAUDE.md — honor these)
- Optimize for the reader. Express functions as top-to-bottom fail-fast pipelines.
- Domain layer is pure and dependency-light; WebGL and dagre live only at the boundary.
- Constructors on entities (not factory helpers). Early returns over assign-then-return.
- No underscore-prefixed private helpers; no docstrings / multiline prose comments.
- Don't create sub-40-line files without a strong reason; group kin (all shapes in ports.js).
- Plain JS/JSX only (no TypeScript). The only feature runtime dep is `@dagrejs/dagre`.
