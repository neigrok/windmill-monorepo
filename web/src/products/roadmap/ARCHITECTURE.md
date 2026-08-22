# Roadmap — architecture (web)

One product package: `web/src/products/roadmap/`. It renders a Windmill roadmap (a **DAG** —
a step can have several prerequisites) as a painterly RPG skill tree on a **hand-rolled WebGL2
renderer** (no three.js). Target: **60fps at 5,000+ nodes, 2 GPU draw calls** — one instanced
node draw plus one connector draw, with labels and near-LOD icons as a pooled DOM overlay —
with pan/zoom, hover, direct-manipulation editing, live sync across one account's own devices, and
a presence cursor layer. Writes are owner-only (`canWrite`, `backend/platform/domain/Access.h`), so
multi-account collaboration is not built — a second account can watch a shared tree, never edit it.

The renderer began on three.js and was rewritten in raw WebGL2; the reasons and the lesson live
in `NOTES.md`, which is this package's chronological build log and is *history* — where it and
this file disagree about the present, this file is the one being maintained. Three.js, troika
and dagre are all gone (layout is the hand-rolled radial engine). What is left beyond React:
`lucide-react` reaches the scene through the design system's `Icon`, `mediabunny` encodes the
share video, and `@fontsource` woff2 files are embedded into exported cards.

The shell learns this package exists through `routes.js` and the product registry alone (see
`web/CLAUDE.md`). Nothing here may import another product, and `test/shell-boundaries.test.mjs`
walks every import in `src/` to keep it that way.

## The pipeline (this is the load, top to bottom)

Lives in `SkillTreeView.jsx`, in the effect keyed on `[reloadKey, treeId, demo]`:

```
const repo      = new HttpTreeRepository({ treeId });
const seed      = await repo.loadTree();              // …or loadDeviceTree(id): the blob, if the row is ours
const tree      = new SkillTree(seed);                // entity + DAG validation
const progress  = await repo.loadProgress(seed);      // {completed, inProgress, startedAt, completedAt, server}
const states    = UnlockRules.derive(tree, progress); // Map<id, NodeState>
const positions = layoutPositions(tree);              // Map<id, Vec2> — synchronous, memoized
const model     = tree.toRenderModel(positions, states);
scene.setModel(model);                                // GPU build + fit
// then: new SyncSession(...) — the lattice becomes truth and every later edit flows through it
```

Repository loads → domain computes → scene renders. **Layout is synchronous** — no worker, no
promise: `layoutPositions` re-runs `RadialLayoutEngine` inline whenever the node/edge/order
signature changes and serves a cached copy otherwise, so a live edit re-lays the tree in the
same tick it was made. No business logic lives in the scene; the React layer wires data
through, and the exceptions `NOTES.md` records are now hooks of their own — see the
`SkillTreeView.jsx` section for the one that stayed, and why.

After the first paint the load pipeline is not the update path. A `SyncSession` owns the tree's
CRDT lattice; a local gesture and a remote frame both land as a new projection, which re-enters
through `syncStructure()` (re-derive → `scene.applyModel`).

## Map of the package

Every directory, one line. The six marked **↓** have a section of their own below.

