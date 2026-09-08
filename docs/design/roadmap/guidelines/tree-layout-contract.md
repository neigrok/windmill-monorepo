# Windmill Tree — Layout & Render Contract

The rules for rendering the roadmap skill-tree canvas on the GPU. Production is a hand-rolled WebGL2
renderer (`web/src/products/roadmap/scene/`); the React `SkillNode` / `SkillConnector` components are
standalone DOM specimens. This contract describes the production canvas; differences in their
resting state treatments are tracked in `docs/design/consistency.md`. Palette values bridge
`web/src/styles/tokens/` through `theme.js`.

> **Metaphor:** circular steps grow outward in ordered generation bands. Major branches have
> separate sectors; wide generations wrap into concentric rows. Colour comes from `kind`, while
> rings and fill intensity carry progress. Connections reveal dependency structure on inspection.

> **Motion:** finite ceremonies follow `../../guidelines/motion-language.md`. Production nodes
> have no continuous resting halo; §7 records the canvas treatment.

---

## 1. Coordinate model

- Work in an unbounded world space (float units = px at zoom 1.0). The root node sits at world origin
  `(0, 0)`; pan/zoom is a camera transform on the stage, never baked into node coords.
- One container per node (disc + label) at the node's world coordinate. One batched layer for all
  branches, beneath the node layer.
- Batched connectors draw below instanced node bodies and finite event effects. DOM captions
  and interaction chrome sit above the canvas.

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
treatment (§3) uses fill intensity and static rings; event halos are finite.

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

Production treatment (`NodeBatch.js`):
- **locked** — a dim kind fill and ring against the canvas.
- **available** — flat base fill and kind ring.
- **active** — flat base fill with a static dashed status ring.
- **complete** — flat base fill with a static outer status ring.

Roots keep their larger body and one quiet structural ring. Hover and selection add immediate
feedback. Ordinary resting nodes have no center bloom or continuous glow.

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

### 3.1 Event halos

Bloom and arrival pulses produce a finite halo, gated by reduced motion. They settle back to the
static status face. Selection has its own ring; grouped selection retains its bark treatment.

## 4. Branches (connectors)

- Connectors are stable, gently bent bezier ribbons. Stroke width is measured in screen pixels.
- At working zoom, resting links show the primary parent forest at 1.25px and 26% opacity.
  Both endpoints must be near the viewport. Unrelated resting links fall to 12% during inspection.
- Hover or selection reveals incident dependencies and the ancestor path at 2px and 86% opacity.
  Secondary DAG links remain in the model and appear in that context, explicit edge selection,
  editing feedback, or a finite travel ceremony. Completion alone does not brighten resting links.
- Below a 20px projected ordinary body, the overview shows a shallow backbone capped at 64 links.
  Deep cross-canvas ribbons are hidden. Rendering and picking share the same visibility predicate.

## 5. Layout

Layout is deterministic: identical input graph ⇒ identical layout. Siblings sort by their order
key, creation stamp, then ID. Positions belong to layout; gestures change sibling order. **A live gallery SVG portrait must
render the tree's own canvas positions** — mode follows the tree, never the surface. Social link
previews use stored assets or a generic fallback and need not match the live page
(`og-tree-cards.md`); sharing performs no image capture or upload.

### 5.1 Structured radial placement

1. A single root sits at the origin. Its trunk children are the major branches. In a forest,
   the roots are the major branches. Colour changes inside a subtree do not create new sectors.
2. Major branches receive equal angular sectors. Each sector is laid out independently.
3. Breadth-first traversal forms logical generation bands. A parent's children remain contiguous
   in the authored full sibling sequence. Wide bands wrap into concentric rows.
4. At reference working zoom, same-row centers are at least 208px apart, radial rows are 240px
   apart, and the next generation starts 320px beyond the preceding generation's outermost row.
5. Reserved body/caption footprints stay at least 128px apart across neighboring sector borders.
   The full two-line footprint determines conservative arc capacity. There is no per-node packing.

The engine is synchronous and cached. Cache inputs include node IDs, prerequisites, sibling order,
raw color, and creation stamps. Zoom never changes world placement. Layout and scene share the
geometry constants in `model/geometry.js`.

