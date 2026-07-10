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
layer. Flow: hover → `AffordanceLayer` plus click → `scene.onCreateChild(parentId)` → the view
spawns a child just below the parent (`addChildNode`, inheriting the parent's kind, a
`position` override so nothing else re-lays-out) as an **uncommitted draft** (`draftRef`) and
opens an inline `<input>` over it. ↵ commits `addChildNode` with the name as **one** history
step; esc/blank discards the draft with no history entry. So `syncStructure` renders
`draftRef ?? editor.treeData`. The new node's tier falls out of UnlockRules like any other
(child of a done node → available). Verified headless: create adds one node (inherits kind,
tethered, positioned), and ⌘Z removes it.

We adopted the design's **always-editable** model (§01A, the recommended one): no mode toggle —
hover shows affordances, click opens detail, drag moves, the plus creates. That's why `edit-mode`
is marked complete. The dashed **bud** visual (§02.2) is deferred to the `bud-state` slice; for
now a created node uses the normal not-done treatment while it's named.

Grace window: the plus lives outside the disc, so the affordance layer keeps chrome alive for
~260ms after the pointer leaves the node (cancelled when the pointer reaches the plus/ports),
and `pointer-events` flip to `auto` only while shown.

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
- **Web-Worker layout** — dagre runs off the main thread (`WorkerLayoutEngine` +
  `layout/dagre.worker.js`); the 5k toggle doesn't freeze the UI.
- **Code-split** — routes are `React.lazy`; entry chunk is ~3 kB.
- **Reduced-motion** — a `uMotion` uniform freezes the pulse / snaps growth.
- **Re-validate 5k perf** on the new renderer (draw-call count is inherently 2 —
  one instanced node draw + one connector draw — but measure FPS at 5k).
- `SpatialGrid.nearest` scans the 3×3 cell block, so keep `cellSize ≥ pickRadius`
  (`NODE_SIZE*2` vs `NODE_SIZE*0.65`).
- Canvas clears opaque to the cream background; the CSS radial-gradient behind it is
  hidden. Could make the canvas alpha-blended to let it show through.
