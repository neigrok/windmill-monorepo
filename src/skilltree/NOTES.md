# Skill-tree — build notes & observations

Renders a Windmill roadmap (a **DAG**) as a painterly RPG skill tree using a
**hand-rolled WebGL2 renderer** (no three.js). Target: 60fps at 5,000+ nodes with
pan/zoom, hover, click-to-complete.

## Renderer: raw WebGL2 (rewrote off three.js)

The node layer was originally built on three.js `InstancedMesh`. That was the
source of a long, painful bug: **the nodes never rendered on the main canvas**
(only the connectors and the minimap showed). Root cause — an `InstancedMesh`
created with a plain `BufferGeometry` + custom per-instance attributes (no
`instanceMatrix` in the shader) issues a draw call that produces **zero pixels**,
with no error. draw-call count and picking *logic* both passed while nothing drew,
which masked it for a long time.

Rather than keep fighting three's abstractions for the ~5% we used, the render
path was rewritten as a **purpose-built WebGL2 renderer**. three.js + troika were
removed (bundle −~600 kB). What each module does:

- `glcore.js` — tiny GL helpers (compile/link, uniform locations, canvas texture).
- `Camera2D.js` — pure ortho 2D camera; world↔screen is scale+translate, Y-down.
  Its `screenToWorld` is the exact inverse of the shader projection, so picking is
  pixel-accurate.
- `NodeBatch.js` — **one instanced draw** for all fruit. A base quad drawn N times;
  per-instance attributes (offset/state/glowSeed/selected/iconCell). Fruit body is
  **procedural** (disc + gradient + ring), glow pulses from `uTime`. GLSL ES 3.00.
- `ConnectorBatch.js` — **one draw** for all edges; bézier ribbons in one buffer.
  Activation replays as a GPU color sweep; `setStates` only rewrites active/grow.
