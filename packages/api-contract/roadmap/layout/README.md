# Roadmap layout fixtures

Roadmaps, and the picture the web's Graph draws of each: every step's seat, the tier it is drawn in, the bow of
every link, the framing of the roadmap, and where its captions sit. [Roadmap on iOS](../../../../docs/foundation/roadmap-ios.md)
§5 holds a port to every number here.

The web writes the files: `npm run generate:roadmap-layout` in `web/` (`web/scripts/roadmap-layout-fixtures.mjs`).
`web/test/products/roadmap/layout/fixtures.test.js` fails when a file is not what the web draws today, so a change
to the picture lands with regenerated fixtures or not at all. No file is edited by hand.

| File | The roadmap | Why it is here |
| --- | --- | --- |
| `learn-to-sail.json` | The design's fixture: eight steps, three of them done | The roadmap the boards draw |
| `wide.json` | One step followed by 56, every fourth of those by three | Fans wider than their free angle, so the ring is found by bisection |
| `deep.json` | A line of 160 steps with a side step every seventh and a second link every 25th | Headings that add up along a line; links across branches |
| `scripts.json` | Labels in Latin with composed and decomposed diacritics, Cyrillic, Chinese, Japanese, Arabic, Hebrew, Thai, Devanagari, emoji, emoji sequences and 40 rockets; a blank label and one of spaces; every kind of white space; zero-width marks; one word of 200 letters | A label's length and its wrapping |
| `ids.json` | Ids that are one character spelled twice or three times, ids outside the basic plane beside ids above the surrogates, and steps that tie in `ord`, in `born`, in depth and in size | Every tie the picture breaks by id, `ord` or `born` |
| `braided.json` | 48 steps, most following two or three, in three kinds | The election of the one link a step is seated by |
| `islands.json` | Four trees and three steps that follow nothing and are followed by nothing | The packing of roots |
| `archipelago.json` | 120 trees of four steps, each named in one word | More steps in a view than the captions weigh, and more names than their pool holds |
| `ceiling.json` | A line of 320 steps with side steps, and a small tree after it | It spends the tuck's whole budget of work, so the bubble layout stops part-way, as it also does on `handbook.json` |
| `fallback.json`, `fallback-roots.json` | A tree of 34 steps; three trees of 25 | Seated by the fallback layout, with one root and with several |
| `handbook.json` | 5,000 steps under one | The size the budget is measured at |
| `empty.json` | No step | The frame of nothing |
| `arithmetic.json` | | The arithmetic's own values |

## Format

- A file is one JSON object. Its text is ASCII: every other character is written as its `\uXXXX` escape, an
  astral one as two, so no tool can respell an id.
- Every number is JavaScript's shortest decimal that reads back as the same double. A reader parses it with
  correct rounding and compares doubles for equality. A negative zero is written `0`: compare by value.
- A list is in the order its rule gives; nothing is sorted for the file.

## The roadmap

`roadmap.steps` is what the room hands the layout, in the order it hands it: the domain's authored order
([domain](../domain/README.md): `ord`, then `born`, then id by UTF-8 bytes). The picture reads the order, and so
does every list below that says "in the steps' order".

| Field | Is | Read by the web as |
| --- | --- | --- |
| `id` | The step's id | `id` |
| `label` | Its name | `label` |
| `ord` | Its order key | `order` |
| `born` | The stamp of its creation, `ms:counter:actor`; `0:0:` for none | `createdAt`, as `{ms, counter, actor}` |
| `color` | Its kind's hue | `color` |
| `follows` | The ids it follows (roadmap on the engine D-5), in the order the domain's read lists them | `prerequisites` |

`roadmap.done` is the completed set, as the domain's read of progress gives it.

## The picture

- **`engine`** is the layout that seated the roadmap. `bubble` is `layoutTree(new BubbleLayoutEngine(), tree)`.
  The web seats a roadmap with `radial` when the bubble layout throws; no roadmap here makes it throw, so the two
  `radial` files are seated by `fallbackLayoutEngine()` directly, and a port seats them with its fallback.
- **`seats`** holds one `[x, y]` for each step, in the steps' order, in world units with y down.
- **`tiers`** holds one number for each step: `0` locked, `1` available, `2` complete (`UnlockRules.statesUnder`,
  then `nodeTier`). A step in `done` is complete; any other is available when every step it follows is in `done`.
- **`links`** holds one row for each id a step follows, steps in order and each step's `follows` in order:
  `from` the followed step, `to` the follower, `kind` (`trunk` where `to` is seated under `from`, else
  `in-branch` or `cross-branch`), `sway` (`bendOf(from, to)`, in [-0.5, 0.5)), and `cx`, `cy`, the control point
  of the link's quadratic curve between the two seats (`controlPoint`).
