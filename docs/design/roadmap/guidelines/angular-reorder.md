# Windmill Angular reorder — editing spec v2 §07

Drag a node tangentially around the radial ring to reslot it among its siblings
under the same parent. This is the successor to the removed free-pixel move (the
layout is deterministic radial, so a free x/y move had no effect after reload).
It touches the CRDT — it adds an **order register** to the sync lattice and the
wire — so canon is pinned here before the build. Live specimens:
`explorations/angular-reorder.html`. Companion to **editing spec v2** §06 and
`guidelines/tree-layout-contract.md` (determinism).

## The four rulings *(yours to overturn)*
1. **Stands alone — the only arrange gesture.** There is no free-pixel move to
   replace; the one thing a user can change is a node's **order among its
   siblings**. Reparenting is a **separate reconnect gesture** (v2 §03/§04):
   arrange changes order, reconnect changes the parent. Never overloaded onto one
   drag.
2. **A single node — its subtree rides along.** The primitive is "reslot this
   node among its same-parent siblings." Descendants keep their own order and
   follow because layout is relative. "Move a whole branch" is just reordering
   that branch's root node — no separate mode.
3. **Roots too — when there's more than one.** The root ring is the depth-0
   sibling ring; the canvas center is its **virtual parent**. Same gesture, same
   rules. Single-root trees make it moot; a forest gets ordering for free.
4. **Drag the node itself, tangentially.** Since free-pixel move is gone, a node
   drag has no other meaning, so a node drag *is* reorder — no new chrome. The
   radial component snaps back (the layout owns radius); the tangential component
   picks the slot. Degrades to touch as "drag a node around its ring."

## The interaction (§07)
- **Lift** — past the 4px threshold the node lifts (scale 1.08 + shadow), the
  same threshold that splits click-to-select from drag (v2 §6.1). A dashed slot
  marks where it sat.
- **Arc** — the node rides the ring: angle follows the cursor, radius is pinned;
  pull in/out and it snaps back. Its subtree ghosts along.
- **Slot** — crossing a sibling boundary opens an insertion **slot** at that gap
  (v2 §6.2) — the position the node will take, not wherever the cursor is.
  **Always legal:** same parent, no cycle possible, no brick states.
- **Relayout** — on release the node lands in the slot; every sibling eases to
  its recomputed even angle over 480ms `--ease-soft` (v2 §6.3). One history step,
  silent + ⌘Z, no toast.
- **Boundary** — the drag stays inside the parent's sibling arc. Crossing into
  another parent's sector does **nothing** here; changing parents is the separate
  reconnect gesture.

## The order register (lattice & wire)
- Each node carries an **`order`**: a **fractional index** (a sortable string,
  Figma/LSEQ-style) scoped to its parent. Siblings render sorted by `order`; even
  angular spacing is derived from the sort, not stored.
- A reorder assigns **one** new index between the two neighbors at the drop slot
  — a single field write, never a renumber; untouched siblings don't change.
- Last-writer-wins register per node; because indices are fractional, concurrent
  reorders rarely collide, and identical results tie-break by **actor id** —
  deterministic, no central sequencer.
- Roots use the same field against the **virtual center parent**. Absent `order`
  (old data) falls back to creation time, so migration is silent.

## Reduced motion & determinism
- **Reduced motion:** no lift-scale, no eased relayout — the node snaps to its
  slot; siblings jump with a 150ms fade-through. The slot preview still shows.
- **Determinism holds:** reorder changes the register, never a free position.
  Identical register ⇒ identical layout on every device.

## Touch (X8)

The gesture degrades intact — **drag a node around its ring** — with three touch
conditions from `mobile.md`: the node must own a real hit disc (max(44px, visual)
capped at half the nearest-neighbour gap, §9), so reorder is **unavailable below
that clamp** — at those zooms a tap zooms in first; the drag is direct
manipulation and therefore exempt from the motion ceilings; and the commit drops
the standard **4s undo snackbar** in the undo lane (§8), since a finger has no ⌘Z.
Slot preview and snap-back are unchanged.
