# Roadmap readability — research note

Why the tree canvas was unreadable, the foundation that answers it, and the four layout engines
measured side by side on the same tree. **The owner has chosen bubble as the layout every reader gets,
and has kept the 168 px caption reserve** (§5); the calls still open are in §5 too.

Every number here was produced by running code. The tree is the Windmill dogfood roadmap — 476 steps,
618 links, 9 roots, 411 complete — pinned as `web/test/products/roadmap/fixtures/dogfood-tree.json`
and seeded into a local backend for the browser runs. §2 measures the shipped renderer at `9ea38ea6`
against a snapshot of the same tree taken one step larger (477); everything else measures this branch.
§6 reproduces all of it, §8 lists what nobody has measured yet.

## 1. The complaint

Three sentences, all about the first screen a reader opens:

- the fruit are too small,
- the names are unreadable,
- the steps are too far apart.

## 2. What made it unreadable

Three mechanisms. Any one of them is enough on its own.

**A caption is drawn in world units, so zoom never separates two names.** The overlay sets the font to
`NODE_SIZE × 0.23 × zoom` px and shows a caption from zoom 0.5 — where it is **6.4 px** tall. Caption
width and neighbour spacing both scale with zoom, so the collision is zoom-invariant: a median
37-character label is **267 wu wide — 4.8 node bodies** — while the layout's sibling floor is 95.2 wu
and the median adjacent-sibling distance 142 wu. 460 of 477 labels are wider than that floor. The pool
is the 64 nodes nearest the viewport centre, ranked by distance, with no collision test and no
priority — an estimated 70 caption boxes overlap another caption and 63 cross another node's body, at
every zoom.

**The first view is the whole tree, and the whole tree is 16k wu across.** Bounds 15,953 × 17,746 wu
fit a 1440×900 canvas at zoom **0.0456**: a **2.1 px** body, no caption anywhere, 477 dots. A 390×844
phone fits at 0.022 — a 1.0 px body. The zoom-in button steps ×1.2, so **15 presses** separate that
first view from the camera's own 0.6 focus floor, and 18 from a 14 px caption.