| | |
|---|---|
| `model/` | Pure domain: the tree entity, unlock rules, the legend, spatial index. **↓** |
| `layout/` | The one layout engine — radial, synchronous, deterministic. **↓** |
| `scene/` | The WebGL2 renderer, its DOM overlays and pointer tools. **↓** |
| `sync/` | The client half of the graph CRDT — both lanes: the shared structure lattice, the private progress lattice, gestures, socket, IndexedDB. **↓** |
| `share/` | Everything that leaves the app: the link, the cards, the video, the offers. **↓** |
| `editing/` | `TreeEditor` — the holder for the current projection. Undo lives in `sync/`. **↓** |
| `persistence/` | The `TreeRepository` over HTTP, the account tree registry, and the per-tree localStorage ledgers (workspaces, legend, last place, return/milestone/share baselines, view prefs — progress moved to the private sync lane; `ProgressStore` is now only the sweeper for what it left behind). Every device-tree row carries the ACCOUNT it belongs to (`LocalTreeRegistry`), and reads are scoped to whoever the server CONFIRMED on this document load — a remembered identity may paint a face but never opens a device store, so a cold boot with no network sees only anonymous work until one `/v1/me` lands. |
| `ui/` | The desktop overlay chrome above the canvas: control bar, step panel, minimap, tree switcher, birth canvas, the Next-up ranking and the honesty chrome. |
| `ui/tree/` | The step's own components — kind legend, checklist, workspace body — and the two hooks that drive them (`useLegend` · `useWorkspace`, each over its pure model), plus `SkillNode`/`SkillConnector`/`ProgressBar`, the canon's DOM reference implementation of the tree metaphor, whose consumer is the `#/showcase` gallery. |
| `ui/mobile/` | The phone/tablet surfaces: bottom sheets, the editor sheet, aim + bulk bars, the action lane, the read-only chrome and the fork door. |
| `list/` | The phone's second view of the same model (X8): the tree as an outline, with its own pure outline/editing/explore rules. |
| `activity/` | The activity log domain, the one presentation grammar (verb hues, sentences, rows) every feed surface speaks, and `useActivity` — the controller that records an arrival and decides whether the dock is showing it. |
| `ceremony/` | `CeremonyDirector` — sequences the motion language's camera → travel → bloom → pulse → toast into one ceremony at a time. |
| `selection/` | The multi-selection predicates (a set of two or more is one thing, not N picks). |
| `shortcuts/` | The canonical keyboard map and the reference dialog built from it. |
| `presence/` | The presence cursor layer, drawn on its own rAF loop above the canvas. |
| `paste/` | Paste-import: the deterministic plan grammar, the composer, the ghost preview, the graft rule, the AI-compose stream, and the ZIP writer the data export shares. |
| `quests/` | The nine authored starter quests (`roster/`) and the shelf + seed-packet thumbnails that plant them. |
| `browse/` | The in-product public wall `#/browse` — the client-rendered twin of the marketing gallery. |
| `demo/` | The playable demo (`#/demo`): the staged tree constants and the once-ever coach chip. |
| `tending/` | The Tend bar, its client, and the pure receipt/meter copy behind settings' ledger. |
| `reminders/` | The weekly-nudge preference client (its settings section lives in `settings/`). |
| `settings/` | The product's own settings sections — plan, reminders, tending, your-data — plus the export archive builder. |
| `marketing/` | The `/roadmap` landing, its crawlable `<head>`, its stylesheet and the self-playing tree scenes. |

Root files: `routes.js` (the route table the shell composes), `SkillTreeApp.jsx` (resolves *which*
tree before the heavy view mounts), `SkillTreeView.jsx`, `HomeCard.jsx` (the `/app` home cell),
`theme.js`, `index.js`, `skilltree.css`, `NOTES.md`.

## Contracts

- `model/ports.js` — the data shapes (`NodeSpec`, `Kind`, `TreeData`, `Progress`, `RenderNode`,
  `RenderEdge`, `RenderModel`, `Bounds`, `Vec2`, `NodeState`) plus the two base ports
  `TreeRepository` (`loadTree` / `loadProgress` / `loadActivity`) and
  `LayoutEngine` (`layout` is synchronous). The C++ server answers these same shapes, so this
  file is the contract both sides are held to — when a field moves, it moves in both.
- `theme.js` — the resolved hex palette, because WebGL cannot read CSS custom properties. A
  node's look is two orthogonal dimensions:
  - its **kind**, `NODE_COLORS` / `NODE_COLOR_NAMES` — six hues, terracotta · olive · gold ·
    brick · sky · plum, each `base` (accent-500), `ring` (accent-600), `soft` (accent-200) and
    `glow`. The shader and the swatch rows size themselves off the name list, so a seventh hue
    would be a one-line addition.
  - its **tier**, `nodeTier(state)` — **four**: `unavailable` (locked → low-opacity wash, no
    glow), `available` (saturated fill + ring, glow on hover), `inprogress` (the ember — a soft
    glow breathing at half the crown, a calm third read that is not a re-hue), `activated`
    (complete → an outer ring + a breathing halo). Indices rise with progress, so a state diff
    reads growth as a rise in tier. `isDone(state)` (complete only) drives edge growth.

  A third, structural axis is `nodeForm(label, parents, children)` — `linked` · `bud` (born,
  unnamed) · `unlinked` (a stray with no branches left) — which the editing gestures reveal as a
  dashed ring. Also `CONNECTOR`, `BACKGROUND`, `BARK` / `BARK_CREAM` (the neutral tool + grouped
  selection treatment) and `NODE_SIZE`.

