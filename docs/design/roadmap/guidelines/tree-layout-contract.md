# Windmill Tree — Layout & Render Contract

The rules for rendering the roadmap skill-tree canvas on the GPU. Production is a hand-rolled WebGL2
renderer (`web/src/products/roadmap/scene/`); the React `SkillNode` / `SkillConnector` components are
the DOM reference. This doc translates their look into resolution-independent rules and concrete
values to hard-code, since a GPU canvas has no CSS custom properties. Everything here mirrors
`web/src/styles/tokens/` — if a token changes, update this doc.

> **Metaphor:** the tree grows radially from a single root at the center of the canvas. Children fan
> out in all directions from their parent. Steps are circular nodes; dependencies are gently-curved
> branches. A node's colour comes from its `kind`; its tier is treatment only — dim → ringed → ember
> → glowing. The tier never re-hues a node.

> **Motion:** §7 is a summary. `motion-language.md` is canon for every animated moment and supersedes
> this doc wherever they disagree.

---

## 1. Coordinate model

- Work in an unbounded world space (float units = px at zoom 1.0). The root node sits at world origin
  `(0, 0)`; pan/zoom is a camera transform on the stage, never baked into node coords.
- One container per node (disc + label) at the node's world coordinate. One batched layer for all
  branches, beneath the node layer.
- Draw order, back to front: `branchesLayer` → `glowLayer` → `nodeLayer` → `labelLayer`. Glows keep
  their own layer so they never occlude a node.

## 2. Node geometry (base size = 56)

Base size 56 world units = px at zoom 1.0, matching `theme.js NODE_SIZE` and the DOM `SkillNode`
default. All values scale linearly with `size`; "u" = size/56.

| Part | Value |
|---|---|
| Fruit diameter | GPU body `0.84 × size`; roots multiply by 1.55 |
| Fruit shape | a perfect circle — no stem, no gloss, no lopsided blob |
| Ring (border) | `2 * u` px stroke, color = state ring (§3) |
| Icon box | `0.4 * size` (≈22px), centered; ink per tier (§3) |
| Label | 14px/20px weight 700 in screen space; up to two lines in 168px; default gap 8px |
| Hit area | nearest node within `0.65 × size`; read-only views also apply a 22px screen-space radius floor |

**Fill is flat.** A single flat, saturated kind colour — no gradient, no gloss highlight. The tier
treatment (§3) supplies depth through fill weight, ring and glow, never a light-spot gradient.

### 2.1 Working size

Ordinary bodies target 52 CSS px in Focus. The reference zoom is `52 / (56 × 0.84)`, approximately
1.105. Roots carry the existing 1.55 emphasis. Layout reserves the full body plus a two-line caption
and 16px clearance at that fixed reference zoom. The camera scales bodies; captions retain their
screen-space size. Depth and progress do not reduce the ordinary body target.

## 3. Kind colours & tier treatment

A node's colour comes from its `kind` (one of six palette hues), not its progress. Its tier
(`locked | available | active | complete`) is a treatment on that same hue. Gold is a kind, not a
state.

| Kind (day) | Soft (−200 step) | Base (fill + ring) | Glow |
|---|---|---|---|
| `terracotta` | `#EAC6B0` | `#BC6C42` | `rgba(188,108,66,·)` |
| `olive` | `#D2DAA5` | `#7D8C43` | `rgba(125,140,67,·)` |
| `gold` | `#EEDA9E` | `#C4972F` | `rgba(196,151,47,·)` |
| `brick` | `#E4B6A8` | `#A84E35` | `rgba(168,78,53,·)` |
| `sky` | `#C4D5DC` | `#5F8494` | `rgba(95,132,148,·)` |
| `plum` | `#D3ABC9` | `#8D4F83` | `rgba(141,79,131,·)` |

Treatment (values mirror `SkillNode.jsx`):
- **locked** — recessed kind tint: fill = base mixed `22%` into the card surface, `1.5px` ring = base
  mixed `52%` with the default border, no glow, full opacity. The tint carries the dim read; no
  opacity wash, which pushes locked toward the white available node.