```
NODE_SIZE          = 56
WORKING_BODY       = 52   // CSS px
WORKING_ZOOM       = 52 / (56 × 0.84)
ROW_PITCH          = 240 / WORKING_ZOOM
GENERATION_GAP     = 320 / WORKING_ZOOM
NODE_PITCH         = 208 / WORKING_ZOOM
SECTOR_GUTTER      = 128 / WORKING_ZOOM
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
| **Root / completed status** | static structural and status rings; no continuous resting halo. |
| **Active status** | static dashed ring. |
| **Hover** (inspectable nodes) | scale 1.06 over 280ms cubic smoothstep, including locked nodes. Feedback-class: never queued. |
| **Press** | scale ~0.97, soft release, no bounce. |
| **Unlock** | finite dependency travel temporarily reveals a 2px context stroke; child ignition starts at 85% of travel duration plus seeded jitter. Resting edges do not stay bright because of completion. |
| **Tier rise** | a 620ms sine-shaped scale/halo window starts at ignition; scale peaks at 1.05 available, 1.02 active, or 1.10 complete. Event halo returns to zero; ordinary downward state application schedules no growth ceremony. |
| Reduced motion | node fill fades over 150ms; event scale, halo, pulse and moving travel heads are suppressed. Camera movement snaps and status rings remain static. |

Finite animation stamps share the scene clock. Resting node status does not animate.

Easing tokens: `--ease-soft = cubic-bezier(0.16,1,0.3,1)`, `--ease-glow = cubic-bezier(0.45,0,0.15,1)`,
`--ease-standard = cubic-bezier(0.4,0,0.2,1)`. Durations: fast 150 / base 280 / slow 480 / glow 2400
(ms).

## 8. Camera / interaction

- **Pan and zoom:** drag empty canvas; wheel/pinch keep the pointer anchor. Wheel zoom spans
  0.00001–6; pinch spans 0.00001–2.5, allowing even very deep graphs to fit.
- **All steps:** fit the complete node bounds inside the visible canvas, excluding chrome and the
  detail panel. Preserve the last working view when leaving it.
- **Focus:** reveal the selected step at a readable scale, restore the saved working view, or focus
  a meaningful root with nearby children, or a stable major-branch anchor with a useful local
  neighborhood. A newly focused step reaches at least 52px; restoring a saved view retains its zoom.
- **Select:** open the step's detail panel. Locked steps remain inspectable so prerequisites can be
  understood. Desktop detail shows the full title; the phone owner sheet's single-line title needs
  the rename control for long names, pending a wrapping-header follow-up.
- Working captions stay horizontal at 14px/20px, 8px below their own bodies. Hover and selection
  receive priority. Obstructed captions are omitted, never floated away from the node.
- Below a 20px ordinary body, overview group boxes show major-branch names and exact subtree
  counts at occupied-sector centroids. These are noninteractive summaries; they do not label
  individual dots. Collisions can omit groups. Zoom or Focus enters the working view.
- Sibling reorder chooses the nearest radial row, then an angular insertion slot mapped back to
  the full sibling sequence. The ghost follows the target row; undo restores the authored order.
- Stored cameras carry a layout version. A mismatched camera preserves the selected step for
  refocus, or opens the overview when no surviving selection exists.

## 9. Performance

- Node fills, rings, and finite halos are procedural in the instanced shader.
- Batch all branches into one draw. Rebuild connector geometry on graph changes; the frame loop
  draws cached geometry and animates through uniforms.
- Drive finite pulses from the shared scene clock; never run N independent resting tweens.
- Cull caption candidates to the visible viewport and bound the candidate pool. Cache text
  measurement between model/font changes. Large spatial queries scan occupied data, not empty area.

## Drawing reconciliation

Figma canvas boards and standalone DOM specimens need the structured rows, branch gutters, quiet
resting state, named overview groups, and Focus/All steps chrome. The available-state material
difference is tracked separately in `docs/design/consistency.md`.

---

**Production implementation:** `web/src/products/roadmap/scene/` for rendering and interaction;
`web/src/products/roadmap/layout/` for placement.