**One crowded pair pushes every branch apart.** A ring's radius is `max(previous ring + clearance,
MIN_ARC / the tightest angular gap anywhere on that ring)` — one radius per depth, shared by every
branch of every root. The tightest pair on ring 2 sits 1.7° apart, which lifts that ring from 921 to
**3,132 wu**: 2,376 wu of empty band between every root and every one of its 28 children, in branches
that gained nothing. Without the arc floor the outer radius would be 3,175 wu instead of 9,551. The
trunk parent→child median is **1,014 wu — 21.6 bodies**; at the focus floor (zoom 0.6, body 28 px,
caption 7.7 px) that is 609 px, 68% of the viewport height. A parent and its child do not fit on one
screen together.

## 3. The foundation

What the branch fixes, ahead of any layout choice. The renderer, the captions and every engine read one
set of constants in `theme.js`; the node shader interpolates the same numbers into its GLSL, so a drawn
disc cannot drift from the box a layout reserved for it.

**Captions are CSS px, never world units.** 14 px on a 20 px line, at most two lines inside a 168 px
box, with overflow ellipsized on the second line, 8 px below the rim, a 2 px halo in the canvas colour
so a ribbon under a name never cuts the glyphs. `scene/captionLayout.js` decides them;
`scene/NodeOverlay.js` measures the text once per label
and moves the elements.

**Which steps are named is a rank, and the zoom says how far down it reaches.** selected → hovered →
the selected step's trunk family → landmarks (crowned roots, and branch heads carrying eight steps or
more, biggest subtree first) → the frontier (available) → the rest. The limit is keyed on
the body **as drawn**, never under the 6 px floor: from 18 px everyone, from 12 px the frontier, below
that the landmarks alone.

**A seat is a seat that is clear.** One 64 px collision grid holds three kinds of obstacle — the names
already placed and the corners chrome holds, the disc rims, and the ribbons actually drawn (each edge's
own bow, sampled where it crosses the caption area). A caption takes the first seat clear of all three,
tried last-seat-first then below → above → right → left; failing that, one that only crosses a ribbon,
because a name on a branch beats a step with no name. The selected and hovered captions are never
dropped; a crowned root below the working view is placed where it stands, over dots and threads but
never over another name. 200 ms of unbroken placement before a caption appears, 200 ms of unbroken loss
before it goes, 150 ms fade. Pool 96, at most 288 candidates a pass.

**The working zoom.** `WORKING_ZOOM` is the zoom at which an ordinary body is **52 CSS px** (1.105);
`PHONE_WORKING_ZOOM` puts it at **40 px** (0.850). Focus frames at the working zoom; default glides
keep at least that zoom, and every whole-tree fit caps there.

**Floors, so nothing vanishes.** A drawn body never goes under 6 px, 9 px for a crowned root — a shader
uniform grows the whole quad, so halo and crown grow with it, and the caption rule reads that same
floored body. The zoom floor is dynamic: half the smaller of the fit zoom and working zoom, so a wheel
or pinch can back off from All steps even on a tiny tree. The drawn disc stays selectable; beyond it,
hit extension reaches a 24 px pointer / 44 px touch radius, capped at half the nearest-neighbor distance.
Below the working zoom an ambiguous crowded tap glides the working view in around the point.

**The first view.** An owner with no saved camera opens at the working zoom over the frontier step's
family, arrival suppressed — the frontier being the selection the device remembers, else the top
Next-up row, else the most recent completion this browser witnessed, else the crown of the largest
tree. A visitor keeps the whole-tree fit and the arrival ceremony. Chrome whose height is its content's
publishes its measured box a beat after the first paint, so the first view is framed again on each one
until 1.2 s pass or the reader moves the camera. A saved camera is stamped with the engine name and a
camera format; one saved under another engine comes back null.

**Focus · All steps.** Two camera verbs, one each. **Focus** (`F`) is the working zoom over the step's
trunk family — the box holding it, its trunk parent and its trunk children when that box fits the
frame, else the step alone. **All steps** (`0`) is the whole tree inside the visible area, capped at the
working zoom. Desktop: two text buttons in the zoom group. Phone: an always-visible pair under the
wordmark.

**Chrome the camera knows about.** `ui/viewport.js` is the only place that says what the chrome covers:
full-width insets per breakpoint and view state for the bar, dock, sheet and lane, plus corner blocks
(the minimap always, the legend dock from its measured box) that take no inset — the camera still
centres behind them — but that no caption may sit under.

**The layout door.** `layout/index.js`: `?layout=radial|rings|bubble|mindmap`, before or after the hash,
picks the engine; **bubble is the default**. Bubble and radial are statically imported; rings and
mindmap load on demand. `loadLayoutEngine` answers a failed alternative import with radial, and
`layoutTree` answers a throwing engine with it, logging the failure. Each result includes its positions
and effective engine, so camera persistence and reorder hints follow the layout that actually drew.
`pageLayoutEngine()` resolves the page's selected engine for the canvas, quest thumbnails and paste
ghost; all three run it through the same fallback guard. Each engine names itself with `layoutName`
and declares `reorder` (`'ring'` around the origin, `'parent-arc'` around a trunk parent, or `'none'`)
and `readsCaptions` (whether a rename has to re-run it). All four are pure, synchronous, deterministic
and iterative, so deep chains do not consume the JavaScript call stack.

## 4. The four layouts on the dogfood tree

Distances in CSS px at the desktop working zoom (52 px bodies), from
`web/scripts/benchmark-roadmap.mjs --only dogfood`; caption counts from the rig captures
(desktop 1440×900, phone 390×844 dpr 3, `--focus`).

| | radial | rings | bubble | mindmap |
|---|---|---|---|---|
| trunk parent→child, median px (bodies) | 1111 (21.4) | 217 (4.2) | **178 (3.4)** | 208 (4.0) |
| p90 px | 1331 | **464** | 491 | 539 |
| links over 700 px | 63.6% | **3.4%** | 4.9% | 7.5% |
| nearest neighbour, median px (bodies) | 177 (3.40) | 142 (2.72) | 136 (2.61) | 112 (2.15) |
| family on one screen | 39.2% | **96.2%** | 93.5% | 92.5% |
| in the working window, around the frontier step | 4 | 22 | **25** | 22 |
| in the working window, around a mid-tree step | 5 | 17 | **24** | 8 |
| footprint overlaps (reserved boxes) | 98 | **0** | **0** | **0** |
| caption overlaps, all 32 captures | 0 | 0 | 0 | 0 |
| bounds wu (aspect) | 15892 × 17612 (0.90) | 9779 × 7848 (1.25) | 9961 × 5396 (1.85) | 6383 × 8623 (0.74) |
| body at All steps (floor 6 px) | 2.0 px | 4.6 px | **6.1 px** | 4.2 px |
| first view: on screen · named, desktop | 10 · 8 | 25 · 17 | 18 · 12 | 24 · 17 |
| first view: on screen · named, phone | 5 · 4 | 16 · 5 | 12 · 5 | 20 · 4 |
| named at All steps, desktop / phone | 8 / 3 | 9 / 7 | 9 / 5 | 10 / 6 |
| layout, 476 steps | **0.40 ms** | 55.9 ms | 29.0 ms | 4.1 ms |
| reorder hint | `ring` | `none` | `parent-arc` | `none` |

Timings are offline medians of five, not frame-time measurements. Bubble's current bounded-tuck
timings and runtime are described in §7. The other engines' recorded runs used Node 20 on Apple
M3 Pro. Geometry is deterministic — two runs of one engine over one tree serialise byte-identically.

**What each one looks like.** The fruit use the same shader on all four: kind hues, the locked
wash, the complete halo and the crown at 1.55× carry over. The silhouette
is what changes, and the minimap, `share/TreePortrait.js` and every gallery card draw whatever the
engine draws.

- **radial** keeps the burst the marketing boards and hand-authored landing scenes draw. It closes
  the size and the text complaints and nothing else: 21 bodies between a parent and its child, 39% of
  families on one screen, 98 reserved boxes overlapping.
- **rings** is the same picture made honest — one crown at the world origin, fruit on depth rings,
  a wreath at the working view — at 4.2 bodies and 96% of families on one screen. It pays at the fit,
  which reads as two blobs, with three unlinked roots floating 12.7–19.2 bodies out of the pack, and
  56 ms a layout.
- **bubble** answers the distance complaint outright: 3.4 bodies, 24–25 fruit in the working window,
  the only engine whose whole-tree fit clears the 6 px body floor on its own. It pays with identity —
  no rings, no centre, a scatter for a minimap — and a first view whose top band is empty because the
  frontier's neighbourhood is.
- **mindmap** measures well (4.0 bodies, 92.5% of families) and reads as an org chart: **400 of 476
  steps share an x with five or more others, the longest column 64 deep**. The overview is a totem.

## 5. What the owner decided, and what is still open

**Decided — bubble is the layout every reader gets.** `DEFAULT_LAYOUT` is `bubble`; `?layout=` still
opens the other three and nothing in the UI offers the switch. It answers the distance complaint
outright — 3.4 bodies between a trunk parent and its child against radial's 21.4, 24–25 steps in the
working window against 4–5, 93.5% of families on one screen against 39.2% — and it is the only engine
whose whole-tree fit clears the 6 px body floor by itself. What it costs is written down rather than
argued away: no rings and no centre, so the overview and the minimap read as a constellation; a
synchronous layout with a deterministic tuck-work ceiling (§7); and `readsCaptions`, so a rename
re-runs it where radial never re-ran.

**Decided — the 168 px caption reserve stays.** `theme.js CAPTION.maxWidthPx` is 168, which is the
number every measure on this page was taken at. Captions have up to two lines inside that reserve;
overflow ellipsizes. The reserve is a caption width, not a fixed distance between node centers.

**The camera and gesture contract.** The phone working view uses 40 px bodies and 44 px camera
button targets. Focus and All steps remain visible in canvas view; a crowded tap below the working
zoom zooms in before selection. Bubble's sibling reorder follows the parent's open arc, with no
root drag. These rules live in `guidelines/tree-layout-contract.md`, `responsive.md`, and
`angular-reorder.md`.

The marketing boards and hand-authored landing scenes draw a radial burst. Their bubble redraw is
the design follow-up **F50** in `../consistency.md`.

Still open:

1. **Cross-branch edges at rest.** 129 of 618 links leave the trunk. In sparse views the hairlines from
   nowhere to nowhere outnumber the family's own ribbons. Options: leave them, quieten their rest
   alpha, cull an edge with both ends off the canvas at the working zoom, or draw stubs.
2. **Visitor entry evaluation.** The shipped entry is whole-tree fit plus arrival. A frontier entry
   remains a possible experiment; the fit names crowns and the biggest branch heads.
3. **The fixture's two roots both named "Windmill".** `a679631b-d65c-4a4c-a00b-ad04be0ecc1a` (5 children) and
   `product` (2 children). Both are named at once in every All-steps capture, and the plaque already
   reads "Windmill | Windmill". Any rename on the live tree requires its own data review and a
   fixture recapture.

## 6. Reproducing the numbers

Offline, no browser — the readability metrics for every engine over the dogfood tree and the synthetic
shapes:

```
cd web
node scripts/benchmark-roadmap.mjs --only dogfood
node scripts/benchmark-roadmap.mjs --only shapes --sizes 500,2000,5000 --json bench.json
node scripts/benchmark-roadmap.mjs --layouts bubble --sizes 5000 --json bubble-bench.json
npm test                                  # the engine tests pin these same measures
```

In a browser — captures and measurements of the live page. `web/scripts/roadmap-rig/APPARATUS.md` is
the apparatus: backend on 8088, one vite per worktree, headless Chrome over raw CDP.

```
cd web/scripts/roadmap-rig
WM_RIG_USER=<uuid> ./start-backend.sh
./start-vite.sh "$(git rev-parse --show-toplevel)" 5175
node seed.mjs --backend http://localhost:8088 --cookie $WM_RIG_COOKIE
node --experimental-websocket capture.mjs --origin http://localhost:5175 --tree t_9362d9bc883e0a1e \
     --cookie $WM_RIG_COOKIE --out <dir>/desktop --port 9401 --layout rings --focus --caption-mode fixed
