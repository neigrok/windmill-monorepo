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
| Fruit diameter | `size` (56) |
| Fruit shape | a perfect circle — no stem, no gloss, no lopsided blob |
| Ring (border) | `2 * u` px stroke, color = state ring (§3) |
| Icon box | `0.4 * size` (≈22px), centered; ink per tier (§3) |
| Label | below the node, gap `8u`; `--text-sm` (14px) weight 700, centered |
| Hit area | circle radius `size/2 + 4` (locked = non-interactive) |

**Fill is flat.** A single flat, saturated kind colour — no gradient, no gloss highlight. The tier
treatment (§3) supplies depth through fill weight, ring and glow, never a light-spot gradient.

### 2.1 Node sizing — taper + milestone bump

Size encodes structure, never metrics.

- **Depth taper (automatic default):** `SIZE(d) = 96 × 0.8^d`, clamped to **[40, 96]** world px — the
  goal is the biggest fruit; each ring outward gets finer. Depth is granularity.
- **Milestone bump (user override):** a step marked *milestone* renders one depth-step larger —
  `SIZE(max(0, d − 1))`. Undo-able, panel-driven, deterministic. New steps need no decision.
- Everything scales in `u = size/56` (§2): ring 2u, icon 0.4·size, glow radius ≈ 0.9·size.
- **Clamps that keep small nodes usable:** hit area never below 44px regardless of visual size; label
  font scales with u but clamps 12–16px and never disappears before the zoom threshold (§8).

## 3. Kind colours & tier treatment

A node's colour comes from its `kind` (one of six palette hues), not its progress. Its tier
(`locked | available | active | complete`) is a treatment on that same hue. Gold is a kind, not a
state.

| Kind | Soft (−200 step) | Base (fill + ring) | Glow |
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

Dark theme brightens each base to its `-400` step and pushes glow alpha to ~0.8; the tokens live
under `[data-theme="dark"]` in `tokens/colors.css`.

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

Layout is deterministic: identical input graph ⇒ identical layout; sort children by `id` before
allocating. Manual per-node nudges override it (`applyNudges`). **The share portrait always renders
the tree's own canvas positions** — mode follows the tree, never the surface, so a tweet, the gallery
card and the live page match.

### 5.1 Radial

The root sits mid-canvas and children fan out in all directions:

1. Root at origin, owning the full angular range `[0, 2π)`.
2. **Depth ring radius:** a node at depth `d` sits at radius `R(d) = d * RING_GAP` from the root,
   `RING_GAP = 190` (≈ `2.6 × (nodeSize+label)`). Tighten to 170 for dense trees, loosen to 220 for
   sparse.
3. **Angular allocation, weighted by subtree size:** a parent owning span `[a0, a1]` splits it among
   its `n` children proportional to each child's leaf count (descendant count + 1), so bushy branches
   get more room. Each child sits at the center angle of its slice, at radius `R(childDepth)`.
4. **Root special case:** the root's direct children divide the full circle, so with 3 children they
   sit ~120° apart.
5. **Min separation:** after placement, if two siblings are closer than `nodeSize + 24`, widen their
   slices or bump `RING_GAP` for that subtree. A couple of relaxation passes is enough; avoid full
   physics.

### 5.2 Dagre — at scale

Top-down dagre: `rankdir: TB`, `nodesep = NODE_SIZE × 1.6`, `ranksep = NODE_SIZE × 2.4`, rank =
dependency depth. The cascade's depth ring (motion §3) maps to the dagre rank, so ceremonies read the
same either way. Run it off the main thread; never block input on a relayout. The mode threshold is a
hysteresis band around ~48 nodes, not a hard flip — a tree crossing it relayouts on its next load,
never mid-session.

```
NODE_SIZE      = 56       // the one size the renderer draws today
SIZE(d)        = 96 × 0.8^d, clamp [40, 96]   // §2.1; milestone bumps to SIZE(d−1)
MODE           = radial ≤ ~48 nodes · dagre above (hysteresis, relayout on load)
RING_GAP       = 190      // radial: distance between depth rings
DAGRE          = rankdir TB · nodesep 1.6×NODE_SIZE · ranksep 2.4×NODE_SIZE
MIN_SIBLING    = SIZE(d) + 24
BEND_FRACTION  = 0.18     // control-point offset as fraction of branch length
LABEL_GAP      = 8
HIT_MIN        = 44       // px — hit disc floor at any visual size
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

- **Pan:** drag empty canvas → translate stage. **Zoom:** wheel / pinch → scale about the cursor;
  clamp 0.5×–2.5× (`responsive.md` canon).
- **Fit:** on load, compute the node bounding box and set zoom so it fits with ~64px padding; center
  on the root.
- **Select:** click a fruit → emit `select(id)`; the app opens the detail panel. Locked fruit are not
  selectable but still show a tooltip ("Finish X to unlock").
- Keep labels upright and unscaled; hide them below 0.8× zoom with a 150ms fade (`responsive.md` §5).

## 9. Performance

- Pre-bake glow as textures rather than a per-frame blur once node counts pass ~50.
- Batch all branches into one draw; redraw only when the graph or layout changes, not every frame —
  the pulse is on glows, not branches.
- Drive pulses from a single shared clock feeding all halos the same phase (optionally offset by node
  seed); never run N independent tweens.
- Cull nodes and labels outside the camera view at large graph sizes.

## Known gaps

- `RadialLayoutEngine` is the only engine in the repo. §5.2's dagre mode and the `MODE` threshold are
  unbuilt.
- That engine does not use a fixed `RING_GAP`: rings start at `NODE_SIZE × 2.8` and each is pushed
  out until its tightest neighbour pair clears an arc of `NODE_SIZE × 1.7`. §5.1's numbers and the
  engine need reconciling.
- §2.1's depth taper and milestone bump are unbuilt; every node renders at `NODE_SIZE`.

---

**Reference implementation:** `web/src/products/roadmap/ui/tree/SkillNode.jsx` and
`SkillConnector.jsx` for the DOM look; `web/src/products/roadmap/layout/` for placement.
