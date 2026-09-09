# Roadmap — architecture (web)

One product package: `web/src/products/roadmap/`. It renders a Windmill roadmap (a **DAG** — a step
can have several prerequisites) as a painterly RPG skill tree on a **hand-rolled WebGL2 renderer**
(no three.js). Target: **60fps at 5,000+ nodes, 2 GPU draw calls** — one instanced node draw plus one
connector draw, labels and near-LOD icons as a pooled DOM overlay — with pan/zoom, hover,
direct-manipulation editing, live sync across one account's own devices, and a presence cursor layer.
Writes are owner-only (`canWrite`, `backend/platform/domain/Access.h`): a second account can watch a
shared tree, never edit it.

Dependencies beyond React: `lucide-react` (through the design system's `Icon`).

The shell reaches this package through `routes.js` and the product registry alone (`web/CLAUDE.md`).
Nothing here may import another product; `test/shell-boundaries.test.mjs` enforces it.

## The load pipeline

`SkillTreeView.jsx`, in the effect keyed on `[reloadKey, treeId, demo]`:

```
const engine    = await loadLayoutEngine(layoutNameFrom(location)); // layout/index.js: ?layout=<name>, default radial
const repo      = new HttpTreeRepository({ treeId });
const seed      = await repo.loadTree();              // …or loadDeviceTree(id): the blob, if the row is ours
const tree      = new SkillTree(seed);                // entity + DAG validation
const progress  = await repo.loadProgress(seed);      // {completed, inProgress, startedAt, completedAt, server}
const states    = UnlockRules.derive(tree, progress); // Map<id, NodeState>
const positions = layoutPositions(tree);              // Map<id, Vec2> — synchronous, memoized per engine
const model     = tree.toRenderModel(positions, states);
scene.setModel(model);                                // GPU build + fit
// the first view: a saved place (PlaceStore, stamped with the engine) is restored; the OWNER with none opens
// instantly at the working zoom on the frontier (ui/viewport.js frontierTarget) with the arrival suppressed;
// a visitor keeps the whole-tree fit and the arrival ceremony
// then: new SyncSession(...) — the lattice becomes truth and every later edit flows through it
```

Repository loads → domain computes → scene renders. **Layout is synchronous** — no worker, no
promise: `layoutPositions` re-runs the chosen engine inline whenever the engine name or the
id/prerequisites/order/color/createdAt/label signature changes and serves a cached copy otherwise. No
business logic lives in the scene.

After the first paint this is not the update path. A `SyncSession` owns the tree's CRDT lattice; a
local gesture and a remote frame both land as a new projection, re-entering through `syncStructure()`
(re-derive → `scene.applyModel`).

## Map of the package

The six marked **↓** have a section of their own below.

| | |
|---|---|
| `model/` | Pure domain: the tree entity, unlock rules, the legend, spatial index. **↓** |
| `layout/` | The layout engines behind one door (`index.js`) — radial today, three named stubs; synchronous, deterministic. **↓** |
| `scene/` | The WebGL2 renderer, its DOM overlays and pointer tools. **↓** |
| `sync/` | The client half of the graph CRDT, both lanes: shared structure, private progress, gestures, socket, IndexedDB. **↓** |
| `share/` | Public-link sharing and the in-product gallery portraits. **↓** |
| `editing/` | `TreeEditor` — the holder for the current projection. Undo lives in `sync/`. **↓** |
| `persistence/` | The `TreeRepository` over HTTP, the account tree registry, and the per-tree localStorage ledgers (workspaces, legend, last place — stamped with the layout engine and a camera format, so a camera saved under another engine or an older format comes back null — return/milestone baselines, view prefs). |
| `ui/` | Desktop overlay chrome above the canvas: control bar, step panel, minimap, tree switcher, birth canvas, Next-up ranking, honesty chrome; `viewport.js` is the pure half — the chrome insets per breakpoint and view state, and `frontierTarget`, the step a first view opens on. |
| `ui/tree/` | The step's components — kind legend, checklist, workspace body — the two hooks over their pure models (`useLegend` · `useWorkspace`), plus `SkillNode`/`SkillConnector`/`ProgressBar`, the DOM reference implementation of the tree metaphor. |
| `ui/mobile/` | Phone/tablet surfaces: bottom sheets, editor sheet, aim + bulk bars, action lane, read-only chrome (with the always-visible Focus · All steps group under the wordmark), fork door. |
| `list/` | The phone's second view of the same model: the tree as an outline, with its own pure outline/editing/explore rules. |
| `activity/` | The activity log domain, the presentation grammar every feed surface speaks, and `useActivity`. |
| `ceremony/` | `CeremonyDirector` — sequences camera → travel → bloom → pulse → toast, one ceremony at a time. |
| `selection/` | Multi-selection predicates. |
| `shortcuts/` | The canonical keyboard map and the reference dialog built from it. |
| `presence/` | The presence cursor layer, on its own rAF loop above the canvas. |
| `paste/` | Paste-import: plan grammar, composer, ghost preview, graft rule, AI-compose stream, and the ZIP writer the data export shares. |
| `quests/` | The nine authored starter quests (`roster/`) and the shelf + thumbnails that plant them. |
| `browse/` | The in-product public wall `#/browse`. |
| `demo/` | The playable demo (`#/demo`): staged tree constants and the once-ever coach chip. |
| `tending/` | The AI assistance bar, its client, and the pure receipt/meter copy behind settings' ledger. |
| `reminders/` | The weekly-nudge preference client (its settings section lives in `settings/`). |
| `settings/` | Plan, reminders, AI assistance and your-data sections, plus the export archive builder. |
| `marketing/` | The `/roadmap` landing, its crawlable `<head>`, its stylesheet, the self-playing tree scenes. |

Two rules `persistence/` enforces: every device-tree row carries the ACCOUNT it belongs to
(`LocalTreeRegistry`), and reads are scoped to whoever the server CONFIRMED on this document load —
a remembered identity may paint a face but never opens a device store. `ProgressStore` holds no live
writes; `drainInto` moves what a browser still has into the private sync lane, then clears the keys.

Root files: `routes.js`, `SkillTreeApp.jsx` (resolves *which* tree before the heavy view mounts),
`SkillTreeView.jsx`, `HomeCard.jsx` (the `/app` home cell), `showcase.js` (the only module
`src/showcase/` may import out of this product — `test/shell-boundaries.test.mjs` allows no other),
`theme.js`, `index.js`, `skilltree.css`, `NOTES.md`.

## Contracts

`model/ports.js` — the data shapes (`NodeSpec`, `Kind`, `TreeData`, `Progress`, `RenderNode`,
`RenderEdge`, `RenderModel`, `Bounds`, `Vec2`, `NodeState`) plus the base ports `TreeRepository`
(`loadTree` / `loadProgress` / `loadActivity`) and `LayoutEngine` (`layout` is synchronous; the static
`reorder` hint — `'ring'` · `'parent-arc'` · `'none'` — says how siblings may be dragged into a new order
on that engine's geometry). The C++ server answers these same shapes: when a field moves, it moves in
both.

`theme.js` — the resolved hex palette, because WebGL cannot read CSS custom properties. The module
constants are the light set; `sceneTheme(isDark)` returns the light or night set (`BACKGROUND`,
`CONNECTOR`, `BARK`, `BARK_CREAM`, `NODE_COLORS`, `CHIP`) and `isNightFor(element)` reads the nearest
`[data-theme]` ancestor, so a room that pins its own theme wins over the html attribute. A node's look
is two orthogonal dimensions:

- **kind** — `NODE_COLORS` / `NODE_COLOR_NAMES`: terracotta · olive · gold · brick · sky · plum, each
  `base` (accent-500), `ring` (accent-600), `soft` (accent-200), `glow`. The shader and the swatch
  rows size themselves off the name list.
- **tier** — `nodeTier(state)`, four rising indices: locked (low-opacity wash, no glow), available
  (saturated fill + ring, glow on hover), ember (`active` — a soft glow breathing at half the crown),
  complete (outer ring + breathing halo). Indices rise with progress, so a state diff reads growth as
  a rise in tier. `isDone(state)` (complete only) drives edge growth.

A third, structural axis is `nodeForm(label, parentCount, childCount)` — `linked` · `bud` (born,
unnamed) · `unlinked` (a stray with no branches left) — revealed as a dashed ring. Also `CONNECTOR`,
`BACKGROUND`, `BARK` / `BARK_CREAM` (neutral tool + grouped selection) and `NODE_SIZE`.

`theme.js` also holds the one shared geometry the renderer, the captions and the layout agree on: the
body is `BODY_FRACTION` (0.84) of `NODE_SIZE`, a crowned root `ROOT_BODY_SCALE` (1.55) wider;
`WORKING_ZOOM` is the zoom at which an ordinary body is 52 CSS px (`PHONE_WORKING_ZOOM` 0.85 → 40 px);
a drawn body never falls under `MIN_BODY_PX` 6 (`MIN_ROOT_BODY_PX` 9) at any zoom — a shader uniform
floors it; `CAPTION` is the fixed caption frame (14 px on a 20 px line, at most two lines inside 168 px,
8 px under the rim, 6.65 px per character for the layout's estimate).

Positions are in **world units** where a node is `NODE_SIZE` (56) across. Everything in `model/` is
pure JS — no WebGL, no React.

## `model/`  (pure JS)

- `SkillTree.js` — the constructor validates the DAG (throws on a duplicate id, a dangling
  prerequisite, or a cycle), indexes `nodesById` + `childrenIndex`, precomputes `topoOrder()` and
  `ranks()` (longest-path depth) and elects the `TrunkTree`. Getters `id`, `title`, `nodes`, `edges`,
  `trunk`; graph ops `roots()`, `parentsOf`, `childrenOf`, `ancestorsOf`.
  `toRenderModel(positions, states)` gives each node `x,y`, `state`, `layer = rank % 3`, `form`,
  `glowSeed` (a stable FNV hash of `id` in 0..1), `branch` + `emphasis` from the trunk. **An edge
  carries no state of its own** — `{from, to, kind}`, inheriting its source node. `bounds` is the
  node extent padded by NODE_SIZE.
- `renderableGraph.js` — `makeRenderable(treeData)`: drops cycle edges and returns the best-effort
  projection plus what was wrong.
- `TrunkTree.js` — elects one primary ("trunk") parent per node, a spanning arborescence over the
  DAG, and derives branch root, trunk depth, leaf weight. Same-kind parents win; ties go to the
  shallowest, then the smallest id. Trunk children keep sibling order (fractional-index key, then
  creation stamp), which is what the layout sweeps.
- `UnlockRules.js` — `derive(tree, progress)`: `complete` if completed, else `active` if in progress,
  else `available` if every prerequisite is complete (roots qualify vacuously), else `locked`. Every
  state transition routes through here; nothing hand-sets a state.
- `Legend.js` — the tree's kinds. Pure: every op takes a legend and returns a new one. `deriveLegend`
  reconciles the server's kinds with the hues actually worn; `withCounts`, `inUseCount`, `freeHue`,
  `renameKind`, `describeKind`, `addKind`, `removeKind`, `recolorKind`. **Legend ORDER is not held
  here** — it is generation priority, a per-kind rank in the lattice, written by the `ReorderKinds`
  gesture (`sync/materialize.js`, also the MCP `reorder_kinds` tool). The pure array ops serve
  `paste/PasteComposer`, which edits a *draft* legend outside the lattice. `GENESIS_STAMP` /
  `DEFAULT_KINDS` are re-exported from `packages/api-contract/genesis.js`, re-asserted by
  `vite.config.js` on every build.
- `NodeWorkspace.js` — a step's sub-tasks, note and links.
- `SpatialGrid.js` — a uniform bucket grid over placed nodes. `nearest(x, y, maxRadius)` scans every
  cell the radius reaches, so a screen-px hit floor wider than a cell still finds its node; `within(...)`
  selects the viewport's nodes for captions and icons; `move(id, x, y)` re-buckets after a live drag.
- `footprint.js` — `footprintOf(label, { root })` / `footprintRect(x, y, footprint)`: the disc-plus-caption
  box a node reserves, in world units, from the label's length alone.
- `milestones.js` — `detectMilestones`: a whole branch turning to light, or the crown; never a single
  step. Pure; the offer conduct (owner-only, once-ever) lives at the call site.
- `progress.js` — advancing progress and choosing which milestone to announce, as pure functions.

## `layout/`

`index.js` is the one door: `LAYOUTS` (`radial` · `rings` · `bubble` · `mindmap`), `layoutNameFrom(location)`
(`?layout=<name>` before or after the hash, else `radial`) and `loadLayoutEngine(name)`, a dynamic import per
engine so one engine's failure never takes the others down. Every engine is a `LayoutEngine` (`model/ports.js`)
with a static `reorder` hint — `'ring'` arms the scene's angular reorder gesture, anything else disarms it.

`RadialLayoutEngine.js` — the built engine (`reorder = 'ring'`). Each node sits on the ring for its trunk
depth, centred in an angular wedge split among trunk children by subtree leaf count; a ring is pushed
outward until its closest pair of neighbours has room. **Synchronous** and deterministic (siblings sort by
their fractional-index key), so a load and a live emission project identical pixels. `RingsLayoutEngine`,
`BubbleLayoutEngine` and `MindmapLayoutEngine` throw `<name> layout is not built yet` from `layout()`.
`quests/QuestThumb.jsx` and `paste/GhostSkeleton.jsx` still construct `RadialLayoutEngine` directly.

An engine that reserves a caption's seat reads `model/footprint.js`: `footprintOf(label, { root })` is the
disc-plus-caption box in world units, estimated from the label's length alone (6.65 px per character, at
most two 20 px lines inside 168 px), never DOM-measured, so every device lays the tree out byte-identically.

## `scene/`  (raw WebGL2)

- `glcore.js` — link a program, resolve uniform/attrib locations, upload a canvas as a texture.
- `Camera2D.js` — a pure ortho 2D camera; world↔screen is scale (`zoom`) + translate, Y-down.
  `screenToWorld` is the exact inverse of the shader projection, so picking is pixel-accurate. It carries
  the **working zoom** (`WORKING_ZOOM` from `theme.js`, `PHONE_WORKING_ZOOM` on a phone via
  `setWorkingZoom`): every `focus` / `glideTo` floors there and `fitToView` caps there. The zoom floor is
  dynamic — half the fit zoom of `setFitBounds` — for wheel, pinch, buttons, `restore` and glides.
  `setInsets({top,right,bottom,left})` names the chrome-covered px per side, and `centreFor` /
  `visibleViewport` / `fitZoomFor` centre focus, fit and glide inside what is left. Also `pan`, `zoomAt`
  (cursor-anchored), `zoomBy`, `panTo`, `glideTo(x, y, zoom, {force})`, `launchInertia`, `update(dt)`.
- `NodeBatch.js` — **one instanced draw** for every node: a base quad drawn N times with per-instance
  attributes (offset, colour, tier, form, glow seed, selection, icon cell, plus the ceremony and
  feedback animation stamps). The body is procedural (disc + gradient + ring); the glow pulses from
  `uTime`; the icon atlas is tinted per tier and fades out across the band where the DOM icons take
  over. `moveInstance(id, x, y)` is a ranged `bufferSubData` write — the live-drag path.
- `ConnectorBatch.js` — **one draw** for all edges, bézier ribbons in one buffer. A branch inherits
  its source: once that node is complete it lights in the source's kind hue with a GPU colour/growth
  sweep driven by `uTime`. `setStates` rewrites only the grow attributes; `moveNode` re-tessellates
  just that node's incident edges.
- `IconAtlas.js` — rasterizes lucide glyphs (through the app's `Icon` registry) into an alpha-mask
  canvas atlas (192px cells) for the far/mid LOD, re-uploading once async glyph decode completes.
- `captionLayout.js` — captions, decided, pure: `wrapCaption` (at most two 20 px lines inside the
  160 px text column, word-broken, the second line ellipsised, a blank label has no caption),
  `captionTier(zoom)` keyed on the projected ordinary body (≥ 18 px working: everyone may be named;
  4–18 px overview: crowned roots and branch heads of eight or more; below 4 px only the selected and
  the hovered), and `CaptionPlacer` — priority selected > hovered > the selected's trunk family >
  anchors > active/available > the rest, seats tried last-seat-first then below → above → right → left
  against a 64 px collision grid of every disc rim, placed captions and the inset-reduced viewport; the
  selected and hovered captions are forced (placed below even boxed in). Hysteresis: 200 ms of unbroken
  placement before a caption shows, 200 ms of unbroken loss before it goes, held in place meanwhile;
  records survive `setModel`, so a live edit never blinks. Pool 96, candidate cap 288.
- `NodeOverlay.js` — DOM above the canvas. The abstract `NodeOverlay` owns the container, a fixed pool
  of absolutely-positioned elements moved by CSS `transform` so a frame costs no layout, and `dispose`.
  `LabelOverlay` mirrors `captionLayout.js`: it measures each label once with a 2D-canvas `measureText`
  under the live caption font (re-measured when `document.fonts` finishes loading), keeps one element
  per captioned node id (`data-node-id`), toggles `st-label--shown` for the 150 ms fade and re-runs
  itself on a settle timer at the next fade deadline; an unchanged camera costs no allocation. The
  halo behind the glyphs (`--st-label-halo`) is pinned to the scene's clear colour by `setTheme`.
  `IconOverlay` (live `<Icon>` SVG cross-fading in as the baked atlas fades out) keeps its own
  nearest-64 placement, LOD-gated by zoom.
- `AffordanceLayer.js` — the edit chrome: a plus chip + ports fading onto the **selected** node
  (hover shows no structure). The plus sits on the outward rim, ports at the widest gaps;
  repositioned per frame. A grace window keeps it reachable just after a deselect. The plus fires
  `onCreate`; each port starts a `ConnectGesture`.
- `EdgeChrome.js` — the selected-edge chrome: a clicked branch turns bark and grows two endpoint
  handles plus a midpoint × (delete). Selection-gated, not hover.
- `ConnectGesture.js` — dragging a dependency from a port or an edge handle: a dashed SVG ghost
  follows the cursor; the target rings olive (valid) or brick with a loop warning. The whole
  cycle-closing set is collected up front and faded to 30%, and that same set is the cyclic
  predicate, so a faded node can never take the drop.
- `MarqueeOverlay.js` · `ReorderSlot.js` · `ArrivalChevron.js` — the Shift-drag rubber band, the
  dashed insertion ring for angular reorder, the viewport-edge pill pointing at off-screen births.
- `edgeKey.js` — an edge has no id; its identity is the ordered `(from, to)` pair. The one place that
  folds those into a stable key and back, so React selection and the GPU highlight cannot disagree.
- `input/` — `InputController` owns the canvas listeners, pointer capture and single-pointer
  bookkeeping, drives two-finger pinch, and forwards down/drag/move/up/leave to the active `Tool`.
  `tools.js` holds the `Tool` contract, `NavigateTool` (drag-pan + inertia, click-select, throttled
  hover — the viewer behaviour and the editing default) and `ReadOnlyTool` (1:1 pan, tap-select, no
  fling). `reorderGeometry.js` is the angular-reorder math, pure.
- `SkillTreeScene.js` — the orchestrator: the GL context, the `Camera2D`, both batches, the
  `IconAtlas`, every overlay, the `CeremonyDirector`, the `InputController`. Its **rAF loop** advances
  `uTime` and the camera, steps any settle glide, considers the pending auto-frame, repositions every
  overlay on a frame that moved, emits the viewport to `subscribeViewport` listeners (the minimap)
  and draws the two batches — no throttle. A `MutationObserver` on `data-theme` re-resolves
  `sceneTheme` live and re-sends every cached colour (batch uniforms, glyph tints, chip pills).

  Motion surface, armed by the React shell and owned by the loop:
  - **arrival** — `setModel` paints the tree dim and hands the director a BFS ring plan from the
    crowned root. `setArrivalNoun` / `setArrivalSummary` / `suppressArrivalToast` are one-shot intents
    consumed by that plan.
  - **return recap** — `armReturnRecap(sinceIds, summary)` before the model installs makes the next
    state push replay only the steps finished since the last visit, cascading parent→child by depth.
  - **settle** — `applyModel` diffs positions and glides every displaced node to its new seat,
    staggered nearest-the-change first. `finishSettle` lands them instantly when a pointer arrives.
  - **auto-frame** — an off-screen birth never yanks the camera: the chevron points, and only a
    plainly idle viewer gets one capped breath outward once the settle has landed.

  Public API (renderer-agnostic, so the React shell never touches GL): `setModel`, `applyModel`,
  `applyStates`, `moveNode`, `fitToView` (All steps — the whole tree inside the visible area, capped at
  the working zoom), `focusWorking(id | null, {instant})` (Focus — the working zoom centred on a step,
  else on the selection), `focusNode`, `frameNodes`, `panTo`, `zoomBy`, `setWorkingZoom`,
  `setViewportInsets` (chrome-covered px per side, handed to the camera and the captions),
  `setReorderHint` (only `'ring'` arms the angular reorder), `suppressArrival` (one-shot, before
  `setModel`), `getViewpoint` / `restoreViewpoint`, `subscribeViewport`, `getBounds`, `getViewport`,
  `resize`, `start`, `stop`, `dispose`; selection (`select` / `selectEdge` — node and edge selection are
  mutually exclusive — `setSelection`, `setSelectedSet`, `toggleSelect`, `hover`, `pick(x, y,
  pointerType)`, `zoomIntoCrowd`, `pickEdge`, `projectEdge`); previews (`previewKind` / `restoreKind`,
  `previewDeleteCost` / `clearDeleteCost`, `setFaded`, `highlightKind`, `spotlightNode`, `pulseNode`).

  Hit testing: the disc itself always takes the hit; beyond it a screen-px floor reaches out (24 px for a
  pointer, 44 px for touch), never past halfway to the nearest other node. A tap that lands among nodes
  too crowded to tell apart is not a miss — `zoomIntoCrowd` glides the working view in around it, and
  the tools try it before edge picking and before clearing the selection.

Perf rules: constant draw calls regardless of node count; no per-node JS in the
animation loop except the LOD-gated, bounded overlay pick; no per-frame allocation; instanced
attribute updates flag their buffer rather than reallocating.

## `sync/`  (the lattice is truth)

The tree's durable state is a CRDT lattice, not a `TreeData`. `TreeData` is only its present-time
projection — what the render pipeline consumes.

**Two lanes, one socket, one clock, one blob.** The SHARED lane is the structure, joined by everyone
who can read the tree. The PRIVATE lane is this account's progress. They never share a frame.

- `progressLattice.js` — the private lane's replica: one last-writer-wins register per node over
  `complete | active | none`, where `none` is a VALUE and not a deletion, so a clear converges like
  any other write and needs no tombstone list. Two clocks ride each register and are not
  interchangeable — `at` decides what wins, `markedAt` is the SERVER's receipt instant and the only
  one any surface may show.
- `lattice.js` — the mirror of the backend's `Crdt.h` + `LooseGraph.h` + `Subgraph.h`: stamped
  registers, add-biased life, last-writer-wins fields. Convergence is exercised by
  `test/…/sync/materialize.test.js` and `reorder.test.js`.
- `materialize.js` — the one place gesture semantics execute on the client: each gesture becomes a
  list of stamped writes (a partial subgraph) computed against the current lattice, all sharing one
  HLC stamp so the gesture is atomic on the wire. Splice, fan-out and reduction live here.
- `SyncSession.js` — the one seam `SkillTreeView` talks to for live sync and durability: the lattice,
  the HLC clock, the socket, the IndexedDB store, and **undo/redo** (it banks each gesture's inverse
  and re-dispatches it re-stamped). The lattice is the outbox — there is no queue; an offline edit is
  already in the durable frame.
- `SyncStore.js` — one IndexedDB record per tree, `{frame, lastSeq}` written together so a crash
  never tears them.
- `fractionalIndex.js` — jitterless LexoRank-style order keys, so a reorder is one write rather than
  a sibling renumber.
- `localTrees.js` · `claimLocalTrees.js` — the signed-out lifecycle of a device-born tree, the
  additive claim that adopts it on sign-in, `loadDeviceTree` (the blob fallback, gated on this device
  holding a row for the caller's account) and `forgetDeviceTrees`.
- `refusals.js` — a reject frame is decided by its stable `code`, never by its sentence, which the
  server may reword. OWNERSHIP (`not-yours` / `nobodys-tree`) demotes the editor to read-only;
  SESSION (`sign-in-required`) re-checks the session; CAPACITY (`tree-too-large`) never resolves on
  its own, so the same frame would re-flush forever. `strandsTheBank` reads the frameId rather than
  the code, so a refusal code this build does not know still reports stranded edits.

## `editing/`

`TreeEditor.js` — the holder for the current projection: one field, one getter, so every read seam
sees the same `TreeData` without threading it through React state. Not a history; undo is the
`SyncSession`'s, over the lattice.

## `share/`

`ShareDialog.jsx` publishes an owner's roadmap as public before copying its `/t/:id` URL.
The explicit action discloses that anyone can view and fork it and that it can appear in the public
gallery. Visibility changes wait for server success; failures stay visible and retryable. Existing
public visitors copy the link without a mutation. Clipboard failures leave the published link
selectable for manual copying. Owners can make a shared roadmap private again.

- `palette.js` — light and dark gallery colours and kind order.
- `ShareStats.js` — completed/total/percent and the dominant completed kind, used by the tree UI.
- `TreePortrait.js` — standalone SVG portraits from the render model for in-product displays.
- `GalleryCard.jsx` — the presentational gallery card with its portrait, title and readout.

## `SkillTreeView.jsx` + overlay UI

Runs the pipeline above, hands the tree to a `SyncSession`, and hosts every overlay around the
canvas. Each edit is dispatched as one gesture (`collab.dispatch({kind, …})`), materialized into
stamped writes, joined into the lattice, persisted, and — when live — sent as one frame; the new
projection comes back through `onTreeChanged` → `syncStructure()` (re-derive, re-validate,
`scene.applyModel`), the *same* path another device's frame takes. Keys: ⌘Z/⇧⌘Z →
`SyncSession.undo`/`redo`, ⌫/Delete on the selection, Esc deselects, F → Focus (the working zoom on
the selection, else the frontier), 0 → All steps; a `selectedId` → `scene.setSelection` effect keeps
the canvas chrome in step with React, and a `viewportInsets(...)` memo → `scene.setViewportInsets`
effect tells the camera and the captions what the dock, sheet and lane cover.

Its controllers are hooks, each over the pure model or feature package it drives:
`ui/tree/useLegend.js`, `ui/tree/useWorkspace.js`, `activity/useActivity.js`.

Wires:

- A full-viewport `<canvas className="st-canvas">`; constructs `SkillTreeScene` in an effect,
  `setModel` + `start()`, `dispose()` on unmount, `resize()` on container resize (ResizeObserver).
  The scene is held in state so overlay children can subscribe once it exists.
- Overlay UI, built from `src/design-system`:
  - `ui/ControlBar.jsx` — the wordmark linking home, the tree identity plaque (`TreeSwitcher` docks
    into `titleSlot`, else a static title), and on the right the Ask AI chip (owner of an armed tree
    only), the Activity / "Next · N" chip with its unseen badge, Share, Reset edits, the shortcuts
    button and the zoom-out / zoom-in / **Focus** / **All steps** group (the two camera verbs, as
    text). Key hints come from `shortcuts/shortcutMap.js`, never a duplicated literal.
  - `ui/StepPanel.jsx` — the one docked panel, slid in on pick: inline-editable name, the state
    block, six kind swatches (hover previews through `scene.previewKind`, click commits), the
    prerequisite checklist, the per-node workspace and History, and an isolated Delete whose hover
    dims the cost through `scene.previewDeleteCost`.
  - `ui/tree/KindLegend.jsx` — the on-canvas colour key that is also its own editor; the parent docks
    it bottom-left and supplies each kind's count.
  - `ui/Minimap.jsx` — two stacked canvases: a dots layer redrawn only on node/state/bounds change,
    a viewport rectangle redrawn every frame from `scene.subscribeViewport`. Click to `panTo`.
  - `activity/ActivityFeed.jsx` + `ui/NextUp.jsx` — the docked feed, led by the ready-work section.
  - `presence/PresenceLayer.jsx`, `tending/TendBar.jsx`, `share/ShareDialog.jsx`,
    `ui/HonestyChrome.jsx`, and on small screens `list/ListView.jsx` plus `ui/mobile/`.
- All node-state transitions go through `UnlockRules.derive` — never hand-set a node state.

## Conventions

Brand-wide conventions are in the root `CLAUDE.md`. Package-specific: plain JS/JSX, no TypeScript;
the domain layer stays pure and WebGL lives only at the boundary; kin shapes group in `ports.js`.