Positions are in **world units** where a node is `NODE_SIZE` (56) across. Everything in `model/`
is pure JS — no WebGL, no React.

## `model/`  (pure JS)

- `model/SkillTree.js` — `class SkillTree`. The constructor validates the DAG (throws on a
  duplicate id, a dangling prerequisite, or a cycle), indexes `nodesById` + `childrenIndex`,
  precomputes `topoOrder()` and `ranks()` (longest-path depth) and elects the `TrunkTree`.
  Getters `id`, `title`, `nodes`, `edges`, `trunk`; graph ops `roots()`, `parentsOf`,
  `childrenOf`, `ancestorsOf`. `toRenderModel(positions, states)` → `RenderModel`: each node
  takes `x,y` from `positions`, `state` from `states`, `layer = rank % 3`, `form` from
  `nodeForm`, `glowSeed` = a stable FNV hash of `id` in 0..1, `branch` + `emphasis` from the
  trunk; each edge takes only `{from, to, kind}` — **an edge carries no state of its own**, it
  inherits its source node, which is how `ConnectorBatch` grows it. `bounds` is the node extent
  padded by NODE_SIZE.
- `model/renderableGraph.js` — `makeRenderable(treeData)`: the backend permits an invalid graph
  and surfaces it, so the client mirrors that rather than throwing. Drops the cycle edges,
  returns the best-effort projection plus what was wrong.
- `model/TrunkTree.js` — elects one primary ("trunk") parent per node, a spanning arborescence
  over the DAG, and derives each node's sector: branch root, trunk depth, leaf weight. Same-kind
  parents win; ties go to the shallowest, then the smallest id. Trunk children keep sibling order
  (the fractional-index key, then creation stamp), which is what the layout sweeps.
- `model/UnlockRules.js` — `UnlockRules.derive(tree, progress)`: `complete` if completed, else
  `active` if in progress, else `available` if every prerequisite is complete (roots qualify
  vacuously), else `locked`. Every state transition routes through here; nothing hand-sets a state.
- `model/Legend.js` — the tree's ordered kinds (F6). Pure: every op takes a legend and returns a
  new one. `deriveLegend` reconciles the server's kinds with the hues actually worn; `withCounts`,
  `inUseCount`, `freeHue`, `renameKind`, `describeKind`, `addKind`, `removeKind`, `recolorKind`.
  **Legend ORDER is not held here.** Order is generation priority and lives in the lattice as a
  per-kind rank: the live legend re-derives from `seed.kinds`, and a reorder is the `ReorderKinds`
  gesture (`sync/materialize.js`), which is also what the MCP's `reorder_kinds` tool writes. The
  pure array ops above survive because `paste/PasteComposer` edits a *draft* legend that is not in
  the lattice yet; there is no draft reorder and no live one, so there is no `reorderKinds` here.
  `GENESIS_STAMP` / `DEFAULT_KINDS` are re-exported from `packages/api-contract/genesis.js` — the
  seed shared byte-for-byte with the backend, re-asserted by `vite.config.js` on every build.
- `model/NodeWorkspace.js` — a step's sub-tasks, note and links (F13), same pure discipline.
- `model/SpatialGrid.js` — a uniform bucket grid over placed nodes. `nearest(x, y, maxRadius)`
  scans the 3×3 neighborhood (so keep `cellSize ≥ pickRadius`); `within(...)` selects the
  viewport's nodes for LOD labels; `move(id, x, y)` re-buckets after a live drag.
- `model/milestones.js` — `detectMilestones`: the structural moment worth sharing — a whole
  branch turning to light, or the crown — never a single step. Pure, so the offer conduct
  (owner-only, once-ever) lives at the call site.

## `layout/`

