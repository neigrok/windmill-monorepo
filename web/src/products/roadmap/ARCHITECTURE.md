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
const engine    = await loadLayoutEngine(layoutNameFrom(location)); // layout/index.js: ?layout=<name>, default bubble
const repo      = new HttpTreeRepository({ treeId });
const seed      = await repo.loadTree();              // …or loadDeviceTree(id): the blob, if the row is ours
const tree      = new SkillTree(seed);                // entity + DAG validation
const progress  = await repo.loadProgress(seed);      // {completed, completedAt, server}
const states    = UnlockRules.derive(tree, progress); // Map<id, NodeState>
const positions = layoutPositions(tree);              // Map<id, Vec2> — synchronous, memoized per engine
const model     = tree.toRenderModel(positions, states);
scene.setModel(model);                                // GPU build + fit
// the first view: a saved place (PlaceStore, stamped with the engine) is restored; the OWNER with none opens
// instantly at the working zoom over the frontier's family (ui/viewport.js frontierTarget), arrival suppressed, and
// is framed again as each piece of chrome publishes its measured inset, until the reader moves the camera;
// a visitor keeps the whole-tree fit and the arrival ceremony
// then: new SyncSession(...) — the lattice becomes truth and every later edit flows through it
```

Repository loads → domain computes → scene renders. **Layout is synchronous** — no worker, no
promise: `layoutPositions` re-runs the chosen engine inline whenever the engine name or the
id/prerequisites/order/color/createdAt signature changes — plus the label for an engine that declares
`readsCaptions`, since only those reserve a caption's box — and serves a cached copy otherwise. No
business logic lives in the scene.

After the first paint this is not the update path. A `SyncSession` owns the tree's CRDT lattice; a
local gesture and a remote frame both land as a new projection, re-entering through `syncStructure()`
(re-derive → `scene.applyModel`).

## Map of the package

The six marked **↓** have a section of their own below.

| | |
|---|---|
| `model/` | Pure domain: the tree entity, unlock rules, the legend, spatial index. **↓** |
| `layout/` | Four layout engines behind one door (`index.js`) — bubble draws the tree, radial catches a failure, rings and mindmap answer `?layout=`; synchronous, deterministic. **↓** |
| `scene/` | The WebGL2 renderer, its DOM overlays and pointer tools. **↓** |
| `sync/` | The client half of the graph CRDT, both lanes: shared structure, private progress, gestures, socket, IndexedDB. **↓** |
| `share/` | Public-link sharing and the in-product gallery portraits. **↓** |
| `editing/` | `TreeEditor` — the holder for the current projection. Undo lives in `sync/`. **↓** |
| `persistence/` | The `TreeRepository` over HTTP, the account tree registry, and the per-tree localStorage ledgers (workspaces, legend, last place — stamped with the layout engine and a camera format, so a camera saved under another engine or an older format comes back null — return/milestone baselines, view prefs). |
| `ui/` | Desktop overlay chrome above the canvas: control bar, step panel, minimap, tree switcher, birth canvas, Next-up ranking, honesty chrome; `viewport.js` is the pure half — the docked panels' widths, the chrome insets and corner blocks per breakpoint and view state, and `frontierTarget`, the step a first view opens on. |
| `ui/tree/` | The step's components — kind legend, checklist, workspace body — the two hooks over their pure models (`useLegend` · `useWorkspace`), plus `SkillNode`/`SkillConnector`/`ProgressBar`, the DOM reference implementation of the tree metaphor. |
| `ui/mobile/` | Phone/tablet surfaces: bottom sheets, editor sheet, aim + bulk bars, action lane, the plaque chrome every non-desktop breakpoint wears (`MobileChrome`, carrying the always-visible Focus · All steps group under the wordmark), fork door. |
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
(`loadTree` / `loadProgress` / `loadActivity`) and `LayoutEngine` (`layout` is synchronous;
`layoutName` names the engine; the static `reorder` hint — `'ring'` · `'parent-arc'` · `'none'` —
says how siblings may be dragged into a new order on
that engine's geometry, and `readsCaptions` says whether a rename changes the picture). The C++ server answers these same
shapes: when a field moves, it moves in both.

`theme.js` — the resolved hex palette, because WebGL cannot read CSS custom properties. The module
constants are the light set; `sceneTheme(isDark)` returns the light or night set (`BACKGROUND`,
`CONNECTOR`, `BARK`, `BARK_CREAM`, `NODE_COLORS`, `CHIP`) and `isNightFor(element)` reads the nearest
`[data-theme]` ancestor, so a room that pins its own theme wins over the html attribute. A node's look
is two orthogonal dimensions:

- **kind** — `NODE_COLORS` / `NODE_COLOR_NAMES`: terracotta · olive · gold · brick · sky · plum, each
  `base` (accent-500), `ring` (accent-600), `soft` (accent-200), `glow`. The shader and the swatch
  rows size themselves off the name list.
- **tier** — `nodeTier(state)`, three rising indices: locked (low-opacity wash, no glow), available
  (saturated fill + ring, glow on hover), complete (outer ring + static halo). Indices rise with progress, so a state diff reads growth as
  a rise in tier. `isDone(state)` (complete only) drives edge growth.

A third, structural axis is `nodeForm(label, parentCount, childCount)` — `linked` · `bud` (born,
unnamed) · `unlinked` (a stray with no branches left) — revealed as a dashed ring. Also `CONNECTOR`,
`BACKGROUND`, `BARK` / `BARK_CREAM` (neutral tool + grouped selection) and `NODE_SIZE`.

`theme.js` also holds the one shared geometry the renderer, the captions and the layout agree on — the
node shader interpolates these same constants into its GLSL, so no drawn disc can drift from the box a
layout reserved for it: the body is `BODY_FRACTION` (0.84) of `NODE_SIZE` (`BODY_WU`, which is also the
rim every edge, port and affordance stops at), a crowned root `ROOT_BODY_SCALE` (1.55) wider and a
selected one `SELECTED_SCALE` (1.14); `WORKING_ZOOM` is the zoom at which an ordinary body is 52 CSS px
(`PHONE_WORKING_ZOOM`, 40 px); a drawn body never falls under `MIN_BODY_PX` 6 (`MIN_ROOT_BODY_PX` 9) at
any zoom — a shader uniform floors it, and the caption rule is keyed on the same floored body; `CAPTION`
is the fixed caption frame (14 px on a 20 px line, at most two lines inside 168 px, overflow ellipsized,
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
- `UnlockRules.js` — `derive(tree, progress)`: `complete` if completed, else `available` if every prerequisite is complete (roots qualify vacuously), else `locked`. Every
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

`index.js` is the one door. `DEFAULT_LAYOUT` is **`bubble`** — the engine a reader gets — and
`FALLBACK_LAYOUT` is `radial`, the engine that answers when another cannot. `LAYOUTS` (`radial` · `rings` ·
`bubble` · `mindmap`) names them all; `layoutNameFrom(location)` reads `?layout=<name>` before or after the
hash and answers the default for anything else. Bubble and radial are statically imported;
`loadLayoutEngine(name)` loads rings and mindmap on demand and answers a failed alternative import
with radial. `layoutTree(engine, tree)` contains a throwing layout the same way and logs the failure.
It returns `{ positions, name, engine }` for the engine that produced the positions, including a
radial fallback. The live scene's reorder hint and persisted camera identity use that effective
engine. Radial's own failure propagates.

`pageLayoutEngine()` resolves `layoutNameFrom(window.location)` for each consumer: the canvas,
quest thumbnails (`quests/QuestThumb.jsx`) and paste ghost (`paste/GhostSkeleton.jsx`). Each gets
a stateless engine instance and runs it through `layoutTree`, sharing the selection and fallback
policy. The preview components hold their positions in state and paint a beat after their frames.

Every engine is a `LayoutEngine` (`model/ports.js`) with a `layoutName` and two behavior statics.
`reorder` names the sibling gesture that fits its geometry; `readsCaptions` tells the view whether a
rename has to re-run it. All four are pure, synchronous and deterministic: siblings sort by their
fractional-index key, so a load and a live emission project identical pixels. Iterative traversal
keeps deep chains off the call stack. Engines hold no state between layouts.

`BubbleLayoutEngine.js` — **the default** (`reorder = 'parent-arc'`, `readsCaptions = true`) — a bubble tree: each
node's children sit on rays around it inside its enclosing circle, every child facing its parent; a
post-order tuck slides rigid subtrees along their ray until footprints or resting trunk edges touch, or
discs come within three quarters of a body of air rim to rim, so a step with a short name or none never
sits on its neighbour; islands settle by front-chain circle packing with the largest root pinned at the
origin. It has no shared center or depth ring, so the minimap reads as a constellation.
Siblings reorder around their trunk parent within an open fan; packed root islands have no drag reorder.

The tuck has a deterministic work ceiling, `max(1,000,000, 2048 × nodeCount)`, counting subtree
passes, grid cells and candidate entries. If it runs out, the unfinished move is discarded and
remaining subtrees keep their enclosing-circle seats. Large trees can remain looser; the ceiling
does not cover every layout phase or guarantee interactive latency. The rectangle index stores
boxes spanning more than 64 cells once and scans rectangles when that is cheaper than visiting cells.

`RadialLayoutEngine.js` — **the fallback** (`reorder = 'ring'`) — each node sits on the ring for its trunk
depth, centred in an angular wedge split among trunk children by subtree leaf count; a ring is pushed
outward until its closest pair of neighbours has room. It reads no caption and provides a simple
synchronous fallback.

`RingsLayoutEngine.js` (`reorder = 'none'`) — concentric depth rings with Reingold–Tilford contour packing
in angle space over each node's `footprintOf` reach; a ring's radius is the larger of the previous ring plus
a pitch and the ring's summed footprint arc over 2π. Multi-root as islands: the largest tree's crown at the
origin, every other tree laid out about its own crown and packed by enclosing circle — never inside another
rim, and seated to keep the forest's box nearest square rather than strung along one axis.

`MindmapLayoutEngine.js` (`reorder = 'none'`) — each branch (a trunk child of the hub, or a root) is a
Buchheim/Walker tidy tree in its own frame with horizontal captions, seated on one of twelve compass
directions by subtree size; radii shrink from a shared ring by halving slides until oriented per-level
boxes touch.

An engine that reserves a caption's seat reads `model/footprint.js`: `footprintOf(label, { root })` is the
disc-plus-caption box in world units, estimated from the label's length alone (6.65 px per character, at
most two 20 px lines inside 168 px), never DOM-measured, so every device lays the tree out byte-identically.

## `scene/` (raw WebGL2)

`SkillTreeScene` owns the GL context, `Camera2D`, two GPU batches, overlays, the
`CeremonyDirector` and `InputController`. React supplies models, state changes, selection and
viewport insets through the scene API; it does not touch GL. The frame loop advances the camera
and motion, repositions overlays, emits viewport changes and draws both batches. Theme changes
re-resolve `sceneTheme` and update GPU and DOM colours together.

| Module | Responsibility |
|---|---|
| `Camera2D.js` | World/screen coordinates, inset-aware fit, working zoom, pan and inertia. |
| `NodeBatch.js` | One instanced draw for all node bodies and atlas glyphs. |
| `ConnectorBatch.js` | One draw for all ribbons; moving nodes update their connected edges once. |
| `IconAtlas.js` | Rasterized glyphs for distant views; `IconOverlay` supplies close-up SVGs. |
| `captionLayout.js` | Pure caption wrapping, priority, collision placement and visibility hysteresis. |
| `NodeOverlay.js` | DOM labels keyed by node id and nearby icon slots; uses the live camera. |
| `edgeCurve.js` | Shared curve geometry for connector drawing and caption collisions. |
| `picking.js` | Disc hits, screen-pixel hit floors and crowded-node detection. |
| `input/` | Canvas listeners, pointer capture, pinch and the active navigation/edit tool. |
| `AffordanceLayer.js`, `EdgeChrome.js`, `ConnectGesture.js` | Node ports, edge handles and dependency gestures. |
| `edgeKey.js` | Ordered `(from, to)` identity shared by React and GPU selection. |

Captions prioritize selected and hovered nodes, then their family, landmarks and available steps.
Placement avoids labels, chrome, discs and ribbons inside the visible viewport. Selected and
hovered labels remain visible even when collision-free space runs out. Caption records survive
model updates; visibility uses `st-label--shown`, not `display`.

Picking always accepts the drawn disc. Outside it, pointer/touch floors stop halfway to the
nearest neighbour. A crowded hit invokes `zoomIntoCrowd` before edge picking or deselection.
`viewportInsets` supplies both covered edges and corner obstacles to the camera and captions.

The director sequences arrival and completion ceremonies. `applyModel` settles displaced nodes
through one batch update per frame; interaction can finish that settle immediately. Births use an
off-screen chevron and may widen an idle view without pulling an active reader away. Reduced
motion freezes pulses and snaps growth.

Draw-call count is independent of node count. Spatial queries fall back to scanning stored nodes
when a cell query would cost more. Settles upload one range per GPU buffer per frame rather than
reallocating; caption work is bounded by visible candidates and grid occupancy.
`captionLayout.test.js` checks working, intermediate and whole-tree views. GPU timing must be
measured separately from the headless capture rig.

## `sync/`  (the lattice is truth)

The tree's durable state is a CRDT lattice, not a `TreeData`. `TreeData` is only its present-time
projection — what the render pipeline consumes.

**Two lanes, one socket, one clock, one blob.** The SHARED lane is the structure, joined by everyone
who can read the tree. The PRIVATE lane is this account's progress. They never share a frame.

- `progressLattice.js` — the private lane's replica: one last-writer-wins register per node over
  `complete | none`, where `none` is a VALUE and not a deletion, so a clear converges like
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

The view loads the model, constructs and disposes the scene, owns resize observation and hosts
canvas chrome. Every edit is dispatched once through `SyncSession`; local and remote changes both
return through `onTreeChanged` → `syncStructure()` → `scene.applyModel`.

Selection and `viewportInsets(...)` effects keep React, the camera and captions aligned. Legend,
workspace and activity hooks wrap their pure feature models. The control bar, step panel, minimap,
activity feed and mobile/list surfaces consume that same projection. Keyboard bindings come from
`shortcuts/shortcutMap.js`; all node-state transitions come from `UnlockRules.derive`.

## Conventions

Brand-wide conventions are in the root `CLAUDE.md`. Package-specific: plain JS/JSX, no TypeScript;
the domain layer stays pure and WebGL lives only at the boundary; kin shapes group in `ports.js`.
