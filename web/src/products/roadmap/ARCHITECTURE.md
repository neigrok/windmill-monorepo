# Roadmap web architecture

Roadmap renders a DAG of steps on a hand-rolled WebGL2 canvas. React owns UI and lifecycle;
pure models own graph rules and layout. Tree writes are owner-only; another account can view a
shared tree and fork it. The shell mounts the product through `routes.js` and its registry;
`showcase.js` is the only entry point for the component showcase.

## Data flow

`SkillTreeView.jsx` loads a tree through `HttpTreeRepository` or the account's device fallback,
constructs `SkillTree`, derives progress through `UnlockRules`, runs layout and installs the render
model in `SkillTreeScene`. Layout is synchronous and cached by graph structure, effective engine
and, for caption-aware engines, labels.

After load, `SyncSession` owns the durable lattice. Both local gestures and remote frames produce
a projection through `syncStructure()` and `scene.applyModel`. `TreeEditor` holds that current
projection; undo/redo belongs to `SyncSession` and reissues inverse gestures with fresh stamps.

A saved camera is scoped to its layout engine and format. Without one, an owner opens at working
zoom over the frontier; a visitor receives the whole-tree fit and arrival ceremony. The initial
owner view reframes as chrome measurements arrive until the reader moves the camera.

Phones open owners on the outline List and visitors on the canvas; a tree's last choice on the device
wins, and an empty or just-planted tree opens on the canvas. `board/gate.js` keeps the Board closed in
production; off production, localStorage `windmill:board:dev` set to `1` opens it. Then the Board takes
the List's place, owners open on the Board and visitors on the Graph, and the selected step carries
across. The desktop editor's topbar carries the Board/Graph switch on both views; elsewhere the Board's
identity row carries it, and the Graph's rides the action lane on phones and tablets. A desktop
visitor's Graph has no switch yet. While the Board stands in for a roadmap that has not loaded, the topbar names
none and offers no Share, and after a failed load it offers no switch. Graph keyboard shortcuts do not act on the Board.

From 1024px the Board stands Locked, Up next and Done side by side, each column scrolling under its
sticky heading and starting just under the topbar, whose content bottom `ControlBar` measures while
the gate is open. From 744px to 1023px one side column folds to a rail, Done first; Show swaps which
one, and Up next never folds (`columnStage` in `BoardColumns.jsx`). Phones show one column at a time
behind Locked · Up next · Done tabs in a bottom band (`PhoneSegments.jsx`). No band draws the action
lane on the Board; a reader's Fork pill lifts the columns and the band clear of it. Shown with a step
selected, the Board opens that step's column (its tab, past the Done fold, or out of the rail) and
scrolls its card into view. The layer stays mounted across Board/Graph switches, so each column keeps
its scroll there. Crossing 744px rebuilds the columns, and a column that folds to a rail starts at the
top when it stands again.
While the Board is shown, `coverBeneath` in `BoardView.jsx` makes everything stacked under its layer
inert, the Graph's overlays and legend included.

Each column renders only the cards in view plus ten either side (`ColumnCards.jsx`), estimating an
unmeasured card's height from its text and the column's width, measuring each card as it renders and
standing a spacer in for every stretch it skips. It keeps the first card in view still as cards above it
settle, in place of the browser's scroll anchoring, which the columns turn off and WebKit lacks. The
roving stop and the selected step always render, so focus and a reveal reach them anywhere in the column.
Above twelve, Done folds to its twelve newest completions and a Show all row (`Board.shownCards`).
The columns are one tab stop with roving focus (`traversal.js`). A stop is a card, the Show all row or a
rail's Show. Tab enters on the stop last focused while it still stands, else the stop a column last
held (Up next's before the others'), else the first Up next card, else the first stop of any column. Up and
Down move within a column, Home and End to its ends, and Left and Right to the neighbouring column's
stop at the nearest height, skipping an empty column; a rail offers only its Show. Enter is the stop's
own button, so a card opens its step. A focused stop that unmounts hands focus to the new stop, and
after Try again focus rests on the skeleton until the roadmap loads. On phones each pane is one tab stop
of its own with the same Up, Down, Home and End, and the tabs keep their own arrow keys. A step that
becomes up next, or a new step that is not done, wakes once while the Board stays mounted (`arrivals` in
`Board.js`); reduced motion fades it in, and focus landing on it ends the wake. While hidden the Board
skips the host's renders and catches up when shown, so a step that arrived meanwhile wakes then.