- `layout/RadialLayoutEngine.js` — `class RadialLayoutEngine extends LayoutEngine`, the one
  engine. Each node sits on the ring for its trunk depth, centred in an angular wedge split
  among trunk children by subtree leaf count; a ring is pushed outward until its closest pair of
  neighbours has room, so a crowded ring spreads rather than clumps. **Synchronous** and
  deterministic (siblings sort by their fractional-index key), so a load and a live emission
  project identical pixels.

## `scene/`  (raw WebGL2)

- `scene/glcore.js` — the narrow GL slice this feature needs: link a program, resolve
  uniform/attrib locations, upload a canvas as a texture.
- `scene/Camera2D.js` — a pure ortho 2D camera; world↔screen is scale (`zoom`) + translate,
  Y-down. `screenToWorld` is the exact inverse of the shader projection, so picking is
  pixel-accurate. `pan`, `zoomAt` (cursor-anchored), `zoomBy`, `panTo`, `focus`, `fitToView`,
  `glideTo`, `launchInertia`, `update(dt)` (glides + decays inertia, answers whether it moved).
- `scene/NodeBatch.js` — **one instanced draw** for every fruit: a base quad drawn N times with
  per-instance attributes — offset, colour, tier, form, glow seed, selection, icon cell, plus the
  animation stamps the ceremonies and the feedback treatments write. The body is
  procedural (disc + gradient + ring); the glow pulses from `uTime`; the icon atlas is sampled
  and tinted per tier, fading out across the handoff band where the DOM icons take over.
  `moveInstance(id, x, y)` is a ranged `bufferSubData` write — the live-drag fast path.
- `scene/ConnectorBatch.js` — **one draw** for all edges, bézier ribbons packed into one buffer.
  A branch inherits its source: once that node is complete it lights in the source's kind hue
  with a GPU colour/growth sweep driven by `uTime`. `setStates` rewrites only the grow attributes;
  `moveNode` re-tessellates just that node's incident edges.
