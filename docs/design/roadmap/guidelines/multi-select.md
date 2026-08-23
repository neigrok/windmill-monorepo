# Multi-selection (desktop)

The surface for selecting and acting on many steps at once. Desktop pointer only; the phone
keeps single-tap plus the touch bulk bar.

> **Ruling:** a set is one thing, not N single-selections. The terracotta glow + scale stays
> reserved for a **single** selection; a set wears a quieter unified **bark** treatment.

## 1. Selecting many
- **⌘/Ctrl+A** selects all steps.
- **⇧-click** toggles one step in or out of the set.
- **⇧-drag** on empty canvas draws a marquee.
- All three are additive to the current selection.

## 2. The marquee
- **Neutral, because it's a tool** — a bark dashed rectangle over a whisper of brand-soft
  fill. Tools are bark and cream; only data wears kind hues.
- **Honest before commit** — nodes the box touches take a lighter *preview* bark ring while
  you drag; release promotes them to full members.
- **Hit test = node center**, so a step joins when the box clearly covers it. ⇧ held during
  the drag keeps the existing set and adds; a bare marquee replaces.

## 3. The grouped highlight
- **Node** — one selected = terracotta ring + scale + glow + the docked StepPanel. Two or
  more = each member wears a quiet bark ring, no scale, a faint bark glow. Dropping back to
  one restores the single look.
- **Link inside the set** — a branch with **both** endpoints selected brightens toward a
  warm bark-cream (heavier stroke): the set reads as one connected shape.
- **Selected link** (single edge selection) brightens toward **white** with endpoint
  handles — brighter than an incidental inside-set link. Links are not part of a node
  multi-selection; edit them one at a time.
- The grouped bark token is shared with the touch bulk bar so the two surfaces read
  identically.

## 4. The action bar
- **Home:** bottom-center in the toast lane, floated above the ControlBar. It replaces the
  single-step StepPanel while a set is live (appears at ≥2).
- **Weight:** a light action card, not a dark transient toast — it persists and you act on
  it. Toasts slide in over it.
- **Contents, left→right:** `N selected` · recolor swatches (hover previews the whole set +
  downstream glow, click commits, silent + ⌘Z; a mixed-kind set shows no ringed swatch) ·
  **Mark all done** · **Delete**.
- **Delete** is the one brick control: hover dims the set and every branch it takes (cost
  preview); click resplices orphaned children up and drops one `N steps deleted · Undo`
  toast (6s), one history step.
- **Grows leftward from Delete.** Count anchors left, destructive stays far right, so muscle
  memory holds as the row grows.

## 5. History & reduced motion
- One gesture = one history step; recolor and mark-done are silent + ⌘Z; only bulk delete
  earns a toast.
- **Reduced motion:** marquee and rings instant; the action bar appears in place (no
  fade-rise); nothing loops.

## 6. Touch

On **your own** tree a phone enters the same grouped set by **long-press**, with a visible
twin — a **"Select steps" row in the sheet** — because a gesture-only mode is undiscoverable
and phones have no `?` overlay. Tap toggles; the bulk bar is the action bar re-docked
(`responsive.md` §13). **A canvas tap never clears a non-empty set** — selection is not in
the undo stack, so an accidental tap must not be able to destroy one. Full registry:
`mobile.md` §3.