node --experimental-websocket capture.mjs --origin http://localhost:5175 --tree t_9362d9bc883e0a1e \
     --cookie $WM_RIG_COOKIE --out <dir>/phone --phone --port 9402 --layout rings --focus --caption-mode fixed
```

Each run writes `overview`, `working`, `selected` and `allsteps` PNGs plus `measures.json` (camera,
body px, caption count and font, overlapping pairs, nodes on screen, the two hit-floor taps at the
fit). The app opens on bubble; to read another engine by hand, `?layout=<name>` before or after the hash
picks it: `http://localhost:5175/?layout=radial#/app/t_9362d9bc883e0a1e`.

## 7. Known limits

**Every engine.** Layout is synchronous on the main thread — once before the first paint, and again on
every signature change (structure, order, colour, and for the three caption-reading engines, a rename).
There is no worker or enforced wall-clock latency budget. Bubble's tuck has a deterministic work
budget of `max(1,000,000, 2048 × nodeCount)`, counting subtree passes, queried grid cells, and
candidate entries. Exhaustion discards an unfinished subtree move and leaves remaining seats
at their enclosing-circle positions; it trades compactness for bounded tuck work without choosing
different geometry on faster devices. Boxes spanning more than 64 grid cells are stored once;
a query wider than the rectangle set scans that set instead of every cell.

