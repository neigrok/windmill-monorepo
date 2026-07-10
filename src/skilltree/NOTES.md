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
- `LabelOverlay.js` — pooled DOM labels over the canvas, LOD-gated by zoom (crisper
  and simpler than SDF text).
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

## Observations / follow-ups (not blocking)
- **Label pool assignment is by distance-rank, recomputed each frame** (`within` +
  sort → slice 64). Now that it runs at 60fps, a node crossing a rank boundary makes
  two pooled spans swap nodes mid-pan. Not visible in testing, but a stable
  nodeId→slot matching (keep in-view assignments, only reslot on enter/leave) would
  remove any residual shimmer and drop the per-frame sort.
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
