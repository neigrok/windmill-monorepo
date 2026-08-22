# Roadmap — build notes & observations

**This file is a log, not a spec.** It records what each wave found and decided, in the
words that were true when the wave shipped, and it is not rewritten as the code moves on.
For how the package works *today*, read `ARCHITECTURE.md` — where the two disagree about
the present, ARCHITECTURE.md is the maintained one.

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
undoable. (Written when it was true; undo moved to `SyncSession`, which banks each gesture's
inverse, and `editing/TreeEditor` is now a bare holder for the present TreeData. `edits.js`
is gone — `sync/materialize.js` is its successor. `ARCHITECTURE.md:275` has the live account.)
`editing/TreeEditor` holds the present TreeData + undo/redo stacks; edits are pure
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
  static `fromTree(tree, states, completedAt)` seeds the resting feed from the roadmap's
  build history, dating each seeded completion from this device's own completion stamp —
  a deed we hold no stamp for is undated (`at: null` → "Earlier", no relative time) rather
  than given a plausible-looking made-up instant, which is what the seed used to do (one
  synthetic completion every 2.6h back from load: order right, dates invented and re-invented
  on every reload). `grammar.jsx` is the one presentation grammar every surface speaks (VERB_STYLE,
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

## Desktop edge multi-select (extends node multi-select)

- **Two sets, two size≤1 projections.** The selection is now `selectedIds` (nodes) **and**
  `selectedEdges` (edge keys). `selectedId` and `scene.selectedEdge` are their projections, and
  `reconcileProjections(nodeSet, edgeSet)` is the single pure function that derives both: a lone
  node shows its StepPanel, a lone edge shows its EdgeChrome, and any **total** above one hides
  both — only the floating bar + GPU highlights remain. Every entrance (shift-click node/edge,
  marquee, ⌘A, plain click, Esc, bulk-delete) reconciles through that one function, so the two
  chromes can never both show at once and single-node/single-edge stay byte-identical.
- **An edge's key is its (from, to) pair.** A node is its own id; an edge has none, so
  `scene/edgeKey.js` folds the ordered endpoints into one string key (NUL separator, which no id
  contains) and back. It's the *one* shared definition — React selection state and the
  ConnectorBatch highlight both import it, so they can't drift on what "this edge" means.
- **The GL highlight cloned the `dim`/`setSpotlight` per-vertex pattern.** A new per-vertex
  `aSelected` float buffer; `setSelectedEdges(keySet)` sweeps every edge (1 if its key is in the
  set) in one upload, never per frame — exactly like `setSpotlight`'s `dim`. The fragment brightens
  a selected branch toward white + an additive kind-hue lift + near-full opacity (last say, so it's
  never dimmed). Geometry width is baked per-vertex, so a shader can't *thicken* the ribbon — the
  brighten/glow is the on-brand stand-in, distinct from hover's hot-hue deepen.
- **Seam decided: single-edge selection stays scene-owned (dual representation).** A *plain* edge
  click still goes `NavigateTool → ctx.selectEdge → scene.selectedEdge`, byte-identical; only
  *shift*-click populates React's `selectedEdges`. The one gap that opens — plain-clicking a new
  edge while a multi-edge selection lingers — is closed by a new `onEdgePick` (fired from the
  tool's `selectEdge` hook, never from internal `selectEdge(null)` clears), which resets the React
  sets so the scene-owned lone edge is the only truth. The shift-branch lives in NavigateTool's
  **marquee no-drag** case (shift-press already enters marquee mode), beside the node toggle.
- **BulkDelete already spoke edges.** `materialize`'s `BulkDelete` case reads `g.edges` as
  `[{from,to}]` and `removeEdge`s any whose endpoints both survive (skipping ones a tombstone
  already takes). Both paths were untested (v1 always passed `[]`); now pinned by two tests.
- **Mixed-selection reconciliation (adversarial-review fixes).** The nodes-only path never
  exercised "some nodes AND some edges at once"; three desyncs surfaced there:
  - *A reconciler must not route through a user-pick verb.* `reconcileProjections` drives the
    edge projection through **`projectEdge`** (a pure setter: `selectedEdge` + EdgeChrome, nothing
    else), NOT `selectEdge`. `selectEdge`'s node-clear cascade reads `scene.selectedIds`, which the
    post-render sync effect updates a beat later — so dropping the node from a mixed selection would
    fire the cascade off the *stale* set and wipe the still-selected edge. `selectEdge` keeps its
    side effects for the one caller that wants them: a genuine plain edge pick (clears any node).
  - *The node GL highlight is the SET, not the projection.* In the editor `refreshHighlight` /
    `applyModel` now always `setSelectedSet(selectedIds)` — a mixed selection has one node with
    `selectedId===null`, and the old `setSelected(selectedId)` blanked it. Read-only keeps the
    single-`selectedId` path (setSelectedSet no-ops there). `setSelected`/`setSelectedSet` are each
    full buffer rewrites, so routing single-select through the sweep leaves no stale slot.
  - *Every delete path must clear its own set.* The lone-edge Delete now clears `selectedEdges` +
    `projectEdge(null)`, mirroring how the lone-node Delete clears via `setSelectedId(null)`.
  - Verified end-to-end: shift-edge → shift-node → shift-node-off leaves the lone edge intact;
    mixed lights node + edge together; Esc clears both; plain-click a node drops a lingering
    multi-edge set; lone-edge Delete empties the set. Known pre-existing (nodes too, out of scope):
    a *remote* structural delete of a selected item prunes the scene's copy but not the React set,
    so the bar can over-count until the next selection change.

## Wave 2 — the week card's offer, labelling and sheet (brief #20 · canon C5–C8)

- **The offer moved from a budget to a rhythm.** Wave 1 asked after a completion, metered by
  "≥3 new steps or 7 days, at most every 3 days" — three numbers nobody can feel. Canon replaces
  all of them with the tree's own planting anniversary: one ask per seven-day period, on the first
  open after one closes. The budget arithmetic simply deleted itself, which is the tell that the
  rhythm was the right axis: `considerProgressShare` now reads as five refusals and a return.
- **A decline needs no button.** "Two declines in a row retire it" sounds like it needs a No, but
  an offer that is COUNTED as declined the moment it goes out (`commit()`) and cleared when taken
  (`accept()`) gets the same answer from a faded toast, a closed tab and an ignored week — and
  survives a reload for free, since the count lives in the same slot as the period stamp.
- **The recap's last beat was already a seam.** `CeremonyDirector` ends every ceremony — recap,
  arrival, growth — on `speak(summary)`, which reaches the shell through the single
  `onCeremonyToast` sink. Wrapping that sink (`speakCeremony`) is the whole hook: no scene API
  changed, and the offer follows the beat by 120ms instead of racing it. The hole is the phone
  LIST, where a paused scene speaks no growth ceremony; a 2600ms cap (past the director's 2400ms
  structural budget) fires the armed offer there. It was first written as "no ceremony ever speaks
  under the list" — false: the ARRIVAL is scheduled by setModel before the scene pauses, and its
  timers speak it once, at ~+2.8s, 230ms after the cap had already fired the ask; the toast replaced
  the ask and the ledger read declines:1 for a line nobody saw (2026-08-05). So the cap now asks the
  director (`busy()`: live or pending) before it closes and stands aside, bounded, while a ceremony
  is coming (`share/weekOfferGate.js`). Worth remembering that "the scene is paused under the list"
  keeps surfacing as the exception to anything hung off ceremony timing — and that a paused scene's
  director is NOT idle.
- **Two doors, one set of facts.** The offer and the share menu both open the same sheet, so the
  week is DERIVED in one memo (`weekSegment`) rather than stashed when the offer fires. The offer
  path only accepts, pre-renders and opens. A second copy of "what this week holds" behind the
  offer's door is exactly how the toast and the card would eventually disagree.
- **`sinceAt` is a moment, not a sentence.** `newThisPeriod` first returned the sub-line string
  ("week 3"), which broke the instant the Week/Day segment flipped — the label depends on a choice
  made at the edge. Returning the timestamp and naming it with `sinceLabel(…)` at the two places
  that print it keeps one counter behind "Week 5" and "since week 3".
- **A tick is a claim the user already made.** The ledger's first cut derived per-period deltas from
  the local `completedAt` map, and that was wrong in the way this whole brief exists to avoid: those
  stamps are written only by completions made in THIS browser, so a week worked on a phone and posted
  from a desktop would publish as a quiet tick — a false claim about the user's week, in their voice,
  to their followers. #20 says "since I last shared" rather than "this week" for exactly that reason.
  The row is now rebuilt from `ShareLedger`'s history of what each POSTED CARD stamped: a period with
  a card takes that card's own number (so the row can never contradict a published picture), a period
  without one takes the floor tick (which is what canon's quiet period already means). Post every
  period and it is byte-for-byte canon's intent; skip one and it stays truthful instead of guessing.
  The general lesson: **a device-local clock can support an omission, never an assertion.** The one
  remaining `completedAt` read (a first-ever card's period-start baseline) survives only because it
  omits — it under-lights a card rather than claiming a period was empty.
- **A rule's stated justification is a precondition to check, not decoration.** "Two declines retire
  it — the share menu keeps the card for anyone who changes their mind" is only safe where that menu
  exists. It does not on a phone (the chrome carries no Share door), where the offer toast is the
  only door — so two fading toasts would lock a phone owner out of their own week card forever.
  `commit({ countsAsDecline })` makes the caller vouch for the second door; the phone spends its
  period ask without ever counting it. Worth grepping other "safe because X exists" rules for the
  same gap.

## Mobile canon, wave 1 (X8 §1 · §5 · §6 · §10)

- **A model that returns a thing twice will be rendered twice.** `buildOutline` put the branch head
  at `rows[0]` AND named it `section.head`; `ListView` dutifully drew both — a fold header and a
  checkable row, same node, two affordances, on every section of every tree. The shape was the bug:
  the head is the section (canon §2), so it must appear in exactly one place in the model. Rows are
  now what hangs BENEATH a head, and the head is rendered once — as a row carrying the fold and the
  branch tally. **When a value is reachable by two names, one render will use each.**
- **A floating control cannot be cleared by a scroller that can't see it.** The list padded its
  bottom only while a keyboard was up, so the Tend bar and its starter chips sat on live rows with
  no way to scroll them clear — and the numbers that would have fixed it (`pillLift`'s `216`, `300`,
  `18 + 50 + 12`) were already hand-arithmetic about controls the list never measured. The lane is a
  real element now (`ActionLane`): it seats the pill, the Tend bar and Share, measures from its own
  top edge to the bottom of the screen, and reports that. The list ends its scroller there. A tenant
  can come and go (the starter chips only exist while the bar is idle and empty) and the clearance
  follows for free. **Anything that overlaps a scroller should publish its own height, never let the
  scroller guess it.**
- **Padding clears a rest position; only a shorter box clears every position.** The list first
  PADDED its scroller by the lane's height, which only promised the LAST row would sit clear — every
  other row still slid under the pill on the way there, and at 375×812 the centre of a fully visible
  mark-done seat hit-tested to the view pill at 21 of 31 scroll offsets (a tap to mark done flipped
  the view). Now the scroller's box ENDS at the lane's top (`margin-bottom: var(--lane-inset)`), so
  no row exists under a lane button at any offset, and only the keyboard's cover of that shorter
  box is padded inside (`scrollerClearance` in `list/editing.js`). **A floating control over a
  scroller must be cut OUT of the scroller's box, not padded past — a seat is tappable as the seat
  or is not on screen.**
- **Three affordances on one line need three elements.** Making the fruit the check-off control
  (§6) was impossible while the row line was itself a `<button>` — a button inside a button. The row
  is now a carrier div holding a seat (fruit, 24px visual in a 44px pseudo-element hit), an opener,
  and the fold; the swipe/hold pointer stream still rides the carrier, so the gesture work is
  untouched. **Nesting is the tell: if a new control can't be added without nesting interactives,
  the container was doing two jobs.**
- The `commit({ countsAsDecline })` precondition from the entry above is now MET: the action lane's
  right slot is the phone's standing Share door, so the guard is gone and every surface counts a
  faded offer as a decline. The parameter stays — it is the next doorless surface's honest escape.