| 5,000 steps | radial | rings | bubble | mindmap |
|---|---|---|---|---|
| mixed | 3.3 ms | 1.5 s | 207 ms | 67 ms |
| broad | 3.1 ms | 331 ms | 202 ms | 52 ms |
| deep (chain of chains) | 2.7 ms | 28 ms | 188 ms | 4.9 ms |
| multiroot | 1.5 ms | 432 ms | 251 ms | 11 ms |

Bubble values are the final graduation offline run, median of five; they measure layout calls
alone, not live edit or frame latency. The same run reports finite, deterministic positions and
zero reserved-footprint overlaps for all five fixtures, including dogfood. Runtime context is
recorded in `bubble-graduation.md`.

- **radial** — the ring rule that §2 measures is still the ring rule: at 5,000 mixed steps the bounds
  are 459k × 452k wu, 92% of trunk links are over 700 px, and the whole-tree fit puts a body at 0.1 px
  before the 6 px floor. It reads no caption, so a rename never re-runs it.
- **rings** — the fit is the weak frame: the box is 1.25:1, but the concentric rings only read past
  zoom ≈0.08, so All steps is two blobs and a scatter of lone roots. Those three unlinked roots sit
  12.7–19.2 bodies from the pack — the engine seats an island, and a one-step island is a stray the
  owner should connect. It is also the least stable under an edit: a rename that pushes one name onto
  a second line moves up to 475 of the 476 seats, by as much as 3,837 wu (81 bodies), and the scene
  glides every one of them. 56 ms a layout here, 543 ms at 2,000 steps.
- **bubble** — large or deeply nested trees can exhaust the tuck budget and retain a looser
  enclosing-circle layout. The ceiling does not cover every phase or guarantee an interactive
  latency. There is no shared center or depth cue at the fit. A 200-leaf fan puts its children on one
  ring about 4,300 px out, because children sit on rays around their parent. A rename moves 5–346
  seats, none of them further than 157 wu.
- **mindmap** — the columns above are the identity, not a defect to tune: a tidy tree with captions
  below the disc stacks by construction. It is the steadiest under an edit (a rename moves at most 272
  seats, none further than 64 wu) and the cheapest of the three.

**Ribbons.** No engine routes an edge around a caption. The placer keeps captions off ribbons where it
can and crosses one rather than leave a step unnamed, so a name over a branch is expected, not a bug.

**Frame cost.** The rig's captures run on SwiftShader, which holds 20–30 Hz with a 0.1 ms tick and
stalls the first frame after a model install: no fps, frame-interval or settle timing may be read from
a capture. A GPU run is the only source for those.

## 8. Not verified

- Real-device pixels. Every capture is headless Chrome on SwiftShader at dpr 1 (desktop) and 3 (phone);
  geometry and DOM measurements are unaffected, glyph rasterisation may differ.
- Rings edit stability on a live page. Bubble's create, long rename, progress and delete sync path,
  sibling reorder with undo, and camera restoration have live local-stack coverage recorded in
  `bubble-graduation.md`; sustained large-tree editing remains unmeasured.
- The arrival cascade and reduced motion on a visitor's first view: no read-only session was captured.
- Frame timing on this branch: no GPU run is recorded in the repo, and the checked-in rig cannot
  measure it.
