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
- `SpatialGrid.nearest` scans as many cells as the radius reaches, so the screen-px hit floors
  (24 px pointer / 44 px touch, divided by zoom) stay correct at any zoom; the cost is one tap or one
  throttled hover, never a frame.
- The icon pool is assigned by distance-rank recomputed each frame (`within` + sort → slice 64). An
  icon crossing a rank boundary makes two pooled elements swap nodes mid-pan. Captions are not pooled
  that way: an element stays with its node id while the caption is on screen.
- A caption's visibility is the `st-label--shown` class (opacity + visibility), never `display`; a
  probe that counts `display !== 'none'` counts every pooled element that ever carried text. Count
  captions by computed visibility.
- Chrome insets reach the camera and the captions as numbers from view state
  (`ui/viewport.js viewportInsets`), never by observing the DOM; a new overlay that covers the canvas
  adds its px there.
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
- Icon slot assignment could be stable per nodeId the way caption elements already are (reslot only
  on enter/leave), removing the per-frame sort and any residual shimmer.
- Below a 4 px projected body no anchor is named, so at the dogfood tree's whole-tree fit (body 2 px,
  drawn at the 6 px floor) only the selected and hovered dots carry a name. Keying the tier on the
  floored body instead would name crowned roots and branch heads at All steps — a contract call.
- On a phone the anonymous owner's "Saved on this device" chip (`SkillTreeView.jsx`, top
  `--space-6 + 52px`, right `--space-6`) and `MobileChrome`'s Focus · All steps group (top
  `SAFE_TOP + 48px`, right 12px) share the top-right band and can overlap; the rig signs in, so no
  capture shows it.
- `quests/QuestThumb.jsx` and `paste/GhostSkeleton.jsx` construct `RadialLayoutEngine` directly; when
  the default engine changes they must go through `layout/index.js` or thumbnails and ghosts drift
  from the canvas.
- A remote structural delete of a selected node or edge prunes the scene's copy but not the React
  set, so the multi-select bar can over-count until the next selection change.
- Undo/redo does not reconcile the append-only activity log: a create-then-undo leaves a row whose
  node is gone. It renders muted.
- The "reconnect me" tag on an unlinked node is not built; the dashed ring carries the signal.
- Ticker burst-coalescing ("completed 3 steps") and narrow-viewport collapse of the activity dock are
  not built.