A card opens its step (`StepDetail.jsx`): from 744px a modal over the scrimmed roadmap (`StepModal.jsx`), 760px wide
and 24px in from the window below that; below 744px a page pushed over the Board (`StepPage.jsx`), which stays mounted
beneath it with its pane and scroll. The open step rides the hash as `?step=<id>` (`stepAddress.js`). Each step opened
from a card or from another step is a history entry, so Back steps out one step at a time and the page's back row names
the screen it returns to; closing pops the whole visit, and a link lands owner and visitor alike on the Board with that
step open. While open the layer makes everything beneath it inert and wraps Tab inside itself; Escape closes the modal or
steps the page back, and closing returns focus to the card the visit began on. `StepFacts.js` reads the step off the
whole roadmap, whatever the Board filters: its column, its prerequisites and the steps it unlocks with their columns, what
Complete would open and how many steps Reset would lock. Complete and Reset act in place through the Graph's progress
writes and toast nothing: the status row flips with an inline Undo for six seconds and a line names what moved, and
hovering or focusing Reset previews what it returns to Locked. On the Workspace section, a step whose every subtask is
checked offers Complete step; subtasks never complete it. The ⋯ menu copies the step's link (the roadmap's share address
plus its step), opens the step in the Graph, and for the owner deletes it through the Graph's delete with its Undo toast.
A visitor gets the overview and the menu without Delete. The detail offers no Edit step or View branch yet.

The Board draws its own states (`BoardStates.jsx`). Until the roadmap arrives it stands wherever it
would open: the saved choice, or the owner's default anywhere but a share or the demo. While the roadmap
loads, skeleton cards hold the columns under the identity row and band, with no counts and no spinner.
A failed load says *Couldn't load this roadmap* with Try again, which reruns the load. A roadmap with no
steps opens on the Graph; switched to the Board on the desktop editor it shows *Your first step* with
New step as its one primary. Elsewhere it stays on the Graph, since phones and tablets cannot plant a
first step yet. Once every step is done, the Up next column rests on Roadmap complete: the owner gets
the body line, Share it (the share dialog) and, from 744px, New step; a reader gets the title alone.
The Board has no step editor yet, so New step switches to the Graph and plants the step there — the
first step on an empty roadmap, otherwise one after the roadmap's last leaf — without changing the
saved view.

## Package map

| Area | Responsibility |
|---|---|
| `model/` | Graph validation, trunk selection, unlock rules, legend, workspace and spatial queries. |
| `board/` | The Board view behind its development gate: derived columns, cards, the step page and modal, the Board/Graph switch and every Board string. |
| `layout/` | Deterministic layout engines behind `index.js`. |
| `scene/` | WebGL batches, camera, DOM overlays, picking and pointer tools. |
| `sync/` | Shared structure and private progress lattices, gesture materialization, socket and IndexedDB. |
| `persistence/` | HTTP repository, account tree registry and device preferences/ledgers. |
| `ui/`, `ui/tree/`, `ui/mobile/`, `list/` | Canvas chrome, step details, phone editing and the outline view. |
| `selection/`, `shortcuts/` | Multi-selection rules and the shared keyboard map. |
| `activity/`, `ceremony/`, `presence/` | Activity presentation, animation sequencing and remote cursors. |
| `paste/`, `quests/`, `demo/` | Import grammar/composition, authored starter trees and the playable demo. |
| `share/`, `browse/` | Publishing, portraits and the public gallery. |
| `tending/`, `reminders/`, `settings/` | AI assistance, reminder preferences and account data export. |
| `marketing/` | Product landing, metadata and self-playing scenes. |

## Domain and shared geometry

`SkillTree` validates the DAG, builds indexes and derives render nodes. `renderableGraph.js` supplies a
best-effort projection when replicated state contains cycles. `TrunkTree` chooses one primary
parent per node for layout: same-kind parents first, then depth and id; siblings retain their
fractional order and creation-stamp order.

`UnlockRules.derive` is the authority for locked, available and complete states; the same file
answers what a step still owes (`owedStepsOf` and `gateOf` for one step, `owedCounts` for every
step in one pass) and what completing it opens (`unlocksOf`). An edge inherits its source node's
state. Legend order lives in the lattice and is written by `ReorderKinds`;
`Legend`'s array operations also serve import drafts. Genesis kinds and stamps come from
`packages/api-contract/genesis.js`, checked by `vite.config.js`.

`theme.js` supplies WebGL's resolved light/dark palettes and shared geometry. Kind chooses hue;
progress chooses tier; structural form distinguishes linked, unnamed and unlinked nodes. Node
bodies, root/selection scale, zoom floors and caption dimensions must agree across shaders,
overlays and layout. `model/footprint.js` estimates disc-plus-caption bounds from label length,
without DOM measurement. Everything under `model/` is independent of React and WebGL.

## Layout

`layout/LayoutEngine.js` defines the layout contract and each engine's caption and reorder capabilities.
`pageLayoutEngine()` and `layoutTree()` serve the canvas, quest thumbnails and paste ghosts.
`?layout=` accepts `bubble`, `radial`, `rings` or `mindmap`. Unknown names use bubble. Radial is the
synchronous fallback for an alternative import or layout failure; failure of the fallback itself
propagates. The returned effective engine controls reorder gestures and saved-camera identity.

