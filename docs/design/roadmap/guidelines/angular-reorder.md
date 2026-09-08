# Angular reorder

Drag a node to another slot among siblings under the same trunk parent. Siblings can occupy several
rows with bounded radial variation inside their major sector. Companion to `tree-layout-contract.md` (determinism).

## Rules

1. **Arrange changes order.** Reparenting is a separate reconnect gesture.
2. **One node register moves a branch.** Descendants take their new layout positions after the
   order change; the drag preview moves only the held node and its incident edges.
3. **Roots form a sibling group.** Their virtual parent is the canvas center.
4. **The layout owns positions.** Radius chooses an existing sibling row during the gesture;
   angle chooses a gap in that row. The committed value is an order key, never a free position.

## The interaction

- **Lift:** movement past 4px changes a press into reorder. The held node receives the marquee
  preview treatment and a dashed insertion ring appears.
- **Row:** siblings belong to one row while their radii stay within a 140px threshold at working
  zoom. This threshold lies between the maximum 56px spread inside one row and the minimum
  224px gap to another. Pointer radius chooses the nearest row by its mean radius; the held node
  follows the pointer angle at the radius interpolated from the gap's neighboring nodes.
- **Slot:** angle chooses a gap within that row. The ring marks the gap on the chosen row;
  its local insertion index maps back to the full authored sibling sequence. Row boundary slots
  use the adjacent keys from that full sequence, including a neighbor on the next or previous row.
- **Scope:** only the original same-parent sibling set participates. Crossing another sector
  cannot reparent the node.
- **Commit:** release writes one fractional key. The layout recomputes row capacity and placement;
  displaced nodes settle over 520ms with up to 120ms stagger. The preview marks the chosen order
  gap, not a promise that all final coordinates will remain at their preview positions.
- **Gesture takeover:** explicit tool cancellation, such as a pinch taking over, restores the
  held node's original coordinates without a write. DOM `pointercancel` currently routes through
  release and can commit the order; that input-path gap is recorded in `web/src/products/roadmap/NOTES.md`.
- **Reduced motion:** the preview still tracks the pointer, but committed layout positions apply
  immediately without the settle animation.

## The order register

- Each node carries a sortable fractional `order` string scoped to its parent. Authored sibling
  order determines row membership and angular spacing.
- A reorder writes one key between the drop slot's neighbors, without renumbering siblings.
  Equal-key runs are stepped over; an empty order is an open bound. Non-empty values must be
  valid fractional keys, including in test fixtures.
- The CRDT stores the register with last-writer-wins semantics. Missing order uses the tree's
  deterministic creation/id fallback.
- Roots use the same field against the virtual center parent.
- The existing gesture history owns undo/redo; a reorder changes no prerequisite edges.

## Touch and drawings

Canvas reorder is desktop-only. Phone and tablet canvases use the navigation tool; owner editing
lives in their sheets and list surfaces (`mobile.md`).

Figma reorder drawings and DOM tree presentations still need reconciliation with gently varied rows and
the current preview. `../../consistency.md` tracks that visual work.
