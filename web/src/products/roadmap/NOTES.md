# Roadmap — notes

Live gotchas and open items for `web/src/products/roadmap/`. How the package works is
`ARCHITECTURE.md`; this file is only the things that bite.

## Rendering and overlays

- Verify actual pixels on screen, not proxy signals (draw-call counts, picking logic, "it compiles").
- Verify animated surfaces by evaluating in-page (`Runtime.evaluate` / `javascript_tool`), never by
  screenshot: the extension's screenshot and `read_page` wait for an idle page, which never comes
  under the perpetual rAF loop.
- Never route a per-frame value and a React-state value through one throttled callback.
- Overlay chrome is positioned from the render loop with the live camera, never a cached one: a
  cached camera is unset until the first overlay pass, so on a still camera chips stack at (0,0).
- An overlay element re-placed every frame must not put `transform` in its CSS `transition`, or the
  reposition animates instead of snapping and the element never sits where a pointerdown lands.
- Glyph colour math is duplicated: the GLSL branch in `NodeBatch` and `glyphCssColor()` in
  `NodeOverlay.js`. Keep them in step or the baked and live glyphs disagree at the LOD seam.
- `OUTER_R` / `QUAD_PADDING` must stay wide enough to contain the glow halo or it clips at the quad edge.
- `SpatialGrid.nearest` scans the 3×3 cell block, so keep `cellSize ≥ pickRadius` (`NODE_SIZE*2` vs
  `NODE_SIZE*0.65`).
- The overlay pool is assigned by distance-rank recomputed each frame (`within` + sort → slice 64),
  shared by labels and icons. A node crossing a rank boundary makes two pooled elements swap nodes
  mid-pan.
- The canvas clears opaque to the cream background, so the CSS radial-gradient behind it is hidden.
- Reduced motion rides one `uMotion` uniform: the pulse freezes and growth snaps.

## Ceremony and timing

- The scene is PAUSED under the phone list, and a paused scene's director is not idle — the arrival
  is scheduled by `setModel` before the pause and its timers still speak. Anything hung off ceremony
  timing must ask the director's `busy()` (live or pending), not assume silence.
- Beat order and timing are caught only by a deterministic director harness with fake collaborators.
- React refs update in an effect after render, so driving `select(id)` then `onNodePick(null)` in one
  synchronous tick reads a stale ref and mis-fires the empty-click branch. Drive test scripts as
  separate steps.

## Honesty rules that constrain the code

- A device-local clock can support an omission, never an assertion. `completedAt` is written only by
  completions made in this browser, so it may under-light a card but must never claim a period was
  empty. Anything a reader sees dated comes from the server's `markedAt` receipt.

## Shape rules

- A model that returns a thing twice will be rendered twice. When a value is reachable by two names,
  one render will use each.
- Anything that overlaps a scroller publishes its own measured height; the scroller never guesses it.
- A floating control over a scroller must be cut OUT of the scroller's box (`margin-bottom`), not
  padded past: padding clears only the rest position.
- If a new control cannot be added without nesting interactives, the container was doing two jobs.
- A reconciler must not route through a user-pick verb. `reconcileProjections` drives the edge
  projection through `projectEdge` (a pure setter), not `selectEdge`, whose node-clear cascade reads
  a set React updates a beat later.
- The node GL highlight is the SET, not the projection: the editor always calls
  `setSelectedSet(selectedIds)`, because a mixed selection has one node with `selectedId === null`.
- Every delete path clears its own selection set.

## Open

- Re-validate 5k-node perf (draw-call count is inherently 2; measure FPS).
- Overlay slot assignment could be stable per nodeId (reslot only on enter/leave), removing the
  per-frame sort and any residual shimmer, and letting labels and icons share one query.
- A remote structural delete of a selected node or edge prunes the scene's copy but not the React
  set, so the multi-select bar can over-count until the next selection change.
- Undo/redo does not reconcile the append-only activity log: a create-then-undo leaves a row whose
  node is gone. It renders muted.
- The "reconnect me" tag on an unlinked node is not built; the dashed ring carries the signal.
- Ticker burst-coalescing ("completed 3 steps") and narrow-viewport collapse of the activity dock are
  not built.