- **`bounds`** is the box around every seat, grown by 56 on each side (`SkillTree.toRenderModel`).
- **`canvases`** frames the roadmap twice: on a phone, 402 by 874 px with chrome over 158 px at the top and 140
  at the foot, and in a desktop browser, 1440 by 900 with the web's margins and the minimap holding a corner.
  `viewport`, `insets` (the px the chrome covers on each side), `blocks` (boxes the chrome holds, each anchored to
  a corner by `left` or `right` and `top` or `bottom`) and `workingZoom` are the canvas; the rest is drawn from it:
  - `fit` is the camera that shows the whole roadmap (`fitFrame`) and `floor` the lowest zoom (`minZoom`).
  - `focus` is the camera that lands on each step named (`focusFrame`): its trunk family at the working zoom.
  - `passes` is one `CaptionPlacer` given the canvas's `insets` and `blocks` once and then asked in turn, so
    each pass meets the records the passes before it left. A pass sets `selected` and `hovered`
    (`setContext`), then places at `camera` and the clock `now`, in ms (`place`). `rankLimit` is
    `captionRankLimit(camera.zoom)`: `3` names landmarks only, `4` the available steps too, `5` every step.
    `captions` are the placements in the order returned: `anchor` is `0` below the disc, `1` above, `2` right,
    `3` left; `left`, `top`, `width` and `height` are the box in screen px; `lines` is the wrapped text; `shown`
    says the caption is past its wait. `nextDeadline` is the clock at which the next caption changes, or null.
  - A caption's text is measured by the fixtures' ruler: a text is 6.65 px wide for each of its code points
    (`CAPTION.charPx`). A port measures with the same ruler to reproduce these files, whatever font it draws in.

The fixtures hold nothing of a node's glow, its glyph, the tessellated ribbon, the minimap, a gesture or a glide.

## The files a port reads

The picture is these files of `web/src/products/roadmap/`, and nothing else decides a number above. A test
(`web/test/products/roadmap/layout/arithmetic.test.js`) fails when one of them imports a file outside the list,
raises a power, or takes anything from `Math` but `abs`, `ceil`, `floor`, `imul`, `max`, `min`, `sqrt` and `trunc`.

| File | Decides |
| --- | --- |
| `layout/arithmetic.js` | sin, cos, asin, atan, atan2, hypot and π |
| `layout/index.js`, `layout/LayoutEngine.js` | Which layout seats a roadmap, and the fallback |
| `layout/BubbleLayoutEngine.js` | The bubble layout |
| `layout/RadialLayoutEngine.js` | The fallback layout |
| `model/SkillTree.js` | The topological order, the links, the bounds |
| `model/TrunkTree.js` | The link each step is seated by, sibling order, branches, link kinds |
| `model/footprint.js` | The box a step reserves, from its label's length |
| `model/UnlockRules.js`, `theme.js` | Tiers; the constants every file shares |
| `model/SpatialGrid.js` | Which steps are near a view |
| `scene/framing.js` | The fit, the zoom floor, the centre the chrome leaves, the family a focus frames |
| `scene/edgeCurve.js` | A link's sway and its control point |
| `scene/captionLayout.js` | A caption's wrapping, rank, seat and timing |

## The arithmetic

`layout/arithmetic.js` is written only from `+ - * /`, square root, comparison, `Math.floor`, `Math.trunc` and
`Math.abs`, each of which IEEE 754 defines exactly, so the same text in another language gives the same bits.
`arithmetic.json` holds, for each function, rows of its arguments and then its value: `[x, sin x]`, `[x, cos x]`,
`[x, asin x]`, `[x, atan x]`, `[y, x, atan2(y, x)]` and `[x, y, hypot(x, y)]`, at the edge of every branch, one
double to either side of it, and across seeded samples.

- No product is fused with a sum. A port compiles and writes it so that `a * b + c` rounds twice.
- Its decimal constants are each the shortest that reads as the intended double. A port copies the digits.
- sin and cos refuse an angle of 1,647,100 or more by throwing; the bubble layout then fails and the roadmap is
  seated by the fallback, whose angles lie within one turn. A roadmap of 10,000 steps turns through less than
  47,124.
- sin, cos, asin, atan and atan2 are fdlibm's, and hypot is the scaled sum V8 computes. Over 95 million seeded
  samples of normal arguments below that bound, each returned the bits of Node 20's `Math`. atan2 of a subnormal
  argument can differ from fdlibm's in its last place.
- Measured against exact values over 300,000 seeded samples of each, sin, cos, asin and atan lie within 0.83 of a
  last place of the true value, atan2 within 1.42 and hypot within 1.96: the first five return the correctly
  rounded double or its neighbour, and hypot at most the one after. The web's test pins what it measures.
- A zero keeps its sign as fdlibm's does, a NaN argument gives NaN, and `hypot` of an infinity is infinity. The
  vectors hold finite values only.

## Numbers, order and text

Beyond the arithmetic, the picture relies on these, each as JavaScript defines it.

**Rounding and integers**