- `IconAtlas.js` — rasterizes lucide glyphs (via the app's Icon registry) into an
  alpha-mask canvas; the scene uploads it as a GL texture, re-uploads on async decode.
- `NodeOverlay.js` — pooled DOM overlays over the canvas, LOD-gated by zoom (crisper
  and simpler than SDF text): `LabelOverlay` captions + `IconOverlay` live SVG glyphs.
- `SkillTreeScene.js` — owns the context, batches, camera, rAF loop, pointer input,
  picking (`SpatialGrid`). Public API unchanged, so the React shell is renderer-agnostic.

Colors are emitted directly in sRGB (matching the CSS palette) — no color-management
step, which also removes a class of "why is it the wrong shade" bugs.

## Verified live
Nodes render (41 fruit), connectors render, labels appear only when zoomed past the
LOD threshold, picking + click-to-complete + DAG diamond unlocks work, demo↔5k toggle,
reduced-motion honored. Zero GL/console errors.

## Lesson
Verify **actual pixels on screen**, not proxy signals (draw-call counts, picking
logic, "it compiles"). The whole three.js episode passed every proxy while rendering
nothing. A single "are there non-background pixels where a node should be?" check
would have caught it on day one.

## Overlay smoothness: labels + minimap track the camera every frame
The GPU canvas redrew every rAF, but labels and the minimap viewport rectangle
only updated inside `notifyCameraChange()`, which was throttled to 100ms — so
they moved at ~10fps while the tree panned at 60fps ("text/minimap wait several
frames then jump"). Root cause was one path feeding two very different consumers:
React state (rightly kept off the hot loop) and pure-render overlays (which
belong *on* it).

Fix: the render loop now drives the overlays directly. `SkillTreeScene.tick`
calls `labelOverlay.update` and per-frame `viewportListeners` whenever the camera
moved — no throttle, no React. The throttled `notifyCameraChange` / `onCameraChange`
/ React `viewport` state are gone. The minimap subscribes via `scene.subscribeViewport`
and splits into two stacked canvases: dots redraw only on node/state/bounds change
(rare, up to 5k arcs), the viewport rectangle redraws per frame on its own layer.
Labels now position with `transform: translate(...)` instead of `left/top`, so 64
spans move each frame without triggering layout.

Verified live: during a 1s pan the minimap rectangle redrew 121× and each visible
label repositioned 120× (120Hz display) — max frame gap ~10ms, no stalls.

Lesson: don't route a per-frame value and a React-state value through one throttled
callback. Per-frame render concerns belong in the rAF loop; React state stays off it.

## Node icons: baked atlas for the many, live SVG for the near
Node glyphs are baked once into an alpha-mask texture atlas (`IconAtlas`) so
thousands draw in the single instanced node call. That raster is fixed-resolution,
so it softens once a node is zoomed large enough to out-resolve its cell. Two-part
fix: (1) bump the atlas cell 96→192px, which keeps it crisp through the whole band
where the GPU icon is at full strength; (2) above that, an `IconOverlay` places the
node's real `<Icon>` SVG as pooled DOM — crisp at any zoom, tinted per state to
match the fruit — and the GPU icon cross-fades out over `[2.0, 3.0]` as the DOM
icons fade in (`iconOpacity * (1 - smoothstep(zoom, ICON_DOM_START, ICON_DOM_FULL))`
vs the overlay's container opacity). The atlas keeps the far/mid LOD where DOM would
be thousands of elements; DOM only ever touches the ~64 nearest nodes.

Structure: labels and icons wanted the same pool + spatial-pick + per-frame
placement skeleton, so it lives once on an abstract `NodeOverlay` and `LabelOverlay`
/ `IconOverlay` override only element / visibility band / draw (`NodeOverlay.js`
replaces the old `LabelOverlay.js`). `IconOverlay.setStates` re-tints visible icons
on completion without a camera move.

Verified live: at zoom 3.5 real `<svg>` icons render at 0.44·NODE_SIZE·zoom with
per-state color (locked #B29F7B, complete #FFFFFF); marking a node complete flips
its icon tan→white immediately; the cross-fade sums to 1.0 at zoom 2.5; DOM icons
are hidden below the band.

## Color = kind, state = three tiers (pulled from the design system)

Node look is **two orthogonal dimensions**. `color` (a `NodeSpec` field: terracotta
/ olive / gold / brick / sky) picks the **hue** — a node's *kind*, a stand-in until
real categorization lands. State maps to one of **three tiers** via `nodeTier(state)`
(design: the `dag-clean-colors` exploration); the finer 4 `NodeState`s live on only
for the detail/dashboard panels:
- **unavailable** (locked) — the same hue at low opacity `mix(canvas, base, 0.22)`,
  muted ring, muted glyph, no glow. Opaque (so trimmed edges never show through).
- **available** — flat saturated `base` fill + `ring` (accent-600), `soft` glyph,
  no resting glow (glow on hover via selection).
- **activated** (active **or** complete — "engaged") — the available look plus an
  **outer ring** (a thin `base` circle beyond the disc) and a **breathing glow**.

Values are the design tokens verbatim (`--kind-*`): `base` = accent-500, `ring` =
accent-600, `soft` = accent-200, `glow` = the kind's rgba. Fills are flat/matte (the
exploration dropped the old glossy gradient). One `aTier` float per instance selects
the branch in-shader; `setStates` rewrites only that float.

Edges follow their **source node** (design `SkillConnector` with
`glowColor=var(--kind-{from.kind})`): a branch lights in the source kind's `base` hue
with a grow-sweep once the source is `isDone` (complete); otherwise a thin muted line
at `0.7` alpha. Edges are trimmed to the node's disc radius (`NODE_SIZE*0.42`) so they
meet the boundary instead of running under the body.

`MockTreeRepository` completes the root + 3 rings so the demo shows all three tiers at
once: an activated spine, a saturated available frontier, dimmed leaves.

Verified live (headless Chromium + swiftshader, since the perpetual rAF loop blocks
the in-browser extension's `document_idle` screenshot): activated spine is saturated
with outer rings + glow + lit edges; the frontier row reads as saturated-no-glow
(available); leaves are pale washes of their own kind — all three tiers distinct.

## Enabling pass for graph editing (interaction seam + incremental scene)

Prep before the editing phase, without committing to a command/undo model yet. Two seams:

1. **Interaction is now a tool router.** `scene/input/InputController` owns the canvas
   listeners + pointer capture + single-pointer bookkeeping and forwards to the active
   `Tool`; wheel-zoom stays global. `NavigateTool` is the old pan/select/hover behaviour
   verbatim; `MoveTool` extends it with node dragging (press-on-node → live move, press-on-
   empty → pan). Scene defaults to `MoveTool`; edit tools (connect/add/marquee) drop in as
   new `Tool`s via `input.setTool` with no change to the scene or the plumbing. The scene
   keeps only the state hooks tools call (`select`, `hover`, `pick`, `moveNode`).

2. **The scene can update incrementally, not just replace-all.** `moveNode(id, x, y)` is the
   per-frame drag path: `NodeBatch.moveInstance` (ranged `bufferSubData` of one offset) +
   `ConnectorBatch.moveNode` (re-tessellate only the node's incident edges via a node→edge
   index, subData their ranges) + `SpatialGrid.move` (re-bucket so it stays pickable) +
   an `overlaysDirty` nudge (labels/icons refresh on node move, not only camera move). For
   structural changes there's `applyModel(newModel)` — a preserve-view rebuild (keeps camera
   + still-present selection, reuses the atlas unless a new icon appears) that the edit layer
   will feed re-derived models to.

Deliberately deferred (co-design with editing): the `TreeData → TreeData` command/reducer +
undo stack, persistence, committing a dragged position back into the domain (`NodeSpec.position`
already exists for it), and per-instance add/remove GPU compaction (`applyModel`'s full
re-upload is fine at edit cadence). Verified live (headless): drag-node moves it with edges +
label following and it stays clickable; pan/select/hover unchanged; no errors.

> Retired 2026-07-18: the free-pixel node-move gesture (`MoveTool`, `scene.onNodeMoveEnd`,
> `repositionNode`) was removed — it had no effect after reload. `NavigateTool` is now the
> editing default (a node-drag pans); the lattice `position` register + the `moveNode` settle
> glide stay (seeded/server positions still render). The §07 angular reorder is the successor.

## Editing phase — command layer + undo/redo (first slice)

The substrate every edit will write through, proven end-to-end by making node drags
undoable. `editing/TreeEditor` holds the present TreeData + undo/redo stacks; edits are pure
`TreeData → TreeData` transforms (`editing/edits.js`) with structural sharing, so a compound
edit is one history step and snapshots stay cheap. The view builds the editor from the loaded
data, caches the raw layout, and:
- a `MoveTool` drop past the 4px threshold fires `scene.onNodeMoveEnd` → the view commits
  `repositionNode(treeData, id, x, y)` (a `NodeSpec.position` override) as one history step —
  the scene is already at the new spot from the live drag, so only history + minimap update.
- ⌘Z/⇧⌘Z → `undo`/`redo` → `syncStructure()`: rebuild a `SkillTree` from `editor.treeData`
  (re-validating the DAG — this is also the cycle guard for structural edits), re-derive
  positions (cached raw layout + overrides via `applyNudges`) + states, and `scene.applyModel`
  (preserve-view). Verified headless: drag → ⌘Z restores the exact position (override cleared),
  ⇧⌘Z re-applies it; canUndo/canRedo flip correctly; a new edit clears redo.

Design alignment / next: this move is a free-pixel `position` override — the design's move
(§07) is *angular reorder* over a deterministic **radial layout** (`radial-layout`, still
`available` on the roadmap), which will replace the gesture. The structural edit transforms
(create/connect/reconnect/delete/rename/kind) each add a pure transform to `edits.js` + a tool
or affordance; they flow through the same `commit`/`syncStructure` seam. Cycle prevention needs
a live `wouldCreateCycle(from, to)` predicate for in-drag feedback (spec §03) in addition to
the commit-time `new SkillTree` validation.

## Editing: calm hover affordances

The chrome every editing gesture starts from (editing-spec §00–§03). `scene/AffordanceLayer`
is a DOM overlay (sibling to the label/icon overlays) that shows a plus chip + two ports on the
hovered node and hides on leave — bark-and-cream, invisible at rest, 150ms fade. The plus lands
on the outward rim (opposite the mean parent direction, where a child grows); ports go to the
widest gaps between incident branches (free rim). It's driven by `scene.hover()` and
repositioned from the render loop, so it follows pan/zoom/drag. Purely visual for this slice —
`pointer-events: none`; wiring the plus (create) and ports (connect) comes with those features,
which will also need to keep the node "hovered" while the pointer is on the chrome.

Radial layout: attempted (5 algorithms) and reverted — our roadmap is a bridging DAG (editing
depends on both the interaction and data foundations), so radial necessarily stretches long
cross-branches; layered reads cleaner. `radial-layout` stays `available` on the roadmap;
revisit only with edge-bundling / cross-branch de-emphasis if a real tree-like roadmap wants it.

## Editing: create node (first structural gesture)

The plus is live (editing-spec §02), and it's the first structural edit through the command
layer. Clicking + **commits a child immediately** (saved even unnamed) — `scene.onCreateChild`
→ `addChildNode` (inherits the parent's kind, a `position` override so nothing else
re-lays-out) → `editor.commit`, then an inline `<input>` opens over it to name it optionally.
↵ / blur amends the label in place (`editor.amend` — create + name stay **one** undo step); a
blank name is fine. Clicking + again first saves the last one, then adds another (successive
new children spread by `SIBLING_GAP` so they don't stack). While the field is focused its
keydown `stopPropagation`s, so ⌘Z there undoes your typing, not the tree — close the field then
⌘Z removes the node. The new node's tier falls out of UnlockRules (child of a done node →
available). Verified headless: 3 unnamed creates spread and save; ⌘Z removes them one at a time.

We adopted the design's **always-editable** model (§01A, the recommended one): no mode toggle —
hover shows affordances, click opens detail, drag moves, the plus creates. That's why `edit-mode`
is marked complete. The dashed **bud** visual (§02.2) is deferred to the `bud-state` slice; for
now a created node uses the normal not-done treatment while it's named.

Grace window: the plus lives outside the disc, so the affordance layer keeps chrome alive for
~260ms after the pointer leaves the node (cancelled when the pointer reaches the plus/ports),
and `pointer-events` flip to `auto` only while shown.

## Editing: delete node + splice + toast

Select a node, ⌫/Delete removes it (editing-spec §06). `edits.deleteNode` is a compound
transform → **one** history step: the node is dropped and any child that loses its *only*
parent is spliced up to the deleted node's parents (children with other parents just drop this
one; re-tether targets are ancestors so it stays a DAG). *(Superseded: `syncStructure` now
re-runs the layout engine whenever the node/edge signature changes — the live path and a fresh
load are one pipeline, so MCP/collaborator creates land laid-out instead of clumped. "Nothing
else moves" survives only for content edits — rename, progress, drag; structural edits reflow,
and the planned settle tween (dogfood: layout-settle-motion) will animate that reflow.)*
The spliced edges just span the gap. Node deletion is the one
destructive edit that earns a **toast** ("Step deleted · Undo", bottom-center, 6s, gold Undo
that calls `undo()`); everything else relies on being visible + ⌘Z. The ⌫ handler ignores
key events while an input is focused. Verified headless: delete splices children up, toast
shows, Undo restores the node + edges + unwinds the splice in one step.

## Editing: action bar + kind picker

Selecting a node raises the **action bar** (§6.1) — `scene/SelectionBar`, a DOM overlay (plain
buttons + callbacks, like AffordanceLayer) positioned above the node each frame: rename · kind ·
delete. It's the discoverable home for delete (was ⌫-only) and rename (was dblclick-only). The
kind button fans the palette **swatches** around the node (§8.2); clicking one commits
`setNodeColor` (one undoable step). Bar chrome is neutral; only the swatches carry hue. Verified
headless: select → bar; swatch → 5-chip fan; chip recolors (⌘Z reverts); trash deletes + toast.
Deferred polish: live hover-preview of a kind (§8.2) and the bar's rise animation.

## Editing: rename inline

Double-click a node → the inline field opens pre-filled with its label (editing-spec §8.1). The
`InputController` forwards `dblclick` → `Tool.onDoubleClick` → `ctx.beginRename(id)` →
`scene.onRenameNode(id, label, x, y)` (positioned at the label). It reuses the create name field
via a `namingModeRef`: `create` **amends** the just-committed node, `rename` **commits** a
`renameNode` as its own step only if the label changed; esc reverts. Verified headless:
double-click pre-fills, edit commits (count unchanged), ⌘Z reverts.

## Editing: connect + cycle guard

The ports are live (editing-spec §03) — the biggest structural gesture, and it spans the
DOM→canvas boundary, so it's its own class. `scene/ConnectGesture` (owned by `AffordanceLayer`,
started on a port `pointerdown` with capture): a dashed SVG ghost branch follows the cursor; the
node under it gets an olive ring (valid) or a brick ring + "would create a loop" tip (a cycle —
i.e. the target is one of the source's ancestors, walked from the parents map). Invalidity is
visible before the drop; a valid release → `scene.onConnectNodes` → `editor.commit(addEdge)`
(adds the source to the target's prerequisites — real multi-parent), one undoable step. Dropping
on empty/invalid just retracts. Verified headless: a valid drag adds the edge (⌘Z removes it); a
drag to an ancestor shows the brick ring + tip and adds nothing.

Deferred polish (not blocking): §3.2 fading *all* cycle-making nodes to 30% during the drag (a
GPU per-node dim flag) and the §3.3 target scale-up. The ring + tip already prevent cycles.

## Editing: branch hover chrome + delete edge

Foundation for edge editing (editing-spec §04–§05). `NavigateTool.onPointerMove` now also picks
the nearest branch when the cursor is off any node (`scene.pickEdge` — straight-segment distance
within `EDGE_PICK_RADIUS`), and `scene/EdgeChrome` fades a bark **midpoint ×** onto that branch,
offset perpendicular so the branch stays visible (§5.1). Clicking it commits `removeEdge` (silent,
one undoable step; the target keeps its other parents — removing an edge never deletes a node).
Grace window keeps the × reachable, same as the node affordances. Verified headless: hovering a
branch shows the ×, clicking it drops the edge (node count unchanged), ⌘Z restores.

The **unlinked** visual (§5.2: gold dashed ring + tag when a node loses its last branch) rides on
the deferred `bud-state` dashed treatment.

## Editing: reconnect an edge

`ConnectGesture` now serves both create and reconnect from one body: `start` pulls a new edge from a
rim port; `startReconnect(edge, movingEnd)` re-aims one end while the other stays pinned as the ghost
anchor. Same targeting, same cycle tip. Reconnect judges cycles against a `parentsWithout(old edge)`
copy, so dropping back on the original end is a clean no-op and every other drop is scored against the
pending shape. The two endpoint handles live on `EdgeChrome` (alongside the delete ×); pressing one
hands `(edge, end)` to the shared gesture via the scene. Drop on a valid node → `edits.reconnectEdge`
(removeEdge ∘ addEdge) as one undo step; the child keeps its other parents. Verified headless: dragging
the parent-end of product→domain onto renderer re-tethers domain to renderer, ⌘Z restores product.

Gotcha worth keeping: overlay chips that are re-placed every frame from the render loop must NOT put
`transform` in their CSS `transition` — the per-frame reposition then animates instead of snapping, so
the chip perpetually lags the cursor and never sits where a pointerdown lands. Handles/× transition
opacity only (the delete × was already correct; the handle had to drop its `transform` transition).

## Visual: bud + unlinked forms

A node now carries a structural *form* alongside its tier, derived (not stored) in `toRenderModel`
via `theme.nodeForm(label, parents, children)`: `bud` = a just-created, still-unnamed tip (blank
label, but linked); `unlinked` = a stray with neither parents nor children (a leaf whose last branch
was cut). Both surface as a dashed ring in the node shader — a new `aForm` instance attribute drives
an `atan`-segmented ring at r≈0.99: kind-hued for a bud, muted-toward-canvas + a lighter body for an
unlinked stray. The authored roadmap is all `linked` (every node named + attached), so the forms only
ever appear through the editing gestures — create → bud (clears when you name it), cut last edge →
unlinked (clears when you reconnect). Structural edits always re-run `setInstances`, so form updates
ride the normal sync; no incremental form path needed. Verified headless: created node = form 1,
its edge deleted = form 2, zero non-linked nodes on load.

The "reconnect me" **tag** on an unlinked node (design §5.2) is deferred — the dashed ring carries the
signal for now; a text tag can ride the label overlay later.

## Persistence: save & load

`persistence/TreeStore.js` is the whole feature — a thin localStorage gateway at the boundary. The
authored roadmap stays the source of truth; the store only overlays a browser's in-app edits between
reloads. Each saved entry is stamped with a **signature** of the seed it was edited from (a hash over
the authored fields — id/label/icon/color/status/prerequisites, not layout); on load, a mismatched
signature drops the stale edits, so editing `roadmapTree.js` cleanly wins over leftover browser state.
Persistence is best-effort (try/catch around every storage call) and demo-only (the 5k perf tree is a
throwaway). Every edit funnels through `persistEdits()` (called from `syncStructure` + node-move), and
a **Reset to authored** control (shown only when local edits exist) clears the entry and re-runs the
load pipeline via a `reloadKey` bump. Verified headless: create → stored + survives reload; reset →
back to 29 + entry cleared; a planted stale-signature entry is ignored (loads authored, no reset).

Note the pipeline change: `repo.loadProgress` now takes the resolved `treeData` (not a treeId) so
progress derives from the actual tree in play — the persisted edit, not the seed.

## Polish: live kind preview (§8.2)

Hovering a swatch in the kind fan now recolours the node live before you commit — `NodeBatch.setColor`
writes one instance's colour attribute (like `moveInstance`), the scene wires the fan's
`onPreviewKind`/`onRestoreKind` to it, and clicking still commits through `onSetKind`. No history for
the preview; leaving the chip restores the model colour (the pointer always leaves a chip before it
can click elsewhere, so leave-restore is enough). The commit's model rebuild supersedes the preview.

This fixed a latent bug in the fan itself: it positioned chips only via a cached `lastCamera`, which is
unset until the first render-loop overlay pass runs — so on a still camera the chips could stay stacked
at (0,0). Replaced with an `onDirty` callback the fan raises on open/toggle; the render loop then
repositions bar + chips with the live camera next frame. Same family as the transform-transition
gotcha above: overlay chrome must be driven from the render loop, never from a stale cached camera.

## v2 editing spec — selection-gated chrome + a docked step panel

Migrated the editing interactions from spec v1 to **v2** (`dag-editing-interactions-v2`). The
principle shift: affordances move from **hover-gated** to **selection-gated**, and editing chrome
consolidates off the canvas into one place.
- **Hover is calm again** (§1.1): hovering a node only scales/glows it and shows a name tooltip
  (`scene/HoverLabel`, inline-styled) — no plus, ports, or handles. Structural affordances
  (`AffordanceLayer` plus + ports) now appear on the **selected** node.
- **One docked step panel** (`ui/StepPanel`, §01) replaces the floating action bar, the kind fan,
  the inline name field, and the old `DetailPanel`: inline name edit, six kind swatches (live
  preview via `scene.previewKind`), prerequisites + Mark complete, and an isolated Delete at the
  bottom (hover dims the step via `scene.previewDeleteCost`). Creating a child spawns a **bud** and
  focuses the panel's name field (§2.2).
- **Edges are click-to-select** (§04): hover only deepens a branch (`ConnectorBatch.setHovered`) +
  a pointer cursor; a click selects the edge → handles + × on `EdgeChrome`. ⌫ deletes the selected
  edge, esc/click-away deselects.
- **Connect-drag cycle feedback** (§3.1): the whole cycle-closing set fades to 30%
  (`NodeBatch.setFaded`) for the drag; that same set is the cyclic predicate, so a faded node can't
  take the drop. `ConnectGesture.reachable` walks ancestors (create / reconnect-child-end) or
  descendants (reconnect-parent-end) on the pending graph — the two ends close loops differently.
- **Sixth kind `plum`** — the shader arrays + panel swatches size off `NODE_COLOR_NAMES`, so it was
  a one-line palette addition that propagated everywhere.

Integration seam worth remembering: **edge selection lives only in the scene** (there's no
`onEdgePick` to React), and node selection lives in React (`selectedId`). Two glue points close the
gap — a `selectedId → scene.setSelection` effect mirrors React deselects (Esc, the panel's ×) back
to the canvas so the affordance chrome doesn't get stuck on, and the ⌫/esc key handler reads
`scene.selectedEdge` to delete/clear a selected edge. `select()` notifies the shell; `setSelection()`
mirrors without echoing (an id guard keeps it idempotent so canvas picks don't double-fire).

Built in parallel by three Fable-5 subagents on disjoint file sets (palette/GPU · scene behavior ·
panel/view), each behind a pinned interface contract, then merged and integration-tested live.
Deferred (not blocking): §3.2 valid-target scale-up (olive ring only); §5.1 dimming a deleted
step's *branches* (needs a connector fade — only the node dims today); §2.2 esc-removes-bud (esc
reverts the name; an unnamed bud persists as a bud form).

## Observations / follow-ups (not blocking)
- **Three visual tiers over 4 model states.** `nodeTier` folds active+complete into
  `activated`; `UnlockRules` still keeps the finer states for `DetailPanel`. If we
  ever want completed to read differently from in-progress *in the tree*, that's a
  scene-only change (add a 4th tier + attribute) — the design's exploration
  deliberately shows three.
- **Glyph math is duplicated** — the GLSL glyph (`soft` when saturated, else
  `mix(canvas, base, 0.55)`) and the DOM `glyphCssColor()` in `NodeOverlay.js`
  (high-zoom live SVG). Keep them in step or the baked/live glyph disagrees at the
  LOD seam.
- **Outer-ring / glow radii are shader constants** (`OUTER_R`, `glowFalloff` reach,
  `QUAD_PADDING`). The padding must stay wide enough to contain the glow halo, or it
  clips at the quad edge.
- **Overlay pool assignment is by distance-rank, recomputed each frame** (`within` +
  sort → slice 64), shared by labels and icons via `NodeOverlay`. Now that it runs at
  60fps, a node crossing a rank boundary makes two pooled elements swap nodes mid-pan.
  Not visible in testing, but a stable nodeId→slot matching (keep in-view assignments,
  only reslot on enter/leave) would remove any residual shimmer and drop the per-frame
  sort — and would let both overlays share one query instead of two.
- **Web-Worker layout** — *(retired: dagre and the worker engine were deleted once the
  radial engine became the only one; it's synchronous, and the live path re-lays inline
  on every structural change. Resurrect a worker only if a measured tree makes inline
  layout janky.)*
- **Code-split** — routes are `React.lazy`; entry chunk is ~3 kB.
- **Reduced-motion** — a `uMotion` uniform freezes the pulse / snaps growth.
- **Re-validate 5k perf** on the new renderer (draw-call count is inherently 2 —
  one instanced node draw + one connector draw — but measure FPS at 5k).
- `SpatialGrid.nearest` scans the 3×3 cell block, so keep `cellSize ≥ pickRadius`
  (`NODE_SIZE*2` vs `NODE_SIZE*0.65`).
- Canvas clears opaque to the cream background; the CSS radial-gradient behind it is
  hidden. Could make the canvas alpha-blended to let it show through.

## Radial constraints initiative — keep any DAG clean (trunk → radial → tidiness)

Goal: lay out an arbitrary user DAG so it reads like a skill tree (areas consolidate,
edges stay low, an obvious center) AND nudge users toward cleaner, less cross-coupled
roadmaps. Thesis: make beauty and cleanliness the same axis — mess renders as visible
cost, not chaos, so users self-correct.

- **`model/TrunkTree.js`** — pure spanning-arborescence pass. Elects ONE trunk parent
  per node (same-kind preferred, else shallowest), derives `branchOf` (a branch = a
  maximal same-colour trunk run, cut at the centre or any colour change), `trunkDepth`,
  `leafCount`, and `edgeKind` (trunk / in-branch / cross-branch). Key fix during build:
  cutting branches only at the centre collapsed everything into 2 sectors — cutting at
  every colour change is what makes affinity sectors real.
- **`layout/RadialLayoutEngine.js`** — radial tidy tree over the trunk: radius = trunk
  depth, wedges split by leaf count. We tried promoting every branch to its own ring-1
  spoke (a forced mandala) — it read *more radial but clumpier*, so we reverted to the
  depth-keyed layout. Lesson: honour the graph's real fan-out; don't coerce a mandala.
- **Root emphasis via design, not layout** — a per-instance `emphasis` attribute in
  `NodeBatch`: the root renders ~1.55× larger, always breathes, and wears a crown ring.
  That gave the "obvious centre" without the clumpy spokes. Emphasis flags all roots
  (`prerequisites.length === 0`).
- **Edge demotion** — `ConnectorBatch` draws trunk bold, in-branch thin, cross-branch a
  faded chord (per-vertex `aKind` + width). Cross-area coupling literally recedes.
- **`model/TreeHealth.js`** — pure metrics: crossBranch, redundant (transitive-implied,
  O(V²) guarded above 1500 nodes), avgInDegree → a 0..100 tidiness score (cross-coupling
  weighted heavier than redundancy). Roadmap scores 83.
- **Push-toward-clean UX** — `TidinessBadge` (the score you nudge up), connect-gesture
  **cost hints** (amber ring + "Links across areas" / "Already implied", non-blocking),
  one-click **Tidy** (`transitiveReduction` in edits.js, gated on redundant>0), and
  clean-by-default create (new nodes inherit the parent's kind + spawn radially outward).
  Verified live: Tidy took the roadmap 83→87, redundant 3→0.

  > Retired 2026-07-18: the user-facing tidiness surface (`model/TreeHealth.js` score,
  > `TidinessBadge`, one-click Tidy) was removed as low-value. The backend transitive-
  > reduction / prune / health capability stays (MCP `tidy` / `prune` / `get_health`), as do
  > the connect-gesture cost hints and clean-by-default create.
- **Follow-ups**: huge (5k) crowds at outer rings under pure radial (ring spacing /
  angular padding needed); cost-hint tip still uses the brick colour (could go amber to
  match its ring); root visual is a first pass (user will refine).

## Activity feed — the event log for the tree canvas (design: event-log-options)

Shipped the design's recommended placement — **A (docked feed) + C (arrival toasts) +
F (node pulse) + A′ (dock coexistence)**. Before this the app recorded nothing; now every
completion/edit leaves an actor–verb–object trace.

- **Feature package `activity/`** (grouped by kind, per CLAUDE.md). `ActivityLog.js` is pure
  domain: `ActivityEvent` snapshots its object's label+kind so a row still renders (struck
  through) after the node is deleted, while live rows resolve the object from the current
  tree by id; `ActivityLog` answers `record` / `recent` / `forNode` / `groupedByDay`, and a
  static `fromTree(tree, states, now)` seeds the resting feed from the roadmap's build
  history. `grammar.jsx` is the one presentation grammar every surface speaks (VERB_STYLE,
  `relativeTime`, `ActorAvatar`, `ObjectLabel`, `EventSentence`) — the feed rows, the step
  panel's History, and the ticker all compose from it, so a verb reads the same everywhere.
- **The dock has two tenants now (A′).** `SkillTreeView` renders `ActivityFeed` at rest and
  `StepPanel` on selection inside one `.st-dock-tenant` (keyed so the swap replays a fade-
  rise), same 360px width — the canvas is an absolute layer beneath, so the swap causes zero
  reflow. Deselect always returns to Activity. The panel's new **History** section is the
  same feed filtered to one node (`forNode`) — one row component, two scopes.
- **Events emit at the real seams** through one `emit()` helper: completed (+ the unlocks it
  causes, attributed to the tree), started (new Start action lifts `inProgress` into React
  state), added, renamed (only when the old label was non-empty — naming a fresh bud is part
  of the add), removed (snapshot before delete; no toast/pulse, the Undo toast already
  speaks). `emit` also plays the arrival: the node pulses, a ticker toast announces it, the
  fresh row flashes.
- **Felt on the graph first.** Three thin renderer additions, each mirroring an existing
  per-instance-attribute pattern: `NodeBatch.aPulseStart` + a decaying double-bump shader
  envelope (`pulseNode`), `ConnectorBatch.aDim` + a recede branch (`setSpotlight`, so a
  hovered feed row lights its node's branches and dims the rest), and `Camera2D.glideTo` (an
  eased reveal so a clicked row flies the camera without touching selection). The scene
  exposes `pulseNode` / `spotlightNode` / `revealNode`; row hover ↔ graph is two-way (a
  hovered fruit lights its rows via `hoveredId`).
- **Demo-only**, like the tidiness badge — the 5k perf tree seeds an empty log and shows no
  feed at rest. The feature is dogfooded as a node in `roadmapTree.js`, so it also appears in
  its own seeded history.
- **Deferred**: narrow-viewport collapse to E's bell; ticker burst-coalescing ("completed 3
  steps"); the terracotta focus-ring on reveal; undo/redo reconciling the append-only log (a
  create-then-undo leaves a row whose node is gone — it renders muted, which is acceptable).

### A″ — summoned, not docked-by-default (design update)

The doc's verdict moved from "A docked-by-default" to **A″ — the panel, summoned**: closed by
default so the canvas runs full-bleed, opened on demand. Same feed, new resting state.
- **The dock is now gated on a summon state** (`feedOpen`) instead of always-open. A labeled
  **Activity chip** in the toolbar (`ControlBar`) toggles it; the panel was already an absolute
  slide-in overlay, so "open = zero-reflow overlay" needed no layout change. A **pin** in the
  feed header (`pinned`) keeps it docked — pinned mode *is* the old option A.
- **Closed ≠ deaf.** `emit` still fires the toast + node pulse while closed; when the feed
  isn't the watched tenant it adds the event to `unseenIdsRef`, bumps the chip's unread badge,
  and pings the chip. Opening (or returning to the feed from details) runs `markRead`, which
  clears the badge and re-flashes the unseen rows — E's catch-up, folded into `newEventIds`.
- **A′ rules intact.** Selecting a fruit swaps the overlay to details regardless of feed state;
  deselecting returns to the feed **only if it was open** (`feedVisible` keys off `feedOpen ||
  pinned`, independent of selection — no `wasOpen` bookkeeping needed). An empty-canvas click
  with the feed showing dismisses it (the `onNodePick(null)` branch); with details open it
  closes details first.
- **Keyboard:** `a` toggles, `esc` closes (after selection/edge). The `rotate-ccw` reset icon
  (a pre-existing unregistered-icon warning) got registered while adding the chip.
- Gotcha for future live-testing: React refs (`selectedIdRef`, `feedOpenRef`) update in an
  effect *after* render, so driving `select(id)` then `onNodePick(null)` in one synchronous tick
  reads a stale ref and mis-fires the empty-click branch. Real interactions render between the
  two, so it only bites synchronous test scripts — drive them as separate steps.

## Motion language (X1) — the beats, composed

Aligned every animated moment to `guidelines/motion-language.md` (X1): one grammar,
`camera ease -> travel -> bloom -> pulse -> toast`, composed one ceremony at a time.

- **Tokens** (`styles/tokens/motion.css`): added `--duration-beat: 320ms` and the DOM
  approximations `wm-bloom` / `wm-pulse-echo` / `wm-pulse-node`. Easings were already the
  canonical `--ease-soft/standard/glow`.
- **Beats live on the GPU.** `NodeBatch` gained `igniteNode(id, at, toTier, {durationMs,
  blossom})` — a per-instance `aBloom` (start, fromTier, durSec, blossom) the shaders read for
  a 280ms tier cross-fade, a 1.02/1.045 scale settle, and the +80ms blossom halo overshoot.
  Only the crown breathes now (2400ms, + satellite ring) — every other activated halo is static
  (a .28); `pulse` retuned to the x2 decaying echo. `ConnectorBatch.travel(from, to, at,
  {durationMs})` runs a comet head (white-hot front + 24px exp tail) with length-derived
  duration (540 wpx/s, clamp [180,420]); `edgeDuration()` lets the director time the 0.85
  handoff. `Camera2D.glideTo` now self-gates on the 80% safe frame, picks 480/600/720 by
  distance, eases on a real `cubic-bezier(0.16,1,0.3,1)` sampler, and exposes
  `settleProgress()` for DEPEND_AT.
- **`ceremony/CeremonyDirector.js`** is the composer — pure sequencing, no GL state, reaches
  growth only through injected batches/camera + a toast sink + a seconds clock + a motion flag.
  `SkillTreeScene.applyStates` now DIFFS states into a changeset (risen/fell/litEdges/frontier/
  focus) and hands upward growth to `director.celebrate`; downward changes just dim (280ms).
  The first push after a fresh model paints silently (baseline seed). Any canvas grab
  (`InputController.onInteract -> director.yieldToInput`) fast-forwards the live beats over
  150ms; the toast still speaks. Reduced motion collapses to 150ms cross-fades, no glide/pulse.
- **Toast is the last beat.** `handleMarkComplete` hands its summary to `scene.announceCeremony`;
  the director speaks it +120ms after the structural beats settle (not up front). Ceremony
  completed/unlocked events stay off the stacking ticker (one summary replaces them).
- **Gotcha (cost a real bug):** a hidden control character had leaked into the director's
  edge-key template literal while `buildChangeset` keyed on a space — the handoff-wake lookup
  silently missed, so children ignited at t=0 instead of when the light lands. Caught only by a
  deterministic director harness (fake collaborators asserting beat order/timing), not by the
  build. Both key-generators now use an explicit `|`. Lesson: verify the *sequence*, not just
  that it compiles.

## X2 share identity — the artifact that leaves the app

Built the share surface (`share/`) to the design system's `share-identity.html` spec: one
frame recipe (mat + kind rule + tree portrait + progress readout + terracotta wordmark)
behind the OG card, the PNG, the gallery thumb and the GIF.

- **SVG portrait over WebGL capture.** The tree exports as a deterministic SVG built from the
  `RenderModel` (`TreePortrait`), not a grab of the live GL canvas. The spec needs *light and
  dark* frames at *four* geometries; the renderer is light-only and sized to the viewport, and
  a read-back would need `preserveDrawingBuffer` + an offscreen fit-camera pass. A portrait
  from the model is pure, resolution-independent, themeable, and matches the mockup's own
  technique. Fidelity note: it re-draws the tree (same `theme.js` hues/glow/crown) rather than
  being pixel-identical to the GPU frame — a GL raster could later drop into the same panel
  rect without touching the frame recipe.
- **The preview IS the export.** One Canvas2D compositor (`exportImage`) paints the whole
  postcard; the dialog shows that canvas and downloads that canvas. No second render path, so
  preview and posted image can't drift — the same discipline as "a paused GIF is the share
  image."

  > Retired 2026-07-18: the image export (`ShareFrame`, `exportImage`, the PNG/GIF preview)
  > was removed — the share surface is a link now (`ShareDialog` copies the URL + flips
  > visibility). `TreePortrait` + `ShareStats` stay (gallery card + stats readouts); the
  > OG/unfurl card is a static asset.
- **`ctx.font` can't parse `var()`.** Canvas2D silently falls back to 10px sans-serif on a CSS
  custom property, so the compositor reads `--font-display/body/mono` off the document root and
  awaits `document.fonts.ready` before any `fillText`. (Fonts render right; the one deviation
  from the spec's literal `var()` in `ctx.font`.)
- **Dominant kind ties to terracotta.** A *shared* maximum among done kinds — not just an empty
  tree — resolves to the brand hue, so the frame never picks an arbitrary winner. Caught in
  review: a naive KIND_ORDER-first compare would have returned olive for an olive/gold tie.
- **Gotcha (tooling, not code):** the extension's screenshot/`read_page` wait for the page to go
  *idle*, which never happens on this continuously-animated app (rAF + the WebGL loop) — every
  capture timed out. `Runtime.evaluate` (`javascript_tool`) runs between frames, so verification
  went through the DOM + reading the exported canvas's pixel buffer directly (mat white, rule =
  terracotta 188,108,66, strip text + gradient + wordmark present, light *and* dark) rather than
  a visual diff. Lesson for this repo: verify animated surfaces by evaluating in-page, not by
  screenshot.
- **Parallel build.** Foundation (palette/stats/frame recipe) authored first as the seam, then
  three agents fanned out on disjoint files — portrait / export+dialog+wiring / gallery+showcase —
  against a written contract. Integration was clean (no file collisions); the only reconciliation
  was confirming shared primitives (`Button` variants, shadow tokens) the surfaces leaned on.
- **Open / deferred:** true animated-GIF encoding (#14) is not shipped — there's no encoder dep,
  and browsers can't natively encode GIF. What ships: the intro title-card frame + the final
  frame (≡ the PNG) as a filmstrip in the dialog, and the reduced-motion path (the static PNG).
  `share-gif` stays `active` in the roadmap log until a real encoder lands.
