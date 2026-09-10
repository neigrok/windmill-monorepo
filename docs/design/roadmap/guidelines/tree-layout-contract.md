# Windmill Tree — Layout & Render Contract

The rules for rendering the roadmap skill-tree canvas on the GPU. Production is a hand-rolled WebGL2
renderer (`web/src/products/roadmap/scene/`); the React `SkillNode` / `SkillConnector` components are
the DOM reference. This doc translates their look into resolution-independent rules and concrete
values to hard-code, since a GPU canvas has no CSS custom properties. Everything here mirrors
`web/src/styles/tokens/` — if a token changes, update this doc.

> **Metaphor:** the tree grows outward as bubbles. Each step's children sit on rays around it, inside
> the circle that holds its whole subtree, and each child faces its parent; the largest root sits at
> the world origin and the other roots pack around it. Steps are circular nodes; dependencies are
> gently-curved branches. A node's colour comes from its `kind`; its tier is treatment only — dim →
> ringed → ember → glowing. The tier never re-hues a node.

> **Motion:** §7 is a summary. `motion-language.md` is canon for every animated moment and supersedes
> this doc wherever they disagree.

---

## 1. Coordinate model

- Work in an unbounded world space (float units = px at zoom 1.0). The largest root sits at world origin
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
| Fruit diameter | `0.84 × size` (47.04 world units); crowned roots are 1.55× wider |
| Fruit shape | a perfect circle — no stem, no gloss, no lopsided blob |
| Ring (border) | `2 * u` px stroke, color = state ring (§3) |
| Icon box | `0.4 * size` (≈22px), centered; ink per tier (§3) |
| Label | fixed 14px/20px, weight 700; up to two lines inside 168px, overflow ellipsized; preferred seat 8px below the drawn rim |
| Hit area | the drawn disc remains selectable; extension reaches a 24px pointer / 44px touch radius, capped at half the nearest-neighbor distance |

**Fill is flat.** A single flat, saturated kind colour — no gradient, no gloss highlight. The tier
treatment (§3) supplies depth through fill weight, ring and glow, never a light-spot gradient.

### 2.1 Unbuilt sizing proposal — taper + milestone bump

The renderer uses one `NODE_SIZE` today. The unbuilt proposal below would encode structure,
never metrics, in the base size; it is not the current sizing rule.

- **Proposed depth taper:** `SIZE(d) = 96 × 0.8^d`, clamped to **[40, 96]** world px — the
  goal is the biggest fruit; each ring outward gets finer. Depth is granularity.
- **Proposed milestone bump:** a step marked *milestone* would render one depth-step larger —
  `SIZE(max(0, d − 1))`. Undo-able, panel-driven, deterministic. New steps need no decision.
- Everything scales in `u = size/56` (§2): ring 2u, icon 0.4·size, glow radius ≈ 0.9·size.
- **Caption and hit geometry stay screen-sized:** captions follow §2 regardless of node size or
  zoom; hit floors and the crowded-tap behavior follow §8.

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

Layout is deterministic: identical input graph ⇒ identical layout. Siblings are ordered by their
fractional-index order key, never by `id`, so a load and a live edit place the same pixels. Layout runs
on the main thread, synchronously, before the first paint and again on every structural, order, colour
or (for an engine that reserves caption boxes) name change.

**Every picture of a tree is drawn by the same engine as the canvas.** The gallery SVG portrait renders
the tree's own canvas positions, and so do the quest thumbnails and the paste ghost — the picture
follows the tree, never the surface. Social link previews use stored assets or a generic fallback and
need not match the live page (`og-tree-cards.md`); sharing performs no image capture or upload.

### 5.1 The four engines

All four are pure, synchronous, deterministic and iterative, so a chain thousands of steps deep is no
deeper. `?layout=<name>` before or after the hash picks one; nothing in the UI offers the switch.

| Engine | Role | The picture |
|---|---|---|
| **`bubble`** | **the default — what every reader sees** | children on rays around each parent, inside the circle holding its whole subtree |
| `radial` | the fallback, bundled beside bubble | the burst: one ring per trunk depth, children fanned into angular wedges |
| `rings` | `?layout=rings` | concentric depth rings, contour-packed in angle space |
| `mindmap` | `?layout=mindmap` | twelve compass branches, each a tidy tree with horizontal captions |

Bubble and radial are statically imported; rings and mindmap load on demand. Radial answers when
an alternative import fails or a layout throws. The result carries the engine that produced its
positions, so reorder behavior and saved cameras follow the effective layout.

### 5.2 Bubble — the shipped layout

1. Over the trunk arborescence, bottom-up: each node gets the shortest ring on which every child's
   circle clears its own and, seen from the node, the children's arcs do not overlap.
2. Children sit on rays around that ring, each facing its parent, with an arc of `π/3` left free on
   the parent side so the in-edge reaches the node between no children. A root has no in-edge, so its
   children spread around it, never further apart than `π/9`.
3. A post-order tuck slides each rigid subtree inward along its own ray until footprints, or resting
   trunk edges, touch — with a margin of 8 CSS px at the working zoom.
