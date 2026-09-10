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
- `SpatialGrid` reaches every cell a query covers, so the screen-px hit floors (24 px pointer / 44 px
  touch, divided by zoom) stay correct at any zoom — but a query asking for more cells than the grid
  holds walks the nodes instead. Without that bound a single caption pass at the whole-tree fit sweeps
  the whole query box: ~126,000 cells for the dogfood tree's 476 nodes, tens of millions on a
  5,000-step radial tree, whose bounds are 459k wu.
- The icon pool is assigned by distance-rank recomputed each frame (`within` + sort → slice 64). An
  icon crossing a rank boundary makes two pooled elements swap nodes mid-pan. Captions are not pooled
  that way: an element stays with its node id while the caption is on screen.
- A caption's visibility is the `st-label--shown` class (opacity + visibility), never `display`; a
  probe that counts `display !== 'none'` counts every pooled element that ever carried text. Count
  captions by computed visibility.
- Chrome that holds a corner (the minimap, the legend dock) takes no inset — the camera still centres
  behind it — but it is a block in `viewportInsets`, anchored to its corner rather than resolved to
  pixels, so a resize cannot leave a caption sitting under it.
- Chrome insets reach the camera and the captions through one call (`ui/viewport.js viewportInsets`),
  never by the scene observing the DOM; a new overlay that covers the canvas adds its px there. Chrome
  whose size is its own content's (the legend dock, the action lane) measures itself and hands the
  number in as an argument — and it arrives a beat after the first paint, which is why the first view
  re-frames on each one for 1.2 s.
- The canvas clears opaque to the scene theme's canvas colour, so the CSS radial-gradient behind it is
  hidden.
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

## The layout engine under everything

- The default is **bubble** (`layout/index.js`). `?layout=radial|rings|mindmap` still opens the others;
  nothing in the UI offers the switch.
- Bubble and radial are statically imported; rings and mindmap load on demand. `loadLayoutEngine`
  answers a failed alternative import with radial, and `layoutTree` answers a throwing layout with it.
  The result includes the effective engine beside its positions: use that identity for camera storage
  and reorder hints. Radial's own failure propagates.
- Every picture of a tree takes its engine from `pageLayoutEngine()` and runs it through `layoutTree` — the
  canvas, `quests/QuestThumb.jsx` and `paste/GhostSkeleton.jsx` — sharing the selected layout and its
  fallback policy. Both pictures paint a beat after their
  frame does, into a box CSS already reserved (the quest thumb's wrap is a fixed 148 px), so nothing moves
  when the picture lands. Neither caches across mounts.
- A quest whose plan is mostly one chain reads as a diagonal string in the 236×128 thumbnail —
  bubble hangs a chain off one ray. It is what the canvas will draw, so it is
  honest; if the shelf wants density back, that is a thumbnail framing question, not a layout one.
- The angular sibling drag is armed from the engine's own `reorder` static (`model/ports.js`): `'ring'`
  sweeps about the world origin, `'parent-arc'` about the node's trunk parent, `'none'` disarms.
  `BubbleLayoutEngine` declares `'parent-arc'`: only children with siblings can reorder, with no slot
  beyond the open fan. Root islands have no parent arc and no drag reorder.
- The `marketing/` scenes are hand-placed coordinates, not engine output — they draw a radial burst and
  they differ from what the app draws. The design follow-up is **F50** in
  `docs/design/consistency.md`; the boards owe a redraw.

## Open

- No frame timing lives in the repo, and the rig cannot produce one: its captures run on SwiftShader,
  where the page holds 20–30 Hz with a 0.1 ms tick and stalls the first frame after a model install.
  Any fps claim needs a GPU run (drop the two swiftshader flags).
- Icon slot assignment could be stable per nodeId the way caption elements already are (reslot only
  on enter/leave), removing the per-frame sort and any residual shimmer.
- A remote structural delete of a selected node or edge prunes the scene's copy but not the React
  set, so the multi-select bar can over-count until the next selection change.
- Undo/redo does not reconcile the append-only activity log: a create-then-undo leaves a row whose
  node is gone. It renders muted.
- The "reconnect me" tag on an unlinked node is not built; the dashed ring carries the signal.
- Layout is synchronous on the main thread. Structural edits and caption changes can run bubble
  again; there is no worker. The tuck's deterministic work ceiling can leave large or deeply nested
  trees looser. It bounds that pass's work, not every layout phase or wall-clock latency; repeated
  live edits still need an interactive budget rather than an isolated layout benchmark.
- Ticker burst-coalescing ("completed 3 steps") and narrow-viewport collapse of the activity dock are
  not built.