- `scene/IconAtlas.js` — rasterizes lucide glyphs (through the app's `Icon` registry) into an
  alpha-mask canvas atlas (192px cells) for the far/mid LOD, and re-uploads once async glyph
  decode completes.
- `scene/NodeOverlay.js` — DOM above the canvas: an abstract `NodeOverlay` owns one placement
  skeleton (a **fixed pool of ~64** absolutely-positioned elements on the nodes nearest the
  viewport centre, LOD-gated by zoom, moved by CSS `transform` so a frame costs no layout), and
  two subclasses override only element / visibility band / draw — `LabelOverlay` (captions) and
  `IconOverlay` (the near LOD: live `<Icon>` SVG that cross-fades in as the baked atlas fades out).
- `scene/AffordanceLayer.js` — the calm edit chrome: a bark-and-cream plus chip + ports fading
  onto the **selected** node (hover shows no structure). The plus sits on the node's outward rim,
  ports at the widest gaps; repositioned per frame so it tracks camera and drags. A grace window
  keeps it reachable just after a deselect. The plus fires `onCreate`; each port starts a
  `ConnectGesture`.
- `scene/HoverLabel.js` — the hover name tip: a dark bark pill under the disc, never structural
  chrome. Inline-styled, so it owns no CSS.
- `scene/EdgeChrome.js` — the selected-edge chrome: a clicked branch turns bark and grows two
  endpoint handles plus a midpoint × (delete). Selection-gated, not hover.
- `scene/ConnectGesture.js` — dragging a dependency from a port (or an edge handle) to another
  node: a dashed SVG ghost follows the cursor; the target rings olive (valid) or brick with a
  "would create a loop" tip. The whole cycle-closing set is collected up front and faded to 30%,
  and that same set is the cyclic predicate — so a faded node can never take the drop.
- `scene/MarqueeOverlay.js` · `scene/ReorderSlot.js` · `scene/ArrivalChevron.js` — three small
  DOM overlays in the same family: the Shift-drag rubber band, the dashed insertion ring for
  angular reorder, and the viewport-edge pill that points at off-screen births.
- `scene/edgeKey.js` — an edge has no id; its identity is the ordered `(from, to)` pair. This is
  the one place that folds those into a stable key and back, so React selection and the GPU
  highlight can never disagree about what "this edge" is.
- `scene/input/` — pointer interaction, extracted so the scene is not a god-object and edit tools
  plug in without touching event plumbing. `InputController` owns the canvas listeners, pointer
  capture and single-pointer bookkeeping, drives two-finger pinch itself, and forwards
  down/drag/move/up/leave to the active `Tool`. `tools.js` holds the `Tool` contract plus
  `NavigateTool` (drag-pan + inertia, click-select, throttled hover — both the viewer behaviour
  and the editing default) and `ReadOnlyTool` (1:1 pan, tap-select, no fling).
  `reorderGeometry.js` is the angular-reorder math, kept pure so it is testable without a scene.
- `scene/SkillTreeScene.js` — the orchestrator: owns the GL context, the `Camera2D`, both
  batches, the `IconAtlas`, every overlay above, the `CeremonyDirector` and the
  `InputController`. Its **rAF loop** advances `uTime` and the camera, steps any settle glide,
  considers the pending auto-frame, repositions every overlay on a frame that moved, emits the
  viewport to `subscribeViewport` listeners (the minimap) and draws the two batches — no
  throttle, so the overlays track the GPU at frame rate.

  Its motion surface, which the React shell arms and the loop then owns:
  - **arrival** — `setModel` paints the tree dim and hands the director a BFS ring plan from the
    crowned root, so light wakes the roadmap outward and travels each edge as its ring enters.
    `setArrivalNoun` / `setArrivalSummary` / `suppressArrivalToast` are one-shot intents consumed
    by that plan (a quest plant, a fork re-plant, the demo's silent bloom).
  - **return recap** — `armReturnRecap(sinceIds, summary)` before the model installs makes the
    next state push replay only the steps finished since the last visit, cascading parent→child
    by depth within the since-subgraph, instead of the generic arrival.
  - **settle** — `applyModel` diffs positions and glides every displaced node from where it
    stands to its new seat, staggered nearest-the-change first, so a live edit reads as the new
    work pushing the tree open. `finishSettle` lands them instantly the moment a pointer arrives.
  - **auto-frame** — an off-screen birth never yanks the camera: the chevron points, and only a
    plainly idle viewer gets one capped breath outward once the settle has landed.

  Public API (renderer-agnostic, so the React shell never touches GL): `setModel`, `applyModel`,
  `applyStates`, `moveNode`, `fitToView`, `focusNode`, `frameNodes`, `panTo`, `zoomBy`,
  `getViewpoint` / `restoreViewpoint`, `subscribeViewport`, `getBounds`, `getViewport`, `resize`,
  `start`, `stop`, `dispose`; the selection hooks the active tool drives (`select` / `selectEdge`
  — node and edge selection are mutually exclusive — `setSelection` for the shell's mirror,
  `setSelectedSet`, `toggleSelect`, `hover`, `pick`, `pickEdge`); and the live previews the panels
  lean on (`previewKind` / `restoreKind`, `previewDeleteCost` / `clearDeleteCost`, `setFaded`,
  `highlightKind`, `spotlightNode`, `pulseNode`).

Perf rules (non-negotiable): constant draw calls regardless of node count; no per-node JS in the
animation loop except the LOD-gated, bounded overlay pick; no per-frame allocation; instanced
attribute updates flag their buffer rather than reallocating. The ortho camera keeps world↔screen
linear.

## `sync/`  (the lattice is truth)

The tree's durable state is a CRDT lattice, not a `TreeData`. `TreeData` is only its present-time
projection — what the render pipeline consumes.

**Two lanes, one socket, one clock, one blob.** The SHARED lane is the structure, joined by
everyone who can read the tree. The PRIVATE lane is this account's progress. They never share a
frame: a progress register inside a subgraph would publish one user's overlay to every
collaborator on the tree, which is why the overlay is a separate resource in the first place.

- `sync/progressLattice.js` — the private lane's replica: one last-writer-wins register per node
  over `complete | active | none`, where `none` is a VALUE and not a deletion, so a clear
  converges like any other write and no tombstone list is needed beside the data. Two clocks ride
  each register and they are not interchangeable — `at` decides what wins, `markedAt` is the
  SERVER's receipt instant and the only one any surface may show. See docs/GRAPH_SYNC_DESIGN.md §12.
- `sync/lattice.js` — the client's half of the graph CRDT: the mirror of the backend's `Crdt.h`
  + `LooseGraph.h` + `Subgraph.h`. Stamped registers, add-biased life, last-writer-wins fields.
  The convergence laws are exercised on this side by `test/…/sync/materialize.test.js` and
  `reorder.test.js`; `backend/test/golden` holds the shared corpus but does not yet run either
  implementation against it (it reimplements the reference semantics in its own runner).
- `sync/materialize.js` — the one place gesture semantics execute on the client: each gesture
  becomes a list of stamped writes (a partial subgraph) computed against the current lattice, all
  sharing one HLC stamp so the gesture is atomic on the wire. **This retired `editing/edits.js`:**
  the splice, fan-out and reduction logic lives here now, over the lattice instead of over
  `TreeData`, and there is exactly one encoding of it.
- `sync/SyncSession.js` — the one seam `SkillTreeView` talks to for live sync *and*
  durability: it owns the lattice, the HLC clock, the socket and the IndexedDB store, and it owns
  **undo/redo** (it banks each gesture's inverse and re-dispatches it re-stamped). "The lattice is
  the outbox" — there is no queue; an offline edit is already in the durable frame.
- `sync/SyncStore.js` — one IndexedDB record per tree, `{frame, lastSeq}` written together so a
  crash never tears them.
- `sync/fractionalIndex.js` — jitterless LexoRank-style order keys, so a reorder is one write
  rather than a sibling renumber.
- `sync/localTrees.js` · `sync/claimLocalTrees.js` — the signed-out lifecycle of a device-born
  tree, the additive claim that adopts it into an account on sign-in, `loadDeviceTree` (the blob
  fallback, gated on this device holding a row for the caller's account) and `forgetDeviceTrees`
  (the account hand-off the shell fires through `roadmapRoutes.forgetDevice`).
- `sync/refusals.js` — what the editor does about a reject frame, decided by the frame's stable
  `code` (`not-yours` / `nobodys-tree` demote the editor; `sign-in-required` re-checks the session;
  anything else warns) — never by its sentence, which is prose the server may reword.

## `editing/`

- `editing/TreeEditor.js` — the holder for the current projection: one field, one getter, so
  every read seam sees the same `TreeData` without threading it through React state. It is not a
  history — undo is the `SyncSession`'s, over the lattice.

## `share/`  (the X2 share identity)

Sharing is a **link**: `ShareDialog` copies the read-only tree URL and, when the tree is yours and
private, flips it to unlisted on copy. The rest of the package renders the cards and the stats the
chrome shows. Canonical spec: the design canon's `explorations/share-identity.html`. Grouped as
one feature package rather than split across layers because it is a self-contained surface.

- `share/palette.js` — `SHARE_PALETTE` (`light` + `dark`) + `KIND_ORDER`. Light is the design
  system 1:1 (kinds pulled from `theme.js`); dark is the export-only night skin.
- `share/ShareStats.js` — `ShareStats.from(tree, states)` → `done/total/percent` plus the
  **dominant kind**: the most common kind among *done* nodes, a tie (or an empty tree) falling to
  terracotta. Feeds the plaque, the switcher, the fork readouts and the cards.
- `share/TreePortrait.js` — `treePortraitSvg(model, palette, box, viewBox, options)`: the tree as
  a standalone SVG string built from the `RenderModel`, self-contained (own xmlns, unique filter
  ids, no text or urls) so it rasterizes inside an `<img>`. `options = {lit}` opens the **period
  ink** — a four-tier ladder plus the route rule that draws the edge INTO each new step in that
  step's own kind at full alpha. An empty set writes nothing, so the default markup every other
  surface pins stays byte-identical.
- `share/ogCard.js` — the unfurl postcard (#12): `buildOgCardSvg` plus the recipe its siblings
  share — `POSTCARD` (the 2400×1260 measures), `paddedGlowBox` / `clampViewBox` (the glow-inclusive
  fit) and the `ellipsize` / `escapeXml` text guards. `paddedGlowBox(model, {steady:true})` measures
  every node as if lit, so a card in a series does not shift frame as the tree fills.
  `share/rasterize.js` turns any card into a PNG, fonts embedded as base64 (an `<img>`-drawn SVG
  cannot reach the page's faces).
- `share/progressCard.js` — the recurring post (#20): the same postcard in period ink on the steady
  frame, with a stamp-led strip and its hue taken from the **dominant kind among the new steps**, so
  two consecutive posts differ by construction — deliberately the structural opposite of the
  milestone card.
- `share/progressPeriod.js` — the period math, pure: `ProgressPeriod` (counted from the tree's
  planting time, **never the calendar week** — "Week 3" or "Day 17" by the reader's choice, `Update
  #N` when the server has no planting stamp), `newThisPeriod`, and `ledgerDeltas` (one tick per
  elapsed period, each the stamp of the card *published* in it — never a local completion time,
  which is device-local and would publish a week worked elsewhere as a quiet one).
- `share/progressOffer.js` — `considerProgressShare(…)`: when that card is worth offering. It rides
  the RETURN, not a completion — the first open after a period closes, once per period, never on the
  first period, never twice, never without a card already posted. Two declines in a row retire it for
  that tree, permanently and silently. Its baseline is `persistence/ShareLedger.js`, written **only
  when a share happens** — the only honest way to say "since you last shared", and still the right
  one now that the overlay DOES carry instants: a receipt says when a step was marked, never when
  its owner last told anybody about it.
- `share/shareVideoFrame.js` · `share/captureShareVideo.js` — the motion companion (#19): the
  animated loop's frames as SVG, encoded to a short seamless mp4 in the owner's browser. Best-effort
  by contract — WebCodecs is not everywhere, so every path returns null and the still stays the
  poster; a final decode probe means a malformed encode falls back rather than shipping a broken tag.
- `share/ogUpload.js` — `uploadOgImage` / `uploadOgVideo`: one guarded PUT behind two named doors,
  with the backend's 3 MB cap stated once. Fire-and-forget by contract — a failed upload must never
  block or break sharing.
- `share/ShareDialog.jsx` — the Share surface in two segments. First the LINK: copy the read-only
  URL and, when the tree is yours and private, flip it to unlisted on copy with an honest reach line,
  plus the gallery-listing consent. Then `share/ProgressCardSegment.jsx` — the period's POST: the
  drawn card, Download / Copy / the OS sheet, the Week/Day segmented control and the ledger toggle
  (both remembered per tree in `ViewPrefs`). It is also the door back for anyone the offer retired.
- `share/GalleryCard.jsx` — the in-product card (#12): drops the mat (it lives inside app chrome)
  but keeps the kind rule and the same title/readout. Presentational, light and dark.

- `share/weekOfferGate.js` — `WeekOfferGate`: arm / follow / drop over a clock and a `ceremonyBusy` probe — the
  offer's whole timing in one testable place (`test/products/roadmap/share/weekOfferGate.test.js`).
- `share/useWeekOffer.js` — the director over all of the above: the share ledger, the two cards'
  pixels (one raster cached, so the sheet opens onto a drawn post), the week segment the sheet
  renders, and the offer's whole conduct. `SkillTreeView` holds only the triggers, because they are
  not the director's to pull: `considerWeekOffer` at the end of the load, `followCeremony` from the
  scene's one toast sink, `dropWeekOffer` from the milestone beat and the load's teardown.

The period's offer is armed during the load and fired by the scene's one toast sink, 120ms after
whatever ceremony closes the open (the welcome-back recap, or the arrival standing in for it).
`share/weekOfferGate.js` is that timing as one policy: a 2600ms safety cap that, before it fires,
asks the scene's `ceremonyBusy()` (the director's `busy()` — live or pending) whether a ceremony
is still coming, and stands aside for another tail if one is (a phone opening into the list still
gets its arrival spoken once, from a scene paused after scheduling it), bounded to three deferrals
so a wedged director never strands the ask. A milestone landing in the same window drops it: one
pride moment per open, and the ask is dropped rather than queued.

## `SkillTreeView.jsx` + overlay UI

Runs the pipeline above, then hands the tree to a `SyncSession` and hosts every overlay around the
canvas. Each edit is dispatched as one gesture (`collab.dispatch({kind, …})`), materialized into
stamped writes, joined into the lattice, persisted, and — when live — sent as one frame; the new
projection comes back through `onTreeChanged` → `syncStructure()` (re-derive, re-validate, then
`scene.applyModel`), which is the *same* path another device's frame takes. Keys: ⌘Z/⇧⌘Z →
`SyncSession.undo`/`redo`, ⌫/Delete on the selection, Esc deselects; a `selectedId` →
`scene.setSelection` effect keeps the canvas chrome in step with React.

At 2,606 lines it is still by far the largest file in the package, and its own header's claim that
no business logic lives here was not true — which is why the header now names what is left rather
than denying it. Wave 17's extractions have landed: advancing progress and choosing the milestone
to announce are pure functions in `model/progress.js`, and four controllers are hooks over the
model or feature package each drives — `ui/tree/useLegend.js`, `ui/tree/useWorkspace.js`,
`share/useWeekOffer.js` and `activity/useActivity.js`.

What is still here, deliberately, is the remote-frame idempotency. The anti-clobber reconciliation
that used to sit beside it is GONE, along with the local stamp maps it reconciled: progress is a
lattice lane now (`sync/progressLattice.js`, GRAPH_SYNC_DESIGN.md §12), so a stale mark cannot
overwrite a newer one by construction rather than by a diff. Remote-frame idempotency is what is
left of that pair, and its failure mode is still silent data loss — a frame applied twice — so every extraction
so far has left it whole rather than split the guarantee across a seam. See Wave 17 in the audit
ledger and `NOTES.md`.

Wires:

- A full-viewport `<canvas className="st-canvas">`; constructs `SkillTreeScene` in an effect,
  `setModel` + `start()`, `dispose()` on unmount, `resize()` on container resize (ResizeObserver).
  The scene is held in state so overlay children can subscribe once it exists.
- Overlay UI (built from `src/design-system`):
  - `ui/ControlBar.jsx` — the top bar: the Windmill wordmark linking home, the tree identity plaque
    (the `TreeSwitcher` docks into `titleSlot`, else a static title), and on the right the Tend chip
    (owner of an armed tree only), the Activity / "Next · N" chip with its unseen badge, Share, Reset
    edits (when there are any), the shortcuts button and the zoom-out / zoom-in / fit group. Its key
    hints come from `shortcuts/shortcutMap.js`, never a duplicated literal.
  - `ui/StepPanel.jsx` — the one docked panel, slid in on pick: inline-editable name, the state block,
    the six kind swatches (hover previews live through `scene.previewKind`, click commits), the
    prerequisite checklist, the per-node workspace and History, and an isolated Delete whose hover
    dims the cost through `scene.previewDeleteCost`.
  - `ui/tree/KindLegend.jsx` — the on-canvas colour key that is also its own editor; the parent docks
    it bottom-left and supplies each kind's count.
  - `ui/Minimap.jsx` — two stacked canvases: a dots layer redrawn only on node/state/bounds change,
    and a viewport rectangle redrawn every frame from `scene.subscribeViewport`, so the rectangle
    tracks the camera without redrawing thousands of dots. Click to `panTo`.
  - `activity/ActivityFeed.jsx` + `ui/NextUp.jsx` — the docked feed, led by the ready-work section.
  - `presence/PresenceLayer.jsx`, `tending/TendBar.jsx`, `share/ShareDialog.jsx`,
    `ui/HonestyChrome.jsx`, and on small screens `list/ListView.jsx` plus the `ui/mobile/` surfaces.
- All node-state transitions go through `UnlockRules.derive` — never hand-set a node state.

## Conventions (from CLAUDE.md — honor these)

- Optimize for the reader. Express functions as top-to-bottom fail-fast pipelines.
- The domain layer is pure and dependency-light; WebGL lives only at the boundary.
- Constructors on entities (not factory helpers). Early returns over assign-then-return.
- No underscore-prefixed private helpers; no docstrings or multiline prose comments.
- Don't create sub-40-line files without a strong reason; group kin (all shapes in `ports.js`).
- Plain JS/JSX only — no TypeScript.