4. Subtree circles are rounded up to a 24 wu step and island circles to 96 wu, so a small change in
   one caption rarely reseats an ancestor.
5. Roots are islands: the largest is pinned at the origin and the rest settle by front-chain circle
   packing.

The tuck is limited to `max(1,000,000, 2048 × nodeCount)` work units. If the budget runs out,
the unfinished move is discarded and the remaining subtrees keep their enclosing-circle seats.
Large trees may therefore be looser. The budget depends on input structure, never elapsed time,
so devices retain the same layout; it is not a wall-clock latency guarantee.

A node reserves its caption's box, not just its disc: `footprintOf(label)` is the disc-plus-caption
rectangle in world units, estimated from the label's length alone (6.65 px per character), never
DOM-measured, so every device lays a tree out byte-identically.

Bubble declares `reorder = 'parent-arc'`: siblings reorder around their trunk parent within an open
fan. Roots have no parent arc and remain in their packed islands. Radial declares `'ring'` around
the world origin; rings and mindmap declare `'none'`. `angular-reorder.md` owns the gesture.

On the 476-step dogfood tree this puts a trunk parent and its child 3.4 node bodies apart, 93.5% of
families on one screen, and 24–25 steps in the working window, with no two reserved boxes overlapping.
`docs/design/roadmap/readability-research.md` is the measured record and names what it costs.

```
NODE_SIZE      = 56       // the one size the renderer draws today
SIZE(d)        = 96 × 0.8^d, clamp [40, 96]   // §2.1 — specified, not built
ENGINE         = bubble (default) · radial (fallback) · rings · mindmap, via ?layout=<name>
IN_EDGE_GAP    = π/3      // bubble: arc kept free on a node's parent side
ROOT_SPREAD    = π/9      // bubble: widest a root's children spread
RADIUS_STEP    = 24       // bubble: subtree circles round up to this (islands, ×4)
CAPTION        = 14px on a 20px line · ≤2 lines inside 168px · 8px under the rim · 6.65px/char reserved
BEND_FRACTION  = 0.18     // control-point offset as fraction of branch length
LABEL_GAP      = 8
HIT_REACH      = 24 pointer · 44 touch   // CSS px radius; extension capped at ½ neighbor distance
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

- **Pan and zoom:** drag empty canvas to pan; wheel zooms about the cursor, pinch about the fingers.
  The minimum is half `min(fitZoom, workingZoom)`, including for a tiny tree; pinch caps at 2.5×,
  other zoom controls at 6×. Read-only pan has 80px of soft slack past the tree's bounds.
- **Working view:** ordinary bodies are 52 CSS px on desktop and 40px on a phone. Focus and default
  glides never go below that zoom; a whole-tree fit never goes above it. Bodies have a 6px visual
  floor, 9px for crowned roots.
- **First view:** restore a saved camera only for its effective layout and camera format. An owner
  without one opens over the frontier's trunk family at the working zoom, without arrival motion.
  A visitor gets a whole-tree fit and the arrival ceremony. Measured chrome can reframe the opening
  for 1.2s; camera input ends that adjustment.
- **Focus (`F`):** frame the selected step, else the frontier, with its trunk parent and children
  when the family fits at the working zoom; otherwise frame the step alone.
- **All steps (`0`):** fit the whole tree inside the visible canvas, capped at the working zoom.
  Both verbs are visible in desktop controls and under the phone wordmark; list view has no camera.
- **Select:** click or tap a fruit to open its detail, including the reason a locked step is locked.
  The drawn disc remains selectable. Beyond it, hit extension reaches a 24px pointer / 44px touch
  radius, capped at half the nearest-neighbor distance. Below the working zoom an ambiguous crowded
  tap zooms around the point without selecting.
- **Captions:** fixed 14px/20px text, up to two lines inside 168px with overflow ellipsized. Priority
  is selected → hovered → selected trunk family → landmarks → active/available → remaining steps.
  Ordinary drawn body diameter sets the eligible rank: landmarks below 12px, frontier from 12px,
  everyone from 18px; selection and hover keep their names. Seats avoid other names, discs and chrome,
  preferring below → above → right → left; a ribbon crossing is allowed if no clear seat exists.
  Eligibility holds for 200ms before appearance or removal, with a 150ms fade.

## 9. Performance

- Pre-bake glow as textures rather than a per-frame blur once node counts pass ~50.
- Batch all branches into one draw; redraw only when the graph or layout changes, not every frame —
  the pulse is on glows, not branches.
- Drive pulses from a single shared clock feeding all halos the same phase (optionally offset by node
  seed); never run N independent tweens.
- Cull nodes and labels outside the camera view at large graph sizes.

## Known gaps

- §2.1's depth taper and milestone bump are unbuilt; every node renders at `NODE_SIZE`.
- The `Windmill · Marketing` boards and the landing scenes draw the radial burst, not the bubble tree
  the app now draws. Filed as **F50** in `../../consistency.md`.

---

**Reference implementation:** `web/src/products/roadmap/ui/tree/SkillNode.jsx` and
`SkillConnector.jsx` for the DOM look; `web/src/products/roadmap/layout/` for placement.
