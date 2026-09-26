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

## Package map

| Area | Responsibility |
|---|---|
| `model/` | Graph validation, trunk selection, unlock rules, legend, workspace and spatial queries. |
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

`model/ports.js` defines data shapes and the `TreeRepository` and `LayoutEngine` seams. `SkillTree`
validates the DAG, builds indexes and derives render nodes. `renderableGraph.js` supplies a
best-effort projection when replicated state contains cycles. `TrunkTree` chooses one primary
parent per node for layout: same-kind parents first, then depth and id; siblings retain their
fractional order and creation-stamp order.

`UnlockRules.derive` is the authority for locked, available and complete states. An edge inherits
its source node's state. Legend order lives in the lattice and is written by `ReorderKinds`;
`Legend`'s array operations also serve import drafts. Genesis kinds and stamps come from
`packages/api-contract/genesis.js`, checked by `vite.config.js`.

`theme.js` supplies WebGL's resolved light/dark palettes and shared geometry. Kind chooses hue;
progress chooses tier; structural form distinguishes linked, unnamed and unlinked nodes. Node
bodies, root/selection scale, zoom floors and caption dimensions must agree across shaders,
overlays and layout. `model/footprint.js` estimates disc-plus-caption bounds from label length,
without DOM measurement. Everything under `model/` is independent of React and WebGL.

## Layout

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