- `Math.round` is not used. `Math.ceil` rounds toward +∞ (a subtree's circle is stepped up to a multiple of 24,
  an island's to one of 96) and `Math.floor` toward -∞: a cell index is `Math.floor(coordinate / cell)`, which
  for a negative coordinate is one less than truncation gives.
- `Math.sqrt` is the correctly rounded square root. `Math.max` and `Math.min` order `-0` below `0` and give NaN
  when an argument is NaN.
- `%` is applied only to a value that is not negative.
- A grid's cell key is `(i + 32768) * 65536 + (j + 32768)` as one number, so two cells further than 32,768 from
  the origin can share a key. The bubble layout's cells are 256 world units, the captions' 64 px.
- `bendOf` hashes the UTF-16 code units of `from`, `-`, `to`: `h` starts at 0 and each unit `c` makes it
  `c + ((h << 5) - h)`. `h << 5` first wraps `h` to a signed 32-bit integer and shifts it, dropping what
  overflows; the subtraction and the sum are not wrapped, so `h` leaves the 32-bit range and stays an exact
  integer. The sway is `(|h| % 100) / 100 - 0.5`.
- Typed arrays hold 32-bit integers (`Int32Array`) and doubles (`Float64Array`), zero until written.
- An expression is evaluated left to right as written: `BODY_WU * scale * WORKING_ZOOM` is two products in
  that order, and a sum over a list starts from 0 and adds in the list's order.

**Order**

- `Array.prototype.sort` is stable. Each comparator the picture sorts by:
  - trunk children and the fallback's roots: `ord`, then `born` (`ms`, then `counter`, then `actor`), then id
    (`cmpOrder`). An absent `ord` is the empty string and sorts first; an absent `born` is `0:0:`.
  - the bubble layout's roots: subtree size, larger first, then `cmpOrder`.
  - the angles on one of the fallback's rings: ascending.
  - caption candidates: rank, then subtree size, larger first, then a caption already on screen before a
    newcomer, then distance from the view's centre, then id (`byPriority`).
- A step with several links is seated by one: among the steps it follows that share its `color`, or among all of
  them when none does, the one of least trunk depth, then of least id.
- The topological order is a queue. It starts as the steps that follow nothing, in the steps' order. A step
  leaves from the front, and its followers, taken in the steps' order, each join the back once every step they
  follow has left.
- No result depends on the order a `Map` or a `Set` is walked in: where one is walked, what is taken is a
  least value, a count or a membership.
- The bubble layout's tuck spends a budget, `work.left`: at first the larger of 1,000,000 and 2,048 for each
  step, shared by every island. Each march step of each sliding step costs one. A grid query costs one for every
  rectangle the grid stores when it covers more cells than that; otherwise the number of cells it covers, one for
  every entry in those cells' buckets, and one for every rectangle too wide for the cells. The move during which
  the budget passes below zero is discarded and no later move is tried, so a port spends exactly the same: its
  grids hold the same rectangles in the same cells. Settling the islands spends nothing.
- `a.next = b.previous = b = c` assigns `c` to the `previous` of the node `b` named before the statement, then to
  `a.next`, and `b` names `c` afterwards.

**Text**

- Ids, `ord` and a stamp's `actor` compare by UTF-16 code unit (`<`, `===`), never by code point, by byte or by
  canonical equivalence: `U+1F600` sorts before `U+FF21`, and `é` as one code point is not `e` with `U+0301`. A
  map keyed by id holds both spellings.
- A label's length is its code points (`[...label].length`, `Array.from`): a surrogate pair is one, an emoji
  sequence several. The box a step reserves counts the label as given, spaces included; the fixtures' ruler
  counts the wrapped line.
- A caption is wrapped from the label trimmed and with each run of white space made one space, where white space
  is JavaScript's `\s`: U+0009 to U+000D, U+0020, U+00A0, U+1680, U+2000 to U+200A, U+2028, U+2029, U+202F,
  U+205F, U+3000 and U+FEFF. U+0085 and U+200B are not white space. A line is cut between code points, and the
  ellipsis is U+2026.

## Constants

π is `3.141592653589793`. A constant written as an expression is that expression computed in doubles, never its
decimal retyped: `NODE_SIZE * 2.8` is `156.79999999999998`.

| Constant | Expression | Value |
| --- | --- | --- |
| `BODY_WU` | `56 * 0.84` | `47.04` |
| `WORKING_ZOOM` | `52 / BODY_WU` | `1.1054421768707483` |
| `PHONE_WORKING_ZOOM` | `40 / BODY_WU` | `0.8503401360544218` |
| `TUCK_MARGIN` | `8 / WORKING_ZOOM` | `7.236923076923077` |
| `DISC_AIR` | `BODY_WU * 0.75` | `35.28` |
| `TWO_PI`, `FULL_CIRCLE` | `2 * PI` | `6.283185307179586` |
| `IN_EDGE_GAP` | `PI / 3` | `1.0471975511965976` |
| `ROOT_SPREAD_CAP` | `PI / 9` | `0.3490658503988659` |
| `RING` | `56 * 2.8` | `156.79999999999998` |
| `MIN_ARC` | `56 * 1.7` | `95.2` |
| `BEND_REACH` | `0.18 / 2` | `0.09` |
| `RIM_FRACTION` | `0.84 / 2` | `0.42` |