- **available** — white node (`--surface-card`), solid `2px` kind ring, no glow at rest.
- **active** — the ember: fill = base mixed `34%` into the card surface, `2px` kind ring, low
  breathing kind glow (`wm-ember` waveform — amplitude peaks below a complete node's resting halo),
  no halo ring.
- **complete** — flat base fill, `2px` base ring, halo glow (`0 0 0 4px glow, 0 0 30px glow`),
  on-accent ink icon. Only complete nodes wear a halo.

By night every kind takes its own four-value set, tuned for the `#0B0B0C` canvas — a brighter base,
a lighter ring, a recessed soft, and a glow hue that ships at two alphas: `--kind-*-glow` in
`colors.css` at 0.8 for DOM halos, and the WebGL night set in `theme.js` at 0.50. On-accent ink on
a night kind fill is `#0B0B0C`.

| Kind (night) | Base | Ring | Soft | Glow |
|---|---|---|---|---|
| `terracotta` | `#D98B5F` | `#E2A887` | `#30221B` | `#DD976F` |
| `olive` | `#9DAF5C` | `#B6C385` | `#25291A` | `#A7B76C` |
| `gold` | `#D9AE45` | `#E2C274` | `#302816` | `#DDB658` |
| `brick` | `#C86B50` | `#D6907C` | `#2D1C18` | `#CE7A62` |
| `sky` | `#7BA6B8` | `#9CBCCA` | `#1F272B` | `#88AFBF` |
| `plum` | `#B06FA6` | `#C493BC` | `#291D28` | `#B87DAF` |

Night scene literals: canvas `#0B0B0C`, glow `#141416`, connector `#2E2E32` inactive / `#7E7C77`
active, bark `#6E5D49`, bark-cream `#D9C7A6`.

### 3.1 Glow (halo)

A blurred circle sprite behind the fruit in `glowLayer`, tinted with the node's kind glow colour —
the full halo only for `complete` nodes; `active` nodes get the ember's low-amplitude glow with no
ring offset. Resting halo: radius ≈ `size * 0.9`, alpha ~0.28. Prefer a pre-blurred sprite over a
live blur filter.

## 4. Branches (connectors)

- A branch is a quadratic bezier from parent center to child center with a single control point
  offset perpendicular to the straight line.
- Bend magnitude: `0.18 * distance(parent, child)`, sign and exact fraction from the branch seed (§6)
  so it's stable across frames but varied between branches. Control point = midpoint +
  perpendicularUnit × bend.
- Stroke: round cap, width `3` when active (grown), else `2`.
- A branch is **active the moment its `from` node is `complete`** — an ember never lights its outward
  branches. Active branches take the source node's kind colour as a solid `3px` stroke with no glow;
  dormant branches are a thin `2px` muted line (`--connector-inactive`) at ~0.7 opacity.

## 5. Layout

Layout is deterministic: identical input graph ⇒ identical layout. Siblings sort by their order
key, creation stamp, then ID. Positions belong to layout; gestures change sibling order. **A live gallery SVG portrait must
render the tree's own canvas positions** — mode follows the tree, never the surface. Social link
previews use stored assets or a generic fallback and need not match the live page
(`og-tree-cards.md`); sharing performs no image capture or upload.

### 5.1 Compact radial placement

1. A single root sits at the origin. Multiple roots divide the full circle around a synthetic center.
2. Parents divide their angular wedge among trunk children: 85% by subtree leaf count, 15% equally.
3. A breadth-first traversal seats parents before descendants. Each node keeps the center angle of
   its wedge and starts at least 170 screen pixels, converted through the reference working zoom,
   farther from the origin than its trunk parent.
4. A spatial grid reserves each node's body, full caption width, two lines, and clearance. Only a
   colliding node moves farther along its ray. Depth does not imply a shared radius.
5. All DAG edges remain in the model. Selection emphasizes immediate prerequisites and dependents,
   including secondary connections, while unrelated connections become quiet.

The engine is synchronous and cached. Cache inputs include node IDs, prerequisites, sibling order,
raw color, and creation stamps. Zoom never changes world placement. Layout and scene share the
geometry constants in `model/geometry.js`.

```
NODE_SIZE          = 56
WORKING_BODY       = 52   // CSS px
WORKING_ZOOM       = 52 / (56 × 0.84)
MIN_RADIAL_STEP    = 170 / WORKING_ZOOM
LABEL_SIZE         = 14   // CSS px, independent of camera zoom
LABEL_LINE_HEIGHT  = 20
LABEL_MAX_WIDTH    = 168
LABEL_GAP          = 8
LABEL_CLEARANCE    = 16
```

## 6. Determinism / seeding

Per-element variation comes from a string hash:
```js
function hashStr(str){let h=0;for(let i=0;i<str.length;i++)h=str.charCodeAt(i)+((h<<5)-h);return Math.abs(h);}
```
- **Node:** seed from the node `id`. Drives fruit rotation.
- **Branch:** seed from `` `${parentId}-${childId}` `` → drives bend sign and amount.

## 7. Motion — summary only

Canon is `motion-language.md` (beats, cascade cadence, calm ceiling, reduced motion). What the
renderer must know:

| Moment | Spec |
|---|---|
| **Crown** (root only) | the only infinite loop on the canvas: halo breathes at 2400ms `--ease-glow` (α .22↔.34, radius ±2px). Other complete nodes wear a static halo (α .28). |
| **Ember** (active) | `wm-ember` waveform, same 2400ms clock and phase, amplitude below a resting halo, no ring offset. |
| **Hover** (interactive nodes) | scale 1.06 over 280ms `--ease-soft`; locked nodes ignore hover. Feedback-class: never queued. |
| **Press** | scale ~0.97, soft release, no bounce. |
| **Unlock** | the travel beat: a bright head runs parent→child, the edge wakes behind it, the child ignites at 85% of the arc. |
| **Tier rise** | bloom (wake 1.02 / full 1.045 + halo overshoot ×1.25); downward changes are a plain 280ms dim — silent. |
| Reduced motion | motion doc §5: spatial motion snaps/skips, ≤280ms cross-fades stay, loops freeze at mid-amplitude (`uMotion = 0`). |

All oscillating halos share one global clock (§9) — the tree breathes as one organism.

Easing tokens: `--ease-soft = cubic-bezier(0.16,1,0.3,1)`, `--ease-glow = cubic-bezier(0.45,0,0.15,1)`,
`--ease-standard = cubic-bezier(0.4,0,0.2,1)`. Durations: fast 150 / base 280 / slow 480 / glow 2400
(ms).

## 8. Camera / interaction

- **Pan and zoom:** drag empty canvas; wheel/pinch keep the pointer anchor. Wheel zoom spans
  0.00001–6; pinch spans 0.00001–2.5, allowing even very deep graphs to fit.
- **All steps:** fit the complete node bounds inside the visible canvas, excluding chrome and the
  detail panel. Preserve the last working view when leaving it.
- **Focus:** reveal the selected step at a readable scale, restore the saved working view, or focus
  the nearest step when there is no selection or saved view. Ordinary bodies reach at least 52px.
- **Select:** open the step's detail panel. Locked steps remain inspectable so prerequisites can be
  understood. Desktop detail shows the full title; the phone owner sheet's single-line title needs
  the rename control for long names, pending a wrapping-header follow-up.
- Captions stay horizontal at 14px/20px. Priority and collision checks decide which names fit.
  Overview captions may cover context dots smaller than 8px; working captions avoid visible node
  bodies and other captions. Hover and selection receive priority within the safe viewport.
- Stored cameras carry a layout version. A mismatched camera preserves the selected step for
  refocus, or opens the overview when no surviving selection exists.

## 9. Performance

- Pre-bake glow as textures rather than a per-frame blur once node counts pass ~50.
- Batch all branches into one draw. Rebuild connector geometry on graph changes; the frame loop
  draws cached geometry and animates through uniforms.
- Drive pulses from a single shared clock feeding all halos the same phase (optionally offset by node
  seed); never run N independent tweens.
- Cull caption candidates to the visible viewport and bound the candidate pool. Cache text
  measurement between model/font changes. Large spatial queries scan occupied data, not empty area.

## Drawing reconciliation

The Figma canvas boards need the compact placement, readable captions, and Focus/All steps chrome.
The available-state material disagreement is tracked separately in `docs/design/consistency.md`.

---

**Reference implementation:** `web/src/products/roadmap/ui/tree/SkillNode.jsx` and
`SkillConnector.jsx` for the DOM look; `web/src/products/roadmap/layout/` for placement.
