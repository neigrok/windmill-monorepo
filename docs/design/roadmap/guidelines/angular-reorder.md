# Angular reorder

Drag a node tangentially around its trunk parent to reslot it among its siblings in the
bubble layout. The radial alternative uses the world origin as its center. Companion to
`tree-layout-contract.md` (determinism).

## Rules

1. **Arrange is order only.** Reparenting is a separate reconnect gesture, never
   overloaded onto this drag.
2. **A single order write.** Moving a branch reorders its root node; its descendants
   take their new positions when the layout recomputes.
3. **Bubble roots stay packed.** Root islands have no parent arc and cannot be reordered
   by dragging. In the radial alternative, roots share a ring around the canvas center.
4. **A node drag is reorder.** No new chrome. Radius is owned by the layout; the
   tangential component picks the slot.

## The interaction

- **Start** — past the 4px threshold that splits click from drag, the node gains the
  grouped preview treatment and the insertion slot appears.
- **Arc** — angle follows the cursor, radius is pinned; pull in/out and it snaps back.
  The node and its incident branches follow; descendants wait for the committed layout.
- **Slot** — crossing a sibling boundary opens an insertion slot at that gap. The slot
  marks the order at the drag radius; the layout owns the final position. A valid slot
  keeps the same parent, so no cycle is possible.
- **Relayout** — on release the new order recomputes the layout; siblings ease to their
  new seats over 520ms with up to 120ms stagger, using cubic ease-in-out. One history step,
  silent + ⌘Z, no toast.
- **Boundary** — the bubble drag stays within its parent's open sibling fan. A drop
  beyond either end's slack has no slot and writes nothing. A lone child has no reorder.
- **Reduced motion** — the committed layout snaps to its positions. The direct drag and
  slot preview still follow the pointer.

## The order register

- Each node carries an `order`: a fractional index (sortable string) scoped to its
  parent. Siblings render sorted by `order`; angular spacing is derived from the sort,
  not stored.
- A reorder writes one new index between the two neighbours at the drop slot — never a
  renumber.
- Last-writer-wins per node; identical results tie-break by actor id.
- Roots carry the same order field; bubble uses it to break ties when packing islands,
  and radial exposes their origin-centered reorder. Absent `order` falls back to creation time.
- Reorder changes the register, never a free position: identical register ⇒ identical
  layout on every device.

## Touch

The gesture degrades intact — drag a node around its parent's arc — under three conditions from
`mobile.md`: the node must own a real hit disc (§9), so reorder is unavailable below that
clamp, where a tap zooms in first; the drag is direct manipulation and so exempt from the
motion ceilings; the commit drops the standard 4s undo snackbar in the undo lane (§8).