| Engine | Geometry | Reorder |
|---|---|---|
| Bubble, default | Child fans, footprint-aware subtree tucking and packed root islands. | Parent arc |
| Radial, fallback | Trunk-depth rings and subtree-sized angular wedges. | Ring |
| Rings | Caption-aware contour packing on depth rings, with separate root islands. | None |
| Mindmap | Tidy branches distributed across twelve directions. | None |

Engines are synchronous, stateless and deterministic. `readsCaptions` declares whether renaming
requires layout. Bubble's tuck has a deterministic work ceiling; an unfinished move is discarded,
leaving the remaining subtrees in their enclosing-circle positions. This ceiling covers the tuck,
not every phase or wall-clock latency. Marketing scenes use hand-placed coordinates.

## Renderer and UI

`SkillTreeScene` owns `Camera2D`, `NodeBatch`, `ConnectorBatch`, overlays, `CeremonyDirector` and
input tools. React supplies models, progress, selection and viewport insets. The continuous frame
loop advances camera/motion, repositions overlays and draws one node batch and one connector batch.
Theme changes update GPU and DOM colours together.

Captions are keyed by node id. `captionLayout.js` prioritizes selection, hover, family, landmarks
and available steps, avoiding chrome, labels, discs and ribbons. Selected and hovered labels stay
visible when collision-free space runs out. Distant glyphs use `IconAtlas`; close glyphs use a
64-slot DOM pool. `edgeCurve.js` supplies connector and caption-collision geometry.

Picking accepts the drawn disc; pointer/touch hit floors stop halfway to the nearest neighbour.
A crowded hit zooms into the group. `ui/viewport.js` supplies the camera and captions with both
edge insets and corner obstacles; content-sized chrome measures itself.

Keep these boundary rules when changing the renderer:

- Place overlays from the live camera and do not transition their per-frame CSS transforms.
- Keep `NodeBatch` glyph colour math aligned with `NodeOverlay`'s `glyphCssColor`.
- Caption visibility is `st-label--shown` and computed opacity/visibility, not `display` alone.
- Use `CeremonyDirector.busy()` for ceremony state: pausing rendering does not cancel its timers.
- GPU selection comes from `setSelectedSet(selectedIds)`. Mixed node/edge selections cannot be
  represented by the single-node projection; reconciliation uses `projectEdge`, not a pick action.

Settles update affected GPU ranges once per frame. Reduced motion freezes pulses and snaps growth.
Spatial queries scan stored nodes when traversing grid cells would cost more. These bounds do not
establish a frame-rate guarantee. The [capture rig](../../../scripts/roadmap-rig/APPARATUS.md)
checks settled pixels and DOM geometry; hardware-backed timing needs a separate run.

## Synchronization and storage

The [graph synchronization contract](../../../../docs/GRAPH_SYNC_DESIGN.md) defines the wire format,
coverage, acknowledgements and durability limits. Shared structure and private progress use one
socket and HLC clock but separate frames. Pending writes are derived from lattice state.
`materialize.js` turns each local gesture into stamped field writes; refusal handling uses machine
codes rather than error sentences.

Each projected step carries `createdMs`, the wall time of its add stamp: when it joined this tree.
Create and import stamp it, a fork re-adds every step at the fork, and edits never touch it. A
genesis seed reads `null`, unknown. A restore re-adds the step with a fresh stamp, so its
`createdMs` becomes the time of the restore.

`SyncStore` saves `{frame, progress, lastSeq}` in one IndexedDB record with transactional read-join-put.
Coverage is rebuilt on subscribe. Saves are queued before sending, but not awaited; transaction
failures are swallowed by the store's queue. Do not treat an in-memory edit as confirmed durable.

`LocalTreeRegistry` associates device trees with accounts, and device reads require identity
confirmed on this document load. A remembered face does not authorize a store read.
`ProgressStore.drainInto` migrates older local marks into the private lane. Displayed completion
dates use the server's `markedAt`; local completion clocks support only incomplete local history.

`ShareDialog` waits for successful publication before copying a public `/t/:id` link. The owner
sees that anyone can view/fork it and that it may appear in the gallery. Clipboard failure leaves
the URL selectable; owners can make a tree private again.

## Open work

- Icon slots are reassigned by distance rank each frame; stable node ownership could remove
  unnecessary sorting and slot swaps.
- Remote structural deletion prunes scene selection without pruning React's selection sets, so
  the multi-select count can remain stale.
- Undo does not reconcile the append-only activity log; rows for removed nodes render muted.
- Layout runs on the main thread. Large trees and repeated live edits need an interactive latency
  budget beyond the tuck ceiling.
- The unlinked-node reconnect tag, activity burst coalescing and narrow activity-dock collapse
  are not built. Design gaps belong in the [consistency ledger](../../../../docs/design/consistency.md).
