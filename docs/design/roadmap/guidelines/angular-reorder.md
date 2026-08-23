# Angular reorder

Drag a node tangentially around the radial ring to reslot it among its siblings under
the same parent. Companion to `tree-layout-contract.md` (determinism).

## Rules

1. **Arrange is order only.** Reparenting is a separate reconnect gesture, never
   overloaded onto this drag.
2. **A single node — its subtree rides along.** Moving a branch is reordering that
   branch's root node; no separate mode.
3. **Roots too.** The root ring is the depth-0 sibling ring; the canvas center is its
   virtual parent.
4. **A node drag is reorder.** No new chrome. Radius is owned by the layout; the
   tangential component picks the slot.

## The interaction

- **Lift** — past the 4px threshold (the same threshold that splits click-to-select from
  drag) the node lifts, scale 1.08 + shadow. A dashed slot marks where it sat.
- **Arc** — angle follows the cursor, radius is pinned; pull in/out and it snaps back.
  The subtree ghosts along.
- **Slot** — crossing a sibling boundary opens an insertion slot at that gap: the
  position the node will take, not where the cursor is. Always legal: same parent, so no
  cycle is possible.
- **Relayout** — on release the node lands in the slot; siblings ease to their recomputed
  even angles over 480ms `--ease-soft`. One history step, silent + ⌘Z, no toast.
- **Boundary** — the drag stays inside the parent's sibling arc; crossing into another
  parent's sector does nothing.
- **Reduced motion** — no lift-scale, no eased relayout: the node snaps to its slot,
  siblings jump with a 150ms fade-through. The slot preview still shows.

## The order register

- Each node carries an `order`: a fractional index (sortable string) scoped to its
  parent. Siblings render sorted by `order`; angular spacing is derived from the sort,
  not stored.
- A reorder writes one new index between the two neighbours at the drop slot — never a
  renumber.
- Last-writer-wins per node; identical results tie-break by actor id.
- Roots use the same field against the virtual center parent. Absent `order` falls back
  to creation time.
- Reorder changes the register, never a free position: identical register ⇒ identical
  layout on every device.

## Touch

The gesture degrades intact — drag a node around its ring — under three conditions from
`mobile.md`: the node must own a real hit disc (§9), so reorder is unavailable below that
clamp, where a tap zooms in first; the drag is direct manipulation and so exempt from the
motion ceilings; the commit drops the standard 4s undo snackbar in the undo lane (§8).
