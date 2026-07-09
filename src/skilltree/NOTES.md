# Skill-tree — build notes & observations

Built by four parallel agents against the contracts in `ARCHITECTURE.md`, then
integrated and verified live in a browser. Status: **working end-to-end.**

## Verified (live, `npm run dev`)
- Loads clean — no console/WebGL errors, shaders compile, real pipeline runs
  (repository → `SkillTree` → `UnlockRules.derive` → `applyNudges(layout)` →
  `toRenderModel` → `scene.setModel`).
- Picking works end-to-end (camera → world → `SpatialGrid.nearest`): a `pick()` at a
  node returns its id, at empty space returns `null`.
- Click opens the detail panel; **Mark complete** flips the node's GPU `aState` to
  `complete` and grows its outgoing connector.
- **DAG diamonds are correct**: completing one of a node's prerequisites leaves it
  `locked` until *all* prerequisites complete (validated on a real 4-prerequisite merge).
- **Performance target met**: at **5,000 nodes → 2 draw calls** (one instanced node
  mesh + one merged connector mesh), 2 shader programs, constant vs node count. Labels
  are pooled (≤64) and add ~5 calls only when zoomed past the LOD threshold.

## Bug fixed during integration
- `NodeAtlas` baked the 2×2 fruit atlas with three's default `CanvasTexture.flipY = true`,
  but `nodeShader` samples cells top-left-origin. That inverted V and swapped the atlas
  rows (locked↔active, available↔complete) — every node showed the wrong fruit color.
  Fixed by `texture.flipY = false` (also corrects the within-cell highlight orientation).
  A draw-call/FPS harness with random states can't catch this — only a visual/state read does.

## Follow-up pass (done, verified live)
- **Web-Worker layout** — `WorkerLayoutEngine` + `layout/dagre.worker.js` run dagre off
  the main thread, so the 5k toggle no longer freezes the UI. `LayoutEngine.layout` may
  now return a `Promise`; `DagreLayoutEngine` (sync) is kept for node tests.
- **Code-split** — both routes are `React.lazy`; three+troika are a lazy `three` chunk and
  React a vendor chunk, so the entry is ~3 kB and first paint no longer waits on WebGL.
- **Reduced-motion** — a `uMotion` uniform on both materials, driven by
  `prefers-reduced-motion`, freezes the glow pulse and snaps branch growth.

## Observations / follow-ups (not blocking)
- **`dagre` ranker matters**: default `network-simplex` was 100+s on diamond-heavy DAGs;
  `longest-path` is ~2.3s and agrees with `SkillTree.ranks()`. Don't revert it.
- **Nodes carry no icon glyph in the scene** (atlas is body+ring only) — a deliberate
  trade for 5k. A zoomed-in icon LOD (a second atlas or per-visible-node sprites) would
  add polish without hurting the far-view draw-call count.
- **Minimap redraws all nodes on every viewport change** (throttled ~100ms). Cheap at 5k
  but wasteful; split the static node layer from the moving viewport rect if it grows.
- **Remaining bundle note**: the `three` chunk is ~623 kB (three + troika) — inherent to
  three.js, now isolated in its own long-cached chunk and loaded only on the tree route.
- `SpatialGrid.nearest` only scans the 3×3 cell block, so it's correct only while
  `cellSize ≥ pickRadius`. The scene uses `cellSize = NODE_SIZE*2`, `pickRadius = NODE_SIZE*0.65`
  — keep that invariant if either constant changes.
